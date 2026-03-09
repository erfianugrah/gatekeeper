/**
 * Shared helpers for the CF API proxy routes.
 *
 * These mirror the patterns in src/dns/routes.ts (validateRequest, proxyToCfApi)
 * but are generalized for account-scoped API proxying via CLOUDFLARE_API_BASE_URL.
 */

import { CF_API_BASE, BEARER_PREFIX, ACCOUNT_ID_RE, ZONE_ID_RE, MAX_LOG_VALUE_LENGTH } from '../constants';
import { getStub } from '../do-stub';

// ─── Upstream rate-limit headers to forward ─────────────────────────────────

/** Headers from the CF API response that should be forwarded to the client. */
const FORWARDED_HEADERS = ['Content-Type', 'Cf-Ray', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'];

// ─── Validation ─────────────────────────────────────────────────────────────

/** Validate a Cloudflare account ID (32-hex-char format). */
export function isValidAccountId(id: string): boolean {
	return ACCOUNT_ID_RE.test(id);
}

/** Validate a Cloudflare zone ID (32-hex-char format). */
export function isValidZoneId(id: string): boolean {
	return ZONE_ID_RE.test(id);
}

/** Extract and validate the Bearer key from the Authorization header. Returns the key ID or null. */
export function extractBearerKey(authHeader: string | undefined): string | null {
	if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) return null;
	const key = authHeader.slice(BEARER_PREFIX.length).trim();
	return key.length > 0 ? key : null;
}

// ─── Upstream token resolution ──────────────────────────────────────────────

/**
 * Resolve the upstream CF API token for a given account.
 * Called AFTER authentication to prevent unauthenticated callers from probing
 * which accounts have registered tokens (would leak 502 vs 401).
 *
 * Returns the token string on success, or a CF-style JSON error Response on failure.
 */
export async function resolveUpstreamTokenOrError(
	env: Env,
	accountId: string,
	log: Record<string, unknown>,
	start: number,
): Promise<string | Response> {
	const stub = getStub(env);
	const upstreamToken = await stub.resolveUpstreamAccountToken(accountId);
	if (!upstreamToken) {
		log.status = 502;
		log.error = 'no_upstream_account_token';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return cfJsonError(502, `No upstream API token registered for account ${accountId}`);
	}
	return upstreamToken;
}

/**
 * Resolve the upstream CF API token for a given zone.
 * Zone-scoped variant for DNS and other zone-level services.
 * Called AFTER authentication to prevent info leakage.
 *
 * Returns the token string on success, or a CF-style JSON error Response on failure.
 */
export async function resolveUpstreamZoneTokenOrError(
	env: Env,
	zoneId: string,
	log: Record<string, unknown>,
	start: number,
): Promise<string | Response> {
	const stub = getStub(env);
	const upstreamToken = await stub.resolveUpstreamToken(zoneId);
	if (!upstreamToken) {
		log.status = 502;
		log.error = 'no_upstream_zone_token';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return cfJsonError(502, `No upstream API token registered for zone ${zoneId}`);
	}
	return upstreamToken;
}

// ─── Upstream proxy ─────────────────────────────────────────────────────────

/** Forward a request to the real Cloudflare API, replacing the auth header with the upstream token. */
export async function proxyToCfApi(
	upstreamPath: string,
	upstreamToken: string,
	method: string,
	body?: BodyInit | null,
	queryString?: string,
	contentType?: string | null,
	extraHeaders?: Record<string, string>,
): Promise<Response> {
	const url = `${CF_API_BASE}${upstreamPath}${queryString ? `?${queryString}` : ''}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${upstreamToken}`,
	};
	if (contentType) {
		headers['Content-Type'] = contentType;
	}
	if (extraHeaders) {
		for (const [k, v] of Object.entries(extraHeaders)) {
			headers[k] = v;
		}
	}
	return fetch(url, {
		method,
		headers,
		body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
	});
}

// ─── Response helpers ───────────────────────────────────────────────────────

/** Build a forwarded response, copying relevant upstream headers (including rate-limit headers).
 *  When responseBody is null, the upstream response body is streamed through directly (for binary passthrough). */
export function buildProxyResponse(upstreamResponse: Response, responseBody: BodyInit | null, statusOverride?: number): Response {
	const headers = new Headers();
	for (const name of FORWARDED_HEADERS) {
		const value = upstreamResponse.headers.get(name);
		if (value) headers.set(name, value);
	}
	// Ensure Content-Type is always set
	if (!headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}
	return new Response(responseBody ?? upstreamResponse.body, {
		status: statusOverride ?? upstreamResponse.status,
		headers,
	});
}

/** Extract a compact response detail string for analytics storage. */
export function extractResponseDetail(responseBody: string): string | null {
	if (!responseBody) return null;
	try {
		const parsed = JSON.parse(responseBody);
		const detail: Record<string, unknown> = {};
		if (parsed.success !== undefined) detail.success = parsed.success;
		if (parsed.errors) detail.errors = parsed.errors;
		if (parsed.messages) detail.messages = parsed.messages;
		const result = JSON.stringify(detail);
		return result.length > MAX_LOG_VALUE_LENGTH ? result.slice(0, MAX_LOG_VALUE_LENGTH) : result;
	} catch {
		return responseBody.length > MAX_LOG_VALUE_LENGTH ? responseBody.slice(0, MAX_LOG_VALUE_LENGTH) : responseBody;
	}
}

/** Cloudflare API-style JSON error response. */
export function cfJsonError(status: number, message: string): Response {
	return new Response(
		JSON.stringify({
			success: false,
			errors: [{ code: status, message }],
			messages: [],
			result: null,
		}),
		{
			status,
			headers: { 'Content-Type': 'application/json' },
		},
	);
}
