/**
 * Vectorize request classification and IAM context building.
 *
 * Vectorize API surface (from CF API / SDK):
 *   POST   /accounts/:acct/vectorize/v2/indexes                                      -> vectorize:create_index
 *   GET    /accounts/:acct/vectorize/v2/indexes                                      -> vectorize:list_indexes
 *   GET    /accounts/:acct/vectorize/v2/indexes/:indexName                            -> vectorize:get_index
 *   DELETE /accounts/:acct/vectorize/v2/indexes/:indexName                            -> vectorize:delete_index
 *   GET    /accounts/:acct/vectorize/v2/indexes/:indexName/info                       -> vectorize:get_info
 *   POST   /accounts/:acct/vectorize/v2/indexes/:indexName/query                     -> vectorize:query
 *   POST   /accounts/:acct/vectorize/v2/indexes/:indexName/insert                    -> vectorize:insert        (ndjson binary)
 *   POST   /accounts/:acct/vectorize/v2/indexes/:indexName/upsert                    -> vectorize:upsert        (ndjson binary)
 *   POST   /accounts/:acct/vectorize/v2/indexes/:indexName/get_by_ids                -> vectorize:get_by_ids
 *   POST   /accounts/:acct/vectorize/v2/indexes/:indexName/delete_by_ids             -> vectorize:delete_by_ids
 *   GET    /accounts/:acct/vectorize/v2/indexes/:indexName/list                       -> vectorize:list_vectors
 *   POST   /accounts/:acct/vectorize/v2/indexes/:indexName/metadata_index/create     -> vectorize:create_metadata_index
 *   GET    /accounts/:acct/vectorize/v2/indexes/:indexName/metadata_index/list        -> vectorize:list_metadata_indexes
 *   POST   /accounts/:acct/vectorize/v2/indexes/:indexName/metadata_index/delete     -> vectorize:delete_metadata_index
 */

import type { RequestContext } from '../../policy-types';

// ─── Vectorize IAM actions ──────────────────────────────────────────────────

export type VectorizeAction =
	| 'vectorize:create_index'
	| 'vectorize:list_indexes'
	| 'vectorize:get_index'
	| 'vectorize:delete_index'
	| 'vectorize:get_info'
	| 'vectorize:query'
	| 'vectorize:insert'
	| 'vectorize:upsert'
	| 'vectorize:get_by_ids'
	| 'vectorize:delete_by_ids'
	| 'vectorize:list_vectors'
	| 'vectorize:create_metadata_index'
	| 'vectorize:list_metadata_indexes'
	| 'vectorize:delete_metadata_index';

// ─── Context builders ───────────────────────────────────────────────────────

/** Build a RequestContext for account-level vectorize operations (list, create). */
export function vectorizeAccountContext(
	accountId: string,
	action: 'vectorize:list_indexes' | 'vectorize:create_index',
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action,
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/** Build a RequestContext for an index-scoped operation. */
export function vectorizeIndexContext(
	accountId: string,
	indexName: string,
	action: VectorizeAction,
	requestFields?: Record<string, string>,
): RequestContext {
	return {
		action,
		resource: `account:${accountId}`,
		fields: {
			...(requestFields ?? {}),
			'vectorize.index_name': indexName,
		},
	};
}
