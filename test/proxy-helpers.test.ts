import { describe, it, expect } from 'vitest';
import {
	isValidAccountId,
	isValidZoneId,
	extractBearerKey,
	cfJsonError,
	buildProxyResponse,
	extractResponseDetail,
} from '../src/cf/proxy-helpers';

// --- Tests ---

describe('proxy-helpers', () => {
	// --- isValidAccountId ---

	describe('isValidAccountId', () => {
		it('valid 32-hex-char ID -> true', () => {
			expect(isValidAccountId('aaaa1111bbbb2222cccc3333dddd4444')).toBe(true);
		});

		it('all lowercase hex -> true', () => {
			expect(isValidAccountId('0123456789abcdef0123456789abcdef')).toBe(true);
		});

		it('uppercase hex -> false', () => {
			expect(isValidAccountId('AAAA1111BBBB2222CCCC3333DDDD4444')).toBe(false);
		});

		it('too short -> false', () => {
			expect(isValidAccountId('aaaa1111bbbb2222')).toBe(false);
		});

		it('too long -> false', () => {
			expect(isValidAccountId('aaaa1111bbbb2222cccc3333dddd44445555')).toBe(false);
		});

		it('empty string -> false', () => {
			expect(isValidAccountId('')).toBe(false);
		});

		it('non-hex chars -> false', () => {
			expect(isValidAccountId('gggg1111bbbb2222cccc3333dddd4444')).toBe(false);
		});
	});

	// --- isValidZoneId ---

	describe('isValidZoneId', () => {
		it('valid 32-hex-char ID -> true', () => {
			expect(isValidZoneId('aaaa1111bbbb2222cccc3333dddd4444')).toBe(true);
		});

		it('invalid format -> false', () => {
			expect(isValidZoneId('not-a-zone-id')).toBe(false);
		});
	});

	// --- extractBearerKey ---

	describe('extractBearerKey', () => {
		it('valid Bearer token -> returns key', () => {
			expect(extractBearerKey('Bearer my-api-key-123')).toBe('my-api-key-123');
		});

		it('Bearer with extra whitespace -> trimmed key', () => {
			expect(extractBearerKey('Bearer   my-key   ')).toBe('my-key');
		});

		it('no Bearer prefix -> null', () => {
			expect(extractBearerKey('Basic dXNlcjpwYXNz')).toBe(null);
		});

		it('undefined header -> null', () => {
			expect(extractBearerKey(undefined)).toBe(null);
		});

		it('empty string -> null', () => {
			expect(extractBearerKey('')).toBe(null);
		});

		it('Bearer with empty key -> null', () => {
			expect(extractBearerKey('Bearer ')).toBe(null);
		});

		it('Bearer with only whitespace -> null', () => {
			expect(extractBearerKey('Bearer    ')).toBe(null);
		});

		it('lowercase bearer -> null (case-sensitive)', () => {
			expect(extractBearerKey('bearer my-key')).toBe(null);
		});
	});

	// --- cfJsonError ---

	describe('cfJsonError', () => {
		it('returns JSON response with correct status', async () => {
			const res = cfJsonError(400, 'Bad request');
			expect(res.status).toBe(400);
			expect(res.headers.get('Content-Type')).toBe('application/json');
		});

		it('body matches CF API error format', async () => {
			const res = cfJsonError(502, 'Upstream unavailable');
			const body = await res.json<any>();
			expect(body).toEqual({
				success: false,
				errors: [{ code: 502, message: 'Upstream unavailable' }],
				messages: [],
				result: null,
			});
		});

		it('404 error', async () => {
			const res = cfJsonError(404, 'Not found');
			expect(res.status).toBe(404);
			const body = await res.json<any>();
			expect(body.success).toBe(false);
			expect(body.errors[0].code).toBe(404);
		});
	});

	// --- buildProxyResponse ---

	describe('buildProxyResponse', () => {
		it('forwards Content-Type from upstream', () => {
			const upstream = new Response('{"ok":true}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
			const res = buildProxyResponse(upstream, '{"ok":true}');
			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toBe('application/json');
		});

		it('sets default Content-Type when upstream has no Content-Type in forwarded list', () => {
			// When upstream provides no Content-Type at all (e.g. empty body or explicit removal),
			// buildProxyResponse falls back to application/json.
			// But the Response constructor auto-adds text/plain for string bodies.
			// Use a stream body to avoid auto Content-Type:
			const upstream = new Response(null, { status: 204 });
			upstream.headers.delete('Content-Type');
			const res = buildProxyResponse(upstream, null);
			expect(res.headers.get('Content-Type')).toBe('application/json');
		});

		it('respects statusOverride', () => {
			const upstream = new Response('', { status: 200 });
			const res = buildProxyResponse(upstream, '', 201);
			expect(res.status).toBe(201);
		});

		it('forwards rate-limit headers', () => {
			const upstream = new Response('', {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'RateLimit-Limit': '100',
					'RateLimit-Remaining': '99',
					'RateLimit-Reset': '1700000000',
					'Retry-After': '5',
					'Cf-Ray': 'abc123',
				},
			});
			const res = buildProxyResponse(upstream, '');
			expect(res.headers.get('RateLimit-Limit')).toBe('100');
			expect(res.headers.get('RateLimit-Remaining')).toBe('99');
			expect(res.headers.get('RateLimit-Reset')).toBe('1700000000');
			expect(res.headers.get('Retry-After')).toBe('5');
			expect(res.headers.get('Cf-Ray')).toBe('abc123');
		});

		it('does not forward arbitrary headers', () => {
			const upstream = new Response('', {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'X-Custom-Header': 'secret',
					'Set-Cookie': 'session=abc',
				},
			});
			const res = buildProxyResponse(upstream, '');
			expect(res.headers.has('X-Custom-Header')).toBe(false);
			expect(res.headers.has('Set-Cookie')).toBe(false);
		});

		it('null responseBody -> streams upstream body', async () => {
			const upstream = new Response('upstream-data', {
				status: 200,
				headers: { 'Content-Type': 'text/plain' },
			});
			const res = buildProxyResponse(upstream, null);
			const text = await res.text();
			expect(text).toBe('upstream-data');
		});
	});

	// --- extractResponseDetail ---

	describe('extractResponseDetail', () => {
		it('extracts success/errors/messages from JSON', () => {
			const body = JSON.stringify({
				success: true,
				errors: [],
				messages: ['OK'],
				result: { id: 'abc' },
			});
			const detail = extractResponseDetail(body);
			const parsed = JSON.parse(detail!);
			expect(parsed.success).toBe(true);
			expect(parsed.errors).toEqual([]);
			expect(parsed.messages).toEqual(['OK']);
			// result is NOT included in the compact detail
			expect(parsed.result).toBeUndefined();
		});

		it('handles error response', () => {
			const body = JSON.stringify({
				success: false,
				errors: [{ code: 404, message: 'Not found' }],
			});
			const detail = extractResponseDetail(body);
			const parsed = JSON.parse(detail!);
			expect(parsed.success).toBe(false);
			expect(parsed.errors).toEqual([{ code: 404, message: 'Not found' }]);
		});

		it('non-JSON -> returns raw string', () => {
			const detail = extractResponseDetail('plain text error');
			expect(detail).toBe('plain text error');
		});

		it('empty string -> null', () => {
			expect(extractResponseDetail('')).toBe(null);
		});

		it('truncates oversized JSON', () => {
			const longError = 'x'.repeat(5000);
			const body = JSON.stringify({
				success: false,
				errors: [{ message: longError }],
			});
			const detail = extractResponseDetail(body);
			expect(detail!.length).toBeLessThanOrEqual(4096);
		});

		it('truncates oversized non-JSON', () => {
			const longText = 'y'.repeat(5000);
			const detail = extractResponseDetail(longText);
			expect(detail!.length).toBeLessThanOrEqual(4096);
		});
	});
});
