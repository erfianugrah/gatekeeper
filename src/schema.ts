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
	purge_target TEXT,
	tokens INTEGER NOT NULL DEFAULT 1,
	status INTEGER NOT NULL,
	collapsed TEXT,
	upstream_status INTEGER,
	duration_ms INTEGER NOT NULL,
	response_detail TEXT,
	created_by TEXT,
	flight_id TEXT,
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

// ─── DNS events ─────────────────────────────────────────────────────────────

export const DNS_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS dns_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	key_id TEXT NOT NULL,
	zone_id TEXT NOT NULL,
	action TEXT NOT NULL,
	record_name TEXT,
	record_type TEXT,
	status INTEGER NOT NULL,
	upstream_status INTEGER,
	duration_ms INTEGER NOT NULL,
	response_detail TEXT,
	created_by TEXT,
	created_at INTEGER NOT NULL
);
`;

export const DNS_EVENTS_INDEX_KEY_SQL = `
CREATE INDEX IF NOT EXISTS idx_dns_events_key_created
ON dns_events (key_id, created_at DESC);
`;

export const DNS_EVENTS_INDEX_ZONE_SQL = `
CREATE INDEX IF NOT EXISTS idx_dns_events_zone_created
ON dns_events (zone_id, created_at DESC);
`;

// ─── CF proxy events ────────────────────────────────────────────────────────

export const CF_PROXY_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS cf_proxy_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	key_id TEXT NOT NULL,
	account_id TEXT NOT NULL,
	service TEXT NOT NULL,
	action TEXT NOT NULL,
	resource_id TEXT,
	status INTEGER NOT NULL,
	upstream_status INTEGER,
	duration_ms INTEGER NOT NULL,
	upstream_latency_ms INTEGER,
	response_size INTEGER,
	response_detail TEXT,
	created_by TEXT,
	created_at INTEGER NOT NULL
);
`;

/** ALTER TABLE migration: add upstream_latency_ms + response_size to existing cf_proxy_events tables. */
export const CF_PROXY_EVENTS_ADD_LATENCY_SQL = `ALTER TABLE cf_proxy_events ADD COLUMN upstream_latency_ms INTEGER`;
export const CF_PROXY_EVENTS_ADD_RESPONSE_SIZE_SQL = `ALTER TABLE cf_proxy_events ADD COLUMN response_size INTEGER`;

export const CF_PROXY_EVENTS_INDEX_KEY_SQL = `
CREATE INDEX IF NOT EXISTS idx_cf_proxy_key_created
ON cf_proxy_events (key_id, created_at DESC);
`;

export const CF_PROXY_EVENTS_INDEX_ACCOUNT_SQL = `
CREATE INDEX IF NOT EXISTS idx_cf_proxy_account_created
ON cf_proxy_events (account_id, created_at DESC);
`;

export const CF_PROXY_EVENTS_INDEX_SERVICE_SQL = `
CREATE INDEX IF NOT EXISTS idx_cf_proxy_service_created
ON cf_proxy_events (service, created_at DESC);
`;

// ─── Audit events ───────────────────────────────────────────────────────────

export const AUDIT_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS audit_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	action TEXT NOT NULL,
	actor TEXT NOT NULL,
	entity_type TEXT NOT NULL,
	entity_id TEXT,
	detail TEXT,
	created_at INTEGER NOT NULL
);
`;

export const AUDIT_EVENTS_INDEX_ENTITY_SQL = `
CREATE INDEX IF NOT EXISTS idx_audit_events_entity
ON audit_events (entity_type, created_at DESC);
`;

export const AUDIT_EVENTS_INDEX_ACTOR_SQL = `
CREATE INDEX IF NOT EXISTS idx_audit_events_actor
ON audit_events (actor, created_at DESC);
`;

export const AUDIT_EVENTS_INDEX_ACTION_SQL = `
CREATE INDEX IF NOT EXISTS idx_audit_events_action
ON audit_events (action, created_at DESC);
`;
