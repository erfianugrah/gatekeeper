-- Gatekeeper D1 analytics schema
-- Single source of truth. Applied via: wrangler d1 execute gatekeeper-analytics --file=schema.sql
-- To nuke and recreate: wrangler d1 execute gatekeeper-analytics --file=schema.sql --remote

-- ─── Purge events ───────────────────────────────────────────────────────────

DROP TABLE IF EXISTS purge_events;

CREATE TABLE purge_events (
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

CREATE INDEX idx_purge_events_zone_created ON purge_events (zone_id, created_at DESC);
CREATE INDEX idx_purge_events_key_created ON purge_events (key_id, created_at DESC);

-- ─── S3 events ──────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS s3_events;

CREATE TABLE s3_events (
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

CREATE INDEX idx_s3_events_cred_created ON s3_events (credential_id, created_at DESC);
CREATE INDEX idx_s3_events_bucket_created ON s3_events (bucket, created_at DESC);
