/**
 * D1-backed analytics for CF API proxy requests.
 * Unified table for all proxied services (D1, KV, Workers, Queues, etc.).
 * All writes are fire-and-forget via waitUntil() so they don't add latency.
 */

import {
	CF_PROXY_EVENTS_TABLE_SQL,
	CF_PROXY_EVENTS_INDEX_KEY_SQL,
	CF_PROXY_EVENTS_INDEX_ACCOUNT_SQL,
	CF_PROXY_EVENTS_INDEX_SERVICE_SQL,
} from '../schema';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CfProxyEvent {
	key_id: string;
	account_id: string;
	/** Service domain: 'd1', 'kv', 'workers', 'queues', 'vectorize', 'hyperdrive'. */
	service: string;
	/** Full action string, e.g. 'd1:query', 'kv:write', 'workers:deploy'. */
	action: string;
	/** Specific resource ID: database ID, namespace ID, script name, etc. */
	resource_id: string | null;
	status: number;
	upstream_status: number | null;
	duration_ms: number;
	created_at: number; // unix ms
	response_detail: string | null;
	created_by: string | null;
}

export interface CfProxyAnalyticsQuery {
	account_id?: string;
	key_id?: string;
	service?: string;
	action?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export interface CfProxyAnalyticsSummary {
	total_requests: number;
	by_status: Record<string, number>;
	by_service: Record<string, number>;
	by_action: Record<string, number>;
	avg_duration_ms: number;
}

// ─── Table init ─────────────────────────────────────────────────────────────

async function ensureTables(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(CF_PROXY_EVENTS_TABLE_SQL),
		db.prepare(CF_PROXY_EVENTS_INDEX_KEY_SQL),
		db.prepare(CF_PROXY_EVENTS_INDEX_ACCOUNT_SQL),
		db.prepare(CF_PROXY_EVENTS_INDEX_SERVICE_SQL),
	]);
}

// ─── Write ──────────────────────────────────────────────────────────────────

/** Log a CF proxy event to D1. Call via waitUntil() for zero latency impact. */
export async function logCfProxyEvent(db: D1Database, event: CfProxyEvent): Promise<void> {
	try {
		await ensureTables(db);
		await db
			.prepare(
				`INSERT INTO cf_proxy_events (key_id, account_id, service, action, resource_id, status, upstream_status, duration_ms, response_detail, created_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				event.key_id,
				event.account_id,
				event.service,
				event.action,
				event.resource_id,
				event.status,
				event.upstream_status,
				event.duration_ms,
				event.response_detail,
				event.created_by,
				event.created_at,
			)
			.run();
	} catch (e) {
		console.error(JSON.stringify({ error: 'cf_proxy_analytics_write_failed', detail: (e as Error).message }));
	}
}

// ─── Retention ──────────────────────────────────────────────────────────────

/** Delete CF proxy events older than the given retention period. Returns the number of rows deleted. */
export async function deleteOldCfProxyEvents(db: D1Database, retentionDays: number): Promise<number> {
	await ensureTables(db);
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const result = await db.prepare('DELETE FROM cf_proxy_events WHERE created_at < ?').bind(cutoff).run();
	return result.meta.changes ?? 0;
}

// ─── Query ──────────────────────────────────────────────────────────────────

/** Query recent CF proxy events. */
export async function queryCfProxyEvents(db: D1Database, query: CfProxyAnalyticsQuery): Promise<Record<string, unknown>[]> {
	await ensureTables(db);

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.account_id) {
		conditions.push('account_id = ?');
		params.push(query.account_id);
	}
	if (query.key_id) {
		conditions.push('key_id = ?');
		params.push(query.key_id);
	}
	if (query.service) {
		conditions.push('service = ?');
		params.push(query.service);
	}
	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}
	if (query.since) {
		conditions.push('created_at >= ?');
		params.push(query.since);
	}
	if (query.until) {
		conditions.push('created_at <= ?');
		params.push(query.until);
	}

	const limit = Math.min(query.limit ?? 100, 1000);
	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const sql = `SELECT * FROM cf_proxy_events ${where} ORDER BY created_at DESC LIMIT ?`;
	params.push(limit);

	const result = await db
		.prepare(sql)
		.bind(...params)
		.all();
	return result.results as Record<string, unknown>[];
}

/** Get summary analytics for CF proxy operations. */
export async function queryCfProxySummary(db: D1Database, query: CfProxyAnalyticsQuery): Promise<CfProxyAnalyticsSummary> {
	await ensureTables(db);

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.account_id) {
		conditions.push('account_id = ?');
		params.push(query.account_id);
	}
	if (query.key_id) {
		conditions.push('key_id = ?');
		params.push(query.key_id);
	}
	if (query.service) {
		conditions.push('service = ?');
		params.push(query.service);
	}
	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}
	if (query.since) {
		conditions.push('created_at >= ?');
		params.push(query.since);
	}
	if (query.until) {
		conditions.push('created_at <= ?');
		params.push(query.until);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	const [totalRow, statusRows, serviceRows, actionRows, durationRow] = await db.batch([
		db.prepare(`SELECT COUNT(*) as cnt FROM cf_proxy_events ${where}`).bind(...params),
		db.prepare(`SELECT status, COUNT(*) as cnt FROM cf_proxy_events ${where} GROUP BY status`).bind(...params),
		db.prepare(`SELECT service, COUNT(*) as cnt FROM cf_proxy_events ${where} GROUP BY service ORDER BY cnt DESC LIMIT 20`).bind(...params),
		db.prepare(`SELECT action, COUNT(*) as cnt FROM cf_proxy_events ${where} GROUP BY action ORDER BY cnt DESC LIMIT 20`).bind(...params),
		db.prepare(`SELECT AVG(duration_ms) as avg_ms FROM cf_proxy_events ${where}`).bind(...params),
	]);

	const total = totalRow.results[0] as any;
	const byStatus: Record<string, number> = {};
	for (const row of statusRows.results as any[]) {
		byStatus[String(row.status)] = row.cnt;
	}
	const byService: Record<string, number> = {};
	for (const row of serviceRows.results as any[]) {
		byService[row.service] = row.cnt;
	}
	const byAction: Record<string, number> = {};
	for (const row of actionRows.results as any[]) {
		byAction[row.action] = row.cnt;
	}

	return {
		total_requests: total?.cnt ?? 0,
		by_status: byStatus,
		by_service: byService,
		by_action: byAction,
		avg_duration_ms: Math.round((durationRow.results[0] as any)?.avg_ms ?? 0),
	};
}
