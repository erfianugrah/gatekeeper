/**
 * Tests for named, revocable admin API tokens (gka_...).
 *
 * Covers:
 *   - Manager RPC via the DO stub: create / verify / list / revoke / expiry
 *   - The 4th admin-auth path: gka_ token via X-Admin-Key and Authorization: Bearer
 *   - Route CRUD + RBAC (admin-only) + show-once semantics
 *   - Token role is honoured (a viewer token cannot write)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ADMIN_KEY, adminHeaders } from './helpers';

import type { Gatekeeper } from '../src/durable-object';

function getStub(): DurableObjectStub<Gatekeeper> {
	return env.GATEKEEPER.get(env.GATEKEEPER.idFromName('account'));
}

const createdIds: string[] = [];

afterEach(async () => {
	const stub = getStub();
	for (const id of createdIds.splice(0)) {
		await stub.deleteAdminToken(id);
	}
});

// ─── Manager RPC (via DO stub) ──────────────────────────────────────────────

describe('AdminTokenManager RPC', () => {
	it('creates a token and verifies it, returning role', async () => {
		const stub = getStub();
		const { token, record } = await stub.createAdminToken({ name: 'ci-token', role: 'operator', createdBy: 'tester' });
		createdIds.push(record.id);

		expect(token).toMatch(/^gka_[a-f0-9]{64}$/);
		expect(record.id).toMatch(/^atk_[a-f0-9]{16}$/);
		expect(record.role).toBe('operator');
		expect(record.token_preview).toContain('...');
		// The record must never carry the raw token or its hash.
		expect((record as any).token).toBeUndefined();
		expect((record as any).token_hash).toBeUndefined();

		const auth = await stub.verifyAdminToken(token);
		expect(auth).not.toBeNull();
		expect(auth!.role).toBe('operator');
		expect(auth!.name).toBe('ci-token');
	});

	it('rejects unknown, malformed, and revoked tokens', async () => {
		const stub = getStub();
		expect(await stub.verifyAdminToken('gka_deadbeef')).toBeNull(); // unknown hash
		expect(await stub.verifyAdminToken('not-a-token')).toBeNull(); // wrong prefix

		const { token, record } = await stub.createAdminToken({ name: 'revoke-me', role: 'admin' });
		createdIds.push(record.id);
		expect(await stub.verifyAdminToken(token)).not.toBeNull();

		expect(await stub.revokeAdminToken(record.id)).toBe(true);
		expect(await stub.verifyAdminToken(token)).toBeNull(); // revoked
		expect(await stub.revokeAdminToken(record.id)).toBe(false); // already revoked
	});

	it('rejects an expired token', async () => {
		const stub = getStub();
		const { token, record } = await stub.createAdminToken({ name: 'expired', role: 'admin', expiresAt: Date.now() - 1000 });
		createdIds.push(record.id);
		expect(await stub.verifyAdminToken(token)).toBeNull();
	});

	it('lists tokens without exposing secrets', async () => {
		const stub = getStub();
		const { record } = await stub.createAdminToken({ name: 'listed', role: 'viewer' });
		createdIds.push(record.id);
		const list = await stub.listAdminTokens();
		const found = list.find((t) => t.id === record.id);
		expect(found).toBeDefined();
		expect((found as any).token).toBeUndefined();
		expect((found as any).token_hash).toBeUndefined();
	});
});

// ─── Auth path: gka_ token authenticates to /admin ──────────────────────────

describe('admin-auth: gka_ token', () => {
	it('authenticates via X-Admin-Key header (CLI-compatible)', async () => {
		const stub = getStub();
		const { token, record } = await stub.createAdminToken({ name: 'via-header', role: 'admin' });
		createdIds.push(record.id);

		const res = await SELF.fetch('http://localhost/admin/me', { headers: { 'X-Admin-Key': token } });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.role).toBe('admin');
		expect(data.result.authMethod).toBe('api-token');
		expect(data.result.logoutUrl).toBeNull();
	});

	it('authenticates via Authorization: Bearer header', async () => {
		const stub = getStub();
		const { token, record } = await stub.createAdminToken({ name: 'via-bearer', role: 'viewer' });
		createdIds.push(record.id);

		const res = await SELF.fetch('http://localhost/admin/me', { headers: { Authorization: `Bearer ${token}` } });
		expect(res.status).toBe(200);
		expect((await res.json<any>()).result.role).toBe('viewer');
	});

	it('honours the token role: a viewer token cannot write, an operator token can', async () => {
		const stub = getStub();
		const { token: viewerToken, record: v } = await stub.createAdminToken({ name: 'v', role: 'viewer' });
		const { token: opToken, record: o } = await stub.createAdminToken({ name: 'o', role: 'operator' });
		createdIds.push(v.id, o.id);

		// Viewer can read keys, but not create one (write needs operator).
		expect((await SELF.fetch('http://localhost/admin/keys', { headers: { 'X-Admin-Key': viewerToken } })).status).toBe(200);
		const viewerCreate = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: { 'X-Admin-Key': viewerToken, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'nope', zone_id: 'z' }),
		});
		expect(viewerCreate.status).toBe(403);

		// Operator token reaches the keys write handler (not a 403 from RBAC).
		const opCreate = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: { 'X-Admin-Key': opToken, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'nope', zone_id: 'z' }),
		});
		expect(opCreate.status).not.toBe(403);
	});

	it('a revoked token no longer authenticates over HTTP', async () => {
		const stub = getStub();
		const { token, record } = await stub.createAdminToken({ name: 'http-revoke', role: 'admin' });
		createdIds.push(record.id);
		expect((await SELF.fetch('http://localhost/admin/me', { headers: { 'X-Admin-Key': token } })).status).toBe(200);
		await stub.revokeAdminToken(record.id);
		expect((await SELF.fetch('http://localhost/admin/me', { headers: { 'X-Admin-Key': token } })).status).toBe(401);
	});
});

// ─── Route CRUD + RBAC ──────────────────────────────────────────────────────

describe('/admin/tokens routes', () => {
	it('creates a token (value shown once), lists it, then revokes it', async () => {
		// Create
		const createRes = await SELF.fetch('http://localhost/admin/tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'route-token', role: 'operator', expires_in_days: 30 }),
		});
		expect(createRes.status).toBe(201);
		const created = await createRes.json<any>();
		expect(created.result.token).toMatch(/^gka_[a-f0-9]{64}$/);
		expect(created.result.role).toBe('operator');
		expect(created.result.expires_at).toBeGreaterThan(Date.now());
		const id = created.result.id as string;
		createdIds.push(id);

		// List (no token value)
		const listRes = await SELF.fetch('http://localhost/admin/tokens', { headers: adminHeaders() });
		const list = await listRes.json<any>();
		const row = list.result.find((t: any) => t.id === id);
		expect(row).toBeDefined();
		expect(row.token).toBeUndefined();

		// Revoke
		const delRes = await SELF.fetch(`http://localhost/admin/tokens/${id}`, { method: 'DELETE', headers: adminHeaders() });
		expect(delRes.status).toBe(200);
		// Second revoke -> 404
		expect((await SELF.fetch(`http://localhost/admin/tokens/${id}`, { method: 'DELETE', headers: adminHeaders() })).status).toBe(404);
	});

	it('validates name, role, and expiry', async () => {
		const noName = await SELF.fetch('http://localhost/admin/tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ role: 'admin' }),
		});
		expect(noName.status).toBe(400);

		const badRole = await SELF.fetch('http://localhost/admin/tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'x', role: 'superuser' }),
		});
		expect(badRole.status).toBe(400);

		const pastExpiry = await SELF.fetch('http://localhost/admin/tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'x', expires_at: Date.now() - 1000 }),
		});
		expect(pastExpiry.status).toBe(400);
	});

	it('requires admin role: no auth -> 401', async () => {
		expect((await SELF.fetch('http://localhost/admin/tokens')).status).toBe(401);
	});

	it('a non-admin token cannot manage tokens (403)', async () => {
		const stub = getStub();
		const { token, record } = await stub.createAdminToken({ name: 'op-cannot-manage', role: 'operator' });
		createdIds.push(record.id);
		const res = await SELF.fetch('http://localhost/admin/tokens', { headers: { 'X-Admin-Key': token } });
		expect(res.status).toBe(403);
	});
});
