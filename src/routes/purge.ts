import { Hono } from 'hono';
import { RequestCollapser } from '../request-collapse';
import { logPurgeEvent } from '../analytics';
import { getStub } from '../do-stub';
import { extractRequestFields } from '../request-fields';
import { BEARER_PREFIX, MAX_LOG_VALUE_LENGTH, AUDIT_CREATED_BY_API_KEY } from '../constants';
import { getCachedConfig, invalidateConfigCache } from '../config-cache';
import { purgeBodySchema, zoneIdParamSchema, jsonError } from './admin-schemas';
import type { PurgeEvent } from '../analytics';
import type { PurgeBody, ParsedPurgeRequest, PurgeResult, HonoEnv } from '../types';

// ─── Per-isolate request collapsing ─────────────────────────────────────────

const isolateCollapser = new RequestCollapser<PurgeResult>();

/**
 * Clear the isolate-level inflight cache.
 * @internal Exported for testing only — do not use in production code.
 */
export function __testClearInflightCache() {
	isolateCollapser.__testClear();
	invalidateConfigCache();
}

// ─── Route ──────────────────────────────────────────────────────────────────

export const purgeRoute = new Hono<HonoEnv>();

purgeRoute.post('/v1/zones/:zoneId/purge_cache', async (c) => {
	const start = Date.now();
	const zoneId = c.req.param('zoneId');
	const env = c.env;
	try {
		const log: Record<string, unknown> = {
			route: 'purge',
			method: 'POST',
			zoneId,
			ts: new Date().toISOString(),
		};

		// Validate zone ID format via Zod
		const paramResult = zoneIdParamSchema.safeParse({ zoneId });
		if (!paramResult.success) {
			log.status = 400;
			log.error = 'invalid_zone_id';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 400, 'Invalid zone ID format');
		}

		// Check auth header presence early
		const authHeader = c.req.header('Authorization');
		if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
			log.status = 401;
			log.error = 'missing_auth';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 401, 'Missing Authorization: Bearer <key>');
		}
		const keyId = authHeader.slice(BEARER_PREFIX.length).trim();
		log.keyId = keyId.slice(0, 12) + '...';

		// Parse and validate body via Zod
		let bodyText: string;
		let body: PurgeBody;
		try {
			bodyText = await c.req.text();
			const raw = JSON.parse(bodyText);
			const bodyResult = purgeBodySchema.safeParse(raw);
			if (!bodyResult.success) {
				const errors = bodyResult.error.issues.map((issue) => ({
					code: 400,
					message: `${issue.path.join('.')}: ${issue.message}`,
				}));
				log.status = 400;
				log.error = 'invalid_purge_body';
				log.validationErrors = errors.map((e) => e.message);
				log.durationMs = Date.now() - start;
				console.log(JSON.stringify(log));
				return c.json({ success: false, errors }, 400);
			}
			body = bodyResult.data as PurgeBody;
		} catch {
			log.status = 400;
			log.error = 'invalid_json';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 400, 'Invalid JSON body');
		}

		const stub = getStub(env);

		// Resolve config from DO registry (isolate-cached with 30s TTL)
		const gwConfig = await getCachedConfig(stub);

		// Classify purge type
		let parsed: ParsedPurgeRequest;
		try {
			parsed = classifyPurge(body, { singleMaxOps: gwConfig.single_max_ops, bulkMaxOps: gwConfig.bulk_max_ops });
		} catch (e: any) {
			log.status = 400;
			log.error = 'invalid_purge_body';
			log.detail = e.message;
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 400, e.message);
		}

		log.purgeType = parsed.type;
		log.rateClass = parsed.rateClass;
		log.tokens = parsed.tokens;

		// Extract request-level fields for policy conditions (IP, geo, time)
		const requestFields = extractRequestFields(c.req.raw);

		// Full policy authorization (always per-request, never collapsed).
		// Authorize BEFORE resolving the upstream token so unauthorized callers
		// cannot probe which zones have upstream tokens registered.
		const authResult = await stub.authorizeFromBody(keyId, zoneId, body, requestFields);
		if (!authResult.authorized) {
			const status = authResult.error === 'Invalid API key' ? 401 : 403;
			log.status = status;
			log.error = 'auth_failed';
			log.authError = authResult.error;
			log.denied = authResult.denied;
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return c.json(
				{
					success: false,
					errors: [{ code: status, message: authResult.error }],
					...(authResult.denied ? { denied: authResult.denied } : {}),
				},
				status as 401 | 403,
			);
		}

		// Resolve upstream CF API token for this zone (after auth to avoid info leak)
		// Key-pinned upstream token takes priority over zone-based resolution
		let upstreamToken: string | null;
		if (authResult.upstreamTokenId) {
			upstreamToken = await stub.resolveUpstreamTokenById(authResult.upstreamTokenId);
		} else {
			upstreamToken = await stub.resolveUpstreamToken(zoneId);
		}
		if (!upstreamToken) {
			const detail = authResult.upstreamTokenId
				? `Pinned upstream token ${authResult.upstreamTokenId} not found`
				: `No upstream API token registered for zone ${zoneId}`;
			log.status = 502;
			log.error = authResult.upstreamTokenId ? 'pinned_upstream_token_not_found' : 'no_upstream_token';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 502, detail);
		}

		// ── Isolate-level request collapsing ────────────────────────────────

		const collapseKey = `${zoneId}\0${bodyText}`;
		const {
			result,
			collapsed: collapsedAtIsolate,
			flightId: isolateFlightId,
		} = await isolateCollapser.collapseOrCreate(collapseKey, () =>
			stub.purge(zoneId, bodyText, parsed.rateClass, parsed.tokens, upstreamToken, keyId),
		);

		// Determine collapse level for logging
		const collapseLevel = collapsedAtIsolate ? 'isolate' : result.collapsed ? 'do' : false;
		// Always use the DO's flightId — isolate followers share the same DO result,
		// so all events in a flight group (leader + DO-collapsed + isolate-collapsed) share one ID.
		const flightId = result.flightId;
		log.collapsed = collapseLevel;
		log.rateLimitAllowed = result.status !== 429 || !!collapseLevel;
		log.rateLimitRemaining = result.rateLimitInfo.remaining;
		log.status = result.status;
		log.identity = keyId;
		log.durationMs = Date.now() - start;

		if (result.status === 429) {
			// Check for our rate-limit header (case-insensitive lookup for robustness)
			const hasGatewayRatelimit = Object.keys(result.headers).some((k) => k.toLowerCase() === 'ratelimit');
			log.error = hasGatewayRatelimit ? 'client_rate_limited' : 'upstream_rate_limited';
			const retryAfter = Object.entries(result.headers).find(([k]) => k.toLowerCase() === 'retry-after');
			log.retryAfterSec = Number(retryAfter?.[1] ?? 0);
		}

		console.log(JSON.stringify(log));

		// Log to D1 analytics asynchronously (fire-and-forget)
		if (env.ANALYTICS_DB) {
			const event = buildPurgeEvent({
				keyId,
				keyName: authResult.keyName,
				zoneId,
				parsed,
				result,
				collapseLevel,
				flightId,
				durationMs: Date.now() - start,
			});
			c.executionCtx.waitUntil(logPurgeEvent(env.ANALYTICS_DB, event));
		}

		return new Response(result.body, {
			status: result.status,
			headers: result.headers,
		});
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'purge', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Classify a purge request body into type, rate-limit class, token cost, and human-readable target. */
export function classifyPurge(body: PurgeBody, limits: { singleMaxOps: number; bulkMaxOps: number }): ParsedPurgeRequest {
	const { singleMaxOps, bulkMaxOps } = limits;

	// Count which purge types are present — reject mixed bodies (matches CF API behavior)
	const hasFiles = body.files && body.files.length > 0;
	const hasPurgeEverything = body.purge_everything === true;
	const hasHosts = body.hosts && body.hosts.length > 0;
	const hasTags = body.tags && body.tags.length > 0;
	const hasPrefixes = body.prefixes && body.prefixes.length > 0;
	const typeCount = [hasFiles, hasPurgeEverything, hasHosts, hasTags, hasPrefixes].filter(Boolean).length;

	if (typeCount > 1) {
		throw new Error('Request body must contain exactly one purge type (files, hosts, tags, prefixes, or purge_everything)');
	}

	if (hasFiles) {
		if (body.files!.length > singleMaxOps) {
			throw new Error(`files array has ${body.files!.length} items, max is ${singleMaxOps}`);
		}
		const target = summarizeFiles(body.files!);
		return { type: 'url', rateClass: 'single', tokens: body.files!.length, target, body };
	}

	if (hasPurgeEverything) {
		if (body.purge_everything !== true) {
			throw new Error('purge_everything must be boolean true');
		}
		return { type: 'everything', rateClass: 'bulk', tokens: 1, target: '*', body };
	}

	if (hasHosts) {
		if (body.hosts!.length > bulkMaxOps) {
			throw new Error(`hosts array has ${body.hosts!.length} items, max per request is ${bulkMaxOps}`);
		}
		const target = summarizeBulk(body);
		return { type: 'host', rateClass: 'bulk', tokens: 1, target, body };
	}

	if (hasTags) {
		if (body.tags!.length > bulkMaxOps) {
			throw new Error(`tags array has ${body.tags!.length} items, max per request is ${bulkMaxOps}`);
		}
		const target = summarizeBulk(body);
		return { type: 'tag', rateClass: 'bulk', tokens: 1, target, body };
	}

	if (hasPrefixes) {
		if (body.prefixes!.length > bulkMaxOps) {
			throw new Error(`prefixes array has ${body.prefixes!.length} items, max per request is ${bulkMaxOps}`);
		}
		const target = summarizeBulk(body);
		return { type: 'prefix', rateClass: 'bulk', tokens: 1, target, body };
	}

	throw new Error('Request body must contain one of: files, hosts, tags, prefixes, or purge_everything');
}

