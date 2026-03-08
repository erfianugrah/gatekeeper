/**
 * DNS Records API proxy routes.
 *
 * Proxies requests to the Cloudflare DNS Records API with IAM policy enforcement,
 * rate limiting (via the account-level bulk bucket), and D1 analytics.
 *
 * Route structure mirrors the CF API:
 *   POST   /v1/zones/:zoneId/dns_records              -> dns:create
 *   GET    /v1/zones/:zoneId/dns_records               -> dns:read (list)
 *   GET    /v1/zones/:zoneId/dns_records/export        -> dns:export
 *   POST   /v1/zones/:zoneId/dns_records/batch         -> dns:batch
 *   POST   /v1/zones/:zoneId/dns_records/import        -> dns:import
 *   GET    /v1/zones/:zoneId/dns_records/:recordId     -> dns:read (get)
 *   PATCH  /v1/zones/:zoneId/dns_records/:recordId     -> dns:update
 *   PUT    /v1/zones/:zoneId/dns_records/:recordId     -> dns:update
 *   DELETE /v1/zones/:zoneId/dns_records/:recordId     -> dns:delete
 */

import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { extractRequestFields } from '../request-fields';
import { logDnsEvent } from './analytics';
import {
	dnsCreateContext,
	dnsReadContext,
	dnsUpdateContext,
	dnsDeleteContext,
	dnsExportContext,
	dnsImportContext,
	dnsBatchToContexts,
} from './operations';
import { CF_API_BASE, BEARER_PREFIX, MAX_LOG_VALUE_LENGTH, AUDIT_CREATED_BY_API_KEY } from '../constants';
import { zoneIdParamSchema, jsonError } from '../routes/admin-schemas';
import type { HonoEnv } from '../types';
import type { DnsRecordFields, DnsBatchBody } from './operations';
import type { DnsEvent } from './analytics';
import type { RequestContext } from '../policy-types';

// ─── Route ──────────────────────────────────────────────────────────────────

export const dnsRoute = new Hono<HonoEnv>();

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Validate zone ID and extract Bearer key. Returns [zoneId, keyId] or a Response on error. */
function validateRequest(c: any, log: Record<string, unknown>, start: number): [string, string] | Response {
	const zoneId = c.req.param('zoneId');
	const paramResult = zoneIdParamSchema.safeParse({ zoneId });
	if (!paramResult.success) {
		log.status = 400;
		log.error = 'invalid_zone_id';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return jsonError(c, 400, 'Invalid zone ID format');
	}

	const authHeader = c.req.header('Authorization');
	if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
		log.status = 401;
		log.error = 'missing_auth';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return jsonError(c, 401, 'Missing Authorization: Bearer <key>');
	}
	const keyId = authHeader.slice(BEARER_PREFIX.length).trim();
	return [zoneId, keyId];
}

/** Forward a request to the CF API and return the raw response. */
async function proxyToCfApi(
	upstreamPath: string,
	upstreamToken: string,
	method: string,
	body?: string | null,
	queryString?: string,
	contentType?: string | null,
): Promise<Response> {
	const url = `${CF_API_BASE}${upstreamPath}${queryString ? `?${queryString}` : ''}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${upstreamToken}`,
	};
	if (contentType) {
		headers['Content-Type'] = contentType;
	}
	return fetch(url, {
		method,
		headers,
		body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
	});
}

/** Truncate a string to the analytics storage limit. */
function truncate(s: string): string {
	return s.length > MAX_LOG_VALUE_LENGTH ? s.slice(0, MAX_LOG_VALUE_LENGTH) : s;
}

/** Extract upstream response detail for analytics. */
function extractResponseDetail(responseBody: string): string | null {
	if (!responseBody) return null;
	try {
		const parsed = JSON.parse(responseBody);
		const detail: Record<string, unknown> = {};
		if (parsed.success !== undefined) detail.success = parsed.success;
		if (parsed.errors?.length) detail.errors = parsed.errors;
		if (parsed.messages?.length) detail.messages = parsed.messages;
		return truncate(JSON.stringify(detail));
	} catch {
		return truncate(responseBody);
	}
}

