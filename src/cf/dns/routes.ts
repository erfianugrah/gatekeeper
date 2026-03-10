/**
 * DNS Records API proxy routes.
 *
 * Mounted under `/cf/zones/:zoneId` by the CF proxy router (and aliased at
 * `/v1/zones/:zoneId` for backward compatibility).
 *
 * Uses zone-scoped upstream tokens and the bulk rate-limit bucket.
 * Shared helpers (proxyToCfApi, extractResponseDetail, etc.) come from
 * the CF proxy infrastructure — no local duplicates.
 *
 * Route structure mirrors the CF API:
 *   POST   /dns_records              -> dns:create
 *   GET    /dns_records              -> dns:read (list)
 *   GET    /dns_records/export       -> dns:export
 *   POST   /dns_records/batch        -> dns:batch
 *   POST   /dns_records/import       -> dns:import
 *   GET    /dns_records/:recordId    -> dns:read (get)
 *   PATCH  /dns_records/:recordId    -> dns:update
 *   PUT    /dns_records/:recordId    -> dns:update
 *   DELETE /dns_records/:recordId    -> dns:delete
 */

import { Hono } from 'hono';
import { getStub } from '../../do-stub';
import { AUDIT_CREATED_BY_API_KEY } from '../../constants';
import { proxyToCfApi, buildProxyResponse, extractResponseDetail, cfJsonError, resolveUpstreamZoneTokenOrError } from '../proxy-helpers';
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
import type { CfProxyEnv } from '../router';
import type { DnsEvent } from './analytics';
import type { DnsRecordFields, DnsBatchBody } from './operations';
import type { RequestContext } from '../../policy-types';

// ─── Route ──────────────────────────────────────────────────────────────────

export const dnsRoutes = new Hono<CfProxyEnv>();

// ─── Shared handler ─────────────────────────────────────────────────────────

/** Build a DnsEvent for analytics logging. */
function buildDnsEvent(ctx: {
	keyId: string;
	keyName: string | undefined;
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
		created_by: ctx.keyName ? `key:${ctx.keyName}` : AUDIT_CREATED_BY_API_KEY,
		created_at: Date.now(),
	};
}

/**
 * Full auth + rate-limit + proxy + analytics flow for a DNS operation.
 * Zone-scoped variant of handleCfServiceRequest — uses zone tokens and the bulk bucket.
 */
async function handleDnsRequest(
	c: any,
	action: string,
	contexts: RequestContext[],
	zoneId: string,
	upstreamPath: string,
	method: string,
	body: BodyInit | null,
	recordName: string | null,
	recordType: string | null,
	contentType?: string | null,
): Promise<Response> {
	const env = c.env;
	const keyId: string = c.get('keyId');
	const start: number = c.get('startTime');
	const log: Record<string, unknown> = c.get('log');
	log.service = 'dns';
	log.action = action;

	const stub = getStub(env);

	// Authorize BEFORE resolving the upstream token
	const authResult = await stub.authorize(keyId, zoneId, contexts);
	if (!authResult.authorized) {
		const status = authResult.error === 'Invalid API key' ? 401 : 403;
		log.status = status;
		log.error = 'auth_failed';
		log.authError = authResult.error;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return new Response(
			JSON.stringify({
				success: false,
				errors: [{ code: status, message: authResult.error }],
				...(authResult.denied ? { denied: authResult.denied } : {}),
			}),
			{ status, headers: { 'Content-Type': 'application/json' } },
		);
	}

	c.set('keyName', authResult.keyName);

	// Resolve zone-scoped upstream token (post-auth) — key-pinned upstream takes priority
	const tokenOrError = await resolveUpstreamZoneTokenOrError(env, zoneId, log, start, authResult.upstreamTokenId);
	if (tokenOrError instanceof Response) return tokenOrError;
	const upstreamToken = tokenOrError;

	// Rate limit — DNS uses the bulk bucket (1 token per request)
	const consumeResult = await stub.consume('bulk', 1);
	if (!consumeResult.allowed) {
		log.status = 429;
		log.error = 'rate_limited';
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return cfJsonError(429, 'Rate limit exceeded');
	}

	// Proxy to CF API
	const queryString = method === 'GET' ? new URL(c.req.url).search.slice(1) : '';
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
			keyName: authResult.keyName,
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

	return buildProxyResponse(upstream, responseBody);
}

// ─── Create record ──────────────────────────────────────────────────────────

