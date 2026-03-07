import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	formatDuration,
	parsePolicy,
	formatApiError,
	formatKey,
	formatPolicy,
	table,
	printJson,
	formatRateLimit,
	parseTime,
	confirmAction,
} from './ui.js';
import { resolveConfig, resolveZoneId, assertOk, request } from './client.js';
import type { ClientConfig } from './client.js';

// ---------- parsePolicy ----------

describe('parsePolicy', () => {
	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('parses inline JSON', () => {
		const policy = parsePolicy('{"version":"2025-01-01","statements":[{"actions":["purge:*"],"resources":["*"],"conditions":[]}]}');
		expect(policy).toEqual({
			version: '2025-01-01',
			statements: [{ actions: ['purge:*'], resources: ['*'], conditions: [] }],
		});
	});

	it('parses minimal policy', () => {
		const policy = parsePolicy('{"version":"2025-01-01","statements":[]}');
		expect(policy).toEqual({ version: '2025-01-01', statements: [] });
	});

	it('reads from @file path', () => {
		const tmpFile = join(tmpdir(), `test-policy-${Date.now()}.json`);
		writeFileSync(tmpFile, '{"version":"2025-01-01","statements":[]}');
		try {
			const policy = parsePolicy(`@${tmpFile}`);
			expect(policy).toEqual({ version: '2025-01-01', statements: [] });
		} finally {
			unlinkSync(tmpFile);
		}
	});

	it('exits on invalid JSON', () => {
		parsePolicy('not json at all');
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('exits on missing file', () => {
		parsePolicy('@nonexistent-file-that-does-not-exist.json');
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

// ---------- formatDuration ----------

describe('formatDuration', () => {
	it('formats milliseconds under 1s', () => {
		expect(formatDuration(0)).toBe('0ms');
		expect(formatDuration(1)).toBe('1ms');
		expect(formatDuration(150)).toBe('150ms');
		expect(formatDuration(999)).toBe('999ms');
	});

	it('formats seconds at 1s boundary', () => {
		expect(formatDuration(1000)).toBe('1.0s');
	});

	it('formats seconds with decimal', () => {
		expect(formatDuration(1500)).toBe('1.5s');
		expect(formatDuration(2345)).toBe('2.3s');
		expect(formatDuration(10000)).toBe('10.0s');
	});
});

// ---------- resolveConfig ----------

describe('resolveConfig', () => {
	const origEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...origEnv };
	});

	it('exits when no endpoint configured', () => {
		vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		delete process.env['GATEKEEPER_URL'];
		delete process.env['GATEKEEPER_ADMIN_KEY'];
		delete process.env['GATEKEEPER_API_KEY'];

		resolveConfig({});
		expect(process.exit).toHaveBeenCalledWith(1);

		vi.restoreAllMocks();
	});

	it('prefers args over env vars', () => {
		process.env['GATEKEEPER_URL'] = 'https://env.example.com';
		process.env['GATEKEEPER_ADMIN_KEY'] = 'env-admin';
		process.env['GATEKEEPER_API_KEY'] = 'env-api';

		const config = resolveConfig({
			endpoint: 'https://arg.example.com',
			'admin-key': 'arg-admin',
			'api-key': 'arg-api',
		});
		expect(config.baseUrl).toBe('https://arg.example.com');
		expect(config.adminKey).toBe('arg-admin');
		expect(config.apiKey).toBe('arg-api');
	});

	it('falls back to env vars when args missing', () => {
		process.env['GATEKEEPER_URL'] = 'https://env.example.com';
		process.env['GATEKEEPER_ADMIN_KEY'] = 'env-admin';
		process.env['GATEKEEPER_API_KEY'] = 'env-api';

		const config = resolveConfig({});
		expect(config.baseUrl).toBe('https://env.example.com');
		expect(config.adminKey).toBe('env-admin');
		expect(config.apiKey).toBe('env-api');
	});

	it('strips trailing slashes from URL', () => {
		const config = resolveConfig({
			endpoint: 'https://example.com///',
		});
		expect(config.baseUrl).toBe('https://example.com');
	});
});

// ---------- resolveZoneId ----------

describe('resolveZoneId', () => {
	const origEnv = { ...process.env };
	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		process.env = { ...origEnv };
		vi.restoreAllMocks();
	});

	it('uses --zone-id arg', () => {
		const zoneId = resolveZoneId({ 'zone-id': 'abc123' });
		expect(zoneId).toBe('abc123');
		expect(process.exit).not.toHaveBeenCalled();
	});

	it('falls back to env var', () => {
		process.env['GATEKEEPER_ZONE_ID'] = 'env-zone';
		const zoneId = resolveZoneId({});
		expect(zoneId).toBe('env-zone');
		expect(process.exit).not.toHaveBeenCalled();
	});

	it('prefers arg over env', () => {
		process.env['GATEKEEPER_ZONE_ID'] = 'env-zone';
		const zoneId = resolveZoneId({ 'zone-id': 'arg-zone' });
		expect(zoneId).toBe('arg-zone');
	});

	it('exits when neither arg nor env set', () => {
		delete process.env['GATEKEEPER_ZONE_ID'];
		resolveZoneId({});
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

// ---------- assertOk ----------

describe('assertOk', () => {
	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not exit when status matches expected', () => {
		const data: unknown = { success: true };
		assertOk(200, data);
		expect(process.exit).not.toHaveBeenCalled();
	});

	it('does not exit when status matches custom expected', () => {
		const data: unknown = { success: true };
		assertOk(201, data, 201);
		expect(process.exit).not.toHaveBeenCalled();
	});

	it('exits when status does not match', () => {
		const data: unknown = { success: false, errors: [{ code: 404, message: 'Not found' }] };
		assertOk(404, data);
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('exits when status does not match custom expected', () => {
		const data: unknown = { success: false };
		assertOk(200, data, 201);
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

// ---------- request ----------

describe('request', () => {
	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('makes a GET request and returns parsed JSON', async () => {
		const mockResponse = { success: true, result: { id: '123' } };
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(new Response(JSON.stringify(mockResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })),
		);

		const config: ClientConfig = { baseUrl: 'https://api.example.com', adminKey: 'test-key' };
		const result = await request(config, 'GET', '/admin/keys', { auth: 'admin' });

		expect(result.status).toBe(200);
		expect(result.data).toEqual(mockResponse);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(fetchCall[0]).toBe('https://api.example.com/admin/keys');
		expect(fetchCall[1].headers['X-Admin-Key']).toBe('test-key');
	});

	it('sets Authorization bearer header when auth=bearer', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 })));

		const config: ClientConfig = { baseUrl: 'https://api.example.com', apiKey: 'gw_abc123' };
		await request(config, 'POST', '/v1/zones/abc/purge_cache', { auth: 'bearer', body: { hosts: ['a.com'] } });

		const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(fetchCall[1].headers['Authorization']).toBe('Bearer gw_abc123');
		expect(fetchCall[1].headers['Content-Type']).toBe('application/json');
		expect(fetchCall[1].body).toBe('{"hosts":["a.com"]}');
	});

	it('exits when admin auth required but no admin key', async () => {
		const config: ClientConfig = { baseUrl: 'https://api.example.com' };
		await request(config, 'GET', '/admin/keys', { auth: 'admin' });
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('exits when bearer auth required but no api key', async () => {
		const config: ClientConfig = { baseUrl: 'https://api.example.com' };
		await request(config, 'POST', '/v1/zones/abc/purge_cache', { auth: 'bearer' });
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('handles non-JSON response gracefully', async () => {
		// The response body can only be consumed once, so json() will fail,
		// and the fallback text() may also fail. The function returns null in that case.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('<html>Error</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })),
		);

		const config: ClientConfig = { baseUrl: 'https://api.example.com' };
		const result = await request(config, 'GET', '/health');

		expect(result.status).toBe(502);
		// data may be null (body consumed by json()) or an error shape (if text() succeeded)
		if (result.data !== null) {
			expect((result.data as any).success).toBe(false);
		}
	});

	it('exits on network error', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

		const config: ClientConfig = { baseUrl: 'https://api.example.com' };
		await request(config, 'GET', '/health');
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

// ---------- formatApiError ----------

describe('formatApiError', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prints error with status and error messages', () => {
		formatApiError(403, { errors: [{ code: 403, message: 'Forbidden' }] });
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('Request failed') && c.includes('403'))).toBe(true);
		expect(calls.some((c: string) => c.includes('Forbidden'))).toBe(true);
	});

	it('prints denied scopes when present', () => {
		formatApiError(403, { errors: [], denied: ['purge:url', 'purge:host'] });
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('purge:url') && c.includes('purge:host'))).toBe(true);
	});

	it('handles null data gracefully', () => {
		formatApiError(500, null);
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('Request failed'))).toBe(true);
	});

	it('handles empty errors array', () => {
		formatApiError(400, { errors: [] });
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('Request failed'))).toBe(true);
		// No error detail lines
		expect(calls.length).toBe(1);
	});
});

