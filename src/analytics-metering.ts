/**
 * Generic per-tenant metering rollups across all proxy analytics tables.
 *
 * Mirrors the `queryTimeseries` + ALLOWED_TABLES pattern: one engine driven by a
 * per-table descriptor registry. Group-by columns and write-rule prefixes are
 * resolved ONLY from hardcoded descriptor literals — never from request input —
 * so the dynamic SQL has no injection surface (the request `group_by` is a logical
 * key looked up in `descriptor.groupable`; unknown keys throw before SQL is built).
 *
 * `created_by` is the universal cross-surface tenant key (the only column present
 * in all five event tables). Per-surface rollups may group by surface-specific
 * dimensions; the cross-surface aggregate always groups by `created_by`.
 */

import { toSafeKeyPreview } from './analytics-identifiers';

// ─── Descriptors ──────────────────────────────────────────────────────────────

export interface WriteRule {
	kind: 'action_suffix' | 'operation_prefix' | 'none';
	/** Read-side prefixes for the operation_prefix rule (everything else is a write). */
	readPrefixes?: string[];
}

export interface MeteringDescriptor {
	table: string;
	/** Column rendered as the human label for a group (preview-safe). */
	previewColumn: string;
	/** logical group_by key → actual SQL column. `tenant` MUST map to created_by. */
	groupable: Record<string, string>;
	writeRule: WriteRule;
	/** True when the table has a response_size column. */
	hasEgress: boolean;
}