dnsRoutes.post('/dns_records', async (c) => {
	const zoneId: string = c.get('zoneId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const bodyText = await c.req.text();
		let body: DnsRecordFields;
		try {
			body = JSON.parse(bodyText);
		} catch {
			return cfJsonError(400, 'Invalid JSON body');
		}

		const contexts = [dnsCreateContext(zoneId, body, requestFields)];
		return handleDnsRequest(
			c,
			'dns:create',
			contexts,
			zoneId,
			`/zones/${zoneId}/dns_records`,
			'POST',
			bodyText,
			body.name ?? null,
			body.type ?? null,
			'application/json',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.create', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── List records ───────────────────────────────────────────────────────────

dnsRoutes.get('/dns_records', async (c) => {
	const zoneId: string = c.get('zoneId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [dnsReadContext(zoneId, requestFields)];
		return handleDnsRequest(c, 'dns:read', contexts, zoneId, `/zones/${zoneId}/dns_records`, 'GET', null, null, null);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.list', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Export zone file ───────────────────────────────────────────────────────
// Must be before /:recordId to avoid matching "export" as a record ID

dnsRoutes.get('/dns_records/export', async (c) => {
	const zoneId: string = c.get('zoneId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [dnsExportContext(zoneId, requestFields)];
		return handleDnsRequest(c, 'dns:export', contexts, zoneId, `/zones/${zoneId}/dns_records/export`, 'GET', null, null, null);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.export', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Batch operations ───────────────────────────────────────────────────────
// Must be before /:recordId to avoid matching "batch" as a record ID

dnsRoutes.post('/dns_records/batch', async (c) => {
	const zoneId: string = c.get('zoneId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const bodyText = await c.req.text();
		let batch: DnsBatchBody;
		try {
			batch = JSON.parse(bodyText);
		} catch {
			return cfJsonError(400, 'Invalid JSON body');
		}

		// Build contexts WITHOUT pre-fetched record data first — auth must happen
		// BEFORE we resolve any upstream tokens (avoids unauthenticated callers
		// probing which zones have registered tokens).
		const basicContexts = dnsBatchToContexts(zoneId, batch, requestFields);
		const subOps = (batch.deletes?.length ?? 0) + (batch.patches?.length ?? 0) + (batch.puts?.length ?? 0) + (batch.posts?.length ?? 0);
		const log: Record<string, unknown> = c.get('log');
		log.subOps = subOps;

		// Auth + upstream resolution happens inside handleDnsRequest.
		// Post-auth, the handler resolves the upstream token which is also used
		// for the actual batch proxy call — no separate pre-flight needed.
		// Note: condition fields from pre-existing records (dns.type, dns.name)
		// won't be available for delete/patch/put sub-ops in the auth check.
		// This is the secure default — condition-based policies won't match
		// without record data, so they become more restrictive rather than more permissive.
		return handleDnsRequest(
			c,
			'dns:batch',
			basicContexts,
			zoneId,
			`/zones/${zoneId}/dns_records/batch`,
			'POST',
			bodyText,
			null,
			null,
			'application/json',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.batch', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Import zone file ──────────────────────────────────────────────────────
// Must be before /:recordId to avoid matching "import" as a record ID

dnsRoutes.post('/dns_records/import', async (c) => {
	const zoneId: string = c.get('zoneId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [dnsImportContext(zoneId, requestFields)];

		// Import uses multipart/form-data — pass body through as-is
		const bodyBuffer = await c.req.arrayBuffer();
		const contentType = c.req.header('Content-Type') ?? 'multipart/form-data';

		return handleDnsRequest(
			c,
			'dns:import',
			contexts,
			zoneId,
			`/zones/${zoneId}/dns_records/import`,
			'POST',
			bodyBuffer,
			null,
			null,
			contentType,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.import', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Get single record ──────────────────────────────────────────────────────

dnsRoutes.get('/dns_records/:recordId', async (c) => {
	const zoneId: string = c.get('zoneId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const recordId = c.req.param('recordId');

	try {
		const contexts = [dnsReadContext(zoneId, requestFields)];
		return handleDnsRequest(c, 'dns:read', contexts, zoneId, `/zones/${zoneId}/dns_records/${recordId}`, 'GET', null, null, null);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.get', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Update record (PATCH) ──────────────────────────────────────────────────

dnsRoutes.patch('/dns_records/:recordId', async (c) => {
	const zoneId: string = c.get('zoneId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const recordId = c.req.param('recordId');

	try {
		const bodyText = await c.req.text();
		let body: DnsRecordFields;
		try {
			body = JSON.parse(bodyText);
		} catch {
			return cfJsonError(400, 'Invalid JSON body');
		}

		const contexts = [dnsUpdateContext(zoneId, body, requestFields)];
		return handleDnsRequest(
			c,
			'dns:update',
			contexts,
			zoneId,
			`/zones/${zoneId}/dns_records/${recordId}`,
			'PATCH',
			bodyText,
			body.name ?? null,
			body.type ?? null,
			'application/json',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.update', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Update record (PUT — full overwrite) ───────────────────────────────────

dnsRoutes.put('/dns_records/:recordId', async (c) => {
	const zoneId: string = c.get('zoneId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const recordId = c.req.param('recordId');

	try {
		const bodyText = await c.req.text();
		let body: DnsRecordFields;
		try {
			body = JSON.parse(bodyText);
		} catch {
			return cfJsonError(400, 'Invalid JSON body');
		}

		const contexts = [dnsUpdateContext(zoneId, body, requestFields)];
		return handleDnsRequest(
			c,
			'dns:update',
			contexts,
			zoneId,
			`/zones/${zoneId}/dns_records/${recordId}`,
			'PUT',
			bodyText,
			body.name ?? null,
			body.type ?? null,
			'application/json',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.update', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Delete record ──────────────────────────────────────────────────────────

dnsRoutes.delete('/dns_records/:recordId', async (c) => {
	const zoneId: string = c.get('zoneId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const recordId = c.req.param('recordId');

	try {
		// Auth first with basic context (no pre-fetched record fields).
		// Record-specific condition fields (dns.type, dns.name) won't be available,
		// making condition-based policies more restrictive — the secure default.
		// The upstream token is resolved AFTER auth inside handleDnsRequest.
		const contexts = [dnsDeleteContext(zoneId, requestFields)];
		return handleDnsRequest(c, 'dns:delete', contexts, zoneId, `/zones/${zoneId}/dns_records/${recordId}`, 'DELETE', null, null, null);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'dns.delete', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});
