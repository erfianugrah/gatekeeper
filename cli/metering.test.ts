import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import meteringCommand from './commands/metering.js';

describe('metering command', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('calls /admin/metering when no --surface is given', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, result: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await (meteringCommand as any).run({
			args: {
				endpoint: 'https://gate.example.com',
				'admin-key': 'test-admin-key',
				json: true,
				since: '1700000000001',
				limit: '50',
			},
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.origin).toBe('https://gate.example.com');
		expect(url.pathname).toBe('/admin/metering');
		expect(url.searchParams.get('since')).toBe('1700000000001');
		expect(url.searchParams.get('limit')).toBe('50');
	});

	it('calls /admin/supabase/analytics/metering when --surface supabase is given', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, result: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await (meteringCommand as any).run({
			args: {
				endpoint: 'https://gate.example.com',
				'admin-key': 'test-admin-key',
				json: true,
				surface: 'supabase',
				'group-by': 'project',
			},
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.origin).toBe('https://gate.example.com');
		expect(url.pathname).toBe('/admin/supabase/analytics/metering');
		expect(url.searchParams.get('group_by')).toBe('project');
	});
});
