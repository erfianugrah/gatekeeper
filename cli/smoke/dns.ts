/**
 * Smoke tests — DNS Records API: CRUD, IAM enforcement, deny statements, analytics.
 */

import type { SmokeContext } from './helpers.js';
import {
	req,
	admin,
	section,
	createKey,
	assertStatus,
	assertJson,
	assertTruthy,
	state,
	sleep,
	green,
	red,
	yellow,
	DNS_TEST_TOKEN,
	SKIP_DNS,
} from './helpers.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function dns(keyId: string, method: string, path: string, body?: unknown): Promise<import('./helpers.js').Resp> {
	const headers: Record<string, string> = { Authorization: `Bearer ${keyId}` };
	if (body) headers['Content-Type'] = 'application/json';
	return req(method, path, body, headers);
}

export async function run(ctx: SmokeContext): Promise<void> {
	if (SKIP_DNS) {
		section('DNS Proxy Tests (skipped — no DNS_TEST_TOKEN)');
		console.log(`  ${yellow('SKIP')}  Set DNS_TEST_TOKEN in .env`);
		return;
	}

	const { ZONE } = ctx;
	const DNS_BASE = `/v1/zones/${ZONE}/dns_records`;

	// ─── DNS Upstream Token Setup ───────────────────────────────────
	// DNS requires a CF API token with DNS:Edit permission, which may differ
	// from the purge token. Register a separate upstream token for DNS tests.
	// The resolver picks the newest exact match, so this overrides the purge token
	// for this zone. We clean it up at the end so purge resolution is restored.

	section('DNS Upstream Token Setup');

	const dnsUpstream = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-dns-token',
		token: DNS_TEST_TOKEN,
		zone_ids: [ZONE],
	});
	const dnsUpstreamId = dnsUpstream.body?.result?.id;
	assertStatus('register DNS upstream token -> 200', dnsUpstream, 200);
	assertTruthy('DNS upstream token has id', dnsUpstreamId);

	// ─── DNS Key Setup ──────────────────────────────────────────────

	section('DNS Key Setup');

	const WILDCARD_DNS_POLICY = {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['dns:*'], resources: [`zone:${ZONE}`] }],
	};

	const { r: wc, keyId: DNS_WILDCARD_ID } = await createKey('smoke-dns-wildcard', ZONE, WILDCARD_DNS_POLICY);
	assertStatus('create dns:* wildcard key -> 200', wc, 200);
	assertTruthy('wildcard key id starts with gw_', DNS_WILDCARD_ID.startsWith('gw_'));

	// ─── DNS Authentication ─────────────────────────────────────────

	section('DNS Authentication');

	const noAuth = await req('GET', DNS_BASE);
	assertStatus('no auth header -> 401', noAuth, 401);
	assertTruthy('401 message mentions Authorization', noAuth.body?.errors?.[0]?.message?.includes('Authorization: Bearer'));

	const badKey = await dns('gw_00000000000000000000000000000000', 'GET', DNS_BASE);
	assertStatus('nonexistent key -> 401', badKey, 401);

	const wrongZone = await dns(DNS_WILDCARD_ID, 'GET', '/v1/zones/aaaa1111bbbb2222cccc3333dddd4444/dns_records');
	assertStatus('wrong zone -> 403 (policy denies)', wrongZone, 403);

	const badZoneFmt = await dns(DNS_WILDCARD_ID, 'GET', '/v1/zones/not-a-hex-zone/dns_records');
	assertStatus('invalid zone ID format -> 400', badZoneFmt, 400);

	// ─── DNS List Records ───────────────────────────────────────────

	section('DNS List Records');

	const listAll = await dns(DNS_WILDCARD_ID, 'GET', DNS_BASE);
	assertStatus('list records -> 200', listAll, 200);
	assertTruthy('list returns result array', Array.isArray(listAll.body?.result));

	const listFiltered = await dns(DNS_WILDCARD_ID, 'GET', `${DNS_BASE}?type=A&per_page=5`);
	assertStatus('list with query params -> 200', listFiltered, 200);

	// ─── DNS Create / Read / Update / Delete ────────────────────────

	section('DNS CRUD (wildcard key)');

	const SMOKE_RECORD_NAME = `_gk-smoke-${Date.now()}.erfi.io`;

	// Create
	const createBody = { type: 'TXT', name: SMOKE_RECORD_NAME, content: '"gatekeeper smoke test"', ttl: 1 };
	const created = await dns(DNS_WILDCARD_ID, 'POST', DNS_BASE, createBody);
	assertStatus('create TXT record -> 200', created, 200);
	const recordId = created.body?.result?.id;
	assertTruthy('created record has id', recordId);

	if (recordId) {
		// Read single
		const getOne = await dns(DNS_WILDCARD_ID, 'GET', `${DNS_BASE}/${recordId}`);
		assertStatus('get single record -> 200', getOne, 200);
		assertTruthy('get returns matching name', getOne.body?.result?.name?.includes('_gk-smoke-'));

		// Update (PATCH)
		const patched = await dns(DNS_WILDCARD_ID, 'PATCH', `${DNS_BASE}/${recordId}`, {
			content: '"gatekeeper smoke updated"',
		});
		assertStatus('patch record -> 200', patched, 200);

		// Update (PUT — full overwrite)
		const putBody = { type: 'TXT', name: SMOKE_RECORD_NAME, content: '"gatekeeper smoke put"', ttl: 1 };
		const putted = await dns(DNS_WILDCARD_ID, 'PUT', `${DNS_BASE}/${recordId}`, putBody);
		assertStatus('put record -> 200', putted, 200);

		// Delete
		const deleted = await dns(DNS_WILDCARD_ID, 'DELETE', `${DNS_BASE}/${recordId}`);
		assertStatus('delete record -> 200', deleted, 200);

		// Verify deleted — GET should return 404 (CF API) or error
		const verifyDel = await dns(DNS_WILDCARD_ID, 'GET', `${DNS_BASE}/${recordId}`);
		// CF API returns various error statuses for not-found; anything non-200 is good
		if (verifyDel.status !== 200) {
			state.pass++;
			console.log(`  ${green('PASS')}  deleted record GET returns non-200 (${verifyDel.status})`);
		} else {
			state.fail++;
			state.errors.push(`deleted record still returns 200`);
			console.log(`  ${red('FAIL')}  deleted record still returns 200`);
		}
	}

	// ─── DNS Canonical Path (/cf/zones/) ───────────────────────────

	section('DNS Canonical Path (/cf/zones/)');

	const CF_DNS_BASE = `/cf/zones/${ZONE}/dns_records`;

	const cfList = await dns(DNS_WILDCARD_ID, 'GET', CF_DNS_BASE);
	assertStatus('canonical: list records -> 200', cfList, 200);
	assertTruthy('canonical: list returns result array', Array.isArray(cfList.body?.result));

	// Create via canonical path
	const CF_SMOKE_NAME = `_gk-cfpath-${Date.now()}.erfi.io`;
	const cfCreated = await dns(DNS_WILDCARD_ID, 'POST', CF_DNS_BASE, {
		type: 'TXT',
		name: CF_SMOKE_NAME,
		content: '"gatekeeper cf-path smoke"',
		ttl: 1,
	});
	assertStatus('canonical: create TXT record -> 200', cfCreated, 200);
	const cfRecordId = cfCreated.body?.result?.id;
	assertTruthy('canonical: created record has id', cfRecordId);

	if (cfRecordId) {
		// Read single via canonical path
		const cfGet = await dns(DNS_WILDCARD_ID, 'GET', `${CF_DNS_BASE}/${cfRecordId}`);
		assertStatus('canonical: get single record -> 200', cfGet, 200);

		// Delete via canonical path
		const cfDel = await dns(DNS_WILDCARD_ID, 'DELETE', `${CF_DNS_BASE}/${cfRecordId}`);
		assertStatus('canonical: delete record -> 200', cfDel, 200);
	}

	// Auth tests on canonical path
	const cfNoAuth = await req('GET', CF_DNS_BASE);
	assertStatus('canonical: no auth -> 401', cfNoAuth, 401);

	const cfBadZone = await dns(DNS_WILDCARD_ID, 'GET', '/cf/zones/not-a-hex-zone/dns_records');
	assertStatus('canonical: invalid zone -> 400', cfBadZone, 400);

	// ─── DNS Export ─────────────────────────────────────────────────

	section('DNS Export');

	const exported = await dns(DNS_WILDCARD_ID, 'GET', `${DNS_BASE}/export`);
	assertStatus('export zone file -> 200', exported, 200);
	// Export returns BIND zone file format (text), not JSON
	assertTruthy('export has content', exported.raw.length > 0);

	const cfExported = await dns(DNS_WILDCARD_ID, 'GET', `${CF_DNS_BASE}/export`);
	assertStatus('canonical: export zone file -> 200', cfExported, 200);
	assertTruthy('canonical: export has content', cfExported.raw.length > 0);

	// ─── DNS IAM Scoped Keys ────────────────────────────────────────

	section('DNS IAM Scoped Keys');

	// Read-only key
	const READ_ONLY_POLICY = {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['dns:read', 'dns:export'], resources: [`zone:${ZONE}`] }],
	};
	const { r: roCreate, keyId: DNS_RO_ID } = await createKey('smoke-dns-readonly', ZONE, READ_ONLY_POLICY);
	assertStatus('create read-only DNS key -> 200', roCreate, 200);

	// Read-only: list allowed
	const roList = await dns(DNS_RO_ID, 'GET', DNS_BASE);
	assertStatus('read-only key: list -> 200', roList, 200);

	// Read-only: export allowed
	const roExport = await dns(DNS_RO_ID, 'GET', `${DNS_BASE}/export`);
	assertStatus('read-only key: export -> 200', roExport, 200);

	// Read-only: create denied
	const roCreateDenied = await dns(DNS_RO_ID, 'POST', DNS_BASE, {
		type: 'TXT',
		name: '_gk-smoke-denied.erfi.io',
		content: '"denied"',
		ttl: 1,
	});
	assertStatus('read-only key: create -> 403', roCreateDenied, 403);

	// Create-only key
	const CREATE_ONLY_POLICY = {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['dns:create'], resources: [`zone:${ZONE}`] }],
	};
	const { r: coCreate, keyId: DNS_CO_ID } = await createKey('smoke-dns-create-only', ZONE, CREATE_ONLY_POLICY);
	assertStatus('create create-only DNS key -> 200', coCreate, 200);

	// Create-only: list denied
	const coListDenied = await dns(DNS_CO_ID, 'GET', DNS_BASE);
	assertStatus('create-only key: list -> 403', coListDenied, 403);

	// Create-only: create allowed — then clean up
	const coCreated = await dns(DNS_CO_ID, 'POST', DNS_BASE, {
		type: 'TXT',
		name: `_gk-smoke-co-${Date.now()}.erfi.io`,
		content: '"create-only"',
		ttl: 1,
	});
	assertStatus('create-only key: create -> 200', coCreated, 200);
	// Clean up with the wildcard key
	const coRecordId = coCreated.body?.result?.id;
	if (coRecordId) {
		await dns(DNS_WILDCARD_ID, 'DELETE', `${DNS_BASE}/${coRecordId}`);
	}

	// ─── DNS Condition Scoping ──────────────────────────────────────

	section('DNS Condition Scoping');

	// Key that only allows creating A records
	const A_ONLY_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['dns:create', 'dns:read'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'dns.type', operator: 'eq', value: 'A' }],
			},
		],
	};
	const { r: aCreate, keyId: DNS_A_ID } = await createKey('smoke-dns-a-only', ZONE, A_ONLY_POLICY);
	assertStatus('create A-only DNS key -> 200', aCreate, 200);

	// A-only: create TXT -> denied
	const aTxtDenied = await dns(DNS_A_ID, 'POST', DNS_BASE, {
		type: 'TXT',
		name: `_gk-smoke-txt-${Date.now()}.erfi.io`,
		content: '"should fail"',
		ttl: 1,
	});
	assertStatus('A-only key: create TXT -> 403', aTxtDenied, 403);

	// ─── DNS Deny Statements ────────────────────────────────────────

	section('DNS Deny Statements');

	// allow dns:* + deny dns:delete → delete denied, everything else allowed
	const DENY_DELETE_POLICY = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['dns:*'], resources: [`zone:${ZONE}`] },
			{ effect: 'deny', actions: ['dns:delete'], resources: [`zone:${ZONE}`] },
		],
	};
	const { r: ddCreate, keyId: DNS_DENY_DEL_ID } = await createKey('smoke-dns-deny-delete', ZONE, DENY_DELETE_POLICY);
	assertStatus('create deny-delete DNS key -> 200', ddCreate, 200);

	// deny-delete: list allowed
	const ddList = await dns(DNS_DENY_DEL_ID, 'GET', DNS_BASE);
	assertStatus('deny-delete key: list -> 200', ddList, 200);

	// deny-delete: create allowed, then try to delete
	const ddCreated = await dns(DNS_DENY_DEL_ID, 'POST', DNS_BASE, {
		type: 'TXT',
		name: `_gk-smoke-dd-${Date.now()}.erfi.io`,
		content: '"deny delete test"',
		ttl: 1,
	});
	assertStatus('deny-delete key: create -> 200', ddCreated, 200);
	const ddRecordId = ddCreated.body?.result?.id;

	if (ddRecordId) {
		const ddDeleteDenied = await dns(DNS_DENY_DEL_ID, 'DELETE', `${DNS_BASE}/${ddRecordId}`);
		assertStatus('deny-delete key: delete -> 403', ddDeleteDenied, 403);

		// Clean up with wildcard key
		await dns(DNS_WILDCARD_ID, 'DELETE', `${DNS_BASE}/${ddRecordId}`);
	}

	// Deny-only policy: deny dns:* with no allow → everything denied
	const DENY_ONLY_POLICY = {
		version: '2025-01-01',
		statements: [{ effect: 'deny', actions: ['dns:*'], resources: [`zone:${ZONE}`] }],
	};
	const { r: doCreate, keyId: DNS_DENY_ONLY_ID } = await createKey('smoke-dns-deny-only', ZONE, DENY_ONLY_POLICY);
	assertStatus('create deny-only DNS key -> 200', doCreate, 200);

	const doList = await dns(DNS_DENY_ONLY_ID, 'GET', DNS_BASE);
	assertStatus('deny-only key: list -> 403', doList, 403);

	const doCreateDenied = await dns(DNS_DENY_ONLY_ID, 'POST', DNS_BASE, {
		type: 'TXT',
		name: '_gk-smoke-do.erfi.io',
		content: '"denied"',
		ttl: 1,
	});
	assertStatus('deny-only key: create -> 403', doCreateDenied, 403);

	// ─── DNS Action Mutation Coverage ───────────────────────────────

	section('DNS Action Mutation Coverage');

	const actionTests: {
		action: string;
		name: string;
		okMethod: string;
		okPath: string;
		okBody?: object;
		failMethod: string;
		failPath: string;
		failBody?: object;
	}[] = [
		{
			action: 'dns:read',
			name: 'smoke-dns-act-read',
			okMethod: 'GET',
			okPath: DNS_BASE,
			failMethod: 'POST',
			failPath: DNS_BASE,
			failBody: { type: 'TXT', name: '_gk-smoke-act.erfi.io', content: '"x"', ttl: 1 },
		},
		{
			action: 'dns:export',
			name: 'smoke-dns-act-export',
			okMethod: 'GET',
			okPath: `${DNS_BASE}/export`,
			failMethod: 'GET',
			failPath: DNS_BASE,
		},
	];

	for (const at of actionTests) {
		const policy = {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: [at.action], resources: [`zone:${ZONE}`] }],
		};
		const { r: cr, keyId } = await createKey(at.name, ZONE, policy);
		assertStatus(`${at.action} key created -> 200`, cr, 200);

		const ok = await dns(keyId, at.okMethod, at.okPath, at.okBody);
		assertStatus(`${at.action} key: allowed action -> 200`, ok, 200);

		const denied = await dns(keyId, at.failMethod, at.failPath, at.failBody);
		assertStatus(`${at.action} key: wrong action -> 403`, denied, 403);
	}

	// ─── DNS Analytics ──────────────────────────────────────────────

	section('DNS Analytics');

	// Small delay for fire-and-forget D1 writes
	await sleep(1500);

	const events = await admin('GET', `/admin/dns/analytics/events?zone_id=${ZONE}`);
	assertStatus('DNS events -> 200', events, 200);
	const eventCount = events.body?.result?.length ?? 0;
	assertTruthy(`DNS event count > 0 (got ${eventCount})`, eventCount > 0);

	const ev0 = events.body?.result?.[0];
	assertTruthy('DNS event has key_id', ev0?.key_id?.startsWith('gw_'));
	assertJson('DNS event has zone_id', ev0?.zone_id, ZONE);
	assertTruthy('DNS event has action', ev0?.action?.startsWith('dns:'));

	const limited = await admin('GET', `/admin/dns/analytics/events?zone_id=${ZONE}&limit=2`);
	assertStatus('DNS events with limit -> 200', limited, 200);
	assertTruthy(`limit=2 respected (got ${limited.body?.result?.length})`, (limited.body?.result?.length ?? 99) <= 2);

	const summary = await admin('GET', `/admin/dns/analytics/summary?zone_id=${ZONE}`);
	assertStatus('DNS summary -> 200', summary, 200);
	assertTruthy('DNS summary has total_requests', summary.body?.result?.total_requests > 0);
	assertTruthy('DNS summary has by_action', Object.keys(summary.body?.result?.by_action ?? {}).length > 0);

	const eventsNoZone = await admin('GET', '/admin/dns/analytics/events');
	assertStatus('DNS events without zone_id -> 200', eventsNoZone, 200);

	const summaryNoZone = await admin('GET', '/admin/dns/analytics/summary');
	assertStatus('DNS summary without zone_id -> 200', summaryNoZone, 200);

	// ─── DNS Upstream Token Cleanup ─────────────────────────────────
	// Remove the DNS upstream token so the purge token is restored as the
	// resolver's match for this zone.

	if (dnsUpstreamId) {
		try {
			await admin('DELETE', `/admin/upstream-tokens/${dnsUpstreamId}`);
			console.log(`  Cleaned up DNS upstream token ${dnsUpstreamId}`);
		} catch {
			/* best effort */
		}
	}
}
