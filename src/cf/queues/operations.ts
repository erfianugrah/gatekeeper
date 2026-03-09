/**
 * Queues request classification and IAM context building.
 *
 * Queues API surface (from CF API / SDK):
 *   POST   /accounts/:acct/queues                                     -> queues:create
 *   GET    /accounts/:acct/queues                                     -> queues:list
 *   GET    /accounts/:acct/queues/:queueId                            -> queues:get
 *   PUT    /accounts/:acct/queues/:queueId                            -> queues:update
 *   PATCH  /accounts/:acct/queues/:queueId                            -> queues:edit
 *   DELETE /accounts/:acct/queues/:queueId                            -> queues:delete
 *   POST   /accounts/:acct/queues/:queueId/messages                   -> queues:push_message
 *   POST   /accounts/:acct/queues/:queueId/messages/batch             -> queues:bulk_push
 *   POST   /accounts/:acct/queues/:queueId/messages/pull              -> queues:pull_messages
 *   POST   /accounts/:acct/queues/:queueId/messages/ack               -> queues:ack_messages
 *   POST   /accounts/:acct/queues/:queueId/purge                      -> queues:purge
 *   GET    /accounts/:acct/queues/:queueId/purge                      -> queues:purge_status
 *   POST   /accounts/:acct/queues/:queueId/consumers                  -> queues:create_consumer
 *   GET    /accounts/:acct/queues/:queueId/consumers                  -> queues:list_consumers
 *   GET    /accounts/:acct/queues/:queueId/consumers/:consumerId      -> queues:get_consumer
 *   PUT    /accounts/:acct/queues/:queueId/consumers/:consumerId      -> queues:update_consumer
 *   DELETE /accounts/:acct/queues/:queueId/consumers/:consumerId      -> queues:delete_consumer
 */

import type { RequestContext } from '../../policy-types';

// ─── Queues IAM actions ─────────────────────────────────────────────────────

export type QueuesAction =
	| 'queues:create'
	| 'queues:list'
	| 'queues:get'
	| 'queues:update'
	| 'queues:edit'
	| 'queues:delete'
	| 'queues:push_message'
	| 'queues:bulk_push'
	| 'queues:pull_messages'
	| 'queues:ack_messages'
	| 'queues:purge'
	| 'queues:purge_status'
	| 'queues:create_consumer'
	| 'queues:list_consumers'
	| 'queues:get_consumer'
	| 'queues:update_consumer'
	| 'queues:delete_consumer';

// ─── Context builders ───────────────────────────────────────────────────────

/** Build a RequestContext for account-level queue operations (list, create). */
export function queuesAccountContext(
	accountId: string,
	action: 'queues:list' | 'queues:create',
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action,
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/** Build a RequestContext for a queue-scoped operation. */
export function queuesQueueContext(
	accountId: string,
	queueId: string,
	action: QueuesAction,
	requestFields?: Record<string, string>,
	extra?: Record<string, string>,
): RequestContext {
	const fields: Record<string, string | boolean> = {
		...(requestFields ?? {}),
		'queues.queue_id': queueId,
	};
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			fields[k] = v;
		}
	}
	return {
		action,
		resource: `account:${accountId}`,
		fields,
	};
}