/** Build a human-readable target string for URL purges. Handles plain strings and {url, headers} objects. */
function summarizeFiles(files: (string | { url: string; headers?: Record<string, string> })[]): string {
	const parts: string[] = [];
	for (const f of files) {
		if (typeof f === 'string') {
			parts.push(f);
		} else {
			// Custom cache key — include header info
			const hdrs = f.headers
				? Object.entries(f.headers)
						.map(([k, v]) => `${k}:${v}`)
						.join(', ')
				: '';
			parts.push(hdrs ? `${f.url} [${hdrs}]` : f.url);
		}
	}
	return truncate(parts.join(', '));
}

/** Build a human-readable target string for bulk purges (hosts, tags, prefixes). */
function summarizeBulk(body: PurgeBody): string {
	const segments: string[] = [];
	if (body.hosts?.length) segments.push(body.hosts.join(', '));
	if (body.tags?.length) segments.push(body.tags.map((t) => `tag:${t}`).join(', '));
	if (body.prefixes?.length) segments.push(body.prefixes.map((p) => `prefix:${p}`).join(', '));
	return truncate(segments.join('; '));
}

/** Truncate a string to the maximum log/analytics storage length. */
function truncate(s: string): string {
	return s.length > MAX_LOG_VALUE_LENGTH ? s.slice(0, MAX_LOG_VALUE_LENGTH) : s;
}

