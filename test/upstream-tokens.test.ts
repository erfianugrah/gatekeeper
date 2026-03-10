import { SELF, env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { adminHeaders, ADMIN_KEY, UPSTREAM_HOST } from './helpers';

// --- Tests ---

describe('Upstream tokens — CRUD', () => {
	it('create -> list -> get -> delete -> verify gone (full lifecycle)', async () => {
		// --- Create ---
		const createRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'crud-test',
				token: 'cf-token-abcdef0123456789abcdef0123456789abcdef',
				zone_ids: ['*'],
				validate: false,
			}),
		});
		expect(createRes.status).toBe(200);
		const createData = await createRes.json<any>();
		expect(createData.success).toBe(true);
		expect(createData.result.id).toMatch(/^upt_/);
		expect(createData.result.name).toBe('crud-test');
		expect(createData.result.zone_ids).toBe('*');
		// preview: first 4 + "..." + last 4 = "cf-t...cdef"
		expect(createData.result.token_preview).toMatch(/^.{4}\.\.\..{4}$/);
		expect(createData.result.created_at).toBeGreaterThan(0);
		// Secret must never appear in response
		expect(createData.result.token).toBeUndefined();
		// No revoked field on upstream tokens
		expect(createData.result.revoked).toBeUndefined();
		const tokenId = createData.result.id;

		// --- List (includes created token) ---
		const listRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			headers: adminHeaders(),
		});
		expect(listRes.status).toBe(200);
		const listData = await listRes.json<any>();
		expect(listData.success).toBe(true);
		expect(Array.isArray(listData.result)).toBe(true);
		const found = listData.result.find((t: any) => t.id === tokenId);
		expect(found).toBeDefined();
		expect(found.name).toBe('crud-test');
		// Secret must never appear in list
		expect(found.token).toBeUndefined();

		// --- Get by ID ---
		const getRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			headers: adminHeaders(),
		});
		expect(getRes.status).toBe(200);
		const getData = await getRes.json<any>();
		expect(getData.success).toBe(true);
		expect(getData.result.id).toBe(tokenId);
		expect(getData.result.name).toBe('crud-test');
		expect(getData.result.token).toBeUndefined();

		// --- Delete ---
		const delRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delRes.status).toBe(200);
		const delData = await delRes.json<any>();
		expect(delData.result.deleted).toBe(true);

		// --- Delete already-deleted -> 404 ---
		const delAgainRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delAgainRes.status).toBe(404);

		// --- Verify gone ---
		const getAfterRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			headers: adminHeaders(),
		});
		expect(getAfterRes.status).toBe(404);
	});

	it('create token with specific zone_ids -> comma-separated storage', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'multi-zone',
				token: 'cf-multi-zone-token-1234567890abcdef1234567890ab',
				zone_ids: ['aaaa1111bbbb2222cccc3333dddd4444', 'eeee5555ffff6666aaaa7777bbbb8888'],
				validate: false,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.zone_ids).toBe('aaaa1111bbbb2222cccc3333dddd4444,eeee5555ffff6666aaaa7777bbbb8888');
	});

	it('get nonexistent token -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/upt_does_not_exist', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});

	it('delete nonexistent token -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/upt_does_not_exist', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});
});

describe('Upstream tokens — validation', () => {
	it('missing name -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				token: 'cf-token-abc123',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/name/i);
	});

	it('missing token -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'val-test',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/token/i);
	});

	it('missing zone_ids -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'val-test',
				token: 'cf-token-abc123',
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/zone_ids/i);
	});

	it('empty zone_ids array -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'val-test',
				token: 'cf-token-abc123',
				zone_ids: [],
			}),
		});
		expect(res.status).toBe(400);
	});

	it('zone_ids with non-string element -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'val-test',
				token: 'cf-token-abc123',
				zone_ids: [123],
			}),
		});
		expect(res.status).toBe(400);
	});

	it('invalid JSON body -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/json/i);
	});

	it('numeric name -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 12345,
				token: 'cf-token-abc123',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(400);
	});
});