/** Build a DnsEvent for analytics logging. */
function buildDnsEvent(ctx: {
	keyId: string;
	zoneId: string;
	action: string;
	recordName: string | null;
	recordType: string | null;
	status: number;
	upstreamStatus: number | null;
	durationMs: number;
	responseDetail: string | null;
}): DnsEvent {
	return {
		key_id: ctx.keyId,
		zone_id: ctx.zoneId,
		action: ctx.action,
		record_name: ctx.recordName,
		record_type: ctx.recordType,
		status: ctx.status,
		upstream_status: ctx.upstreamStatus,
		duration_ms: ctx.durationMs,
		response_detail: ctx.responseDetail,
		created_by: AUDIT_CREATED_BY_API_KEY,
		created_at: Date.now(),
	};
}

/**
 * Full auth + rate-limit + proxy + analytics flow for a DNS operation.
 * Shared by all single-record route handlers.
 */
async function handleDnsRequest(
	c: any,
	action: string,
	contexts: RequestContext[],
	zoneId: string,
	keyId: string,
	upstreamPath: string,
	method: string,
	body: string | null,
	recordName: string | null,
	recordType: string | null,
	log: Record<string, unknown>,
	start: number,
): Promise<Response> {
	const env = c.env;
	const stub = getStub(env);

	// Authorize
	const authResult = await stub.authorize(keyId, zoneId, contexts);
	if (!authResult.authorized) {
		const status = authResult.error === 'Invalid API key' ? 401 : 403;
		log.status = status;
		log.error = 'auth_failed';
		log.authError = authResult.error;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json(
			{
				success: false,
				errors: [{ code: status, message: authResult.error }],
				...(authResult.denied ? { denied: authResult.denied } : {}),
			},
			status,
		);
	}

	// Resolve upstream token
	const upstreamToken = await stub.resolveUpstreamToken(zoneId);
	if (!upstreamToken) {
		log.status = 502;
		log.error = 'no_upstream_token';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return jsonError(c, 502, `No upstream API token registered for zone ${zoneId}`);
	}

	// Rate limit — DNS uses the bulk bucket (1 token per request)
	const consumeResult = await stub.consume('bulk', 1);
	if (!consumeResult.allowed) {
		log.status = 429;
		log.error = 'rate_limited';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors: [{ code: 429, message: 'Rate limit exceeded' }] }, 429, {
			'Retry-After': String(Math.ceil(consumeResult.retryAfterSec)),
			RateLimit: `limit=${consumeResult.remaining + 1}, remaining=0, reset=${Math.ceil(consumeResult.retryAfterSec)}`,
		});
	}

	// Proxy to CF API
	const queryString = method === 'GET' ? new URL(c.req.url).search.slice(1) : '';
	const contentType = method !== 'GET' && method !== 'HEAD' ? (c.req.header('Content-Type') ?? 'application/json') : null;
	const upstream = await proxyToCfApi(upstreamPath, upstreamToken, method, body, queryString || undefined, contentType);
	const responseBody = await upstream.text();

	log.status = upstream.status;
	log.upstreamStatus = upstream.status;
	log.durationMs = Date.now() - start;
	console.log(JSON.stringify(log));

	// Analytics
	if (env.ANALYTICS_DB) {
		const event = buildDnsEvent({
			keyId,
			zoneId,
			action,
			recordName,
			recordType,
			status: upstream.status,
			upstreamStatus: upstream.status,
			durationMs: Date.now() - start,
			responseDetail: extractResponseDetail(responseBody),
		});
		c.executionCtx.waitUntil(logDnsEvent(env.ANALYTICS_DB, event));
	}

	// Forward response headers we care about
	const headers: Record<string, string> = { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' };
	const cfRayId = upstream.headers.get('Cf-Ray');
	if (cfRayId) headers['Cf-Ray'] = cfRayId;

	return new Response(responseBody, { status: upstream.status, headers });
}

// ─── Create record ──────────────────────────────────────────────────────────

