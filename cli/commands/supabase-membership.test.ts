import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supabaseMembershipCommand from './supabase-membership.js';

describe('supabase-membership events command', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('calls /admin/supabase/membership/events with filter query params', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, result: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await (supabaseMembershipCommand as any).subCommands.events.run({
			args: {
				endpoint: 'https://gate.example.com',
				'admin-key': 'test-admin-key',
				json: true,
				'org-slug': 'acme-org',
				'key-id': 'gw_test_key',
				action: 'supabase:members:invite',
				outcome: 'denied',
				'target-email': 'dev@corp.io',
				since: '1700000000001',
				until: '1700003600001',
				limit: '50',
			},
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.origin).toBe('https://gate.example.com');
		expect(url.pathname).toBe('/admin/supabase/membership/events');
		expect(url.searchParams.get('org_slug')).toBe('acme-org');
		expect(url.searchParams.get('key_id')).toBe('gw_test_key');
		expect(url.searchParams.get('action')).toBe('supabase:members:invite');
		expect(url.searchParams.get('outcome')).toBe('denied');
		expect(url.searchParams.get('target_email')).toBe('dev@corp.io');
		expect(url.searchParams.get('since')).toBe('1700000000001');
		expect(url.searchParams.get('until')).toBe('1700003600001');
		expect(url.searchParams.get('limit')).toBe('50');
	});

	it('renders non-JSON events output with role transitions', async () => {
		const created = Date.parse('2025-01-02T03:04:05.000Z');
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					result: [
						{
							created_at: created,
							outcome: 'preview',
							org_slug: 'acme-org',
							action: 'supabase:members:update_role',
							target_email: 'bump@corp.io',
							from_role: 'Read-Only',
							requested_role: 'Developer',
							created_by: 'key:sb-key',
						},
					],
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		vi.stubGlobal('fetch', fetchMock);

		await (supabaseMembershipCommand as any).subCommands.events.run({
			args: {
				endpoint: 'https://gate.example.com',
				'admin-key': 'test-admin-key',
			},
		});

		const stderr = vi
			.mocked(console.error)
			.mock.calls.map((call) => String(call[0] ?? ''))
			.join('\n');
		const expectedTs = new Date(created).toISOString().slice(0, 19).replace('T', ' ');

		expect(stderr).toContain('OUTCOME');
		expect(stderr).toContain('TARGET');
		expect(stderr).toContain('ROLE');
		expect(stderr).toContain(expectedTs);
		expect(stderr).toContain('Read-Only -> Developer');
		expect(stderr).toContain('1 event');
	});

	it('renders empty non-JSON events message', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, result: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await (supabaseMembershipCommand as any).subCommands.events.run({
			args: {
				endpoint: 'https://gate.example.com',
				'admin-key': 'test-admin-key',
			},
		});

		const stderr = vi
			.mocked(console.error)
			.mock.calls.map((call) => String(call[0] ?? ''))
			.join('\n');

		expect(stderr).toContain('No membership audit events found');
	});
});

describe('supabase-membership summary command', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('calls /admin/supabase/membership/summary and renders outcome breakdown', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					result: {
						total_events: 5,
						denied_count: 2,
						by_outcome: { preview: 2, denied: 2, noop: 1 },
						by_action: { 'supabase:members:invite': 4, 'supabase:members:update_role': 1 },
						by_org: { 'acme-org': 5 },
					},
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		vi.stubGlobal('fetch', fetchMock);

		await (supabaseMembershipCommand as any).subCommands.summary.run({
			args: {
				endpoint: 'https://gate.example.com',
				'admin-key': 'test-admin-key',
				'org-slug': 'acme-org',
			},
		});

		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.pathname).toBe('/admin/supabase/membership/summary');
		expect(url.searchParams.get('org_slug')).toBe('acme-org');

		const stderr = vi
			.mocked(console.error)
			.mock.calls.map((call) => String(call[0] ?? ''))
			.join('\n');

		expect(stderr).toContain('Total events');
		expect(stderr).toContain('Denied');
		expect(stderr).toContain('By outcome:');
		expect(stderr).toContain('preview');
		expect(stderr).toContain('denied');
		expect(stderr).toContain('By action:');
		expect(stderr).toContain('By org:');
		expect(stderr).toContain('acme-org');
	});
});
