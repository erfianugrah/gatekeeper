/**
 * D1-backed analytics for Supabase proxy requests (Management API + Metrics).
 * All writes are fire-and-forget via waitUntil() so they don't add latency.
 *
 * NOTE: do NOT add a module-level `tablesInitialized` flag to ensureTables() — see the
 * "Known Pitfalls" note in AGENTS.md. CREATE TABLE IF NOT EXISTS is a cheap no-op and must
 * run per call so each vitest-pool-workers D1 instance gets its tables.
 */

import {
	SUPABASE_PROXY_EVENTS_TABLE_SQL,
	SUPABASE_PROXY_EVENTS_INDEX_KEY_SQL,
	SUPABASE_PROXY_EVENTS_INDEX_REF_SQL,
	SUPABASE_PROXY_EVENTS_INDEX_ACTION_SQL,
} from '../schema';
import type { SupabaseCategory } from './constants';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SupabaseProxyEvent {
	key_id: string;
	project_ref: string | null;
	category: SupabaseCategory;
	/** Full action string, e.g. 'supabase:database:write'. */
	action: string;
	status: number;
	upstream_status: number | null;
	duration_ms: number;
	/** Time spent waiting for the Supabase upstream response (ms). */
	upstream_latency_ms: number | null;
	/** Response body size in bytes (null for streamed passthrough). */
	response_size: number | null;
	response_detail: string | null;
	created_by: string | null;
	created_at: number; // unix ms
}

export interface SupabaseProxyAnalyticsQuery {
	project_ref?: string;
	key_id?: string;
	category?: string;
	action?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export interface SupabaseProxyAnalyticsSummary {
	total_requests: number;
	by_status: Record<string, number>;
	by_category: Record<string, number>;
	by_action: Record<string, number>;
	avg_duration_ms: number;
	avg_upstream_latency_ms: number;
	avg_response_size: number;
}

// ─── Table init ─────────────────────────────────────────────────────────────

async function ensureTables(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(SUPABASE_PROXY_EVENTS_TABLE_SQL),
		db.prepare(SUPABASE_PROXY_EVENTS_INDEX_KEY_SQL),
		db.prepare(SUPABASE_PROXY_EVENTS_INDEX_REF_SQL),
		db.prepare(SUPABASE_PROXY_EVENTS_INDEX_ACTION_SQL),
	]);
}

// ─── Write ──────────────────────────────────────────────────────────────────

/** Log a Supabase proxy event to D1. Call via waitUntil() for zero latency impact. */
export async function logSupabaseProxyEvent(db: D1Database, event: SupabaseProxyEvent): Promise<void> {
	try {
		await ensureTables(db);
		await db
			.prepare(
				`INSERT INTO supabase_proxy_events (key_id, project_ref, category, action, status, upstream_status, duration_ms, upstream_latency_ms, response_size, response_detail, created_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				event.key_id,
				event.project_ref,
				event.category,
				event.action,
				event.status,
				event.upstream_status,
				event.duration_ms,
				event.upstream_latency_ms,
				event.response_size,
				event.response_detail,
				event.created_by,
				event.created_at,
			)
			.run();
	} catch (e) {
		console.error(JSON.stringify({ error: 'supabase_proxy_analytics_write_failed', detail: (e as Error).message }));
	}
}

// ─── Retention ──────────────────────────────────────────────────────────────

/** Delete Supabase proxy events older than the given retention period. Returns rows deleted. */
export async function deleteOldSupabaseProxyEvents(db: D1Database, retentionDays: number): Promise<number> {
	await ensureTables(db);
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const result = await db.prepare('DELETE FROM supabase_proxy_events WHERE created_at < ?').bind(cutoff).run();
	return result.meta.changes ?? 0;
}

// ─── Query ──────────────────────────────────────────────────────────────────

function buildWhere(query: SupabaseProxyAnalyticsQuery): { where: string; params: (string | number)[] } {
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	if (query.project_ref) {
		conditions.push('project_ref = ?');
		params.push(query.project_ref);
	}
	if (query.key_id) {
		conditions.push('key_id = ?');
		params.push(query.key_id);
	}
	if (query.category) {
		conditions.push('category = ?');
		params.push(query.category);
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
	return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** Query recent Supabase proxy events. */
export async function querySupabaseProxyEvents(db: D1Database, query: SupabaseProxyAnalyticsQuery): Promise<Record<string, unknown>[]> {
	await ensureTables(db);
	const { where, params } = buildWhere(query);
	const limit = Math.min(query.limit ?? 100, 1000);
	const sql = `SELECT * FROM supabase_proxy_events ${where} ORDER BY created_at DESC LIMIT ?`;
	const result = await db
		.prepare(sql)
		.bind(...params, limit)
		.all();
	return result.results as Record<string, unknown>[];
}

/** Get summary analytics for Supabase proxy operations. */
export async function querySupabaseProxySummary(
	db: D1Database,
	query: SupabaseProxyAnalyticsQuery,
): Promise<SupabaseProxyAnalyticsSummary> {
	await ensureTables(db);
	const { where, params } = buildWhere(query);

	const [totalRow, statusRows, categoryRows, actionRows, avgRow] = await db.batch([
		db.prepare(`SELECT COUNT(*) as cnt FROM supabase_proxy_events ${where}`).bind(...params),
		db.prepare(`SELECT status, COUNT(*) as cnt FROM supabase_proxy_events ${where} GROUP BY status`).bind(...params),
		db
			.prepare(`SELECT category, COUNT(*) as cnt FROM supabase_proxy_events ${where} GROUP BY category ORDER BY cnt DESC LIMIT 20`)
			.bind(...params),
		db
			.prepare(`SELECT action, COUNT(*) as cnt FROM supabase_proxy_events ${where} GROUP BY action ORDER BY cnt DESC LIMIT 20`)
			.bind(...params),
		db
			.prepare(
				`SELECT AVG(duration_ms) as avg_ms, AVG(upstream_latency_ms) as avg_upstream_ms, AVG(response_size) as avg_resp_size FROM supabase_proxy_events ${where}`,
			)
			.bind(...params),
	]);

	const total = totalRow.results[0] as any;
	const byStatus: Record<string, number> = {};
	for (const row of statusRows.results as any[]) byStatus[String(row.status)] = row.cnt;
	const byCategory: Record<string, number> = {};
	for (const row of categoryRows.results as any[]) byCategory[row.category] = row.cnt;
	const byAction: Record<string, number> = {};
	for (const row of actionRows.results as any[]) byAction[row.action] = row.cnt;

	const avg = avgRow.results[0] as any;
	return {
		total_requests: total?.cnt ?? 0,
		by_status: byStatus,
		by_category: byCategory,
		by_action: byAction,
		avg_duration_ms: Math.round(avg?.avg_ms ?? 0),
		avg_upstream_latency_ms: Math.round(avg?.avg_upstream_ms ?? 0),
		avg_response_size: Math.round(avg?.avg_resp_size ?? 0),
	};
}
