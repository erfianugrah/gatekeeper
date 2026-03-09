/**
 * D1 request classification and IAM context building.
 *
 * Maps incoming HTTP requests to D1 IAM actions and extracts condition fields
 * for policy evaluation. Follows the same pattern as src/dns/operations.ts.
 *
 * D1 API surface (from CF API / SDK):
 *   POST   /accounts/:acct/d1/database                                   -> d1:create
 *   GET    /accounts/:acct/d1/database                                   -> d1:list
 *   GET    /accounts/:acct/d1/database/:dbId                             -> d1:get
 *   PUT    /accounts/:acct/d1/database/:dbId                             -> d1:update
 *   PATCH  /accounts/:acct/d1/database/:dbId                             -> d1:update
 *   DELETE /accounts/:acct/d1/database/:dbId                             -> d1:delete
 *   POST   /accounts/:acct/d1/database/:dbId/query                      -> d1:query
 *   POST   /accounts/:acct/d1/database/:dbId/raw                        -> d1:raw
 *   POST   /accounts/:acct/d1/database/:dbId/export                     -> d1:export
 *   POST   /accounts/:acct/d1/database/:dbId/import                     -> d1:import
 *   GET    /accounts/:acct/d1/database/:dbId/time_travel/bookmark       -> d1:time_travel
 *   POST   /accounts/:acct/d1/database/:dbId/time_travel/restore        -> d1:time_travel
 */

import type { RequestContext } from '../../policy-types';

// ─── D1 IAM actions ─────────────────────────────────────────────────────────

export type D1Action =
	| 'd1:create'
	| 'd1:list'
	| 'd1:get'
	| 'd1:update'
	| 'd1:delete'
	| 'd1:query'
	| 'd1:raw'
	| 'd1:export'
	| 'd1:import'
	| 'd1:time_travel';

// ─── SQL command classification ─────────────────────────────────────────────

/** Broad SQL command category for policy conditions. */
export type SqlCommandType = 'select' | 'insert' | 'update' | 'delete' | 'create' | 'drop' | 'alter' | 'pragma' | 'other';

/** Classify the first SQL command in a query string. Used for d1:query / d1:raw conditions. */
export function classifySqlCommand(sql: string): SqlCommandType {
	const trimmed = sql.trimStart().toUpperCase();
	if (trimmed.startsWith('SELECT')) return 'select';
	if (trimmed.startsWith('INSERT')) return 'insert';
	if (trimmed.startsWith('UPDATE')) return 'update';
	if (trimmed.startsWith('DELETE')) return 'delete';
	if (trimmed.startsWith('CREATE')) return 'create';
	if (trimmed.startsWith('DROP')) return 'drop';
	if (trimmed.startsWith('ALTER')) return 'alter';
	if (trimmed.startsWith('PRAGMA')) return 'pragma';
	return 'other';
}

// ─── Context builders ───────────────────────────────────────────────────────

/** Build a RequestContext for listing databases (GET /d1/database). */
export function d1ListContext(accountId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'd1:list',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}) },
	};
}

/** Build a RequestContext for creating a database (POST /d1/database). */
export function d1CreateContext(accountId: string, body: Record<string, unknown>, requestFields?: Record<string, string>): RequestContext {
	const fields: Record<string, string | boolean> = { ...(requestFields ?? {}) };
	if (typeof body.name === 'string') fields['d1.name'] = body.name;
	return {
		action: 'd1:create',
		resource: `account:${accountId}`,
		fields,
	};
}

/** Build a RequestContext for getting a single database (GET /d1/database/:dbId). */
export function d1GetContext(accountId: string, databaseId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'd1:get',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'd1.database_id': databaseId },
	};
}

/** Build a RequestContext for updating a database (PUT or PATCH /d1/database/:dbId). */
export function d1UpdateContext(accountId: string, databaseId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'd1:update',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'd1.database_id': databaseId },
	};
}

/** Build a RequestContext for deleting a database (DELETE /d1/database/:dbId). */
export function d1DeleteContext(accountId: string, databaseId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'd1:delete',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'd1.database_id': databaseId },
	};
}

/** Build a RequestContext for querying a database (POST /d1/database/:dbId/query). */
export function d1QueryContext(
	accountId: string,
	databaseId: string,
	sql: string | undefined,
	requestFields?: Record<string, string>,
): RequestContext {
	const fields: Record<string, string | boolean> = { ...(requestFields ?? {}), 'd1.database_id': databaseId };
	if (sql) {
		fields['d1.sql_command'] = classifySqlCommand(sql);
	}
	return {
		action: 'd1:query',
		resource: `account:${accountId}`,
		fields,
	};
}

/** Build a RequestContext for raw querying (POST /d1/database/:dbId/raw). */
export function d1RawContext(
	accountId: string,
	databaseId: string,
	sql: string | undefined,
	requestFields?: Record<string, string>,
): RequestContext {
	const fields: Record<string, string | boolean> = { ...(requestFields ?? {}), 'd1.database_id': databaseId };
	if (sql) {
		fields['d1.sql_command'] = classifySqlCommand(sql);
	}
	return {
		action: 'd1:raw',
		resource: `account:${accountId}`,
		fields,
	};
}

/** Build a RequestContext for exporting a database (POST /d1/database/:dbId/export). */
export function d1ExportContext(accountId: string, databaseId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'd1:export',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'd1.database_id': databaseId },
	};
}

/** Build a RequestContext for importing to a database (POST /d1/database/:dbId/import). */
export function d1ImportContext(accountId: string, databaseId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'd1:import',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'd1.database_id': databaseId },
	};
}

/** Build a RequestContext for time travel operations (GET bookmark, POST restore). */
export function d1TimeTravelContext(accountId: string, databaseId: string, requestFields?: Record<string, string>): RequestContext {
	return {
		action: 'd1:time_travel',
		resource: `account:${accountId}`,
		fields: { ...(requestFields ?? {}), 'd1.database_id': databaseId },
	};
}