export const METERING_DESCRIPTORS: Record<string, MeteringDescriptor> = {
	purge_events: {
		table: 'purge_events',
		previewColumn: 'key_id',
		groupable: { tenant: 'created_by', key: 'key_fingerprint', zone: 'zone_id' },
		writeRule: { kind: 'none' },
		hasEgress: false,
	},
	dns_events: {
		table: 'dns_events',
		previewColumn: 'key_id',
		groupable: { tenant: 'created_by', key: 'key_fingerprint', zone: 'zone_id' },
		writeRule: { kind: 'action_suffix' },
		hasEgress: false,
	},
	cf_proxy_events: {
		table: 'cf_proxy_events',
		previewColumn: 'key_id',
		groupable: { tenant: 'created_by', key: 'key_fingerprint' },
		writeRule: { kind: 'action_suffix' },
		hasEgress: true,
	},
	supabase_proxy_events: {
		table: 'supabase_proxy_events',
		previewColumn: 'key_id',
		groupable: { tenant: 'created_by', key: 'key_fingerprint', project: 'project_ref' },
		writeRule: { kind: 'action_suffix' },
		hasEgress: true,
	},
	s3_events: {
		table: 's3_events',
		previewColumn: 'credential_id',
		groupable: { tenant: 'created_by', credential: 'credential_id', bucket: 'bucket' },
		writeRule: { kind: 'operation_prefix', readPrefixes: ['Get', 'List', 'Head'] },
		hasEgress: false,
	},
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MeteringRow {
	group_key: string | null;
	label: string | null;
	total_requests: number;
	read_requests: number | null;
	write_requests: number | null;
	error_count: number;
	error_rate_pct: number;
	egress_bytes: number | null;
	first_seen: number;
	last_seen: number;
}

export interface MeteringQuery {
	group_by?: string;
	since?: number;
	until?: number;
	limit?: number;
}

// ─── SQL helpers ──────────────────────────────────────────────────────────────

/** SQL boolean expression that is true for write rows, or null when the surface has no split. */
function writeExpr(rule: WriteRule): string | null {
	switch (rule.kind) {
		case 'action_suffix':
			return "action LIKE '%:write'";
		case 'operation_prefix': {
			const reads = (rule.readPrefixes ?? []).map((p) => `operation LIKE '${p}%'`).join(' OR ');
			return reads ? `NOT (${reads})` : null;
		}
		case 'none':
			return null;
	}
}

// ─── Single-surface rollup ──────────────────────────────────────────────────

/** Per-tenant (or per-dimension) metering rollup for one analytics table. */
export async function queryMetering(db: D1Database, table: string, query: MeteringQuery): Promise<MeteringRow[]> {
	const desc = METERING_DESCRIPTORS[table];
	if (!desc) throw new Error(`Invalid metering table: ${table}`);
	const groupBy = query.group_by ?? 'tenant';
	const groupCol = desc.groupable[groupBy];
	if (!groupCol) throw new Error(`Invalid group_by '${groupBy}' for table ${table}`);

	const conditions: string[] = [];
	const params: (string | number)[] = [];
	if (query.since) {
		conditions.push('created_at >= ?');
		params.push(query.since);
	}
	if (query.until) {
		conditions.push('created_at <= ?');
		params.push(query.until);
	}
	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const limit = Math.min(query.limit ?? 100, 1000);

	const we = writeExpr(desc.writeRule);
	const writeSelect = we
		? `SUM(CASE WHEN ${we} THEN 1 ELSE 0 END) AS write_requests, SUM(CASE WHEN ${we} THEN 0 ELSE 1 END) AS read_requests,`
		: '';
	const egressSelect = desc.hasEgress ? 'SUM(response_size) AS egress_bytes,' : '';

	const sql = `
		SELECT
			${groupCol} AS group_key,
			MIN(${desc.previewColumn}) AS label,
			COUNT(*) AS total_requests,
			${writeSelect}
			${egressSelect}
			SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS error_count,
			MIN(created_at) AS first_seen,
			MAX(created_at) AS last_seen
		FROM ${desc.table}
		${where}
		GROUP BY ${groupCol}
		ORDER BY total_requests DESC
		LIMIT ?`;

	let result: D1Result;
	try {
		result = await db
			.prepare(sql)
			.bind(...params, limit)
			.all();
	} catch (e: any) {
		if (e.message?.includes('no such table')) return [];
		throw e;
	}

	return (result.results as any[]).map((row) => {
		const total = Number(row.total_requests ?? 0);
		const errors = Number(row.error_count ?? 0);
		const label = typeof row.label === 'string' ? toSafeKeyPreview(row.label) : (row.label ?? null);
		return {
			group_key: row.group_key ?? null,
			label,
			total_requests: total,
			read_requests: we ? Number(row.read_requests ?? 0) : null,
			write_requests: we ? Number(row.write_requests ?? 0) : null,
			error_count: errors,
			error_rate_pct: total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,
			egress_bytes: desc.hasEgress ? Number(row.egress_bytes ?? 0) : null,
			first_seen: Number(row.first_seen ?? 0),
			last_seen: Number(row.last_seen ?? 0),
		};
	});
}

// ─── Cross-surface aggregation ────────────────────────────────────────────────

export interface CrossSurfaceSurfaceTotals {
	total_requests: number;
	write_requests: number | null;
	error_count: number;
	egress_bytes: number | null;
}

export interface CrossSurfaceTenantRow {
	tenant: string | null;
	surfaces: Record<string, CrossSurfaceSurfaceTotals>;
	total_requests: number;
	total_errors: number;
	total_egress_bytes: number;
}

export interface CrossSurfaceMeteringQuery {
	since?: number;
	until?: number;
	limit?: number;
}

/** Fan out over every surface, grouping each by created_by, and merge into one row per tenant. */
export async function queryMeteringAcrossSurfaces(db: D1Database, query: CrossSurfaceMeteringQuery): Promise<CrossSurfaceTenantRow[]> {
	const byTenant = new Map<string, CrossSurfaceTenantRow>();
	for (const table of Object.keys(METERING_DESCRIPTORS)) {
		const rows = await queryMetering(db, table, {
			group_by: 'tenant',
			since: query.since,
			until: query.until,
			limit: 1000,
		});
		for (const r of rows) {
			const tenantKey = r.group_key ?? '(none)';
			let agg = byTenant.get(tenantKey);
			if (!agg) {
				agg = { tenant: r.group_key, surfaces: {}, total_requests: 0, total_errors: 0, total_egress_bytes: 0 };
				byTenant.set(tenantKey, agg);
			}
			agg.surfaces[table] = {
				total_requests: r.total_requests,
				write_requests: r.write_requests,
				error_count: r.error_count,
				egress_bytes: r.egress_bytes,
			};
			agg.total_requests += r.total_requests;
			agg.total_errors += r.error_count;
			agg.total_egress_bytes += r.egress_bytes ?? 0;
		}
	}
	const limit = Math.min(query.limit ?? 100, 1000);
	return Array.from(byTenant.values())
		.sort((a, b) => b.total_requests - a.total_requests)
		.slice(0, limit);
}
