/**
 * D1 API proxy routes.
 *
 * Proxies requests to the Cloudflare D1 API with per-database policy enforcement.
 * Mounted under `/cf/accounts/:accountId/d1` by the CF proxy router.
 *
 * Uses the shared `handleCfServiceRequest` / `jsonServiceRoute` from service-handler.ts
 * to eliminate duplicated auth + proxy + analytics boilerplate.
 *
 * Routes that need to peek at the request body (query, raw, create) use
 * `handleCfServiceRequest` directly to avoid double-reading the stream.
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
import { handleCfServiceRequest, jsonServiceRoute } from '../service-handler';
import { cfJsonError } from '../proxy-helpers';
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

// ─── Route ──────────────────────────────────────────────────────────────────

export const d1Routes = new Hono<CfProxyEnv>();

// ─── Create database ────────────────────────────────────────────────────────
// Reads body to build policy context fields, then passes pre-read body to handler.

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
		return handleCfServiceRequest(
			c,
			'd1',
			'd1:create',
			contexts,
			`/accounts/${accountId}/d1/database`,
			'POST',
			bodyText,
			'application/json',
		);
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
		return jsonServiceRoute(c, 'd1', 'd1:list', contexts, `/accounts/${accountId}/d1/database`, 'GET');
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
		const contexts = [d1ExportContext(accountId, databaseId, requestFields)];
		return jsonServiceRoute(c, 'd1', 'd1:export', contexts, `/accounts/${accountId}/d1/database/${databaseId}/export`, 'POST', databaseId);
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
		const contexts = [d1ImportContext(accountId, databaseId, requestFields)];
		return jsonServiceRoute(c, 'd1', 'd1:import', contexts, `/accounts/${accountId}/d1/database/${databaseId}/import`, 'POST', databaseId);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.import', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Query database ─────────────────────────────────────────────────────────
// Reads body to extract SQL for policy context, then passes pre-read body to handler.

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
		return handleCfServiceRequest(
			c,
			'd1',
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
// Reads body to extract SQL for policy context, then passes pre-read body to handler.

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
		return handleCfServiceRequest(
			c,
			'd1',
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
		return jsonServiceRoute(
			c,
			'd1',
			'd1:time_travel',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}/time_travel/bookmark`,
			'GET',
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
		const contexts = [d1TimeTravelContext(accountId, databaseId, requestFields)];
		return jsonServiceRoute(
			c,
			'd1',
			'd1:time_travel',
			contexts,
			`/accounts/${accountId}/d1/database/${databaseId}/time_travel/restore`,
			'POST',
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
		return jsonServiceRoute(c, 'd1', 'd1:get', contexts, `/accounts/${accountId}/d1/database/${databaseId}`, 'GET', databaseId);
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
		const contexts = [d1UpdateContext(accountId, databaseId, requestFields)];
		return jsonServiceRoute(c, 'd1', 'd1:update', contexts, `/accounts/${accountId}/d1/database/${databaseId}`, 'PUT', databaseId);
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
		const contexts = [d1UpdateContext(accountId, databaseId, requestFields)];
		return jsonServiceRoute(c, 'd1', 'd1:update', contexts, `/accounts/${accountId}/d1/database/${databaseId}`, 'PATCH', databaseId);
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
		return jsonServiceRoute(c, 'd1', 'd1:delete', contexts, `/accounts/${accountId}/d1/database/${databaseId}`, 'DELETE', databaseId);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'd1.delete', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});