dnsRoute.post('/v1/zones/:zoneId/dns_records', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'dns.create', method: 'POST', ts: new Date().toISOString() };

	try {
		const result = validateRequest(c, log, start);
		if (result instanceof Response) return result;
		const [zoneId, keyId] = result;
		log.zoneId = zoneId;
		log.keyId = keyId.slice(0, 12) + '...';

		const bodyText = await c.req.text();
		let body: DnsRecordFields;
		try {
			body = JSON.parse(bodyText);
		} catch {
			log.status = 400;
			log.error = 'invalid_json';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 400, 'Invalid JSON body');
		}

		const requestFields = extractRequestFields(c.req.raw);
		const contexts = [dnsCreateContext(zoneId, body, requestFields)];

		return handleDnsRequest(
			c,
			'dns:create',
			contexts,
			zoneId,
			keyId,
			`/zones/${zoneId}/dns_records`,
			'POST',
			bodyText,
			body.name ?? null,
			body.type ?? null,
			log,
			start,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.create', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── List records ───────────────────────────────────────────────────────────

dnsRoute.get('/v1/zones/:zoneId/dns_records', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'dns.list', method: 'GET', ts: new Date().toISOString() };

	try {
		const result = validateRequest(c, log, start);
		if (result instanceof Response) return result;
		const [zoneId, keyId] = result;
		log.zoneId = zoneId;
		log.keyId = keyId.slice(0, 12) + '...';

		const requestFields = extractRequestFields(c.req.raw);
		const contexts = [dnsReadContext(zoneId, requestFields)];

		return handleDnsRequest(c, 'dns:read', contexts, zoneId, keyId, `/zones/${zoneId}/dns_records`, 'GET', null, null, null, log, start);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.list', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Export zone file ───────────────────────────────────────────────────────
// Must be before /:recordId to avoid matching "export" as a record ID

dnsRoute.get('/v1/zones/:zoneId/dns_records/export', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'dns.export', method: 'GET', ts: new Date().toISOString() };

	try {
		const result = validateRequest(c, log, start);
		if (result instanceof Response) return result;
		const [zoneId, keyId] = result;
		log.zoneId = zoneId;
		log.keyId = keyId.slice(0, 12) + '...';

		const requestFields = extractRequestFields(c.req.raw);
		const contexts = [dnsExportContext(zoneId, requestFields)];

		return handleDnsRequest(
			c,
			'dns:export',
			contexts,
			zoneId,
			keyId,
			`/zones/${zoneId}/dns_records/export`,
			'GET',
			null,
			null,
			null,
			log,
			start,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.export', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Batch operations ───────────────────────────────────────────────────────
// Must be before /:recordId to avoid matching "batch" as a record ID

dnsRoute.post('/v1/zones/:zoneId/dns_records/batch', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'dns.batch', method: 'POST', ts: new Date().toISOString() };

	try {
		const result = validateRequest(c, log, start);
		if (result instanceof Response) return result;
		const [zoneId, keyId] = result;
		log.zoneId = zoneId;
		log.keyId = keyId.slice(0, 12) + '...';

		const bodyText = await c.req.text();
		let batch: DnsBatchBody;
		try {
			batch = JSON.parse(bodyText);
		} catch {
			log.status = 400;
			log.error = 'invalid_json';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 400, 'Invalid JSON body');
		}

		const requestFields = extractRequestFields(c.req.raw);

		// Pre-flight: fetch existing records for deletes/patches/puts so we can extract
		// condition fields (name, type, etc.) for policy evaluation.
		const recordIdsToFetch = new Set<string>();
		if (batch.deletes) batch.deletes.forEach((d) => recordIdsToFetch.add(d.id));
		if (batch.patches) batch.patches.forEach((p) => recordIdsToFetch.add(p.id));
		if (batch.puts) batch.puts.forEach((p) => recordIdsToFetch.add(p.id));

		let prefetchedRecords: Map<string, DnsRecordFields> | undefined;
		if (recordIdsToFetch.size > 0) {
			const stub = getStub(c.env);
			const upstreamToken = await stub.resolveUpstreamToken(zoneId);
			if (upstreamToken) {
				prefetchedRecords = await prefetchRecords(zoneId, [...recordIdsToFetch], upstreamToken);
			}
		}

		const contexts = dnsBatchToContexts(zoneId, batch, requestFields, prefetchedRecords);

		const subOps = (batch.deletes?.length ?? 0) + (batch.patches?.length ?? 0) + (batch.puts?.length ?? 0) + (batch.posts?.length ?? 0);
		log.subOps = subOps;

		return handleDnsRequest(
			c,
			'dns:batch',
			contexts,
			zoneId,
			keyId,
			`/zones/${zoneId}/dns_records/batch`,
			'POST',
			bodyText,
			null,
			null,
			log,
			start,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.batch', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Import zone file ──────────────────────────────────────────────────────
// Must be before /:recordId to avoid matching "import" as a record ID

dnsRoute.post('/v1/zones/:zoneId/dns_records/import', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'dns.import', method: 'POST', ts: new Date().toISOString() };

	try {
		const result = validateRequest(c, log, start);
		if (result instanceof Response) return result;
		const [zoneId, keyId] = result;
		log.zoneId = zoneId;
		log.keyId = keyId.slice(0, 12) + '...';

		const requestFields = extractRequestFields(c.req.raw);
		const contexts = [dnsImportContext(zoneId, requestFields)];

		// Import uses multipart/form-data — pass body through as-is
		const bodyBuffer = await c.req.arrayBuffer();

		const env = c.env;
		const stub = getStub(env);

		// Authorize
		const authResult = await stub.authorize(keyId, zoneId, contexts);
		if (!authResult.authorized) {
			const status = authResult.error === 'Invalid API key' ? 401 : 403;
			log.status = status;
			log.error = 'auth_failed';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return c.json(
				{
					success: false,
					errors: [{ code: status, message: authResult.error }],
					...(authResult.denied ? { denied: authResult.denied } : {}),
				},
				status,
			);
		}

		// Resolve upstream token
		const upstreamToken = await stub.resolveUpstreamToken(zoneId);
		if (!upstreamToken) {
			log.status = 502;
			log.error = 'no_upstream_token';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 502, `No upstream API token registered for zone ${zoneId}`);
		}

		// Rate limit
		const consumeResult = await stub.consume('bulk', 1);
		if (!consumeResult.allowed) {
			log.status = 429;
			log.error = 'rate_limited';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return c.json({ success: false, errors: [{ code: 429, message: 'Rate limit exceeded' }] }, 429, {
				'Retry-After': String(Math.ceil(consumeResult.retryAfterSec)),
			});
		}

		// Proxy — preserve the original Content-Type (multipart boundary)
		const contentType = c.req.header('Content-Type') ?? 'multipart/form-data';
		const upstream = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records/import`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${upstreamToken}`,
				'Content-Type': contentType,
			},
			body: bodyBuffer,
		});
		const responseBody = await upstream.text();

		log.status = upstream.status;
		log.upstreamStatus = upstream.status;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));

		if (env.ANALYTICS_DB) {
			const event = buildDnsEvent({
				keyId,
				zoneId,
				action: 'dns:import',
				recordName: null,
				recordType: null,
				status: upstream.status,
				upstreamStatus: upstream.status,
				durationMs: Date.now() - start,
				responseDetail: extractResponseDetail(responseBody),
			});
			c.executionCtx.waitUntil(logDnsEvent(env.ANALYTICS_DB, event));
		}

		return new Response(responseBody, {
			status: upstream.status,
			headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
		});
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.import', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Get single record ──────────────────────────────────────────────────────

