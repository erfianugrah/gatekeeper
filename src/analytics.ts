/**
 * D1-backed analytics for purge requests.
 * All writes are fire-and-forget via waitUntil() so they don't add latency.
 */

export interface PurgeEvent {
	key_id: string;
	zone_id: string;
	purge_type: "single" | "bulk";
	cost: number;
	status: number;
	collapsed: string | false;
	upstream_status: number | null;
	duration_ms: number;
	created_at: number; // unix ms
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS purge_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	key_id TEXT NOT NULL,
	zone_id TEXT NOT NULL,
	purge_type TEXT NOT NULL,
	cost INTEGER NOT NULL,
	status INTEGER NOT NULL,
	collapsed TEXT,
	upstream_status INTEGER,
	duration_ms INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
`;

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_purge_events_zone_created
ON purge_events (zone_id, created_at DESC);
`;

const CREATE_KEY_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_purge_events_key_created
ON purge_events (key_id, created_at DESC);
`;

async function ensureTables(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(CREATE_TABLE_SQL),
		db.prepare(CREATE_INDEX_SQL),
		db.prepare(CREATE_KEY_INDEX_SQL),
	]);
}

/**
 * Log a purge event to D1. Call via waitUntil() for zero latency impact.
 */
export async function logPurgeEvent(db: D1Database, event: PurgeEvent): Promise<void> {
	try {
		await ensureTables(db);
		await db
			.prepare(
				`INSERT INTO purge_events (key_id, zone_id, purge_type, cost, status, collapsed, upstream_status, duration_ms, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				event.key_id,
				event.zone_id,
				event.purge_type,
				event.cost,
				event.status,
				event.collapsed || null,
				event.upstream_status,
				event.duration_ms,
				event.created_at,
			)
			.run();
	} catch (e) {
		// Fire-and-forget: log but don't crash the request
		console.error(JSON.stringify({ error: "analytics_write_failed", detail: (e as Error).message }));
	}
}

export interface AnalyticsQuery {
	zone_id: string;
	key_id?: string;
	since?: number; // unix ms
	until?: number; // unix ms
	limit?: number;
}

export interface AnalyticsSummary {
	total_requests: number;
	total_cost: number;
	by_status: Record<string, number>;
	by_purge_type: Record<string, number>;
	collapsed_count: number;
	avg_duration_ms: number;
}

/**
 * Query recent purge events.
 */
export async function queryEvents(
	db: D1Database,
	query: AnalyticsQuery,
): Promise<Record<string, unknown>[]> {
	await ensureTables(db);

	const conditions: string[] = ["zone_id = ?"];
	const params: (string | number)[] = [query.zone_id];

	if (query.key_id) {
		conditions.push("key_id = ?");
		params.push(query.key_id);
	}
	if (query.since) {
		conditions.push("created_at >= ?");
		params.push(query.since);
	}
	if (query.until) {
		conditions.push("created_at <= ?");
		params.push(query.until);
	}

	const limit = Math.min(query.limit ?? 100, 1000);
	const sql = `SELECT * FROM purge_events WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
	params.push(limit);

	const result = await db.prepare(sql).bind(...params).all();
	return result.results as Record<string, unknown>[];
}

/**
 * Get summary analytics for a zone.
 */
export async function querySummary(
	db: D1Database,
	query: AnalyticsQuery,
): Promise<AnalyticsSummary> {
	await ensureTables(db);

	const conditions: string[] = ["zone_id = ?"];
	const params: (string | number)[] = [query.zone_id];

	if (query.key_id) {
		conditions.push("key_id = ?");
		params.push(query.key_id);
	}
	if (query.since) {
		conditions.push("created_at >= ?");
		params.push(query.since);
	}
	if (query.until) {
		conditions.push("created_at <= ?");
		params.push(query.until);
	}

	const where = conditions.join(" AND ");

	const [totalRow, statusRows, typeRows, collapsedRow, durationRow] = await db.batch([
		db.prepare(`SELECT COUNT(*) as cnt, SUM(cost) as total_cost FROM purge_events WHERE ${where}`).bind(...params),
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
		total_cost: total?.total_cost ?? 0,
		by_status: byStatus,
		by_purge_type: byType,
		collapsed_count: (collapsedRow.results[0] as any)?.cnt ?? 0,
		avg_duration_ms: Math.round((durationRow.results[0] as any)?.avg_ms ?? 0),
	};
}
