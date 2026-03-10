/**
 * Shared helpers for the smoke test suite.
 *
 * Exports: config, mutable state, HTTP helpers, assertion helpers, key/S3 helpers.
 */

import { readFileSync } from 'node:fs';
import { AwsClient } from 'aws4fetch';

// ─── ANSI helpers ──────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;
const noColor = !!process.env['NO_COLOR'];
const color = isTTY && !noColor;

export const green = (s: string) => (color ? `\x1b[32m${s}\x1b[39m` : s);
export const red = (s: string) => (color ? `\x1b[31m${s}\x1b[39m` : s);
export const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[39m` : s);
export const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[22m` : s);
export const magenta = (s: string) => (color ? `\x1b[35m${s}\x1b[39m` : s);
export const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[22m` : s);

// ─── Config ────────────────────────────────────────────────────────────────

export const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

/** Read a key=value from a file (no quotes handling — matches the .env/.dev.vars format). */
function readVar(file: string, key: string): string | undefined {
	try {
		const content = readFileSync(file, 'utf-8');
		const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
}

export const BASE = (process.env['GATEKEEPER_URL'] ?? 'http://localhost:8787').replace(/\/+$/, '');
export const IS_REMOTE = BASE.startsWith('https://');

export const ADMIN_KEY = IS_REMOTE
	? (process.env['GATEKEEPER_ADMIN_KEY'] ?? readVar('.env', 'GATEKEEPER_ADMIN_KEY'))
	: readVar('.dev.vars', 'ADMIN_KEY');

export const CF_API_TOKEN = process.env['CF_API_TOKEN'] ?? readVar('.env', 'UPSTREAM_PURGE_KEY');

export const R2_ACCESS_KEY = process.env['R2_ACCESS_KEY'] ?? readVar('.env', 'R2_TEST_ACCESS_KEY');
export const R2_SECRET_KEY = process.env['R2_SECRET_KEY'] ?? readVar('.env', 'R2_TEST_SECRET_KEY');
export const R2_ENDPOINT = process.env['R2_ENDPOINT'] ?? readVar('.env', 'R2_TEST_ENDPOINT');
export const S3_TEST_BUCKET = process.env['S3_TEST_BUCKET'] ?? 'vault';
export const SKIP_S3 = !R2_ACCESS_KEY || !R2_SECRET_KEY || !R2_ENDPOINT;

export const DNS_TEST_TOKEN = process.env['DNS_TEST_TOKEN'] ?? readVar('.env', 'DNS_TEST_TOKEN');
export const SKIP_DNS = !DNS_TEST_TOKEN;

// ─── Mutable test state ────────────────────────────────────────────────────

export const state = {
	pass: 0,
	fail: 0,
	errors: [] as string[],
	createdKeys: [] as string[],
	createdS3Creds: [] as string[],
	createdUpstreamTokens: [] as string[],
	createdUpstreamR2: [] as string[],
	createdDnsRecords: [] as { zoneId: string; recordId: string }[],
	createdD1Databases: [] as { accountId: string; dbId: string }[],
	createdKvNamespaces: [] as { accountId: string; nsId: string }[],
	configOverrides: [] as string[],
};

// ─── HTTP helpers ──────────────────────────────────────────────────────────

export interface Resp {
	status: number;
	body: any;
	headers: Headers;
	raw: string;
}

export async function req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Resp> {
	const headers: Record<string, string> = { ...extraHeaders };
	if (body && typeof body !== 'string') {
		headers['Content-Type'] = 'application/json';
	}
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
	});
	const raw = await res.text();
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	return { status: res.status, body: parsed, headers: res.headers, raw };
}

export function admin(method: string, path: string, body?: unknown): Promise<Resp> {
	return req(method, path, body, { 'X-Admin-Key': ADMIN_KEY! });
}

export function purge(keyId: string, path: string, body: unknown): Promise<Resp> {
	return req('POST', path, body, { Authorization: `Bearer ${keyId}` });
}

// ─── Assertion helpers ─────────────────────────────────────────────────────

export function assertStatus(name: string, r: Resp, expected: number): void {
	if (r.status === expected) {
		state.pass++;
		console.log(`  ${green('PASS')}  ${name} ${dim(`(HTTP ${r.status})`)}`);
	} else {
		state.fail++;
		state.errors.push(`${name}: expected HTTP ${expected}, got HTTP ${r.status}`);
		console.log(`  ${red('FAIL')}  ${name} ${dim(`(expected ${expected}, got ${r.status})`)}`);
	}
	if (VERBOSE) console.log(JSON.stringify(r.body, null, 2));
}

export function assertJson(name: string, value: unknown, expected: unknown): void {
	const ok = JSON.stringify(value) === JSON.stringify(expected);
	if (ok) {
		state.pass++;
		console.log(`  ${green('PASS')}  ${name} ${dim(`(${JSON.stringify(value)})`)}`);
	} else {
		state.fail++;
		state.errors.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
		console.log(`  ${red('FAIL')}  ${name} ${dim(`(expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)})`)}`);
	}
}

export function assertMatch(name: string, value: string, pattern: RegExp): void {
	if (pattern.test(value)) {
		state.pass++;
		console.log(`  ${green('PASS')}  ${name}`);
	} else {
		state.fail++;
		state.errors.push(`${name}: '${value}' did not match ${pattern}`);
		console.log(`  ${red('FAIL')}  ${name} ${dim(`('${value}' !~ ${pattern})`)}`);
	}
}

export function assertTruthy(name: string, value: unknown): void {
	if (value) {
		state.pass++;
		console.log(`  ${green('PASS')}  ${name}`);
	} else {
		state.fail++;
		state.errors.push(`${name}: expected truthy, got ${JSON.stringify(value)}`);
		console.log(`  ${red('FAIL')}  ${name} ${dim(`(falsy: ${JSON.stringify(value)})`)}`);
	}
}

export function section(name: string): void {
	console.log('');
	console.log(`${bold(magenta(`─── ${name} ───`))}`);
}

// ─── Key creation helper ───────────────────────────────────────────────────

export async function createKey(
	name: string,
	zone: string,
	policy: object,
	extra?: object & { upstream_token_id?: string },
): Promise<{ r: Resp; keyId: string }> {
	const upstreamTokenId = extra?.upstream_token_id ?? currentSmokeUpstreamTokenId;
	const r = await admin('POST', '/admin/keys', { name, zone_id: zone, policy, upstream_token_id: upstreamTokenId, ...extra });
	const keyId = r.body?.result?.key?.id ?? '';
	if (keyId) state.createdKeys.push(keyId);
	return { r, keyId };
}

// ─── Upstream token binding state ──────────────────────────────────────────

/** Current zone-scoped upstream token ID for smoke tests. Set by setSmokeUpstreamTokenId(). */
let currentSmokeUpstreamTokenId = '';

/** Set the upstream token ID used by createKey(). Call from the orchestrator after registering. */
export function setSmokeUpstreamTokenId(id: string): void {
	currentSmokeUpstreamTokenId = id;
}

// ─── S3 client helpers ─────────────────────────────────────────────────────

export function s3client(accessKeyId: string, secretAccessKey: string): AwsClient {
	return new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
}

export async function s3req(client: AwsClient, method: string, path: string, body?: string | ReadableStream): Promise<Resp> {
	const url = `${BASE}/s3${path}`;
	const headers: Record<string, string> = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
	if (body && typeof body === 'string') headers['content-length'] = String(Buffer.byteLength(body));
	const signed = await client.sign(url, { method, headers, body });
	const res = await fetch(signed);
	const raw = await res.text();
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	return { status: res.status, body: parsed, headers: res.headers, raw };
}

// ─── Utilities ─────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Smoke context — populated by orchestrator, passed to section modules ──

export interface SmokeContext {
	ZONE: string;
	PURGE_URL: string;
	WILDCARD_POLICY: object;
	UPSTREAM_TOKEN_ID: string;
	/** Key IDs created in the admin section. */
	WILDCARD_ID: string;
	HOST_ID: string;
	TAG_ID: string;
	PREFIX_ID: string;
	URL_ID: string;
	MULTI_ID: string;
	REVOKE_ID: string;
	REVOKE_ID_2: string;
	RATELIMIT_ID: string;
	/** DNS upstream token ID, set when DNS tests run. */
	dnsUpstreamId?: string;
	/** CF proxy fields, set when CF proxy tests run. */
	cfProxyUpstreamId?: string;
	/** S3 fields, set when S3 tests run. */
	s3UpstreamId?: string;
	S3_FULL_AK?: string;
	S3_FULL_SK?: string;
	S3_RO_AK?: string;
	S3_RO_SK?: string;
}
