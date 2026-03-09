import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getCachedConfig, invalidateConfigCache, __testClearConfigCache } from '../src/config-cache';
import type { GatewayConfig } from '../src/config-registry';

// --- Helpers ---

function makeStub(config: GatewayConfig) {
	return { getConfig: vi.fn().mockResolvedValue(config) };
}

const DEFAULT_CONFIG: GatewayConfig = {
	bulk_rate: 50,
	bulk_bucket_size: 500,
	bulk_max_ops: 100,
	single_rate: 3000,
	single_bucket_size: 6000,
	single_max_ops: 500,
	key_cache_ttl_ms: 60_000,
	retention_days: 30,
	s3_rps: 100,
	s3_burst: 200,
	cf_proxy_rps: 200,
	cf_proxy_burst: 400,
};

// --- Tests ---

describe('config-cache', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		__testClearConfigCache();
	});

	afterEach(() => {
		vi.useRealTimers();
		__testClearConfigCache();
	});

	it('cold cache -> calls stub.getConfig()', async () => {
		const stub = makeStub(DEFAULT_CONFIG);
		const config = await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledOnce();
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	it('warm cache -> returns cached value without calling stub', async () => {
		const stub = makeStub(DEFAULT_CONFIG);
		await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledOnce();

		// Second call should be cached
		const config2 = await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledOnce(); // still 1
		expect(config2).toEqual(DEFAULT_CONFIG);
	});

	it('cache expires after 30s TTL', async () => {
		const stub = makeStub(DEFAULT_CONFIG);
		await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledOnce();

		// Advance 29.9s — still cached
		vi.advanceTimersByTime(29_900);
		await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledOnce();

		// Advance past 30s boundary
		vi.advanceTimersByTime(200);
		await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledTimes(2);
	});

	it('invalidateConfigCache() forces re-fetch on next call', async () => {
		const stub = makeStub(DEFAULT_CONFIG);
		await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledOnce();

		invalidateConfigCache();

		await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledTimes(2);
	});

	it('returns updated config after invalidation', async () => {
		const stub = makeStub(DEFAULT_CONFIG);
		await getCachedConfig(stub);

		// Change config
		const updatedConfig = { ...DEFAULT_CONFIG, bulk_rate: 999 };
		stub.getConfig.mockResolvedValue(updatedConfig);

		// Still returns old cached value
		const cached = await getCachedConfig(stub);
		expect(cached.bulk_rate).toBe(50);

		// Invalidate and re-fetch
		invalidateConfigCache();
		const fresh = await getCachedConfig(stub);
		expect(fresh.bulk_rate).toBe(999);
	});

	it('__testClearConfigCache() clears state', async () => {
		const stub = makeStub(DEFAULT_CONFIG);
		await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledOnce();

		__testClearConfigCache();
		await getCachedConfig(stub);
		expect(stub.getConfig).toHaveBeenCalledTimes(2);
	});

	it('multiple sequential calls with warm cache -> single RPC', async () => {
		const stub = makeStub(DEFAULT_CONFIG);

		const c1 = await getCachedConfig(stub);
		const c2 = await getCachedConfig(stub);
		const c3 = await getCachedConfig(stub);

		expect(stub.getConfig).toHaveBeenCalledOnce();
		expect(c1).toEqual(DEFAULT_CONFIG);
		expect(c2).toEqual(DEFAULT_CONFIG);
		expect(c3).toEqual(DEFAULT_CONFIG);
	});
});
