/**
 * D1 API proxy routes.
 *
 * Proxies requests to the Cloudflare D1 API with per-database policy enforcement.
 * Mounted under `/cf/accounts/:accountId/d1` by the CF proxy router.
 *
 * Route structure mirrors the CF API (relative to the mount point):
 *   POST   /database                                      -> d1:create
 *   GET    /database                                      -> d1:list
 *   GET    /database/:databaseId                          -> d1:get
 *   PUT    /database/:databaseId                          -> d1:update
 *   PATCH  /database/:databaseId                          -> d1:update
 *   DELETE /database/:databaseId                          -> d1:delete
 *   POST   /database/:databaseId/query                    -> d1:query
 *   POST   /database/:databaseId/raw                      -> d1:raw
 *   POST   /database/:databaseId/export                   -> d1:export
 *   POST   /database/:databaseId/import                   -> d1:import
 *   GET    /database/:databaseId/time_travel/bookmark     -> d1:time_travel
 *   POST   /database/:databaseId/time_travel/restore      -> d1:time_travel
 */

import { Hono } from 'hono';
import { getStub } from '../../do-stub';
import { AUDIT_CREATED_BY_API_KEY } from '../../constants';
import { proxyToCfApi, buildProxyResponse, extractResponseDetail, cfJsonError } from '../proxy-helpers';
import { logCfProxyEvent } from '../analytics';
import {
	d1ListContext,
	d1CreateContext,
	d1GetContext,
	d1UpdateContext,
	d1DeleteContext,
	d1QueryContext,
	d1RawContext,
	d1ExportContext,
	d1ImportContext,
	d1TimeTravelContext,
} from './operations';
import type { CfProxyEnv } from '../router';
import type { CfProxyEvent } from '../analytics';
import type { RequestContext } from '../../policy-types';

// ─── Route ──────────────────────────────────────────────────────────────────

export const d1Routes = new Hono<CfProxyEnv>();

// ─── Shared handler ─────────────────────────────────────────────────────────

/**
 * Full auth + proxy + analytics flow for a D1 operation.
 * The shared CF proxy middleware already handled bearer extraction,
 * account validation, upstream token resolution, and rate limiting.
 */
async function handleD1Request(
	c: any,
	action: string,
	contexts: RequestContext[],
	upstreamPath: string,
	method: string,
	body?: BodyInit | null,
	contentType?: string | null,
	resourceId?: string | null,
): Promise<Response> {
	const env = c.env;
	const keyId: string = c.get('keyId');
	const accountId: string = c.get('accountId');
	const upstreamToken: string = c.get('upstreamToken');
	const start: number = c.get('startTime');
	const log: Record<string, unknown> = c.get('log');
	log.service = 'd1';
	log.action = action;
	if (resourceId) log.resourceId = resourceId;

	const stub = getStub(env);

	// Authorize — pass accountId as the "zoneId" param; for keys with zone_id=null
	// (which all CF proxy keys should be) this is harmless — the policy engine uses
	// the resource string (account:xxx) for matching.
	const authResult = await stub.authorize(keyId, accountId, contexts);
	if (!authResult.authorized) {
		const status = authResult.error === 'Invalid API key' ? 401 : 403;
		log.status = status;
		log.error = 'auth_failed';
		log.authError = authResult.error;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return cfJsonError(status, authResult.error ?? 'Forbidden');
	}

	c.set('keyName', authResult.keyName);

	// Proxy to CF API
	const queryString = method === 'GET' ? new URL(c.req.url).search.slice(1) : '';
	const upstream = await proxyToCfApi(upstreamPath, upstreamToken, method, body, queryString || undefined, contentType);
	const responseBody = await upstream.text();

	log.status = upstream.status;
	log.upstreamStatus = upstream.status;
	log.durationMs = Date.now() - start;
	console.log(JSON.stringify(log));

	// Drain bucket on upstream 429 to prevent hammering
	if (upstream.status === 429) {
		c.executionCtx.waitUntil(stub.drainCfProxyBucket());
	}

	// Analytics
	if (env.ANALYTICS_DB) {
		const event: CfProxyEvent = {
			key_id: keyId,
			account_id: accountId,
			service: 'd1',
			action,
			resource_id: resourceId ?? null,
			status: upstream.status,
			upstream_status: upstream.status,
			duration_ms: Date.now() - start,
			response_detail: extractResponseDetail(responseBody),
			created_by: authResult.keyName ? `key:${authResult.keyName}` : AUDIT_CREATED_BY_API_KEY,
			created_at: Date.now(),
		};
		c.executionCtx.waitUntil(logCfProxyEvent(env.ANALYTICS_DB, event));
	}

	return buildProxyResponse(upstream, responseBody);
}

// ─── Create database ────────────────────────────────────────────────────────

