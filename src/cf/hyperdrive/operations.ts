/**
 * Hyperdrive request classification and IAM context building.
 *
 * Hyperdrive API surface (from CF API / SDK):
 *   POST   /accounts/:acct/hyperdrive/configs                     -> hyperdrive:create
 *   GET    /accounts/:acct/hyperdrive/configs                     -> hyperdrive:list
 *   GET    /accounts/:acct/hyperdrive/configs/:hyperdriveId       -> hyperdrive:get
 *   PUT    /accounts/:acct/hyperdrive/configs/:hyperdriveId       -> hyperdrive:update
 *   PATCH  /accounts/:acct/hyperdrive/configs/:hyperdriveId       -> hyperdrive:edit
 *   DELETE /accounts/:acct/hyperdrive/configs/:hyperdriveId       -> hyperdrive:delete
 */

import type { RequestContext } from '../../policy-types';

// ─── Hyperdrive IAM actions ─────────────────────────────────────────────────

export type HyperdriveAction =
	| 'hyperdrive:create'
	| 'hyperdrive:list'
	| 'hyperdrive:get'
	| 'hyperdrive:update'
	| 'hyperdrive:edit'
	| 'hyperdrive:delete';

// ─── Context builders ───────────────────────────────────────────────────────

/** Build a RequestContext for account-level hyperdrive operations (list, create). */
export function hyperdriveAccountContext(
	accountId: string,
	action: 'hyperdrive:list' | 'hyperdrive:create',
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action,
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/** Build a RequestContext for a config-scoped operation. */
export function hyperdriveConfigContext(
	accountId: string,
	hyperdriveId: string,
	action: HyperdriveAction,
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action,
		resource: `account:${accountId}/hyperdrive/${hyperdriveId}`,
		fields: {
			...(requestFields ?? {}),
			'hyperdrive.config_id': hyperdriveId,
		},
	};
}