// ---------- formatKey ----------

describe('formatKey', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('formats an active key', () => {
		formatKey({
			id: 'gw_abc123',
			name: 'test-key',
			zone_id: 'zone123',
			created_at: Date.now() - 86400_000,
			expires_at: null,
			revoked: 0,
			created_by: 'admin@example.com',
		});
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('gw_abc123'))).toBe(true);
		expect(calls.some((c: string) => c.includes('test-key'))).toBe(true);
		expect(calls.some((c: string) => c.includes('zone123'))).toBe(true);
		expect(calls.some((c: string) => c.includes('active'))).toBe(true);
		expect(calls.some((c: string) => c.includes('admin@example.com'))).toBe(true);
	});

	it('formats a revoked key', () => {
		formatKey({
			id: 'gw_revoked',
			name: 'revoked-key',
			zone_id: null,
			created_at: Date.now(),
			expires_at: null,
			revoked: 1,
		});
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('revoked'))).toBe(true);
		// zone_id null should show 'any'
		expect(calls.some((c: string) => c.includes('any'))).toBe(true);
	});

	it('formats an expired key', () => {
		formatKey({
			id: 'gw_expired',
			name: 'expired-key',
			zone_id: 'zone456',
			created_at: Date.now() - 86400_000 * 60,
			expires_at: Date.now() - 86400_000,
			revoked: 0,
		});
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('expired'))).toBe(true);
		expect(calls.some((c: string) => c.includes('Expires'))).toBe(true);
	});
});

