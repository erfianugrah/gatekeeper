/**
 * Live traffic generator for Gatekeeper.
 *
 * Unlike the smoke suite (cli/smoke-test.ts) which asserts allow/deny correctness at
 * ~1 request per scenario, this produces a believable *workload*: many synthetic tenant
 * keys with varied policies across every fronted surface, driven at volume with a
 * realistic read/write/deny mix, so the metering rollups read like real usage rather
 * than a handful of seed hits. It prints a live progress summary, then the cross-surface
 * and per-surface metering, and (by default) cleans up everything it created.
 *
 * Env (same names the smoke suite uses; export a decrypted set before running):
 *   GATEKEEPER_URL, GATEKEEPER_ADMIN_KEY   - target + admin auth (required)
 *   CF_API_TOKEN                           - zone token for purge (required for purge)
 *   DNS_TEST_TOKEN                         - zone token with DNS:Edit (dns surface)
 *   CF_PROXY_TOKEN + CF_ACCOUNT_ID         - account token (cf surface)
 *   R2_ACCESS_KEY + R2_SECRET_KEY + R2_ENDPOINT [+ S3_TEST_BUCKET] (s3 surface)
 *   SUPABASE_TRAFFIC_PAT [+ SUPABASE_TRAFFIC_REF] - optional supabase PAT (supabase surface)
 *
 * Flags:
 *   --requests N     total requests to generate (default 300)
 *   --tenants M      synthetic tenant keys to mint per available surface (default 3)
 *   --concurrency C  in-flight requests (default 5)
 *   --no-cleanup     leave the synthetic keys/tokens/resources in place (default: clean up)
 */

