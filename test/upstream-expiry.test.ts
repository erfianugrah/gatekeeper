import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { adminHeaders } from './helpers';
import worker from '../src/index';

// ─── Upstream Token Expiry ──────────────────────────────────────────────────

describe('Upstream tokens — expiry', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('create with expires_in_days -> sets expires_at in response', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'expiry-test',
				token: 'cf-expiry-test-token-1234567890abcdef1234567890',
				zone_ids: ['*'],
				expires_in_days: 30,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);

		const expected = new Date('2026-01-01T00:00:00Z').getTime() + 30 * 24 * 60 * 60 * 1000;
		expect(data.result.expires_at).toBe(expected);

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-tokens/${data.result.id}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('create without expires_in_days -> null expires_at', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'no-expiry',
				token: 'cf-no-expiry-token-1234567890abcdef1234567890ab',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.expires_at).toBeNull();

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-tokens/${data.result.id}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('expired token -> resolution skips it', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const ZONE = 'aaaa000011112222333344445555eeee';

		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'expire-resolve-test',
				token: 'cf-expire-resolve-token-1234567890abcdef12345678',
				zone_ids: [ZONE],
				expires_in_days: 1,
			}),
		});
		const data = await res.json<any>();
		const tokenId = data.result.id;

		// Token should resolve now (not expired yet)
		const stub = env.GATEKEEPER.get(env.GATEKEEPER.idFromName('account'));
		const resolvedBefore = await stub.resolveUpstreamToken(ZONE);
		expect(resolvedBefore).toBe('cf-expire-resolve-token-1234567890abcdef12345678');

		// Advance time past expiry
		vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));

		const resolvedAfter = await stub.resolveUpstreamToken(ZONE);
		expect(resolvedAfter).toBeNull();

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('PATCH update name -> 200', async () => {
		const createRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'patch-name-test',
				token: 'cf-patch-name-token-1234567890abcdef1234567890ab',
				zone_ids: ['*'],
			}),
		});
		const tokenId = (await createRes.json<any>()).result.id;

		const patchRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'patched-name' }),
		});
		expect(patchRes.status).toBe(200);
		const patchData = await patchRes.json<any>();
		expect(patchData.success).toBe(true);
		expect(patchData.result.name).toBe('patched-name');

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('PATCH update expires_at -> 200', async () => {
		const createRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'patch-expiry-test',
				token: 'cf-patch-expiry-token-1234567890abcdef12345678ab',
				zone_ids: ['*'],
			}),
		});
		const tokenId = (await createRes.json<any>()).result.id;

		const futureTs = Date.now() + 90 * 24 * 60 * 60 * 1000;
		const patchRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ expires_at: futureTs }),
		});
		expect(patchRes.status).toBe(200);
		const patchData = await patchRes.json<any>();
		expect(patchData.result.expires_at).toBe(futureTs);

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('PATCH clear expires_at -> null', async () => {
		const createRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'patch-clear-expiry',
				token: 'cf-patch-clear-token-1234567890abcdef1234567890',
				zone_ids: ['*'],
				expires_in_days: 30,
			}),
		});
		const createData = await createRes.json<any>();
		const tokenId = createData.result.id;
		expect(createData.result.expires_at).not.toBeNull();

		const patchRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ expires_at: null }),
		});
		expect(patchRes.status).toBe(200);
		const patchData = await patchRes.json<any>();
		expect(patchData.result.expires_at).toBeNull();

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('PATCH nonexistent -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/upt_doesnotexist12345', {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'nope' }),
		});
		expect(res.status).toBe(404);
	});

	it('PATCH empty body -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/upt_whatever', {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});

// ─── Upstream R2 Expiry ─────────────────────────────────────────────────────