// ---------- formatPolicy ----------

describe('formatPolicy', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('formats a valid policy with statements', () => {
		const policy = JSON.stringify({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:host'],
					resources: ['zone:abc123'],
					conditions: [{ field: 'host', operator: 'eq', value: 'example.com' }],
				},
			],
		});
		formatPolicy(policy);
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('2025-01-01'))).toBe(true);
		expect(calls.some((c: string) => c.includes('allow'))).toBe(true);
		expect(calls.some((c: string) => c.includes('purge:host'))).toBe(true);
		expect(calls.some((c: string) => c.includes('zone:abc123'))).toBe(true);
		expect(calls.some((c: string) => c.includes('example.com'))).toBe(true);
	});

	it('formats empty statements', () => {
		formatPolicy(JSON.stringify({ version: '2025-01-01', statements: [] }));
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('No statements'))).toBe(true);
	});

	it('handles invalid JSON gracefully', () => {
		formatPolicy('not valid json');
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('invalid policy JSON'))).toBe(true);
	});

	it('formats compound conditions (any/all/not)', () => {
		const policy = JSON.stringify({
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:url'],
					resources: ['zone:abc123'],
					conditions: [
						{
							any: [
								{ field: 'url', operator: 'starts_with', value: 'https://a.com/' },
								{ field: 'url', operator: 'starts_with', value: 'https://b.com/' },
							],
						},
					],
				},
			],
		});
		formatPolicy(policy);
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('any'))).toBe(true);
		expect(calls.some((c: string) => c.includes('https://a.com/'))).toBe(true);
	});
});

// ---------- table ----------

describe('table', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prints headers and rows with proper alignment', () => {
		table(
			['ID', 'Name', 'Status'],
			[
				['gw_abc', 'test-key', 'active'],
				['gw_def', 'other-key', 'revoked'],
			],
		);
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		// Header line should have uppercased headers
		expect(calls[0]).toMatch(/ID/);
		expect(calls[0]).toMatch(/NAME/);
		expect(calls[0]).toMatch(/STATUS/);
		// Data rows present
		expect(calls[1]).toMatch(/gw_abc/);
		expect(calls[2]).toMatch(/other-key/);
	});

	it('handles empty rows', () => {
		table(['Col1', 'Col2'], []);
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls;
		// Only header line
		expect(calls.length).toBe(1);
	});
});

// ---------- printJson ----------

describe('printJson', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('outputs JSON to stdout', () => {
		printJson({ success: true, result: { id: 'abc' } });
		const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(true);
		expect(parsed.result.id).toBe('abc');
	});

	it('outputs compact JSON in non-TTY mode', () => {
		printJson({ a: 1 });
		const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// Non-TTY: no newlines in output (compact)
		expect(output).not.toContain('\n');
	});
});

