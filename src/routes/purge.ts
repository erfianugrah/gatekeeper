import { Hono } from 'hono';
import { RequestCollapser } from '../request-collapse';
import { logPurgeEvent } from '../analytics';
import { getStub } from '../do-stub';
import { extractRequestFields } from '../request-fields';
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
}

// ─── Route ──────────────────────────────────────────────────────────────────

export const purgeRoute = new Hono<HonoEnv>();

purgeRoute.post('/v1/zones/:zoneId/purge_cache', async (c) => {
	const start = Date.now();
	const zoneId = c.req.param('zoneId');
	const env = c.env;

	const log: Record<string, unknown> = {
		route: 'purge',
		method: 'POST',
		zoneId,
		ts: new Date().toISOString(),
	};

	// Validate zone ID format
	if (!/^[a-f0-9]{32}$/.test(zoneId)) {
		log.status = 400;
		log.error = 'invalid_zone_id';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Invalid zone ID format' }] }, 400);
	}

	// Check auth header presence early
	const authHeader = c.req.header('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		log.status = 401;
		log.error = 'missing_auth';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 401, message: 'Missing Authorization: Bearer <key>' }] }, 401);
	}
	const keyId = authHeader.slice(7).trim();
	log.keyId = keyId.slice(0, 12) + '...';

	// Parse body
	let bodyText: string;
	let body: PurgeBody;
	try {
		bodyText = await c.req.text();
		body = JSON.parse(bodyText);
	} catch {
		log.status = 400;
		log.error = 'invalid_json';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 400, message: 'Invalid JSON body' }] }, 400);
	}

	const stub = getStub(env);

	// Resolve config from DO registry for max-ops limits
	const gwConfig = await stub.getConfig();

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
		return c.json({ success: false, errors: [{ code: 400, message: e.message }] }, 400);
	}

	log.purgeType = parsed.type;
	log.rateClass = parsed.rateClass;
	log.tokens = parsed.tokens;

	// Resolve upstream CF API token for this zone
	const upstreamToken = await stub.resolveUpstreamToken(zoneId);
	if (!upstreamToken) {
		log.status = 502;
		log.error = 'no_upstream_token';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 502, message: `No upstream API token registered for zone ${zoneId}` }] }, 502);
	}

	// Extract request-level fields for policy conditions (IP, geo, time)
	const requestFields = extractRequestFields(c.req.raw);

	// Full policy authorization (always per-request, never collapsed)
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
		const isUpstream = !result.headers['Ratelimit'];
		log.error = isUpstream ? 'upstream_rate_limited' : 'client_rate_limited';
		log.retryAfterSec = Number(result.headers['Retry-After'] ?? 0);
	}

	console.log(JSON.stringify(log));

	// Extract upstream response detail for debugging — truncated CF API JSON
	let responseDetail: string | null = null;
	if (result.reachedUpstream && result.body) {
		try {
			const parsed = JSON.parse(result.body);
			// Keep only the useful debugging fields from the CF API response
			const detail: Record<string, unknown> = {};
			if (parsed.success !== undefined) detail.success = parsed.success;
			if (parsed.errors?.length) detail.errors = parsed.errors;
			if (parsed.messages?.length) detail.messages = parsed.messages;
			const serialized = JSON.stringify(detail);
			responseDetail = serialized.length > 4096 ? serialized.slice(0, 4096) : serialized;
		} catch {
			// Non-JSON upstream response — store raw (truncated)
			responseDetail = result.body.length > 4096 ? result.body.slice(0, 4096) : result.body;
		}
	}

	// Log to D1 analytics asynchronously (fire-and-forget)
	if (env.ANALYTICS_DB) {
		const event: PurgeEvent = {
			key_id: keyId,
			zone_id: zoneId,
			purge_type: parsed.type,
			purge_target: parsed.target,
			tokens: parsed.tokens,
			status: result.status,
			collapsed: collapseLevel,
			upstream_status: !collapseLevel && result.reachedUpstream ? result.status : null,
			duration_ms: Date.now() - start,
			response_detail: responseDetail,
			created_by: 'via API key',
			flight_id: flightId,
			created_at: Date.now(),
		};
		c.executionCtx.waitUntil(logPurgeEvent(env.ANALYTICS_DB, event));
	}

	return new Response(result.body, {
		status: result.status,
		headers: result.headers,
	});
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Classify a purge request body into type, rate-limit class, token cost, and human-readable target. */
export function classifyPurge(body: PurgeBody, limits: { singleMaxOps: number; bulkMaxOps: number }): ParsedPurgeRequest {
	const { singleMaxOps, bulkMaxOps } = limits;

	if (body.files && body.files.length > 0) {
		if (body.files.length > singleMaxOps) {
			throw new Error(`files array has ${body.files.length} items, max is ${singleMaxOps}`);
		}
		const target = summarizeFiles(body.files);
		return { type: 'url', rateClass: 'single', tokens: body.files.length, target, body };
	}

	if ('purge_everything' in body) {
		if (body.purge_everything !== true) {
			throw new Error('purge_everything must be boolean true');
		}
		return { type: 'everything', rateClass: 'bulk', tokens: 1, target: '*', body };
	}

	// Hosts, tags, prefixes — all bulk rate-limited. Pick the dominant type.
	const hostCount = body.hosts?.length ?? 0;
	const tagCount = body.tags?.length ?? 0;
	const prefixCount = body.prefixes?.length ?? 0;
	const totalOps = hostCount + tagCount + prefixCount;

	if (totalOps > 0) {
		if (totalOps > bulkMaxOps) {
			throw new Error(`Total bulk operations is ${totalOps}, max per request is ${bulkMaxOps}`);
		}
		// Determine the specific type — if mixed, pick the first non-empty
		let type: 'host' | 'tag' | 'prefix' = 'host';
		if (hostCount > 0) type = 'host';
		else if (tagCount > 0) type = 'tag';
		else if (prefixCount > 0) type = 'prefix';

		const target = summarizeBulk(body);
		return { type, rateClass: 'bulk', tokens: 1, target, body };
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
	return truncateTarget(parts.join(', '));
}

/** Build a human-readable target string for bulk purges (hosts, tags, prefixes). */
function summarizeBulk(body: PurgeBody): string {
	const segments: string[] = [];
	if (body.hosts?.length) segments.push(body.hosts.join(', '));
	if (body.tags?.length) segments.push(body.tags.map((t) => `tag:${t}`).join(', '));
	if (body.prefixes?.length) segments.push(body.prefixes.map((p) => `prefix:${p}`).join(', '));
	return truncateTarget(segments.join('; '));
}

/** Truncate target string to fit in a D1 TEXT column without bloating storage. */
function truncateTarget(s: string): string {
	return s.length > 4096 ? s.slice(0, 4096) : s;
}