import {
	BASE,
	IS_REMOTE,
	ADMIN_KEY,
	CF_API_TOKEN,
	DNS_TEST_TOKEN,
	R2_ACCESS_KEY,
	R2_SECRET_KEY,
	R2_ENDPOINT,
	S3_TEST_BUCKET,
	SKIP_S3,
	SKIP_DNS,
	req,
	admin,
	s3client,
	s3req,
	state,
	sleep,
	green,
	red,
	yellow,
	bold,
	dim,
	magenta,
} from './smoke/helpers.js';
import type { Resp } from './smoke/helpers.js';
import type { AwsClient } from 'aws4fetch';

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function argVal(name: string, def: number): number {
	const i = process.argv.indexOf(`--${name}`);
	if (i >= 0 && process.argv[i + 1]) {
		const n = Number(process.argv[i + 1]);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return def;
}

const TOTAL_REQUESTS = argVal('requests', 300);
const TENANTS_PER_SURFACE = argVal('tenants', 3);
const CONCURRENCY = argVal('concurrency', 5);
const CLEANUP = !process.argv.includes('--no-cleanup');

const CF_PROXY_TOKEN = process.env['CF_PROXY_TOKEN'];
const CF_ACCOUNT_ID = process.env['CF_ACCOUNT_ID'];
const SUPABASE_PAT = process.env['SUPABASE_TRAFFIC_PAT'];
const SUPABASE_REF = process.env['SUPABASE_TRAFFIC_REF'];

// ─── Tenant + op model ─────────────────────────────────────────────────────────

interface Tenant {
	surface: string;
	label: string; // display name
	keyId: string; // gw_ key or S3 access key id
	// Weighted op generators. Each returns a Resp; classification is by HTTP status.
	ops: { kind: 'read' | 'write' | 'deny'; weight: number; run: () => Promise<Resp> }[];
	s3?: AwsClient; // for s3 tenants
}

const tenants: Tenant[] = [];
const counts = { read: 0, write: 0, deny: 0, error: 0, rateLimited: 0, byStatus: {} as Record<number, number> };
const createdDnsRecords: string[] = [];
const createdS3Objects: string[] = [];

let ZONE = '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

/** Weighted pick of an op from a tenant. */
function pickOp(t: Tenant): Tenant['ops'][number] {
	const total = t.ops.reduce((s, o) => s + o.weight, 0);
	let r = Math.random() * total;
	for (const o of t.ops) {
		r -= o.weight;
		if (r <= 0) return o;
	}
	return t.ops[t.ops.length - 1];
}

function bearer(keyId: string) {
	return { Authorization: `Bearer ${keyId}` };
}

function rand(n: number) {
	return Math.floor(Math.random() * n);
}

/**
 * Create a key bound to an upstream token. Zone-scoped surfaces (purge/dns) pass a
 * zone_id; account-scoped surfaces (cf/supabase) must omit it - a zone_id on an
 * account-scoped key fails token-binding validation and every request 403s.
 */
async function createKeyFor(name: string, policy: object, upstreamTokenId: string, zoneId?: string): Promise<string> {
	const body: Record<string, unknown> = { name, policy, upstream_token_id: upstreamTokenId };
	if (zoneId) body['zone_id'] = zoneId;
	const r = await admin('POST', '/admin/keys', body);
	const id = r.body?.result?.key?.id ?? '';
	if (id) state.createdKeys.push(id);
	return id;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

async function setup(): Promise<void> {
	console.log(bold('\nGatekeeper - Traffic Generator'));
	console.log(`Base:        ${BASE} (${IS_REMOTE ? 'remote' : 'local'})`);
	console.log(`Requests:    ${TOTAL_REQUESTS}   Concurrency: ${CONCURRENCY}   Cleanup: ${CLEANUP}`);

	if (!ADMIN_KEY) {
		console.error(red('ERROR: no admin key. Set GATEKEEPER_ADMIN_KEY.'));
		process.exit(1);
	}
	const health = await req('GET', '/health');
	if (health.status !== 200) {
		console.error(red(`ERROR: server not healthy at ${BASE}/health (HTTP ${health.status})`));
		process.exit(1);
	}

	// Resolve zone for purge/dns (erfi.io).
	if (CF_API_TOKEN) {
		const zoneRes = await fetch('https://api.cloudflare.com/client/v4/zones?name=erfi.io', {
			headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
		});
		const zoneData = (await zoneRes.json()) as any;
		ZONE = zoneData?.result?.[0]?.id ?? '';
	}

	console.log(bold('\nProvisioning synthetic tenants...'));

	// ── Purge surface ──
	if (CF_API_TOKEN && ZONE) {
		const reg = await admin('POST', '/admin/upstream-tokens', { name: 'traffic-purge-token', token: CF_API_TOKEN, zone_ids: [ZONE] });
		const tokenId = reg.body?.result?.id;
		if (tokenId) {
			state.createdUpstreamTokens.push(tokenId);
			const purgeUrl = `/v1/zones/${ZONE}/purge_cache`;
			for (let i = 0; i < TENANTS_PER_SURFACE; i++) {
				// Mix: 2/3 wildcard (all purge ops allowed), 1/3 tag-only (file/host purges denied).
				const wildcard = i % 3 !== 0;
				const policy = {
					version: '2025-01-01',
					statements: [{ effect: 'allow', actions: wildcard ? ['purge:*'] : ['purge:tag'], resources: [`zone:${ZONE}`] }],
				};
				const keyId = await createKeyFor(`traffic-purge-${wildcard ? 'wild' : 'tagonly'}-${i}`, policy, tokenId, ZONE);
				if (!keyId) continue;
				tenants.push({
					surface: 'purge',
					label: `purge-${wildcard ? 'wild' : 'tagonly'}-${i}`,
					keyId,
					ops: [
						{ kind: 'read', weight: 0, run: async () => req('POST', purgeUrl, { tags: [`t${rand(50)}`] }, bearer(keyId)) },
						// tag purge always allowed for both policies
						{ kind: 'write', weight: 5, run: async () => req('POST', purgeUrl, { tags: [`sku-${rand(9999)}`] }, bearer(keyId)) },
						// host/prefix/url purge: allowed for wildcard, denied (403) for tag-only
						{
							kind: wildcard ? 'write' : 'deny',
							weight: 4,
							run: async () => req('POST', purgeUrl, { hosts: [pick(['img', 'api', 'www', 'cdn']) + '.erfi.io'] }, bearer(keyId)),
						},
						{
							kind: wildcard ? 'write' : 'deny',
							weight: 3,
							run: async () => req('POST', purgeUrl, { prefixes: [`erfi.io/assets/${rand(20)}/`] }, bearer(keyId)),
						},
					],
				});
			}
			console.log(`  purge:    ${TENANTS_PER_SURFACE} tenants  ${dim(`(token ${tokenId})`)}`);
		}
	} else {
		console.log(dim('  purge:    skipped (no CF_API_TOKEN / zone)'));
	}

	// ── DNS surface ──
	if (!SKIP_DNS && ZONE) {
		const reg = await admin('POST', '/admin/upstream-tokens', { name: 'traffic-dns-token', token: DNS_TEST_TOKEN, zone_ids: [ZONE] });
		const tokenId = reg.body?.result?.id;
		if (tokenId) {
			state.createdUpstreamTokens.push(tokenId);
			const dnsBase = `/v1/zones/${ZONE}/dns_records`;
			for (let i = 0; i < TENANTS_PER_SURFACE; i++) {
				const readonly = i % 3 === 0;
				const policy = {
					version: '2025-01-01',
					statements: [{ effect: 'allow', actions: readonly ? ['dns:read', 'dns:export'] : ['dns:*'], resources: [`zone:${ZONE}`] }],
				};
				const keyId = await createKeyFor(`traffic-dns-${readonly ? 'ro' : 'rw'}-${i}`, policy, tokenId, ZONE);
				if (!keyId) continue;
				const ops: Tenant['ops'] = [
					{ kind: 'read', weight: 6, run: async () => req('GET', dnsBase, undefined, bearer(keyId)) },
					{ kind: 'read', weight: 2, run: async () => req('GET', `${dnsBase}/export`, undefined, bearer(keyId)) },
				];
				if (readonly) {
					ops.push({
						kind: 'deny',
						weight: 3,
						run: async () =>
							req('POST', dnsBase, { type: 'TXT', name: `_gk-traffic-deny-${rand(1e6)}.erfi.io`, content: '"x"', ttl: 60 }, bearer(keyId)),
					});
				} else {
					// Real create then delete (cleanup) - generates write cost.
					ops.push({
						kind: 'write',
						weight: 3,
						run: async () => {
							const name = `_gk-traffic-${Date.now()}-${rand(1e6)}.erfi.io`;
							const created = await req('POST', dnsBase, { type: 'TXT', name, content: '"traffic"', ttl: 60 }, bearer(keyId));
							const recId = created.body?.result?.id;
							if (recId) {
								await req('DELETE', `${dnsBase}/${recId}`, undefined, bearer(keyId));
							}
							return created;
						},
					});
				}
				tenants.push({ surface: 'dns', label: `dns-${readonly ? 'ro' : 'rw'}-${i}`, keyId, ops });
			}
			console.log(`  dns:      ${TENANTS_PER_SURFACE} tenants  ${dim(`(token ${tokenId})`)}`);
		}
	} else {
		console.log(dim('  dns:      skipped (no DNS_TEST_TOKEN / zone)'));
	}

	// ── CF proxy surface (reads only - avoid creating real D1/KV resources) ──
	if (CF_PROXY_TOKEN && CF_ACCOUNT_ID) {
		const reg = await admin('POST', '/admin/upstream-tokens', {
			name: 'traffic-cf-token',
			token: CF_PROXY_TOKEN,
			scope_type: 'account',
			zone_ids: [CF_ACCOUNT_ID],
		});
		const tokenId = reg.body?.result?.id;
		if (tokenId) {
			state.createdUpstreamTokens.push(tokenId);
			const cfBase = `/cf/accounts/${CF_ACCOUNT_ID}`;
			for (let i = 0; i < TENANTS_PER_SURFACE; i++) {
				const readonly = i % 3 === 0;
				const policy = {
					version: '2025-01-01',
					statements: [
						{
							effect: 'allow',
							actions: readonly
								? ['d1:list', 'kv:list_namespaces']
								: ['d1:list', 'd1:get', 'kv:list_namespaces', 'workers:list_scripts', 'vectorize:list_indexes'],
							resources: [`account:${CF_ACCOUNT_ID}`],
						},
					],
				};
				const keyId = await createKeyFor(`traffic-cf-${readonly ? 'ro' : 'rw'}-${i}`, policy, tokenId);
				if (!keyId) continue;
				const ops: Tenant['ops'] = [
					{ kind: 'read', weight: 5, run: async () => req('GET', `${cfBase}/d1/database`, undefined, bearer(keyId)) },
					{ kind: 'read', weight: 4, run: async () => req('GET', `${cfBase}/storage/kv/namespaces`, undefined, bearer(keyId)) },
				];
				if (readonly) {
					// workers:list not granted -> denied
					ops.push({ kind: 'deny', weight: 3, run: async () => req('GET', `${cfBase}/workers/scripts`, undefined, bearer(keyId)) });
				} else {
					ops.push({ kind: 'read', weight: 2, run: async () => req('GET', `${cfBase}/workers/scripts`, undefined, bearer(keyId)) });
					ops.push({ kind: 'read', weight: 2, run: async () => req('GET', `${cfBase}/vectorize/v2/indexes`, undefined, bearer(keyId)) });
				}
				tenants.push({ surface: 'cf', label: `cf-${readonly ? 'ro' : 'rw'}-${i}`, keyId, ops });
			}
			console.log(`  cf:       ${TENANTS_PER_SURFACE} tenants  ${dim(`(token ${tokenId})`)}`);
		}
	} else {
		console.log(dim('  cf:       skipped (no CF_PROXY_TOKEN / CF_ACCOUNT_ID)'));
	}

	// ── S3 surface (real put/get/delete with cleanup) ──
	if (!SKIP_S3) {
		const reg = await admin('POST', '/admin/upstream-r2', {
			name: 'traffic-r2',
			endpoint: R2_ENDPOINT,
			access_key_id: R2_ACCESS_KEY,
			secret_access_key: R2_SECRET_KEY,
			bucket_names: [S3_TEST_BUCKET],
		});
		const r2Id = reg.body?.result?.id;
		if (r2Id) {
			(state.createdUpstreamR2 as string[]).push(r2Id);
			for (let i = 0; i < TENANTS_PER_SURFACE; i++) {
				const readonly = i % 3 === 0;
				const policy = {
					version: '2025-01-01',
					statements: [
						{
							effect: 'allow',
							actions: readonly ? ['s3:GetObject', 's3:HeadObject', 's3:ListBucket', 's3:ListAllMyBuckets'] : ['s3:*'],
							resources: ['account:*', 'bucket:*', 'object:*'],
						},
					],
				};
				const cred = await admin('POST', '/admin/s3/credentials', {
					name: `traffic-s3-${readonly ? 'ro' : 'rw'}-${i}`,
					policy,
					upstream_token_id: r2Id,
				});
				const ak = cred.body?.result?.credential?.access_key_id;
				const sk = cred.body?.result?.credential?.secret_access_key;
				if (!ak || !sk) continue;
				state.createdS3Creds.push(ak);
				const client = s3client(ak, sk);
				const ops: Tenant['ops'] = [
					{ kind: 'read', weight: 5, run: async () => s3req(client, 'GET', `/${S3_TEST_BUCKET}?list-type=2&max-keys=5`) },
				];
				if (readonly) {
					ops.push({
						kind: 'deny',
						weight: 3,
						run: async () => s3req(client, 'PUT', `/${S3_TEST_BUCKET}/gk-traffic/denied-${rand(1e6)}.txt`, 'nope'),
					});
				} else {
					ops.push({
						kind: 'write',
						weight: 4,
						run: async () => {
							const key = `gk-traffic/${Date.now()}-${rand(1e6)}.txt`;
							const put = await s3req(client, 'PUT', `/${S3_TEST_BUCKET}/${key}`, `traffic ${'x'.repeat(rand(2000))}`);
							if (put.status < 300) {
								createdS3Objects.push(key);
								await s3req(client, 'DELETE', `/${S3_TEST_BUCKET}/${key}`);
								createdS3Objects.pop();
							}
							return put;
						},
					});
				}
				tenants.push({ surface: 's3', label: `s3-${readonly ? 'ro' : 'rw'}-${i}`, keyId: ak, ops, s3: client });
			}
			console.log(`  s3:       ${TENANTS_PER_SURFACE} tenants  ${dim(`(r2 ${r2Id})`)}`);
		}
	} else {
		console.log(dim('  s3:       skipped (no R2 creds)'));
	}

	// ── Supabase surface (optional; needs a real PAT) ──
	if (SUPABASE_PAT) {
		const reg = await admin('POST', '/admin/upstream-tokens', {
			name: 'traffic-supabase-token',
			token: SUPABASE_PAT,
			scope_type: 'supabase',
			zone_ids: ['*'],
			validate: false,
		});
		const tokenId = reg.body?.result?.id;
		if (tokenId) {
			state.createdUpstreamTokens.push(tokenId);
			const refRes = SUPABASE_REF ? `project:${SUPABASE_REF}` : 'supabase:account';
			for (let i = 0; i < TENANTS_PER_SURFACE; i++) {
				const policy = {
					version: '2025-01-01',
					statements: [
						{ effect: 'allow', actions: ['supabase:projects:read', 'supabase:oauth:read'], resources: ['project:*', 'supabase:account'] },
					],
				};
				const keyId = await createKeyFor(`traffic-supabase-${i}`, policy, tokenId);
				if (!keyId) continue;
				tenants.push({
					surface: 'supabase',
					label: `supabase-${i}`,
					keyId,
					ops: [
						{ kind: 'read', weight: 6, run: async () => req('GET', '/supabase/v1/projects', undefined, bearer(keyId)) },
						// write-classified action not in policy -> denied
						{ kind: 'deny', weight: 2, run: async () => req('POST', '/supabase/v1/projects', { name: 'x' }, bearer(keyId)) },
					],
				});
			}
			console.log(`  supabase: ${TENANTS_PER_SURFACE} tenants  ${dim(`(token ${tokenId})`)}`);
		}
	} else {
		console.log(dim('  supabase: skipped (no SUPABASE_TRAFFIC_PAT)'));
	}

	if (tenants.length === 0) {
		console.error(red('\nNo surfaces available - nothing to generate. Check your credentials.'));
		await cleanup();
		process.exit(1);
	}
	console.log(bold(`\n${tenants.length} tenants across ${new Set(tenants.map((t) => t.surface)).size} surfaces ready.`));
}

// ─── Traffic loop ────────────────────────────────────────────────────────────

async function fireOne(): Promise<void> {
	const t = pick(tenants);
	const op = pickOp(t);
	try {
		const r = await op.run();
		counts.byStatus[r.status] = (counts.byStatus[r.status] ?? 0) + 1;
		if (r.status === 429) counts.rateLimited++;
		if (r.status >= 500) counts.error++;
		else counts[op.kind]++;
	} catch {
		counts.error++;
	}
}

async function generate(): Promise<void> {
	console.log(bold(`\nGenerating ${TOTAL_REQUESTS} requests...\n`));
	let done = 0;
	const started = Date.now();
	while (done < TOTAL_REQUESTS) {
		const batch = Math.min(CONCURRENCY, TOTAL_REQUESTS - done);
		await Promise.all(Array.from({ length: batch }, () => fireOne()));
		done += batch;
		if (done % 50 === 0 || done === TOTAL_REQUESTS) {
			const pct = Math.round((done / TOTAL_REQUESTS) * 100);
			process.stdout.write(
				`\r  ${done}/${TOTAL_REQUESTS} (${pct}%)  ${dim(`read=${counts.read} write=${counts.write} deny=${counts.deny} 429=${counts.rateLimited} err=${counts.error}`)}   `,
			);
		}
		await sleep(20 + rand(40)); // jitter between batches
	}
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	console.log(
		`\n\n${green('Done')} in ${secs}s. Status mix: ${Object.entries(counts.byStatus)
			.map(([s, n]) => `${s}:${n}`)
			.join('  ')}`,
	);
}

// ─── Metering readout ──────────────────────────────────────────────────────────

async function meteringReadout(): Promise<void> {
	console.log(bold(magenta('\n─── Metering (cross-surface, per tenant) ───\n')));
	const r = await admin('GET', '/admin/metering?limit=25');
	const rows = (r.body?.result ?? []) as any[];
	if (rows.length === 0) {
		console.log(dim('  (no rows - metering may lag a moment behind analytics writes)'));
		return;
	}
	console.log(
		`  ${'TENANT'.padEnd(30)} ${'REQ'.padStart(6)} ${'COST*'.padStart(11)} ${'ERR'.padStart(5)}  ${'EGRESS'.padStart(9)}  surfaces`,
	);
	for (const row of rows) {
		const surfaces = Object.entries((row.surfaces ?? {}) as Record<string, { total_requests?: number }>)
			.map(([k, v]) => `${k.replace('_proxy_events', '').replace('_events', '')}:${v.total_requests ?? 0}`)
			.join(' ');
		const cost = Number(row.total_cost_usd ?? 0);
		console.log(
			`  ${String(row.tenant ?? '(none)')
				.slice(0, 30)
				.padEnd(
					30,
				)} ${String(row.total_requests ?? 0).padStart(6)} ${('$' + cost.toFixed(6)).padStart(11)} ${String(row.total_errors ?? 0).padStart(5)}  ${String(row.total_egress_bytes ?? 0).padStart(9)}  ${dim(surfaces)}`,
		);
	}
	console.log(dim('\n  * Cost uses illustrative placeholder pricing (src/metering-pricing.ts), not real list prices.'));
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
	if (!CLEANUP) {
		console.log(
			yellow(
				`\nSkipping cleanup (--no-cleanup). Left ${state.createdKeys.length} keys, ${state.createdS3Creds.length} S3 creds, ${state.createdUpstreamTokens.length} tokens.`,
			),
		);
		return;
	}
	console.log(bold('\nCleaning up...'));
	for (const kid of state.createdKeys) {
		await admin('DELETE', `/admin/keys/${kid}?permanent=true`).catch(() => {});
	}
	for (const cid of state.createdS3Creds) {
		await admin('DELETE', `/admin/s3/credentials/${cid}?permanent=true`).catch(() => {});
	}
	for (const tid of state.createdUpstreamTokens) {
		await admin('DELETE', `/admin/upstream-tokens/${tid}`).catch(() => {});
	}
	for (const rid of state.createdUpstreamR2 as string[]) {
		await admin('DELETE', `/admin/upstream-r2/${rid}`).catch(() => {});
	}
	console.log(
		`  Deleted ${state.createdKeys.length} keys, ${state.createdS3Creds.length} S3 creds, ${state.createdUpstreamTokens.length} upstream tokens, ${(state.createdUpstreamR2 as string[]).length} R2 endpoints.`,
	);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	await setup();
	try {
		await generate();
		await meteringReadout();
	} finally {
		await cleanup();
	}
	console.log('');
}

main().catch((e) => {
	console.error(red(`\nFATAL: ${e?.message ?? e}`));
	cleanup().finally(() => process.exit(1));
});
