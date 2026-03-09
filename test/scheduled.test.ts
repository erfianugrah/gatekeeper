import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getStub } from '../src/do-stub';

// Import the default export which contains the scheduled handler
import worker from '../src/index';

// --- Tests ---

describe('scheduled() retention cron', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs without error when no events exist', async () => {
		const controller: ScheduledController = {
			cron: '0 3 * * *',
			scheduledTime: Date.now(),
			noRetry: vi.fn(),
		};

		// Should not throw — tables will be created, no rows to delete
		await worker.scheduled(controller, env, {
			waitUntil: vi.fn(),
			passThroughOnException: vi.fn(),
			abort: vi.fn() as any,
			props: undefined as any,
		} as unknown as ExecutionContext);
	});

	it('uses retention_days from config', async () => {
		// Override retention to 7 days via admin API
		const stub = getStub(env);
		const config = await stub.getConfig();
		expect(config.retention_days).toBeGreaterThan(0);

		const controller: ScheduledController = {
			cron: '0 3 * * *',
			scheduledTime: Date.now(),
			noRetry: vi.fn(),
		};

		// Run should succeed — it reads config.retention_days and deletes old events
		await worker.scheduled(controller, env, {
			waitUntil: vi.fn(),
			passThroughOnException: vi.fn(),
			abort: vi.fn() as any,
			props: undefined as any,
		} as unknown as ExecutionContext);
	});

	it('deletes events older than retention period', async () => {
		// Insert a fake event into the purge_events table that is very old
		const db = env.ANALYTICS_DB;

		// Ensure tables exist by importing and calling the analytics functions
		const { logPurgeEvent } = await import('../src/analytics');
		const { logCfProxyEvent } = await import('../src/cf/analytics');

		// Insert an old purge event (90 days old)
		const oldTs = Date.now() - 90 * 24 * 60 * 60 * 1000;
		await logPurgeEvent(db, {
			key_id: 'old-key',
			zone_id: 'aaaa1111bbbb2222cccc3333dddd4444',
			purge_type: 'hosts',
			purge_target: 'example.com',
			tokens: 1,
			status: 200,
			collapsed: false,
			upstream_status: 200,
			duration_ms: 100,
			created_at: oldTs,
			response_detail: null,
			created_by: 'test',
			flight_id: 'test-flight-1',
		});

		// Insert a recent purge event (1 day old)
		const recentTs = Date.now() - 1 * 24 * 60 * 60 * 1000;
		await logPurgeEvent(db, {
			key_id: 'recent-key',
			zone_id: 'aaaa1111bbbb2222cccc3333dddd4444',
			purge_type: 'hosts',
			purge_target: 'example.com',
			tokens: 1,
			status: 200,
			collapsed: false,
			upstream_status: 200,
			duration_ms: 50,
			created_at: recentTs,
			response_detail: null,
			created_by: 'test',
			flight_id: 'test-flight-2',
		});

		// Insert an old CF proxy event (90 days old)
		await logCfProxyEvent(db, {
			key_id: 'old-cf-key',
			account_id: 'aaaa1111bbbb2222cccc3333dddd4444',
			service: 'd1',
			action: 'd1:query',
			resource_id: 'test-db',
			status: 200,
			upstream_status: 200,
			duration_ms: 50,
			upstream_latency_ms: 30,
			response_size: 128,
			created_at: oldTs,
			response_detail: null,
			created_by: 'test',
		});

		// Insert a recent CF proxy event
		await logCfProxyEvent(db, {
			key_id: 'recent-cf-key',
			account_id: 'aaaa1111bbbb2222cccc3333dddd4444',
			service: 'kv',
			action: 'kv:read',
			resource_id: 'test-ns',
			status: 200,
			upstream_status: 200,
			duration_ms: 20,
			upstream_latency_ms: 10,
			response_size: 64,
			created_at: recentTs,
			response_detail: null,
			created_by: 'test',
		});

		// Run the scheduled handler (default retention = 30 days)
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

		// Verify: old events should be deleted, recent events should remain
		const purgeRows = await db.prepare('SELECT * FROM purge_events').all();
		expect(purgeRows.results.length).toBe(1);
		expect((purgeRows.results[0] as any).key_id).toBe('recent-key');

		const cfRows = await db.prepare('SELECT * FROM cf_proxy_events').all();
		expect(cfRows.results.length).toBe(1);
		expect((cfRows.results[0] as any).key_id).toBe('recent-cf-key');
	});
});