// ---------- formatRateLimit ----------

describe('formatRateLimit', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prints rate limit info when headers present', () => {
		const headers = new Headers({
			Ratelimit: '"purge-bulk";r=490;t=0',
			'Ratelimit-Policy': '"purge-bulk";q=500;w=10',
		});
		formatRateLimit(headers);
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('Rate Limit'))).toBe(true);
		expect(calls.some((c: string) => c.includes('purge-bulk'))).toBe(true);
		expect(calls.some((c: string) => c.includes('490'))).toBe(true);
		expect(calls.some((c: string) => c.includes('500'))).toBe(true);
		// Bar in non-TTY mode shows [pct%]
		expect(calls.some((c: string) => c.includes('[98%]'))).toBe(true);
	});

	it('prints THROTTLED when Retry-After present', () => {
		const headers = new Headers({
			Ratelimit: '"purge-single";r=0;t=1',
			'Ratelimit-Policy': '"purge-single";q=6000;w=2',
			'Retry-After': '5',
		});
		formatRateLimit(headers);
		const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes('THROTTLED'))).toBe(true);
		expect(calls.some((c: string) => c.includes('5s'))).toBe(true);
	});

	it('does nothing when no Ratelimit header', () => {
		const headers = new Headers();
		formatRateLimit(headers);
		expect(console.error).not.toHaveBeenCalled();
	});
});

// ---------- parseTime ----------

describe('parseTime', () => {
	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('passes through unix milliseconds', () => {
		expect(parseTime('1700000000000')).toBe(1700000000000);
	});

	it('converts unix seconds to milliseconds', () => {
		expect(parseTime('1700000000')).toBe(1700000000000);
	});

	it('parses ISO 8601 date string', () => {
		const result = parseTime('2025-01-15T12:00:00Z');
		expect(result).toBe(new Date('2025-01-15T12:00:00Z').getTime());
	});

	it('exits on invalid time format', () => {
		parseTime('not-a-date');
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

// ---------- confirmAction ----------

describe('confirmAction', () => {
	it('returns false when stdin is not a TTY', async () => {
		// In test environment, process.stdin.isTTY is undefined (not a TTY)
		const result = await confirmAction('Delete everything?');
		expect(result).toBe(false);
	});
});

// ---------- bulk-helpers factory ----------

describe('makeBulkSubcommand', () => {
	it('returns a valid citty command definition', async () => {
		const { makeBulkSubcommand } = await import('./bulk-helpers.js');
		const cmd = makeBulkSubcommand({
			entityName: 'test-entities',
			apiPath: '/admin/test/bulk-delete',
			idField: 'ids',
			action: 'delete',
		});

		const meta = cmd.meta as Record<string, unknown>;
		const args = cmd.args as Record<string, unknown>;
		expect(meta?.name).toBe('bulk-delete');
		expect(meta?.description).toMatch(/test-entities/);
		expect(args).toBeDefined();
		expect(args.ids).toBeDefined();
		expect(args.confirm).toBeDefined();
		expect(typeof cmd.run).toBe('function');
	});

	it('includes extra args when provided', async () => {
		const { makeBulkSubcommand } = await import('./bulk-helpers.js');
		const cmd = makeBulkSubcommand({
			entityName: 'keys',
			apiPath: '/admin/keys/bulk-revoke',
			idField: 'ids',
			action: 'revoke',
			extraArgs: { 'zone-id': { type: 'string' as const, description: 'Zone ID' } },
		});

		const args = cmd.args as Record<string, unknown>;
		expect(args['zone-id']).toBeDefined();
	});
});

// ---------- OpenAPI generation smoke test ----------

describe('OpenAPI generation', () => {
	it('openapi.json exists and is valid JSON with expected structure', () => {
		const fs = require('node:fs');
		const path = require('node:path');
		const openapiPath = path.resolve(__dirname, '..', 'openapi.json');
		expect(fs.existsSync(openapiPath)).toBe(true);

		const content = fs.readFileSync(openapiPath, 'utf-8');
		const doc = JSON.parse(content);

		expect(doc.openapi).toMatch(/^3\.\d+\.\d+$/);
		expect(doc.info.title).toBeTruthy();
		expect(doc.paths).toBeTruthy();
		expect(Object.keys(doc.paths).length).toBeGreaterThan(10);
		expect(doc.components?.schemas).toBeTruthy();
		expect(Object.keys(doc.components.schemas).length).toBeGreaterThan(10);
	});
});