describe('Upstream R2 — expiry', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('create with expires_in_days -> sets expires_at in response', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));

		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-expiry-test',
				access_key_id: 'R2EXPIRYACCESSKEYID123',
				secret_access_key: 'r2expirysecretaccesskey1234567890abcdef1234567890abcdef1234567890',
				endpoint: 'https://expiry.r2.cloudflarestorage.com',
				bucket_names: ['*'],
				expires_in_days: 14,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);

		const expected = new Date('2026-03-01T00:00:00Z').getTime() + 14 * 24 * 60 * 60 * 1000;
		expect(data.result.expires_at).toBe(expected);

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-r2/${data.result.id}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('create without expires_in_days -> null expires_at', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-no-expiry',
				access_key_id: 'R2NOEXPIRYACCESSKEYI1',
				secret_access_key: 'r2noexpirysecretaccesskey1234567890abcdef1234567890abcdef12345678',
				endpoint: 'https://noexpiry.r2.cloudflarestorage.com',
				bucket_names: ['*'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.expires_at).toBeNull();

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-r2/${data.result.id}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('expired R2 endpoint -> resolution skips it', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const BUCKET = 'expire-test-bucket';

		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-expire-resolve',
				access_key_id: 'R2EXPIRERESOLVEACCESS',
				secret_access_key: 'r2expireresolvesecretaccesskey1234567890abcdef1234567890abcdef1234',
				endpoint: 'https://expire-resolve.r2.cloudflarestorage.com',
				bucket_names: [BUCKET],
				expires_in_days: 1,
			}),
		});
		const data = await res.json<any>();
		const endpointId = data.result.id;

		// Should resolve now
		const stub = env.GATEKEEPER.get(env.GATEKEEPER.idFromName('account'));
		const before = await stub.resolveR2ForBucket(BUCKET);
		expect(before).not.toBeNull();
		expect(before!.accessKeyId).toBe('R2EXPIRERESOLVEACCESS');

		// Advance past expiry
		vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));

		const after = await stub.resolveR2ForBucket(BUCKET);
		expect(after).toBeNull();

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('PATCH update name -> 200', async () => {
		const createRes = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-patch-name',
				access_key_id: 'R2PATCHNAMEACCESSKEY1',
				secret_access_key: 'r2patchnamesecretaccesskey1234567890abcdef1234567890abcdef12345678',
				endpoint: 'https://patchname.r2.cloudflarestorage.com',
				bucket_names: ['*'],
			}),
		});
		const endpointId = (await createRes.json<any>()).result.id;

		const patchRes = await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'r2-patched-name' }),
		});
		expect(patchRes.status).toBe(200);
		const patchData = await patchRes.json<any>();
		expect(patchData.result.name).toBe('r2-patched-name');

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('PATCH update expires_at -> 200', async () => {
		const createRes = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-patch-expiry',
				access_key_id: 'R2PATCHEXPIRYACCESSK1',
				secret_access_key: 'r2patchexpirysecretaccesskey1234567890abcdef1234567890abcdef123456',
				endpoint: 'https://patchexpiry.r2.cloudflarestorage.com',
				bucket_names: ['*'],
			}),
		});
		const endpointId = (await createRes.json<any>()).result.id;

		const futureTs = Date.now() + 90 * 24 * 60 * 60 * 1000;
		const patchRes = await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ expires_at: futureTs }),
		});
		expect(patchRes.status).toBe(200);
		const patchData = await patchRes.json<any>();
		expect(patchData.result.expires_at).toBe(futureTs);

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});

	it('PATCH nonexistent -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2/upr2_doesnotexist1234', {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'nope' }),
		});
		expect(res.status).toBe(404);
	});

	it('PATCH empty body -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2/upr2_whatever', {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});

// ─── Cleanup cron (expired entities) ────────────────────────────────────────

describe('scheduled() expired entity cleanup', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('cleans up expired upstream tokens and R2 endpoints', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

		// Create token that expires in 1 day
		const tokenRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'cleanup-token',
				token: 'cf-cleanup-token-1234567890abcdef1234567890abcd',
				zone_ids: ['*'],
				expires_in_days: 1,
			}),
		});
		const tokenId = (await tokenRes.json<any>()).result.id;

		// Create R2 endpoint that expires in 1 day
		const r2Res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'cleanup-r2',
				access_key_id: 'CLEANUPACCESSKEYID123',
				secret_access_key: 'cleanupsecretaccesskey1234567890abcdef1234567890abcdef1234567890',
				endpoint: 'https://cleanup.r2.cloudflarestorage.com',
				bucket_names: ['*'],
				expires_in_days: 1,
			}),
		});
		const r2Id = (await r2Res.json<any>()).result.id;

		// Both should exist
		const getToken = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, { headers: adminHeaders() });
		expect(getToken.status).toBe(200);
		const getR2 = await SELF.fetch(`http://localhost/admin/upstream-r2/${r2Id}`, { headers: adminHeaders() });
		expect(getR2.status).toBe(200);

		// Advance time past expiry
		vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));

		// Run the scheduled handler
		const controller: ScheduledController = {
			cron: '0 3 * * *',
			scheduledTime: Date.now(),
			noRetry: vi.fn(),
		};

		await worker.scheduled(controller, env, {
			waitUntil: vi.fn(),
			passThroughOnException: vi.fn(),
			abort: vi.fn() as any,
			props: undefined as any,
		} as unknown as ExecutionContext);

		// Expired upstream tokens are hard-deleted, not soft-revoked
		const getTokenAfter = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, { headers: adminHeaders() });
		expect(getTokenAfter.status).toBe(404);

		// Expired R2 endpoints are hard-deleted
		const getR2After = await SELF.fetch(`http://localhost/admin/upstream-r2/${r2Id}`, { headers: adminHeaders() });
		expect(getR2After.status).toBe(404);
	});

	it('non-expired entities are NOT cleaned up', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

		// Create token that expires in 90 days
		const tokenRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'keep-token',
				token: 'cf-keep-token-1234567890abcdef1234567890abcdef',
				zone_ids: ['*'],
				expires_in_days: 90,
			}),
		});
		const tokenId = (await tokenRes.json<any>()).result.id;

		// Advance only 1 day (token still has 89 days)
		vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));

		const controller: ScheduledController = {
			cron: '0 3 * * *',
			scheduledTime: Date.now(),
			noRetry: vi.fn(),
		};

		await worker.scheduled(controller, env, {
			waitUntil: vi.fn(),
			passThroughOnException: vi.fn(),
			abort: vi.fn() as any,
			props: undefined as any,
		} as unknown as ExecutionContext);

		// Token should still exist
		const getToken = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, { headers: adminHeaders() });
		expect(getToken.status).toBe(200);

		// Cleanup
		await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	});
});