dnsRoute.get('/v1/zones/:zoneId/dns_records/:recordId', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'dns.get', method: 'GET', ts: new Date().toISOString() };

	try {
		const result = validateRequest(c, log, start);
		if (result instanceof Response) return result;
		const [zoneId, keyId] = result;
		const recordId = c.req.param('recordId');
		log.zoneId = zoneId;
		log.keyId = keyId.slice(0, 12) + '...';
		log.recordId = recordId;

		const requestFields = extractRequestFields(c.req.raw);
		const contexts = [dnsReadContext(zoneId, requestFields)];

		return handleDnsRequest(
			c,
			'dns:read',
			contexts,
			zoneId,
			keyId,
			`/zones/${zoneId}/dns_records/${recordId}`,
			'GET',
			null,
			null,
			null,
			log,
			start,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.get', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Update record (PATCH) ──────────────────────────────────────────────────

dnsRoute.patch('/v1/zones/:zoneId/dns_records/:recordId', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'dns.update', method: 'PATCH', ts: new Date().toISOString() };

	try {
		const result = validateRequest(c, log, start);
		if (result instanceof Response) return result;
		const [zoneId, keyId] = result;
		const recordId = c.req.param('recordId');
		log.zoneId = zoneId;
		log.keyId = keyId.slice(0, 12) + '...';
		log.recordId = recordId;

		const bodyText = await c.req.text();
		let body: DnsRecordFields;
		try {
			body = JSON.parse(bodyText);
		} catch {
			log.status = 400;
			log.error = 'invalid_json';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 400, 'Invalid JSON body');
		}

		const requestFields = extractRequestFields(c.req.raw);
		const contexts = [dnsUpdateContext(zoneId, body, requestFields)];

		return handleDnsRequest(
			c,
			'dns:update',
			contexts,
			zoneId,
			keyId,
			`/zones/${zoneId}/dns_records/${recordId}`,
			'PATCH',
			bodyText,
			body.name ?? null,
			body.type ?? null,
			log,
			start,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.update', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Update record (PUT — full overwrite) ───────────────────────────────────

dnsRoute.put('/v1/zones/:zoneId/dns_records/:recordId', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'dns.update', method: 'PUT', ts: new Date().toISOString() };

	try {
		const result = validateRequest(c, log, start);
		if (result instanceof Response) return result;
		const [zoneId, keyId] = result;
		const recordId = c.req.param('recordId');
		log.zoneId = zoneId;
		log.keyId = keyId.slice(0, 12) + '...';
		log.recordId = recordId;

		const bodyText = await c.req.text();
		let body: DnsRecordFields;
		try {
			body = JSON.parse(bodyText);
		} catch {
			log.status = 400;
			log.error = 'invalid_json';
			log.durationMs = Date.now() - start;
			console.log(JSON.stringify(log));
			return jsonError(c, 400, 'Invalid JSON body');
		}

		const requestFields = extractRequestFields(c.req.raw);
		const contexts = [dnsUpdateContext(zoneId, body, requestFields)];

		return handleDnsRequest(
			c,
			'dns:update',
			contexts,
			zoneId,
			keyId,
			`/zones/${zoneId}/dns_records/${recordId}`,
			'PUT',
			bodyText,
			body.name ?? null,
			body.type ?? null,
			log,
			start,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.update', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Delete record ──────────────────────────────────────────────────────────

dnsRoute.delete('/v1/zones/:zoneId/dns_records/:recordId', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'dns.delete', method: 'DELETE', ts: new Date().toISOString() };

	try {
		const result = validateRequest(c, log, start);
		if (result instanceof Response) return result;
		const [zoneId, keyId] = result;
		const recordId = c.req.param('recordId');
		log.zoneId = zoneId;
		log.keyId = keyId.slice(0, 12) + '...';
		log.recordId = recordId;

		const requestFields = extractRequestFields(c.req.raw);

		// Pre-flight GET to extract condition fields for the record being deleted
		const stub = getStub(c.env);
		let recordFields: DnsRecordFields | undefined;
		const upstreamToken = await stub.resolveUpstreamToken(zoneId);
		if (upstreamToken) {
			try {
				const getResp = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records/${recordId}`, {
					headers: { Authorization: `Bearer ${upstreamToken}` },
				});
				if (getResp.ok) {
					const data = (await getResp.json()) as { result?: DnsRecordFields };
					if (data.result) recordFields = data.result;
				}
			} catch {
				// Pre-flight failed — proceed without condition fields
				console.log(JSON.stringify({ breadcrumb: 'dns-preflight-failed', zoneId, recordId }));
			}
		}

		const contexts = [dnsDeleteContext(zoneId, requestFields, recordFields)];

		return handleDnsRequest(
			c,
			'dns:delete',
			contexts,
			zoneId,
			keyId,
			`/zones/${zoneId}/dns_records/${recordId}`,
			'DELETE',
			null,
			recordFields?.name ?? null,
			recordFields?.type ?? null,
			log,
			start,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.delete', error: e.message, ts: new Date().toISOString() }));
		return jsonError(c, 500, 'Internal server error');
	}
});

// ─── Batch pre-flight helper ────────────────────────────────────────────────

/**
 * Pre-fetch existing records by ID for batch authorization.
 * Uses individual GET calls (CF API doesn't have a batch-get).
 * Failures are silently ignored — the record just won't have condition fields.
 */
async function prefetchRecords(zoneId: string, recordIds: string[], upstreamToken: string): Promise<Map<string, DnsRecordFields>> {
	const results = new Map<string, DnsRecordFields>();
	// Fetch in parallel, cap at 50 to avoid overwhelming upstream
	const batch = recordIds.slice(0, 50);
	const fetches = batch.map(async (id) => {
		try {
			const resp = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records/${id}`, {
				headers: { Authorization: `Bearer ${upstreamToken}` },
			});
			if (resp.ok) {
				const data = (await resp.json()) as { result?: DnsRecordFields };
				if (data.result) results.set(id, data.result);
			}
		} catch {
			// Silently ignore — proceed without fields for this record
		}
	});
	await Promise.all(fetches);

	if (results.size < recordIds.length) {
		console.log(
			JSON.stringify({
				breadcrumb: 'dns-batch-preflight-partial',
				zoneId,
				requested: recordIds.length,
				resolved: results.size,
			}),
		);
	}

	return results;
}