describe('Upstream tokens — authentication', () => {
	it('no admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens');
		expect(res.status).toBe(401);
	});

	it('wrong admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			headers: { 'X-Admin-Key': 'wrong-key' },
		});
		expect(res.status).toBe(401);
	});

	it('create without admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'test', token: 'abc', zone_ids: ['*'] }),
		});
		expect(res.status).toBe(401);
	});
});

describe('Upstream tokens — bulk delete', () => {
	it('bulk-delete mix of existing and not-found', async () => {
		const c1 = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'bulk-d-1', token: 'cf-bulk-d1-token-1234567890abcdef1234567890ab', zone_ids: ['*'], validate: false }),
		});
		const t1 = (await c1.json<any>()).result.id;

		const c2 = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'bulk-d-2', token: 'cf-bulk-d2-token-1234567890abcdef1234567890ab', zone_ids: ['*'], validate: false }),
		});
		const t2 = (await c2.json<any>()).result.id;

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [t1, t2, 'upt_doesnotexist000000'], confirm_count: 3 }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.processed).toBe(3);

		const statuses = Object.fromEntries(data.result.results.map((r: any) => [r.id, r.status]));
		expect(statuses[t1]).toBe('deleted');
		expect(statuses[t2]).toBe('deleted');
		expect(statuses['upt_doesnotexist000000']).toBe('not_found');

		// Tokens should be gone
		const get1 = await SELF.fetch(`http://localhost/admin/upstream-tokens/${t1}`, { headers: adminHeaders() });
		expect(get1.status).toBe(404);
	});

	it('bulk-delete dry_run returns preview without modifying', async () => {
		const c1 = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'bulk-dry-d-1',
				token: 'cf-bulk-dryd-token-1234567890abcdef12345678',
				zone_ids: ['*'],
				validate: false,
			}),
		});
		const t1 = (await c1.json<any>()).result.id;

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [t1], confirm_count: 1, dry_run: true }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.dry_run).toBe(true);
		expect(data.result.items[0].would_become).toBe('deleted');

		// Token should still exist
		const getRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${t1}`, { headers: adminHeaders() });
		expect(getRes.status).toBe(200);
	});

	it('bulk-delete rejects confirm_count mismatch', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: ['upt_a', 'upt_b'], confirm_count: 5 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/confirm_count/);
	});

	it('bulk-delete rejects empty array', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [], confirm_count: 0 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/non-empty/);
	});

	it('bulk-delete rejects over 100 items', async () => {
		const ids = Array.from({ length: 101 }, (_, i) => `upt_${String(i).padStart(24, '0')}`);
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids, confirm_count: 101 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/100/);
	});
});

describe('Upstream tokens — created_by', () => {
	it('created_by from request body when no Access identity', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'created-by-test',
				token: 'cf-token-createdby-test-1234567890abcdef1234567890',
				zone_ids: ['*'],
				created_by: 'test@example.com',
				validate: false,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.created_by).toBe('unverified:test@example.com');
	});
});

// --- Upstream token validation (capability verification) ---

describe('Upstream tokens — validate on registration', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('valid token + wildcard zones -> verifies token + probes /zones -> no warnings', async () => {
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: '/client/v4/user/tokens/verify' })
			.reply(200, JSON.stringify({ success: true, result: { status: 'active' } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		// Wildcard zone probe
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: '/client/v4/zones?per_page=1' })
			.reply(200, JSON.stringify({ success: true, result: [], result_info: { total_count: 5 } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'validate-good-wildcard',
				token: 'cf-valid-token-1234567890abcdef1234567890abcdef',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upt_/);
		expect(data.warnings).toBeUndefined();
	});

	it('valid token + specific zone accessible -> no warnings', async () => {
		const zoneId = 'aaaa000011112222333344445555aaaa';

		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: '/client/v4/user/tokens/verify' })
			.reply(200, JSON.stringify({ success: true, result: { status: 'active' } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `/client/v4/zones/${zoneId}` })
			.reply(200, JSON.stringify({ success: true, result: { id: zoneId } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'validate-zone-ok',
				token: 'cf-valid-zone-token-1234567890abcdef1234567890ab',
				zone_ids: [zoneId],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.warnings).toBeUndefined();
	});

	it('valid token + specific zone inaccessible -> warning per zone', async () => {
		const zoneId = 'bbbb000011112222333344445555bbbb';

		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: '/client/v4/user/tokens/verify' })
			.reply(200, JSON.stringify({ success: true, result: { status: 'active' } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `/client/v4/zones/${zoneId}` })
			.reply(403, JSON.stringify({ success: false, errors: [{ code: 7003, message: 'No permissions' }] }), {
				headers: { 'Content-Type': 'application/json' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'validate-zone-fail',
				token: 'cf-zone-fail-token-1234567890abcdef1234567890abc',
				zone_ids: [zoneId],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upt_/);
		expect(data.warnings).toHaveLength(1);
		expect(data.warnings[0].message).toMatch(/token cannot access this zone/);
	});

	it('invalid token -> token verify warning, no zone probes', async () => {
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: '/client/v4/user/tokens/verify' })
			.reply(403, JSON.stringify({ success: false, errors: [{ code: 6003, message: 'Invalid request headers' }] }), {
				headers: { 'Content-Type': 'application/json' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'validate-bad',
				token: 'cf-invalid-token-1234567890abcdef1234567890abcdef',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upt_/);
		expect(data.result.name).toBe('validate-bad');
		// Only token verify warning — zone probes should be skipped
		expect(data.warnings).toHaveLength(1);
		expect(data.warnings[0].code).toBe(422);
		expect(data.warnings[0].message).toMatch(/Token validation failed/);
	});

	it('account-scoped + valid token + account accessible -> no warnings', async () => {
		const accountId = 'cccc000011112222333344445555cccc';

		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: '/client/v4/user/tokens/verify' })
			.reply(200, JSON.stringify({ success: true, result: { status: 'active' } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `/client/v4/accounts/${accountId}` })
			.reply(200, JSON.stringify({ success: true, result: { id: accountId } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'validate-account-ok',
				token: 'cf-acct-token-1234567890abcdef1234567890abcdefab',
				scope_type: 'account',
				zone_ids: [accountId],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.warnings).toBeUndefined();
	});

	it('account-scoped + account inaccessible -> warning', async () => {
		const accountId = 'dddd000011112222333344445555dddd';

		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: '/client/v4/user/tokens/verify' })
			.reply(200, JSON.stringify({ success: true, result: { status: 'active' } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `/client/v4/accounts/${accountId}` })
			.reply(403, JSON.stringify({ success: false, errors: [{ code: 1000, message: 'not authorized' }] }), {
				headers: { 'Content-Type': 'application/json' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'validate-account-fail',
				token: 'cf-acct-fail-token-1234567890abcdef1234567890abcd',
				scope_type: 'account',
				zone_ids: [accountId],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upt_/);
		expect(data.warnings).toHaveLength(1);
		expect(data.warnings[0].message).toMatch(/token cannot access this account/);
	});

	it('validate: false -> skips all probes, no warnings', async () => {
		// No fetchMock intercept — if validation fires, disableNetConnect would fail
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'no-validate',
				token: 'cf-no-validate-1234567890abcdef1234567890abcdef',
				zone_ids: ['*'],
				validate: false,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.warnings).toBeUndefined();
	});

	it('wildcard zones with 0 accessible -> warning', async () => {
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: '/client/v4/user/tokens/verify' })
			.reply(200, JSON.stringify({ success: true, result: { status: 'active' } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: '/client/v4/zones?per_page=1' })
			.reply(200, JSON.stringify({ success: true, result: [], result_info: { total_count: 0 } }), {
				headers: { 'Content-Type': 'application/json' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'validate-wildcard-empty',
				token: 'cf-wildcard-empty-1234567890abcdef1234567890abcd',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upt_/);
		expect(data.warnings).toHaveLength(1);
		expect(data.warnings[0].message).toMatch(/can access 0 zones/);
	});
});

// --- Resolution logic (Fix #1 — ORDER BY created_at DESC, exact vs wildcard) ---

describe('Upstream tokens — resolution', () => {
	// --- Constants ---
	const ZONE_A = 'aaaa000011112222333344445555aaaa';
	const ZONE_B = 'bbbb000011112222333344445555bbbb';
	const ZONE_UNREGISTERED = 'cccc000011112222333344445555cccc';

	const TOKEN_EXACT_A = 'cf-exact-a-token-1234567890abcdef1234567890abcd';
	const TOKEN_WILDCARD = 'cf-wildcard-token-1234567890abcdef1234567890ab';
	const TOKEN_NEWER_A = 'cf-newer-a-token-1234567890abcdef1234567890abcd';

	/** Get the DO stub for direct RPC calls. */
	function getStub() {
		return env.GATEKEEPER.get(env.GATEKEEPER.idFromName('account'));
	}

	/** Register an upstream token and return its ID. */
	async function registerToken(name: string, token: string, zoneIds: string[]): Promise<string> {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name, token, zone_ids: zoneIds, validate: false }),
		});
		const data = await res.json<any>();
		if (!data.success) throw new Error(`registerToken failed: ${JSON.stringify(data.errors)}`);
		return data.result.id;
	}

	/** Delete an upstream token by ID. */
	async function deleteToken(id: string): Promise<void> {
		await SELF.fetch(`http://localhost/admin/upstream-tokens/${id}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	}

	it('exact zone match -> returns matching token', async () => {
		const id = await registerToken('exact-match', TOKEN_EXACT_A, [ZONE_A]);
		try {
			const resolved = await getStub().resolveUpstreamToken(ZONE_A);
			expect(resolved).toBe(TOKEN_EXACT_A);
		} finally {
			await deleteToken(id);
		}
	});

	it('wildcard token -> returned for any zone', async () => {
		const id = await registerToken('wildcard', TOKEN_WILDCARD, ['*']);
		try {
			const resolved = await getStub().resolveUpstreamToken(ZONE_B);
			expect(resolved).toBe(TOKEN_WILDCARD);
		} finally {
			await deleteToken(id);
		}
	});

	it('exact match preferred over wildcard', async () => {
		const wcId = await registerToken('res-wildcard', TOKEN_WILDCARD, ['*']);
		const exactId = await registerToken('res-exact-a', TOKEN_EXACT_A, [ZONE_A]);
		try {
			// ZONE_A should resolve to the exact token, not the wildcard
			const resolvedA = await getStub().resolveUpstreamToken(ZONE_A);
			expect(resolvedA).toBe(TOKEN_EXACT_A);

			// ZONE_B has no exact match, so should fall back to the wildcard
			const resolvedB = await getStub().resolveUpstreamToken(ZONE_B);
			expect(resolvedB).toBe(TOKEN_WILDCARD);
		} finally {
			await deleteToken(exactId);
			await deleteToken(wcId);
		}
	});

	it('newest token wins when multiple claim the same zone', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
			const olderId = await registerToken('older-a', TOKEN_EXACT_A, [ZONE_A]);

			vi.setSystemTime(new Date('2025-06-01T00:00:00Z'));
			const newerId = await registerToken('newer-a', TOKEN_NEWER_A, [ZONE_A]);

			const resolved = await getStub().resolveUpstreamToken(ZONE_A);
			expect(resolved).toBe(TOKEN_NEWER_A);

			await deleteToken(newerId);
			await deleteToken(olderId);
		} finally {
			vi.useRealTimers();
		}
	});

	it('no match -> returns null', async () => {
		const resolved = await getStub().resolveUpstreamToken(ZONE_UNREGISTERED);
		expect(resolved).toBeNull();
	});

	it('deleted token -> no longer resolved', async () => {
		const id = await registerToken('delete-resolve', TOKEN_EXACT_A, [ZONE_A]);
		const before = await getStub().resolveUpstreamToken(ZONE_A);
		expect(before).toBe(TOKEN_EXACT_A);

		await deleteToken(id);
		const after = await getStub().resolveUpstreamToken(ZONE_A);
		expect(after).toBeNull();
	});

	it('multi-zone token covers all listed zones', async () => {
		const id = await registerToken('multi-zone-resolve', TOKEN_EXACT_A, [ZONE_A, ZONE_B]);
		try {
			expect(await getStub().resolveUpstreamToken(ZONE_A)).toBe(TOKEN_EXACT_A);
			expect(await getStub().resolveUpstreamToken(ZONE_B)).toBe(TOKEN_EXACT_A);
			expect(await getStub().resolveUpstreamToken(ZONE_UNREGISTERED)).toBeNull();
		} finally {
			await deleteToken(id);
		}
	});
});