d1Routes.post('/database', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const bodyText = await c.req.text();
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(bodyText);
		} catch {
			return cfJsonError(400, 'Invalid JSON body');
		}

		const contexts = [d1CreateContext(accountId, body, requestFields)];
		return handleD1Request(c, 'd1:create', contexts, `/accounts/${accountId}/d1/database`, 'POST', bodyText, 'application/json');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.create', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── List databases ─────────────────────────────────────────────────────────

d1Routes.get('/database', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');

	try {
		const contexts = [d1ListContext(accountId, requestFields)];
		return handleD1Request(c, 'd1:list', contexts, `/accounts/${accountId}/d1/database`, 'GET');
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.list', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Export database (must be before /:databaseId to avoid capture) ─────────

d1Routes.post('/database/:databaseId/export', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const bodyText = await c.req.text();
		const contexts = [d1ExportContext(accountId, databaseId, requestFields)];
		return handleD1Request(
			c,
			'd1:export',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}/export`,
			'POST',
			bodyText,
			'application/json',
			databaseId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.export', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Import to database ─────────────────────────────────────────────────────

d1Routes.post('/database/:databaseId/import', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const bodyText = await c.req.text();
		const contexts = [d1ImportContext(accountId, databaseId, requestFields)];
		return handleD1Request(
			c,
			'd1:import',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}/import`,
			'POST',
			bodyText,
			'application/json',
			databaseId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.import', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Query database ─────────────────────────────────────────────────────────

d1Routes.post('/database/:databaseId/query', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const bodyText = await c.req.text();
		let sql: string | undefined;
		try {
			const parsed = JSON.parse(bodyText);
			if (typeof parsed.sql === 'string') sql = parsed.sql;
		} catch {
			return cfJsonError(400, 'Invalid JSON body');
		}

		const contexts = [d1QueryContext(accountId, databaseId, sql, requestFields)];
		return handleD1Request(
			c,
			'd1:query',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}/query`,
			'POST',
			bodyText,
			'application/json',
			databaseId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.query', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Raw query database ─────────────────────────────────────────────────────

d1Routes.post('/database/:databaseId/raw', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const bodyText = await c.req.text();
		let sql: string | undefined;
		try {
			const parsed = JSON.parse(bodyText);
			if (typeof parsed.sql === 'string') sql = parsed.sql;
		} catch {
			return cfJsonError(400, 'Invalid JSON body');
		}

		const contexts = [d1RawContext(accountId, databaseId, sql, requestFields)];
		return handleD1Request(
			c,
			'd1:raw',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}/raw`,
			'POST',
			bodyText,
			'application/json',
			databaseId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.raw', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Time travel: get bookmark ──────────────────────────────────────────────

d1Routes.get('/database/:databaseId/time_travel/bookmark', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const contexts = [d1TimeTravelContext(accountId, databaseId, requestFields)];
		return handleD1Request(
			c,
			'd1:time_travel',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}/time_travel/bookmark`,
			'GET',
			null,
			null,
			databaseId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.time_travel.bookmark', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Time travel: restore ───────────────────────────────────────────────────

d1Routes.post('/database/:databaseId/time_travel/restore', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const bodyText = await c.req.text();
		const contexts = [d1TimeTravelContext(accountId, databaseId, requestFields)];
		return handleD1Request(
			c,
			'd1:time_travel',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}/time_travel/restore`,
			'POST',
			bodyText,
			'application/json',
			databaseId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.time_travel.restore', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Get database ───────────────────────────────────────────────────────────

d1Routes.get('/database/:databaseId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const contexts = [d1GetContext(accountId, databaseId, requestFields)];
		return handleD1Request(c, 'd1:get', contexts, `/accounts/${accountId}/d1/database/${databaseId}`, 'GET', null, null, databaseId);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.get', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Update database (PUT — full overwrite) ─────────────────────────────────

d1Routes.put('/database/:databaseId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const bodyText = await c.req.text();
		const contexts = [d1UpdateContext(accountId, databaseId, requestFields)];
		return handleD1Request(
			c,
			'd1:update',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}`,
			'PUT',
			bodyText,
			'application/json',
			databaseId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.update', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Update database (PATCH — partial update) ──────────────────────────────

d1Routes.patch('/database/:databaseId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const bodyText = await c.req.text();
		const contexts = [d1UpdateContext(accountId, databaseId, requestFields)];
		return handleD1Request(
			c,
			'd1:update',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}`,
			'PATCH',
			bodyText,
			'application/json',
			databaseId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.edit', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Delete database ────────────────────────────────────────────────────────

d1Routes.delete('/database/:databaseId', async (c) => {
	const accountId: string = c.get('accountId');
	const requestFields: Record<string, string> = c.get('requestFields');
	const databaseId = c.req.param('databaseId');

	try {
		const contexts = [d1DeleteContext(accountId, databaseId, requestFields)];
		return handleD1Request(c, 'd1:delete', contexts, `/accounts/${accountId}/d1/database/${databaseId}`, 'DELETE', null, null, databaseId);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.delete', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});
