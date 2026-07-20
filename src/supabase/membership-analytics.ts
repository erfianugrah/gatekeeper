/**
 * D1-backed audit trail for the Supabase membership-provisioning surface (plan Task 5).
 * All writes are fire-and-forget via waitUntil() so they don't add latency.
 *
 * One row per planned change / noop / blocked assignment on the invitations route.
 * Member writes are not PAT-drivable (plan Task 0), so `resulting_role` stays null
 * and `outcome` is one of: preview | denied | noop | blocked. The executed/failed
 * outcomes are reserved for when an upstream write transport exists.
 *
 * Member LIST reads are NOT logged here - they flow through the generic Management
 * API proxy and already land in supabase_proxy_events.
 *
 * NOTE: do NOT add a module-level `tablesInitialized` flag to ensureTables() - see the
 * "Known Pitfalls" note in AGENTS.md. CREATE TABLE IF NOT EXISTS is a cheap no-op and must
 * run per call so each vitest-pool-workers D1 instance gets its tables.
 */

import { buildKeyIdFilter, keyFingerprint, sanitizeKeyIdRow, toSafeKeyPreview } from '../analytics-identifiers';
import {
	SUPABASE_MEMBERSHIP_EVENTS_INDEX_ACTION_SQL,
	SUPABASE_MEMBERSHIP_EVENTS_INDEX_KEY_FINGERPRINT_SQL,
	SUPABASE_MEMBERSHIP_EVENTS_INDEX_KEY_SQL,
	SUPABASE_MEMBERSHIP_EVENTS_INDEX_ORG_SQL,
	SUPABASE_MEMBERSHIP_EVENTS_TABLE_SQL,
} from '../schema';

// ─── Types ──────────────────────────────────────────────────────────────────

/** preview | denied | noop | blocked (executed | failed reserved for a future write transport). */
export type MembershipOutcome = 'preview' | 'denied' | 'noop' | 'blocked' | 'executed' | 'failed';

export interface SupabaseMembershipEvent {
	key_id: string;
	org_slug: string;
	/** e.g. 'supabase:members:invite' | 'supabase:members:update_role'. */
	action: string;
	target_email: string | null;
	/** Role before the change (null for an add). */
	from_role: string | null;
	requested_role: string | null;
	/** Role after execution; null for preview / blocked outcomes. */
	resulting_role: string | null;
	outcome: MembershipOutcome;
	idempotency_key: string | null;
	/** pending | reconciled | conflict on execution; null for preview / blocked. */
	reconcile_status: string | null;
	detail: string | null;
	created_by: string | null;
	created_at: number; // unix ms
}

export interface SupabaseMembershipQuery {
	org_slug?: string;
	key_id?: string;
	action?: string;
	outcome?: string;
	target_email?: string;
	since?: number;
	until?: number;
	limit?: number;
}

export interface SupabaseMembershipSummary {
	total_events: number;
	by_outcome: Record<string, number>;
	by_action: Record<string, number>;
	by_org: Record<string, number>;
	denied_count: number;
}

// ─── Table init ─────────────────────────────────────────────────────────────

async function ensureTables(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(SUPABASE_MEMBERSHIP_EVENTS_TABLE_SQL),
		db.prepare(SUPABASE_MEMBERSHIP_EVENTS_INDEX_KEY_SQL),
		db.prepare(SUPABASE_MEMBERSHIP_EVENTS_INDEX_ORG_SQL),
		db.prepare(SUPABASE_MEMBERSHIP_EVENTS_INDEX_ACTION_SQL),
		db.prepare(SUPABASE_MEMBERSHIP_EVENTS_INDEX_KEY_FINGERPRINT_SQL),
	]);
}

// ─── Write ──────────────────────────────────────────────────────────────────

