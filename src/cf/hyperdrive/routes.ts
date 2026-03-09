/**
 * Hyperdrive API proxy routes.
 *
 * Mounted under `/cf/accounts/:accountId/hyperdrive` by the CF proxy router.
 * All endpoints use JSON — no special content types.
 */

import { Hono } from 'hono';
import { jsonServiceRoute } from '../service-handler';
import { cfJsonError } from '../proxy-helpers';
import { hyperdriveAccountContext, hyperdriveConfigContext } from './operations';
import type { CfProxyEnv } from '../router';

const SVC = 'hyperdrive';

export const hyperdriveRoutes = new Hono<CfProxyEnv>();

// ─── Config CRUD ────────────────────────────────────────────────────────────

hyperdriveRoutes.post('/configs', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'hyperdrive:create',
			[hyperdriveAccountContext(accountId, 'hyperdrive:create', rf)],
			`/accounts/${accountId}/hyperdrive/configs`,
			'POST',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'hyperdrive.create', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

hyperdriveRoutes.get('/configs', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'hyperdrive:list',
			[hyperdriveAccountContext(accountId, 'hyperdrive:list', rf)],
			`/accounts/${accountId}/hyperdrive/configs`,
			'GET',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'hyperdrive.list', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

hyperdriveRoutes.get('/configs/:hyperdriveId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const hyperdriveId = c.req.param('hyperdriveId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'hyperdrive:get',
			[hyperdriveConfigContext(accountId, hyperdriveId, 'hyperdrive:get', rf)],
			`/accounts/${accountId}/hyperdrive/configs/${hyperdriveId}`,
			'GET',
			hyperdriveId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'hyperdrive.get', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

hyperdriveRoutes.put('/configs/:hyperdriveId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const hyperdriveId = c.req.param('hyperdriveId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'hyperdrive:update',
			[hyperdriveConfigContext(accountId, hyperdriveId, 'hyperdrive:update', rf)],
			`/accounts/${accountId}/hyperdrive/configs/${hyperdriveId}`,
			'PUT',
			hyperdriveId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'hyperdrive.update', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

hyperdriveRoutes.patch('/configs/:hyperdriveId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const hyperdriveId = c.req.param('hyperdriveId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'hyperdrive:edit',
			[hyperdriveConfigContext(accountId, hyperdriveId, 'hyperdrive:edit', rf)],
			`/accounts/${accountId}/hyperdrive/configs/${hyperdriveId}`,
			'PATCH',
			hyperdriveId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'hyperdrive.edit', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

hyperdriveRoutes.delete('/configs/:hyperdriveId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const hyperdriveId = c.req.param('hyperdriveId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'hyperdrive:delete',
			[hyperdriveConfigContext(accountId, hyperdriveId, 'hyperdrive:delete', rf)],
			`/accounts/${accountId}/hyperdrive/configs/${hyperdriveId}`,
			'DELETE',
			hyperdriveId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'hyperdrive.delete', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});
