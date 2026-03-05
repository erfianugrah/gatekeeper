import { Hono } from 'hono';
import { logPurgeEvent } from '../analytics';
import { getStub } from '../do-stub';
import type { PurgeEvent } from '../analytics';
import type { PurgeBody, ParsedPurgeRequest, PurgeResult, HonoEnv } from '../types';
import type { Gatekeeper } from '../durable-object';

// ─── Per-isolate request collapsing ─────────────────────────────────────────

const ISOLATE_COLLAPSE_GRACE_MS = 50;
const inflightIsolate = new Map<string, Promise<PurgeResult>>();

/**
 * Clear the isolate-level inflight cache.
 * @internal Exported for testing only — do not use in production code.
 */
export function __testClearInflightCache() {
	inflightIsolate.clear();
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
	log.cost = parsed.cost;

	// Resolve upstream CF API token for this zone
	const upstreamToken = await stub.resolveUpstreamToken(zoneId);
	if (!upstreamToken) {
		log.status = 502;
		log.error = 'no_upstream_token';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 502, message: `No upstream API token registered for zone ${zoneId}` }] }, 502);
	}

	// Full policy authorization (always per-request, never collapsed)
	const authResult = await stub.authorizeFromBody(keyId, zoneId, body);
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
	let result: PurgeResult;
	let collapsedAtIsolate = false;

	const existingFlight = inflightIsolate.get(collapseKey);
	if (existingFlight) {
		try {
			result = await existingFlight;
			collapsedAtIsolate = true;
		} catch {
			inflightIsolate.delete(collapseKey);
			result = await createAndTrackFlight(collapseKey, stub, zoneId, bodyText, parsed, upstreamToken, keyId);
		}
	} else {
		result = await createAndTrackFlight(collapseKey, stub, zoneId, bodyText, parsed, upstreamToken, keyId);
	}

	// Determine collapse level for logging
	const collapseLevel = collapsedAtIsolate ? 'isolate' : result.collapsed ? 'do' : false;
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
			cost: parsed.cost,
			status: result.status,
			collapsed: collapseLevel,
			upstream_status: !collapseLevel && result.reachedUpstream ? result.status : null,
			duration_ms: Date.now() - start,
			response_detail: responseDetail,
			created_by: keyId,
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

function createAndTrackFlight(
	collapseKey: string,
	stub: DurableObjectStub<Gatekeeper>,
	zoneId: string,
	bodyText: string,
	parsed: ParsedPurgeRequest,
	upstreamToken: string,
	keyId?: string,
): Promise<PurgeResult> {
	const promise = stub.purge(zoneId, bodyText, parsed.type, parsed.cost, upstreamToken, keyId);

	inflightIsolate.set(collapseKey, promise);
	promise.finally(() => {
		setTimeout(() => {
			if (inflightIsolate.get(collapseKey) === promise) {
				inflightIsolate.delete(collapseKey);
			}
		}, ISOLATE_COLLAPSE_GRACE_MS);
	});

	return promise;
}

/** Classify a purge request body into type (single/bulk) and cost. */
export function classifyPurge(body: PurgeBody, limits: { singleMaxOps: number; bulkMaxOps: number }): ParsedPurgeRequest {
	const { singleMaxOps, bulkMaxOps } = limits;

	if (body.files && body.files.length > 0) {
		if (body.files.length > singleMaxOps) {
			throw new Error(`files array has ${body.files.length} items, max is ${singleMaxOps}`);
		}
		return { type: 'single', cost: body.files.length, body };
	}

	if ('purge_everything' in body) {
		if (body.purge_everything !== true) {
			throw new Error('purge_everything must be boolean true');
		}
		return { type: 'bulk', cost: 1, body };
	}

	const hasBulk =
		(body.hosts && body.hosts.length > 0) || (body.tags && body.tags.length > 0) || (body.prefixes && body.prefixes.length > 0);

	if (hasBulk) {
		const totalOps = (body.hosts?.length || 0) + (body.tags?.length || 0) + (body.prefixes?.length || 0);

		if (totalOps > bulkMaxOps) {
			throw new Error(`Total bulk operations is ${totalOps}, max per request is ${bulkMaxOps}`);
		}
		return { type: 'bulk', cost: 1, body };
	}

	throw new Error('Request body must contain one of: files, hosts, tags, prefixes, or purge_everything');
}
