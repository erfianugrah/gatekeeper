/**
 * KV request classification and IAM context building.
 *
 * Maps incoming HTTP requests to KV IAM actions and extracts condition fields
 * for policy evaluation. Follows the same pattern as src/cf/d1/operations.ts.
 *
 * KV API surface (from CF API / SDK):
 *   POST   /accounts/:acct/storage/kv/namespaces                                       -> kv:create_namespace
 *   GET    /accounts/:acct/storage/kv/namespaces                                       -> kv:list_namespaces
 *   GET    /accounts/:acct/storage/kv/namespaces/:nsId                                 -> kv:get_namespace
 *   PUT    /accounts/:acct/storage/kv/namespaces/:nsId                                 -> kv:update_namespace
 *   DELETE /accounts/:acct/storage/kv/namespaces/:nsId                                 -> kv:delete_namespace
 *   GET    /accounts/:acct/storage/kv/namespaces/:nsId/keys                            -> kv:list_keys
 *   PUT    /accounts/:acct/storage/kv/namespaces/:nsId/values/:keyName                 -> kv:put_value
 *   GET    /accounts/:acct/storage/kv/namespaces/:nsId/values/:keyName                 -> kv:get_value
 *   DELETE /accounts/:acct/storage/kv/namespaces/:nsId/values/:keyName                 -> kv:delete_value
 *   GET    /accounts/:acct/storage/kv/namespaces/:nsId/metadata/:keyName               -> kv:get_metadata
 *   PUT    /accounts/:acct/storage/kv/namespaces/:nsId/bulk                            -> kv:bulk_write
 *   POST   /accounts/:acct/storage/kv/namespaces/:nsId/bulk/delete                     -> kv:bulk_delete
 *   POST   /accounts/:acct/storage/kv/namespaces/:nsId/bulk/get                        -> kv:bulk_get
 */

import type { RequestContext } from '../../policy-types';

// ─── KV IAM actions ─────────────────────────────────────────────────────────

export type KvAction =
	| 'kv:create_namespace'
	| 'kv:list_namespaces'
	| 'kv:get_namespace'
	| 'kv:update_namespace'
	| 'kv:delete_namespace'
	| 'kv:list_keys'
	| 'kv:put_value'
	| 'kv:get_value'
	| 'kv:delete_value'
	| 'kv:get_metadata'
	| 'kv:bulk_write'
	| 'kv:bulk_delete'
	| 'kv:bulk_get';

// ─── Context builders ───────────────────────────────────────────────────────

/** Build a RequestContext for listing namespaces (GET /storage/kv/namespaces). */
export function kvListNamespacesContext(accountId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'kv:list_namespaces',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/** Build a RequestContext for creating a namespace (POST /storage/kv/namespaces). */
export function kvCreateNamespaceContext(
	accountId: string,
	body: Record<string, unknown>,
	requestFields?: Record<string, string>,
): RequestContext {
	const fields: Record<string, string | boolean> = { ...(requestFields ?? {}) };
	if (typeof body.title === 'string') fields['kv.title'] = body.title;
	return {
		action: 'kv:create_namespace',
		resource: `account:${accountId}`,
		fields,
	};
}

/** Build a RequestContext for getting a single namespace (GET /storage/kv/namespaces/:nsId). */
export function kvGetNamespaceContext(accountId: string, namespaceId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'kv:get_namespace',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId },
	};
}

/** Build a RequestContext for updating/renaming a namespace (PUT /storage/kv/namespaces/:nsId). */
export function kvUpdateNamespaceContext(accountId: string, namespaceId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'kv:update_namespace',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId },
	};
}

/** Build a RequestContext for deleting a namespace (DELETE /storage/kv/namespaces/:nsId). */
export function kvDeleteNamespaceContext(accountId: string, namespaceId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'kv:delete_namespace',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId },
	};
}

/** Build a RequestContext for listing keys (GET /storage/kv/namespaces/:nsId/keys). */
export function kvListKeysContext(accountId: string, namespaceId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'kv:list_keys',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId },
	};
}

/** Build a RequestContext for writing a single value (PUT /storage/kv/namespaces/:nsId/values/:keyName). */
export function kvPutValueContext(
	accountId: string,
	namespaceId: string,
	keyName: string,
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action: 'kv:put_value',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId, 'kv.key_name': keyName },
	};
}

/** Build a RequestContext for reading a single value (GET /storage/kv/namespaces/:nsId/values/:keyName). */
export function kvGetValueContext(
	accountId: string,
	namespaceId: string,
	keyName: string,
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action: 'kv:get_value',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId, 'kv.key_name': keyName },
	};
}

/** Build a RequestContext for deleting a single value (DELETE /storage/kv/namespaces/:nsId/values/:keyName). */
export function kvDeleteValueContext(
	accountId: string,
	namespaceId: string,
	keyName: string,
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action: 'kv:delete_value',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId, 'kv.key_name': keyName },
	};
}

/** Build a RequestContext for getting key metadata (GET /storage/kv/namespaces/:nsId/metadata/:keyName). */
export function kvGetMetadataContext(
	accountId: string,
	namespaceId: string,
	keyName: string,
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action: 'kv:get_metadata',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId, 'kv.key_name': keyName },
	};
}

/** Build a RequestContext for bulk writing values (PUT /storage/kv/namespaces/:nsId/bulk). */
export function kvBulkWriteContext(accountId: string, namespaceId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'kv:bulk_write',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId },
	};
}

/** Build a RequestContext for bulk deleting keys (POST /storage/kv/namespaces/:nsId/bulk/delete). */
export function kvBulkDeleteContext(accountId: string, namespaceId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'kv:bulk_delete',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId },
	};
}

/** Build a RequestContext for bulk getting values (POST /storage/kv/namespaces/:nsId/bulk/get). */
export function kvBulkGetContext(accountId: string, namespaceId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'kv:bulk_get',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'kv.namespace_id': namespaceId },
	};
}
