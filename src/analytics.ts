/**
 * D1-backed analytics for purge requests.
 * All writes are fire-and-forget via waitUntil() so they don't add latency.
 *
 * Schema source of truth: schema.sql (project root).
 */

import { PURGE_EVENTS_TABLE_SQL, PURGE_EVENTS_INDEX_ZONE_SQL, PURGE_EVENTS_INDEX_KEY_SQL } from './schema';
import { DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT } from './constants';

export interface PurgeEvent {
	key_id: string;
	zone_id: string;
	purge_type: string;
	/** Human-readable summary of the purge target — hosts, URLs, tags, prefixes, or "all". Truncated to 4 KB. */
	purge_target: string | null;
	/** Rate-limit tokens consumed by this request. For url purges: number of URLs. For bulk types: 1. */
	tokens: number;
	status: number;
	collapsed: string | false;
	upstream_status: number | null;
	duration_ms: number;
	created_at: number; // unix ms
	/** Truncated upstream response for debugging (CF API errors, etc.). */
	response_detail: string | null;
	/** Identity of the caller — 'via API key' for token auth, email for Access SSO. */
	created_by: string | null;
	/** Links a leader request to its collapsed followers — all share the same flight_id. */
	flight_id: string;
}

async function ensureTables(db: D1Database): Promise<void> {
	try {
		await db.batch([db.prepare(PURGE_EVENTS_TABLE_SQL), db.prepare(PURGE_EVENTS_INDEX_ZONE_SQL), db.prepare(PURGE_EVENTS_INDEX_KEY_SQL)]);
	} catch (e: any) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-ensure-tables-failed', error: e.message }));
		throw e;
	}
}

/**
 * Log a purge event to D1. Call via waitUntil() for zero latency impact.
 */
export async function logPurgeEvent(db: D1Database, event: PurgeEvent): Promise<void> {
	try {
		await ensureTables(db);
		await db
			.prepare(
				`INSERT INTO purge_events (key_id, zone_id, purge_type, purge_target, tokens, status, collapsed, upstream_status, duration_ms, response_detail, created_by, flight_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				event.key_id,
				event.zone_id,
				event.purge_type,
				event.purge_target,
				event.tokens,
				event.status,
				event.collapsed === false ? null : event.collapsed,
				event.upstream_status,
				event.duration_ms,
				event.response_detail,
				event.created_by,
				event.flight_id,
				event.created_at,
			)
			.run();
	} catch (e) {
		// Fire-and-forget: log but don't crash the request
		console.error(JSON.stringify({ error: 'analytics_write_failed', detail: (e as Error).message }));
	}
}

/** Delete purge events older than the given retention period. Returns the number of rows deleted. */
export async function deleteOldEvents(db: D1Database, retentionDays: number): Promise<number> {
	await ensureTables(db);
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const result = await db.prepare('DELETE FROM purge_events WHERE created_at < ?').bind(cutoff).run();
	return result.meta.changes ?? 0;
}

export interface AnalyticsQuery {
	zone_id?: string;
	key_id?: string;
	since?: number; // unix ms
	until?: number; // unix ms
	limit?: number;
}

export interface AnalyticsSummary {
	total_requests: number;
	total_urls_purged: number;
	by_status: Record<string, number>;
	by_purge_type: Record<string, number>;
	collapsed_count: number;
	avg_duration_ms: number;
}

/**
 * Query recent purge events.
 */
export async function queryEvents(db: D1Database, query: AnalyticsQuery): Promise<Record<string, unknown>[]> {
	await ensureTables(db);

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.zone_id) {
		conditions.push('zone_id = ?');
		params.push(query.zone_id);
	}
	if (query.key_id) {
		conditions.push('key_id = ?');
		params.push(query.key_id);
	}
	if (query.since) {
		conditions.push('created_at >= ?');
		params.push(query.since);
	}
	if (query.until) {
		conditions.push('created_at <= ?');
		params.push(query.until);
	}

	const limit = Math.min(query.limit ?? DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT);
	const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
	const sql = `SELECT * FROM purge_events${where} ORDER BY created_at DESC LIMIT ?`;
	params.push(limit);

	const result = await db
		.prepare(sql)
		.bind(...params)
		.all();
	return result.results as Record<string, unknown>[];
}

/**
 * Get summary analytics for a zone.
 */
export async function querySummary(db: D1Database, query: AnalyticsQuery): Promise<AnalyticsSummary> {
	await ensureTables(db);

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.zone_id) {
		conditions.push('zone_id = ?');
		params.push(query.zone_id);
	}
	if (query.key_id) {
		conditions.push('key_id = ?');
		params.push(query.key_id);
	}
	if (query.since) {
		conditions.push('created_at >= ?');
		params.push(query.since);
	}
	if (query.until) {
		conditions.push('created_at <= ?');
		params.push(query.until);
	}

	const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

	const [totalRow, statusRows, typeRows, collapsedRow, durationRow] = await db.batch([
		db.prepare(`SELECT COUNT(*) as cnt, SUM(tokens) as total_urls_purged FROM purge_events WHERE ${where}`).bind(...params),
		db.prepare(`SELECT status, COUNT(*) as cnt FROM purge_events WHERE ${where} GROUP BY status`).bind(...params),
		db.prepare(`SELECT purge_type, COUNT(*) as cnt FROM purge_events WHERE ${where} GROUP BY purge_type`).bind(...params),
		db.prepare(`SELECT COUNT(*) as cnt FROM purge_events WHERE ${where} AND collapsed IS NOT NULL`).bind(...params),
		db.prepare(`SELECT AVG(duration_ms) as avg_ms FROM purge_events WHERE ${where}`).bind(...params),
	]);

	const total = totalRow.results[0] as any;
	const byStatus: Record<string, number> = {};
	for (const row of statusRows.results as any[]) {
		byStatus[String(row.status)] = row.cnt;
	}
	const byType: Record<string, number> = {};
	for (const row of typeRows.results as any[]) {
		byType[row.purge_type] = row.cnt;
	}

	return {
		total_requests: total?.cnt ?? 0,
		total_urls_purged: total?.total_urls_purged ?? 0,
		by_status: byStatus,
		by_purge_type: byType,
		collapsed_count: (collapsedRow.results[0] as any)?.cnt ?? 0,
		avg_duration_ms: Math.round((durationRow.results[0] as any)?.avg_ms ?? 0),
	};
}