/** Extract upstream response detail for debugging — truncated CF API JSON or raw body. */
function extractResponseDetail(result: PurgeResult): string | null {
	if (!result.reachedUpstream || !result.body) return null;
	try {
		const parsed = JSON.parse(result.body);
		const detail: Record<string, unknown> = {};
		if (parsed.success !== undefined) detail.success = parsed.success;
		if (parsed.errors?.length) detail.errors = parsed.errors;
		if (parsed.messages?.length) detail.messages = parsed.messages;
		return truncate(JSON.stringify(detail));
	} catch {
		return truncate(result.body);
	}
}

/** Build a PurgeEvent for D1 analytics from the request lifecycle context. */
function buildPurgeEvent(ctx: {
	keyId: string;
	keyName: string | undefined;
	zoneId: string;
	parsed: ParsedPurgeRequest;
	result: PurgeResult;
	collapseLevel: string | false;
	flightId: string;
	durationMs: number;
}): PurgeEvent {
	return {
		key_id: ctx.keyId,
		zone_id: ctx.zoneId,
		purge_type: ctx.parsed.type,
		purge_target: ctx.parsed.target,
		tokens: ctx.parsed.tokens,
		status: ctx.result.status,
		collapsed: ctx.collapseLevel,
		upstream_status: !ctx.collapseLevel && ctx.result.reachedUpstream ? ctx.result.status : null,
		duration_ms: ctx.durationMs,
		response_detail: extractResponseDetail(ctx.result),
		created_by: ctx.keyName ? `key:${ctx.keyName}` : AUDIT_CREATED_BY_API_KEY,
		flight_id: ctx.flightId,
		created_at: Date.now(),
	};
}
