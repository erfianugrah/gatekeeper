/**
 * Queues API proxy routes.
 *
 * Mounted under `/cf/accounts/:accountId/queues` by the CF proxy router.
 * All endpoints use JSON — no special content types.
 */

import { Hono } from 'hono';
import { jsonServiceRoute } from '../service-handler';
import { cfJsonError } from '../proxy-helpers';
import { queuesAccountContext, queuesQueueContext } from './operations';
import type { CfProxyEnv } from '../router';

const SVC = 'queues';

export const queuesRoutes = new Hono<CfProxyEnv>();

// ─── Queue CRUD ─────────────────────────────────────────────────────────────

queuesRoutes.post('/', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:create',
			[queuesAccountContext(accountId, 'queues:create', rf)],
			`/accounts/${accountId}/queues`,
			'POST',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.create', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.get('/', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:list',
			[queuesAccountContext(accountId, 'queues:list', rf)],
			`/accounts/${accountId}/queues`,
			'GET',
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.list', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.get('/:queueId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:get',
			[queuesQueueContext(accountId, queueId, 'queues:get', rf)],
			`/accounts/${accountId}/queues/${queueId}`,
			'GET',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.get', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.put('/:queueId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:update',
			[queuesQueueContext(accountId, queueId, 'queues:update', rf)],
			`/accounts/${accountId}/queues/${queueId}`,
			'PUT',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.update', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.patch('/:queueId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:edit',
			[queuesQueueContext(accountId, queueId, 'queues:edit', rf)],
			`/accounts/${accountId}/queues/${queueId}`,
			'PATCH',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.edit', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.delete('/:queueId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:delete',
			[queuesQueueContext(accountId, queueId, 'queues:delete', rf)],
			`/accounts/${accountId}/queues/${queueId}`,
			'DELETE',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.delete', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Messages ───────────────────────────────────────────────────────────────

queuesRoutes.post('/:queueId/messages', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:push_message',
			[queuesQueueContext(accountId, queueId, 'queues:push_message', rf)],
			`/accounts/${accountId}/queues/${queueId}/messages`,
			'POST',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.push_message', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.post('/:queueId/messages/batch', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:bulk_push',
			[queuesQueueContext(accountId, queueId, 'queues:bulk_push', rf)],
			`/accounts/${accountId}/queues/${queueId}/messages/batch`,
			'POST',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.bulk_push', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.post('/:queueId/messages/pull', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:pull_messages',
			[queuesQueueContext(accountId, queueId, 'queues:pull_messages', rf)],
			`/accounts/${accountId}/queues/${queueId}/messages/pull`,
			'POST',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.pull_messages', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.post('/:queueId/messages/ack', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:ack_messages',
			[queuesQueueContext(accountId, queueId, 'queues:ack_messages', rf)],
			`/accounts/${accountId}/queues/${queueId}/messages/ack`,
			'POST',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.ack_messages', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Purge ──────────────────────────────────────────────────────────────────

queuesRoutes.post('/:queueId/purge', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:purge',
			[queuesQueueContext(accountId, queueId, 'queues:purge', rf)],
			`/accounts/${accountId}/queues/${queueId}/purge`,
			'POST',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.purge', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.get('/:queueId/purge', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:purge_status',
			[queuesQueueContext(accountId, queueId, 'queues:purge_status', rf)],
			`/accounts/${accountId}/queues/${queueId}/purge`,
			'GET',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.purge_status', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

// ─── Consumers ──────────────────────────────────────────────────────────────

queuesRoutes.post('/:queueId/consumers', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:create_consumer',
			[queuesQueueContext(accountId, queueId, 'queues:create_consumer', rf)],
			`/accounts/${accountId}/queues/${queueId}/consumers`,
			'POST',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.create_consumer', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.get('/:queueId/consumers', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:list_consumers',
			[queuesQueueContext(accountId, queueId, 'queues:list_consumers', rf)],
			`/accounts/${accountId}/queues/${queueId}/consumers`,
			'GET',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.list_consumers', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.get('/:queueId/consumers/:consumerId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	const consumerId = c.req.param('consumerId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:get_consumer',
			[queuesQueueContext(accountId, queueId, 'queues:get_consumer', rf, { 'queues.consumer_id': consumerId })],
			`/accounts/${accountId}/queues/${queueId}/consumers/${consumerId}`,
			'GET',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.get_consumer', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.put('/:queueId/consumers/:consumerId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	const consumerId = c.req.param('consumerId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:update_consumer',
			[queuesQueueContext(accountId, queueId, 'queues:update_consumer', rf, { 'queues.consumer_id': consumerId })],
			`/accounts/${accountId}/queues/${queueId}/consumers/${consumerId}`,
			'PUT',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.update_consumer', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});

queuesRoutes.delete('/:queueId/consumers/:consumerId', async (c) => {
	const accountId: string = c.get('accountId');
	const rf: Record<string, string> = c.get('requestFields');
	const queueId = c.req.param('queueId');
	const consumerId = c.req.param('consumerId');
	try {
		return jsonServiceRoute(
			c,
			SVC,
			'queues:delete_consumer',
			[queuesQueueContext(accountId, queueId, 'queues:delete_consumer', rf, { 'queues.consumer_id': consumerId })],
			`/accounts/${accountId}/queues/${queueId}/consumers/${consumerId}`,
			'DELETE',
			queueId,
		);
	} catch (e: any) {
		console.error(JSON.stringify({ route: 'queues.delete_consumer', error: e.message, ts: new Date().toISOString() }));
		return cfJsonError(500, 'Internal server error');
	}
});