/** Log membership audit events to D1. Call via waitUntil() for zero latency impact. */
export async function logMembershipEvents(db: D1Database, events: SupabaseMembershipEvent[]): Promise<void> {
	if (events.length === 0) return;
	try {
		await ensureTables(db);
		const stmts = await Promise.all(
			events.map(async (event) =>
				db
					.prepare(
						`INSERT INTO supabase_membership_events
						 (key_id, key_fingerprint, org_slug, action, target_email, from_role, requested_role, resulting_role, outcome, idempotency_key, reconcile_status, detail, created_by, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						toSafeKeyPreview(event.key_id),
						await keyFingerprint(event.key_id),
						event.org_slug,
						event.action,
						event.target_email,
						event.from_role,
						event.requested_role,
						event.resulting_role,
						event.outcome,
						event.idempotency_key,
						event.reconcile_status,
						event.detail,
						event.created_by,
						event.created_at,
					),
			),
		);
		await db.batch(stmts);
	} catch (e) {
		console.error(JSON.stringify({ error: 'supabase_membership_analytics_write_failed', detail: (e as Error).message }));
	}
}

/** Single-event convenience wrapper. */
export async function logMembershipEvent(db: D1Database, event: SupabaseMembershipEvent): Promise<void> {
	return logMembershipEvents(db, [event]);
}

// ─── Retention ──────────────────────────────────────────────────────────────

/** Delete membership events older than the given retention period. Returns rows deleted. */
export async function deleteOldMembershipEvents(db: D1Database, retentionDays: number): Promise<number> {
	await ensureTables(db);
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const result = await db.prepare('DELETE FROM supabase_membership_events WHERE created_at < ?').bind(cutoff).run();
	return result.meta.changes ?? 0;
}

// ─── Query ──────────────────────────────────────────────────────────────────

async function buildWhere(query: SupabaseMembershipQuery): Promise<{ where: string; params: (string | number)[] }> {
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	if (query.org_slug) {
		conditions.push('org_slug = ?');
		params.push(query.org_slug);
	}
	if (query.key_id) {
		const keyFilter = await buildKeyIdFilter(query.key_id);
		conditions.push(keyFilter.condition);
		params.push(...keyFilter.params);
	}
	if (query.action) {
		conditions.push('action = ?');
		params.push(query.action);
	}
	if (query.outcome) {
		conditions.push('outcome = ?');
		params.push(query.outcome);
	}
	if (query.target_email) {
		conditions.push('target_email = ?');
		params.push(query.target_email);
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

/** Query recent membership audit events. */
export async function queryMembershipEvents(db: D1Database, query: SupabaseMembershipQuery): Promise<Record<string, unknown>[]> {
	await ensureTables(db);
	const { where, params } = await buildWhere(query);
	const limit = Math.min(query.limit ?? 100, 1000);
	const result = await db
		.prepare(`SELECT * FROM supabase_membership_events ${where} ORDER BY created_at DESC LIMIT ?`)
		.bind(...params, limit)
		.all();
	const rows = result.results as Record<string, unknown>[];
	return rows.map((row) => sanitizeKeyIdRow(row));
}

/** Get summary analytics for membership audit events. */
export async function queryMembershipSummary(db: D1Database, query: SupabaseMembershipQuery): Promise<SupabaseMembershipSummary> {
	await ensureTables(db);
	const { where, params } = await buildWhere(query);

	const [totalRow, outcomeRows, actionRows, orgRows, deniedRow] = await db.batch([
		db.prepare(`SELECT COUNT(*) as cnt FROM supabase_membership_events ${where}`).bind(...params),
		db.prepare(`SELECT outcome, COUNT(*) as cnt FROM supabase_membership_events ${where} GROUP BY outcome`).bind(...params),
		db
			.prepare(`SELECT action, COUNT(*) as cnt FROM supabase_membership_events ${where} GROUP BY action ORDER BY cnt DESC LIMIT 20`)
			.bind(...params),
		db
			.prepare(`SELECT org_slug, COUNT(*) as cnt FROM supabase_membership_events ${where} GROUP BY org_slug ORDER BY cnt DESC LIMIT 20`)
			.bind(...params),
		db
			.prepare(`SELECT COUNT(*) as cnt FROM supabase_membership_events ${where} ${where ? 'AND' : 'WHERE'} outcome = 'denied'`)
			.bind(...params),
	]);

	const byOutcome: Record<string, number> = {};
	for (const row of outcomeRows.results as any[]) byOutcome[row.outcome] = row.cnt;
	const byAction: Record<string, number> = {};
	for (const row of actionRows.results as any[]) byAction[row.action] = row.cnt;
	const byOrg: Record<string, number> = {};
	for (const row of orgRows.results as any[]) byOrg[row.org_slug] = row.cnt;

	return {
		total_events: Number((totalRow.results[0] as any)?.cnt ?? 0),
		by_outcome: byOutcome,
		by_action: byAction,
		by_org: byOrg,
		denied_count: Number((deniedRow.results[0] as any)?.cnt ?? 0),
	};
}
