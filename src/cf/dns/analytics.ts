/**
 * D1-backed analytics for DNS proxy requests.
 * All writes are fire-and-forget via waitUntil() so they don't add latency.
 */

import { DNS_EVENTS_TABLE_SQL, DNS_EVENTS_INDEX_KEY_SQL, DNS_EVENTS_INDEX_ZONE_SQL } from '../../schema';

export interface DnsEvent {
	key_id: string;
	zone_id: string;
	action: string;
	record_name: string | null;
	record_type: string | null;
	status: number;
	upstream_status: number | null;
	duration_ms: number;
	created_at: number; // unix ms
	response_detail: string | null;
	created_by: string | null;
}

async function ensureTables(db: D1Database): Promise<void> {
	await db.batch([db.prepare(DNS_EVENTS_TABLE_SQL), db.prepare(DNS_EVENTS_INDEX_KEY_SQL), db.prepare(DNS_EVENTS_INDEX_ZONE_SQL)]);
}

/** Log a DNS event to D1. Call via waitUntil() for zero latency impact. */
export async function logDnsEvent(db: D1Database, event: DnsEvent): Promise<void> {
	try {
		await ensureTables(db);
		await db
			.prepare(
				`INSERT INTO dns_events (key_id, zone_id, action, record_name, record_type, status, upstream_status, duration_ms, response_detail, created_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				event.key_id,
				event.zone_id,
				event.action,
				event.record_name,
				event.record_type,
				event.status,
				event.upstream_status,
				event.duration_ms,
				event.response_detail,
				event.created_by,
				event.created_at,
			)
			.run();
	} catch (e) {
		console.error(JSON.stringify({ error: 'dns_analytics_write_failed', detail: (e as Error).message }));
	}
}

/** Delete DNS events older than the given retention period. Returns the number of rows deleted. */
export async function deleteOldDnsEvents(db: D1Database, retentionDays: number): Promise<number> {
	await ensureTables(db);
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const result = await db.prepare('DELETE FROM dns_events WHERE created_at < ?').bind(cutoff).run();
	return result.meta.changes ?? 0;
}

export interface DnsAnalyticsQuery {
	zone_id?: string;
	key_id?: string;
	action?: string;
	record_type?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export interface DnsAnalyticsSummary {
	total_requests: number;
	by_status: Record<string, number>;
	by_action: Record<string, number>;
	by_record_type: Record<string, number>;
	avg_duration_ms: number;
}

/** Query recent DNS events. */
export async function queryDnsEvents(db: D1Database, query: DnsAnalyticsQuery): Promise<Record<string, unknown>[]> {
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
	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}
	if (query.record_type) {
		conditions.push('record_type = ?');
		params.push(query.record_type);
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
	const sql = `SELECT * FROM dns_events ${where} ORDER BY created_at DESC LIMIT ?`;
	params.push(limit);

	const result = await db
		.prepare(sql)
		.bind(...params)
		.all();
	return result.results as Record<string, unknown>[];
}

/** Get summary analytics for DNS operations. */
export async function queryDnsSummary(db: D1Database, query: DnsAnalyticsQuery): Promise<DnsAnalyticsSummary> {
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
	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}
	if (query.record_type) {
		conditions.push('record_type = ?');
		params.push(query.record_type);
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

	const [totalRow, statusRows, actionRows, typeRows, durationRow] = await db.batch([
		db.prepare(`SELECT COUNT(*) as cnt FROM dns_events ${where}`).bind(...params),
		db.prepare(`SELECT status, COUNT(*) as cnt FROM dns_events ${where} GROUP BY status`).bind(...params),
		db.prepare(`SELECT action, COUNT(*) as cnt FROM dns_events ${where} GROUP BY action ORDER BY cnt DESC LIMIT 20`).bind(...params),
		db
			.prepare(`SELECT record_type, COUNT(*) as cnt FROM dns_events ${where} GROUP BY record_type ORDER BY cnt DESC LIMIT 20`)
			.bind(...params),
		db.prepare(`SELECT AVG(duration_ms) as avg_ms FROM dns_events ${where}`).bind(...params),
	]);

	const total = totalRow.results[0] as any;
	const byStatus: Record<string, number> = {};
	for (const row of statusRows.results as any[]) {
		byStatus[String(row.status)] = row.cnt;
	}
	const byAction: Record<string, number> = {};
	for (const row of actionRows.results as any[]) {
		byAction[row.action] = row.cnt;
	}
	const byType: Record<string, number> = {};
	for (const row of typeRows.results as any[]) {
		if (row.record_type) byType[row.record_type] = row.cnt;
	}

	return {
		total_requests: total?.cnt ?? 0,
		by_status: byStatus,
		by_action: byAction,
		by_record_type: byType,
		avg_duration_ms: Math.round((durationRow.results[0] as any)?.avg_ms ?? 0),
	};
}
