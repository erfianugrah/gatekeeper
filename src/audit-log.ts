/**
 * D1-backed audit log for admin control-plane mutations.
 * All writes are fire-and-forget via waitUntil() so they don't add latency.
 *
 * Every admin mutation (key CRUD, credential CRUD, upstream token/R2 CRUD,
 * config changes) gets a persistent row. This complements the ephemeral
 * breadcrumb console.log() calls that may be lost when Workers log retention expires.
 */

import {
	AUDIT_EVENTS_TABLE_SQL,
	AUDIT_EVENTS_INDEX_ENTITY_SQL,
	AUDIT_EVENTS_INDEX_ACTOR_SQL,
	AUDIT_EVENTS_INDEX_ACTION_SQL,
} from './schema';
import { DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT } from './constants';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AuditEvent {
	/** The mutation that occurred (e.g. create_key, revoke_key, delete_upstream_token). */
	action: string;
	/** Who performed it — SSO email, "unverified:<name>", or "via admin key". */
	actor: string;
	/** The type of entity affected (key, s3_credential, upstream_token, upstream_r2, config). */
	entity_type: string;
	/** The ID of the affected entity (key ID, access key ID, token ID, config key name, etc.). */
	entity_id: string | null;
	/** JSON-serialized metadata — varies by action (e.g. zone_id, scope_type, config values). */
	detail: string | null;
}

export interface AuditQuery {
	action?: string;
	actor?: string;
	entity_type?: string;
	entity_id?: string;
	since?: number;
	until?: number;
	limit?: number;
}

// ─── Table init ─────────────────────────────────────────────────────────────

async function ensureTables(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(AUDIT_EVENTS_TABLE_SQL),
		db.prepare(AUDIT_EVENTS_INDEX_ENTITY_SQL),
		db.prepare(AUDIT_EVENTS_INDEX_ACTOR_SQL),
		db.prepare(AUDIT_EVENTS_INDEX_ACTION_SQL),
	]);
}

// ─── Write ──────────────────────────────────────────────────────────────────

/** Log an audit event to D1. Call via waitUntil() for zero latency impact. */
export async function logAuditEvent(db: D1Database, event: AuditEvent): Promise<void> {
	try {
		await ensureTables(db);
		await db
			.prepare(
				`INSERT INTO audit_events (action, actor, entity_type, entity_id, detail, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(event.action, event.actor, event.entity_type, event.entity_id, event.detail, Date.now())
			.run();
	} catch (e) {
		console.error(JSON.stringify({ error: 'audit_log_write_failed', detail: (e as Error).message }));
	}
}

// ─── Read ───────────────────────────────────────────────────────────────────

/** Query audit events with optional filters. */
export async function queryAuditEvents(db: D1Database, query: AuditQuery): Promise<Record<string, unknown>[]> {
	await ensureTables(db);

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}
	if (query.actor) {
		conditions.push('actor = ?');
		params.push(query.actor);
	}
	if (query.entity_type) {
		conditions.push('entity_type = ?');
		params.push(query.entity_type);
	}
	if (query.entity_id) {
		conditions.push('entity_id = ?');
		params.push(query.entity_id);
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
	const sql = `SELECT * FROM audit_events${where} ORDER BY created_at DESC LIMIT ?`;
	params.push(limit);

	const result = await db
		.prepare(sql)
		.bind(...params)
		.all();
	return result.results as Record<string, unknown>[];
}

// ─── Retention ──────────────────────────────────────────────────────────────

/** Delete audit events older than the given retention period. Returns the number of rows deleted. */
export async function deleteOldAuditEvents(db: D1Database, retentionDays: number): Promise<number> {
	await ensureTables(db);
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const result = await db.prepare('DELETE FROM audit_events WHERE created_at < ?').bind(cutoff).run();
	return result.meta.changes ?? 0;
}
