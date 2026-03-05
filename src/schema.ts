/**
 * D1 analytics schema — runtime SQL for ensureTables().
 *
 * Source of truth is schema.sql at the project root.
 * These use CREATE TABLE IF NOT EXISTS so they're safe to run on every request.
 * New columns on existing tables require ALTER TABLE migrations (see each analytics module).
 */

// ─── Purge events ───────────────────────────────────────────────────────────

export const PURGE_EVENTS_TABLE_SQL = `
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
	response_detail TEXT,
	created_by TEXT,
	created_at INTEGER NOT NULL
);
`;

export const PURGE_EVENTS_INDEX_ZONE_SQL = `
CREATE INDEX IF NOT EXISTS idx_purge_events_zone_created
ON purge_events (zone_id, created_at DESC);
`;

export const PURGE_EVENTS_INDEX_KEY_SQL = `
CREATE INDEX IF NOT EXISTS idx_purge_events_key_created
ON purge_events (key_id, created_at DESC);
`;

// ─── S3 events ──────────────────────────────────────────────────────────────

export const S3_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS s3_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	credential_id TEXT NOT NULL,
	operation TEXT NOT NULL,
	bucket TEXT,
	key TEXT,
	status INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	response_detail TEXT,
	created_by TEXT,
	created_at INTEGER NOT NULL
);
`;

export const S3_EVENTS_INDEX_CRED_SQL = `
CREATE INDEX IF NOT EXISTS idx_s3_events_cred_created
ON s3_events (credential_id, created_at DESC);
`;

export const S3_EVENTS_INDEX_BUCKET_SQL = `
CREATE INDEX IF NOT EXISTS idx_s3_events_bucket_created
ON s3_events (bucket, created_at DESC);
`;
