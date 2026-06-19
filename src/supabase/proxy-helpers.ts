/**
 * Shared helpers for the Supabase proxy routes.
 *
 * Mirrors the patterns in src/cf/proxy-helpers.ts but targets Supabase upstreams:
 * the Management API (`api.supabase.com`, Bearer PAT) and the per-project Metrics
 * endpoint (`<ref>.supabase.co`, HTTP Basic Auth). Supabase returns plain JSON
 * errors (`{ message }`), not the Cloudflare success envelope.
 */

import { BEARER_PREFIX, MAX_LOG_VALUE_LENGTH } from '../constants';
import { SUPABASE_API_BASE, SUPABASE_PROJECT_HOST, SUPABASE_METRICS_PATH, SUPABASE_REF_RE } from './constants';

// ─── Validation ─────────────────────────────────────────────────────────────

/** Validate a Supabase project ref (20 lowercase alphanumeric chars). */
export function isValidSupabaseRef(ref: string): boolean {
	return SUPABASE_REF_RE.test(ref);
}

/** Extract and validate the Bearer key from the Authorization header. Returns the key ID or null. */
export function extractBearerKey(authHeader: string | undefined): string | null {
	if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) return null;
	const key = authHeader.slice(BEARER_PREFIX.length).trim();
	return key.length > 0 ? key : null;
}

// ─── Response helpers ───────────────────────────────────────────────────────

/** Plain JSON error (Supabase Management API uses `{ message }`, not the CF envelope). */
export function sbJsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ message }), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Headers from the upstream response that should be forwarded to the client. */
const FORWARDED_HEADERS = ['Content-Type', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'];

/** Build a forwarded response, copying relevant upstream headers.
 *  When responseBody is null, the upstream body is streamed through directly (for the metrics text passthrough). */
export function buildProxyResponse(upstream: Response, body: BodyInit | null, statusOverride?: number): Response {
	const headers = new Headers();
	for (const name of FORWARDED_HEADERS) {
		const v = upstream.headers.get(name);
		if (v) headers.set(name, v);
	}
	const status = statusOverride ?? upstream.status;
	const isNullBodyStatus = status === 204 || status === 205 || status === 304;
	if (!isNullBodyStatus && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
	return new Response(isNullBodyStatus ? null : (body ?? upstream.body), { status, headers });
}

/** Extract a compact response detail string for analytics storage. */
export function extractResponseDetail(body: string): string | null {
	if (!body) return null;
	try {
		const p = JSON.parse(body);
		if (p && typeof p === 'object' && 'message' in p) {
			const m = JSON.stringify({ message: (p as Record<string, unknown>).message });
			return m.length > MAX_LOG_VALUE_LENGTH ? m.slice(0, MAX_LOG_VALUE_LENGTH) : m;
		}
	} catch {
		// not JSON — fall through to truncated raw body
	}
	return body.length > MAX_LOG_VALUE_LENGTH ? body.slice(0, MAX_LOG_VALUE_LENGTH) : body;
}

// ─── Upstream proxy ─────────────────────────────────────────────────────────

/** Proxy to the Supabase Management API, swapping in the stored PAT. */
export async function proxyToManagementApi(
	path: string,
	pat: string,
	method: string,
	body?: BodyInit | null,
	queryString?: string,
	contentType?: string | null,
): Promise<Response> {
	const url = `${SUPABASE_API_BASE}${path}${queryString ? `?${queryString}` : ''}`;
	const headers: Record<string, string> = { Authorization: `Bearer ${pat}` };
	if (contentType) headers['Content-Type'] = contentType;
	return fetch(url, { method, headers, body: method !== 'GET' && method !== 'HEAD' ? body : undefined });
}

/**
 * Proxy to the per-project Metrics endpoint with HTTP Basic Auth.
 * Supabase authenticates on the password (the sb_secret_ key) only; the username is ignored.
 */
export async function proxyToMetrics(ref: string, username: string, secret: string): Promise<Response> {
	const url = `${SUPABASE_PROJECT_HOST(ref)}${SUPABASE_METRICS_PATH}`;
	const basic = btoa(`${username}:${secret}`);
	return fetch(url, { method: 'GET', headers: { Authorization: `Basic ${basic}` } });
}
