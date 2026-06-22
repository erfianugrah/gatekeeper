import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supabaseAnalyticsCommand from './supabase-analytics.js';

describe('supabase-analytics timeseries command', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('calls /admin/supabase/analytics/timeseries with filter query params', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, result: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await (supabaseAnalyticsCommand as any).subCommands.timeseries.run({
			args: {
				endpoint: 'https://gate.example.com',
				'admin-key': 'test-admin-key',
				json: true,
				'project-ref': 'abcdefghijklmnopqrst',
				'key-id': 'gw_test_key',
				category: 'database',
				action: 'supabase:database:read',
				since: '1700000000001',
				until: '1700003600001',
			},
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.origin).toBe('https://gate.example.com');
		expect(url.pathname).toBe('/admin/supabase/analytics/timeseries');
		expect(url.searchParams.get('project_ref')).toBe('abcdefghijklmnopqrst');
		expect(url.searchParams.get('key_id')).toBe('gw_test_key');
		expect(url.searchParams.get('category')).toBe('database');
		expect(url.searchParams.get('action')).toBe('supabase:database:read');
		expect(url.searchParams.get('since')).toBe('1700000000001');
		expect(url.searchParams.get('until')).toBe('1700003600001');
	});

	it('renders non-JSON timeseries output with table headers and rows', async () => {
		const bucket = Date.parse('2025-01-02T03:04:05.000Z');
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, result: [{ bucket, count: 3, errors: 1 }] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await (supabaseAnalyticsCommand as any).subCommands.timeseries.run({
			args: {
				endpoint: 'https://gate.example.com',
				'admin-key': 'test-admin-key',
			},
		});

		const stderr = vi
			.mocked(console.error)
			.mock.calls.map((call) => String(call[0] ?? ''))
			.join('\n');
		const expectedTs = new Date(bucket).toISOString().slice(0, 19).replace('T', ' ');

		expect(stderr).toContain('TIME');
		expect(stderr).toContain('COUNT');
		expect(stderr).toContain('ERRORS');
		expect(stderr).toContain(expectedTs);
		expect(stderr).toContain('1 bucket');
	});

	it('renders empty non-JSON timeseries message', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, result: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await (supabaseAnalyticsCommand as any).subCommands.timeseries.run({
			args: {
				endpoint: 'https://gate.example.com',
				'admin-key': 'test-admin-key',
			},
		});

		const stderr = vi
			.mocked(console.error)
			.mock.calls.map((call) => String(call[0] ?? ''))
			.join('\n');

		expect(stderr).toContain('No Supabase proxy timeseries buckets found');
	});
});
