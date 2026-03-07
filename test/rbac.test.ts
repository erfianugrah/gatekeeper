import { describe, it, expect } from 'vitest';
import { resolveRole } from '../src/auth-admin';
import { SELF } from 'cloudflare:test';
import { adminHeaders } from './helpers';

// --- Unit tests for resolveRole ---

describe('RBAC — resolveRole', () => {
	/** Build a minimal Env-like object with RBAC vars. */
	function fakeEnv(rbac?: { admin?: string; operator?: string; viewer?: string }): Env {
		return {
			RBAC_ADMIN_GROUPS: rbac?.admin,
			RBAC_OPERATOR_GROUPS: rbac?.operator,
			RBAC_VIEWER_GROUPS: rbac?.viewer,
		} as unknown as Env;
	}

	it('no RBAC vars -> all users get admin (backward compatible)', () => {
		expect(resolveRole([], fakeEnv())).toBe('admin');
		expect(resolveRole(['any-group'], fakeEnv())).toBe('admin');
	});

	it('user in admin group -> admin', () => {
		expect(resolveRole(['team-admins'], fakeEnv({ admin: 'team-admins' }))).toBe('admin');
	});

	it('user in operator group -> operator', () => {
		expect(resolveRole(['deployers'], fakeEnv({ admin: 'team-admins', operator: 'deployers' }))).toBe('operator');
	});

	it('user in viewer group -> viewer', () => {
		expect(resolveRole(['readonly'], fakeEnv({ admin: 'team-admins', operator: 'deployers', viewer: 'readonly' }))).toBe('viewer');
	});

	it('user in multiple groups -> highest role wins', () => {
		const env = fakeEnv({ admin: 'team-admins', operator: 'deployers', viewer: 'readonly' });
		expect(resolveRole(['readonly', 'deployers'], env)).toBe('operator');
		expect(resolveRole(['readonly', 'team-admins'], env)).toBe('admin');
		expect(resolveRole(['deployers', 'team-admins'], env)).toBe('admin');
	});

	it('user with no matching group -> null (denied)', () => {
		const env = fakeEnv({ admin: 'team-admins', operator: 'deployers' });
		expect(resolveRole([], env)).toBeNull();
		expect(resolveRole(['marketing'], env)).toBeNull();
	});

	it('comma-separated groups in env var', () => {
		const env = fakeEnv({ admin: 'admins, super-admins', operator: 'ops,deployers' });
		expect(resolveRole(['super-admins'], env)).toBe('admin');
		expect(resolveRole(['deployers'], env)).toBe('operator');
		expect(resolveRole(['ops'], env)).toBe('operator');
	});

	it('only viewer groups configured -> non-viewers denied', () => {
		const env = fakeEnv({ viewer: 'readonly' });
		expect(resolveRole(['readonly'], env)).toBe('viewer');
		expect(resolveRole(['other'], env)).toBeNull();
	});
});

// --- Integration: X-Admin-Key always gets admin role ---

describe('RBAC — X-Admin-Key bypasses RBAC', () => {
	it('X-Admin-Key can access upstream-tokens (admin-only route)', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
	});

	it('X-Admin-Key can access config (admin-only for writes)', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
	});

	it('X-Admin-Key can write config (admin-only write)', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ retention_days: 30 }),
		});
		expect(res.status).toBe(200);
	});
});
