/**
 * D1-backed analytics for S3 proxy requests.
 * All writes are fire-and-forget via waitUntil() so they don't add latency.
 */

export interface S3Event {
	credential_id: string;
	operation: string;
	bucket: string | null;
	key: string | null;
	status: number;
	duration_ms: number;
	created_at: number; // unix ms
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS s3_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	credential_id TEXT NOT NULL,
	operation TEXT NOT NULL,
	bucket TEXT,
	key TEXT,
	status INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
`;

const CREATE_CRED_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_s3_events_cred_created
ON s3_events (credential_id, created_at DESC);
`;

const CREATE_BUCKET_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_s3_events_bucket_created
ON s3_events (bucket, created_at DESC);
`;

async function ensureTables(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(CREATE_TABLE_SQL),
		db.prepare(CREATE_CRED_INDEX_SQL),
		db.prepare(CREATE_BUCKET_INDEX_SQL),
	]);
}

/**
 * Log an S3 event to D1. Call via waitUntil() for zero latency impact.
 */
export async function logS3Event(db: D1Database, event: S3Event): Promise<void> {
	try {
		await ensureTables(db);
		await db
			.prepare(
				`INSERT INTO s3_events (credential_id, operation, bucket, key, status, duration_ms, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				event.credential_id,
				event.operation,
				event.bucket,
				event.key,
				event.status,
				event.duration_ms,
				event.created_at,
			)
			.run();
	} catch (e) {
		// Fire-and-forget: log but don't crash the request
		console.error(JSON.stringify({ error: 's3_analytics_write_failed', detail: (e as Error).message }));
	}
}

/** Delete S3 events older than the given retention period. Returns the number of rows deleted. */
export async function deleteOldS3Events(db: D1Database, retentionDays: number): Promise<number> {
	await ensureTables(db);
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const result = await db.prepare('DELETE FROM s3_events WHERE created_at < ?').bind(cutoff).run();
	return result.meta.changes ?? 0;
}

export interface S3AnalyticsQuery {
	credential_id?: string;
	bucket?: string;
	operation?: string;
	since?: number; // unix ms
	until?: number; // unix ms
	limit?: number;
}

export interface S3AnalyticsSummary {
	total_requests: number;
	by_status: Record<string, number>;
	by_operation: Record<string, number>;
	by_bucket: Record<string, number>;
	avg_duration_ms: number;
}

/**
 * Query recent S3 events.
 */
export async function queryS3Events(
	db: D1Database,
	query: S3AnalyticsQuery,
): Promise<Record<string, unknown>[]> {
	await ensureTables(db);

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.credential_id) {
		conditions.push('credential_id = ?');
		params.push(query.credential_id);
	}
	if (query.bucket) {
		conditions.push('bucket = ?');
		params.push(query.bucket);
	}
	if (query.operation) {
		conditions.push('operation = ?');
		params.push(query.operation);
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
	const sql = `SELECT * FROM s3_events ${where} ORDER BY created_at DESC LIMIT ?`;
	params.push(limit);

	const result = await db.prepare(sql).bind(...params).all();
	return result.results as Record<string, unknown>[];
}

/**
 * Get summary analytics for S3 operations.
 */
export async function queryS3Summary(
	db: D1Database,
	query: S3AnalyticsQuery,
): Promise<S3AnalyticsSummary> {
	await ensureTables(db);

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.credential_id) {
		conditions.push('credential_id = ?');
		params.push(query.credential_id);
	}
	if (query.bucket) {
		conditions.push('bucket = ?');
		params.push(query.bucket);
	}
	if (query.operation) {
		conditions.push('operation = ?');
		params.push(query.operation);
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

	const [totalRow, statusRows, opRows, bucketRows, durationRow] = await db.batch([
		db.prepare(`SELECT COUNT(*) as cnt FROM s3_events ${where}`).bind(...params),
		db.prepare(`SELECT status, COUNT(*) as cnt FROM s3_events ${where} GROUP BY status`).bind(...params),
		db.prepare(`SELECT operation, COUNT(*) as cnt FROM s3_events ${where} GROUP BY operation ORDER BY cnt DESC LIMIT 20`).bind(...params),
		db.prepare(`SELECT bucket, COUNT(*) as cnt FROM s3_events ${where} GROUP BY bucket ORDER BY cnt DESC LIMIT 20`).bind(...params),
		db.prepare(`SELECT AVG(duration_ms) as avg_ms FROM s3_events ${where}`).bind(...params),
	]);

	const total = totalRow.results[0] as any;
	const byStatus: Record<string, number> = {};
	for (const row of statusRows.results as any[]) {
		byStatus[String(row.status)] = row.cnt;
	}
	const byOp: Record<string, number> = {};
	for (const row of opRows.results as any[]) {
		byOp[row.operation] = row.cnt;
	}
	const byBucket: Record<string, number> = {};
	for (const row of bucketRows.results as any[]) {
		if (row.bucket) byBucket[row.bucket] = row.cnt;
	}

	return {
		total_requests: total?.cnt ?? 0,
		by_status: byStatus,
		by_operation: byOp,
		by_bucket: byBucket,
		avg_duration_ms: Math.round((durationRow.results[0] as any)?.avg_ms ?? 0),
	};
}
