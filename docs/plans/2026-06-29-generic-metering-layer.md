# Generic Per-Tenant Metering Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic, descriptor-driven per-tenant metering layer that rolls up request counts, read/write split, error rate, and best-effort egress across ALL five proxy surfaces (purge, dns, cf_proxy, supabase, s3) — plus a cross-surface aggregate that unifies a tenant's cost across surfaces on `created_by`.

**Architecture:** One generic engine (`src/analytics-metering.ts`) with a per-table `MeteringDescriptor` registry — the same "one engine + per-surface descriptor" pattern the repo already uses for `queryTimeseries` (`ALLOWED_TABLES` safelist) and the api-coverage provider registry. Single-surface rollup `queryMetering(db, table, q)` builds grouped aggregate SQL from the descriptor; `queryMeteringAcrossSurfaces(db, q)` fans out over all descriptors and merges by `created_by` (the only column present in all five event tables). Each surface's analytics sub-app gets a `/metering` route; a new top-level `/admin/metering` serves the cross-surface view. CLI `gk metering` and a dashboard panel surface it.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), Zod, Vitest (`@cloudflare/vitest-pool-workers`), citty (CLI), Astro + React (dashboard).

---

## Design constraints (from the column audit)

Column commonality across the five event tables (verified against `src/schema.ts`):

| Column | purge | dns | cf_proxy | supabase | s3 |
|---|---|---|---|---|---|
| `key_fingerprint` / `key_id` | ✓ | ✓ | ✓ | ✓ | ✗ (uses `credential_id`) |
| `created_by` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `status`, `duration_ms`, `created_at` | ✓ | ✓ | ✓ | ✓ | ✓ |
| read/write source | none | `action` | `action` | `action` | `operation` |
| `response_size` (egress) | ✗ | ✗ | ✓ | ✓ | ✗ |
| resource col | `zone_id` | `zone_id` | — | `project_ref` | `bucket` |

Two decisions fall out:

1. **`created_by` is the universal cross-surface tenant key.** It is the only column in all five tables. Per-surface rollups may group by surface-specific dimensions (`key`/`zone`/`project`/`credential`/`bucket`); the cross-surface aggregate ALWAYS groups by `created_by`.
2. **Read/write split and egress are surface-dependent.** The descriptor declares a `writeRule` (`action_suffix` for dns/cf/supabase, `operation_prefix` for s3, `none` for purge) and a `hasEgress` flag. Surfaces lacking a split return `read_requests`/`write_requests` = `null`; surfaces lacking egress return `egress_bytes` = `null`. Egress is documented best-effort (`response_size` is `null` for streamed passthrough).

**SQL-injection note:** group-by columns and write-rule prefixes are resolved ONLY from hardcoded descriptor literals (never request input). The request's `group_by` is a logical key looked up in `descriptor.groupable`; an unknown key throws before any SQL is built. This mirrors the `ALLOWED_TABLES` safelist in `src/analytics-timeseries.ts`.

---

## File Structure

- **Create** `src/analytics-metering.ts` — the generic engine: `MeteringDescriptor`, `METERING_DESCRIPTORS`, `queryMetering`, `queryMeteringAcrossSurfaces`, and their types.
- **Create** `src/routes/admin-metering.ts` — the unified `GET /admin/metering` sub-app.
- **Create** `test/analytics-metering.test.ts` — engine unit tests + route integration tests.
- **Modify** `src/routes/admin-schemas.ts` — add `meteringQuerySchema` + `crossSurfaceMeteringQuerySchema`.
- **Modify** `src/routes/admin-supabase-analytics.ts`, `admin-cf-analytics.ts`, `admin-dns-analytics.ts`, `admin-analytics.ts` (purge), `admin-s3.ts` (s3) — add a `/metering` route to each.
- **Modify** `src/routes/admin.ts` — mount the unified `/admin/metering` sub-app + RBAC.
- **Create** `cli/commands/metering.ts` — `gk metering` (cross-surface, `--surface` for single-surface).
- **Modify** `cli/index.ts`, `cli/commands/completions.ts` — register the command.
- **Modify** `dashboard/src/lib/api.ts`, `dashboard/src/components/AnalyticsPage.tsx` — metering table panel.
- **Create** `e2e/metering-ui.spec.ts` — Playwright deploy-gate smoke for the dashboard panel through the real asset layer.
- **Modify** `docs/GUIDE.md` — Metering section.

No DB migration, no classifier change, no new instrumentation — the layer rides on data already written.

---

## Task 1: Generic metering engine — single-surface rollup ✅ DONE (e28b14c)

**Files:**
- Create: `src/analytics-metering.ts`
- Test: `test/analytics-metering.test.ts`

- [x] **Step 1: Write the failing test**

Create `test/analytics-metering.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { queryMetering, METERING_DESCRIPTORS } from '../src/analytics-metering';

// Direct D1 inserts — exercises the engine without driving the proxy for all 5 surfaces.
async function seedSupabase(rows: Array<{ key_id: string; key_fingerprint: string; project_ref: string; action: string; status: number; response_size: number | null; created_by: string; created_at: number }>) {
	const db = env.ANALYTICS_DB;
	await db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS supabase_proxy_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT NOT NULL, key_fingerprint TEXT, project_ref TEXT,
		category TEXT NOT NULL, action TEXT NOT NULL, status INTEGER NOT NULL, upstream_status INTEGER,
		duration_ms INTEGER NOT NULL, upstream_latency_ms INTEGER, response_size INTEGER, response_detail TEXT,
		created_by TEXT, created_at INTEGER NOT NULL)`)]);
	for (const r of rows) {
		await db.prepare(`INSERT INTO supabase_proxy_events (key_id, key_fingerprint, project_ref, category, action, status, duration_ms, response_size, created_by, created_at)
			VALUES (?, ?, ?, 'database', ?, ?, 5, ?, ?, ?)`)
			.bind(r.key_id, r.key_fingerprint, r.project_ref, r.action, r.status, r.response_size, r.created_by, r.created_at).run();
	}
}

describe('queryMetering — supabase surface', () => {
	beforeEach(async () => {
		await env.ANALYTICS_DB.prepare('DROP TABLE IF EXISTS supabase_proxy_events').run();
	});

	it('rolls up by project_ref with read/write split and egress sum', async () => {
		await seedSupabase([
			{ key_id: 'gw_aaa...bbb', key_fingerprint: 'fp1', project_ref: 'projA', action: 'supabase:database:read', status: 200, response_size: 100, created_by: 'user-1', created_at: 1000 },
			{ key_id: 'gw_aaa...bbb', key_fingerprint: 'fp1', project_ref: 'projA', action: 'supabase:database:write', status: 200, response_size: 50, created_by: 'user-1', created_at: 2000 },
			{ key_id: 'gw_ccc...ddd', key_fingerprint: 'fp2', project_ref: 'projA', action: 'supabase:database:read', status: 500, response_size: null, created_by: 'user-1', created_at: 3000 },
			{ key_id: 'gw_eee...fff', key_fingerprint: 'fp3', project_ref: 'projB', action: 'supabase:database:read', status: 200, response_size: 10, created_by: 'user-2', created_at: 4000 },
		]);

		const rows = await queryMetering(env.ANALYTICS_DB, 'supabase_proxy_events', { group_by: 'project' });
		const a = rows.find((r) => r.group_key === 'projA')!;
		expect(a.total_requests).toBe(3);
		expect(a.read_requests).toBe(2);
		expect(a.write_requests).toBe(1);
		expect(a.error_count).toBe(1);
		expect(a.error_rate_pct).toBeCloseTo(33.3, 1);
		expect(a.egress_bytes).toBe(150); // null response_size ignored by SUM
		expect(a.first_seen).toBe(1000);
		expect(a.last_seen).toBe(3000);
	});

	it('rolls up by tenant (created_by)', async () => {
		await seedSupabase([
			{ key_id: 'gw_a...b', key_fingerprint: 'fp1', project_ref: 'projA', action: 'supabase:database:read', status: 200, response_size: 1, created_by: 'user-1', created_at: 1 },
			{ key_id: 'gw_c...d', key_fingerprint: 'fp2', project_ref: 'projB', action: 'supabase:database:read', status: 200, response_size: 1, created_by: 'user-1', created_at: 2 },
		]);
		const rows = await queryMetering(env.ANALYTICS_DB, 'supabase_proxy_events', { group_by: 'tenant' });
		expect(rows).toHaveLength(1);
		expect(rows[0].group_key).toBe('user-1');
		expect(rows[0].total_requests).toBe(2);
	});

	it('throws on unknown table', async () => {
		await expect(queryMetering(env.ANALYTICS_DB, 'evil_events', {})).rejects.toThrow('Invalid metering table');
	});

	it('throws on unknown group_by for the surface', async () => {
		await expect(queryMetering(env.ANALYTICS_DB, 'supabase_proxy_events', { group_by: 'bucket' })).rejects.toThrow("Invalid group_by");
	});

	it('returns [] when the table does not exist yet', async () => {
		await env.ANALYTICS_DB.prepare('DROP TABLE IF EXISTS supabase_proxy_events').run();
		const rows = await queryMetering(env.ANALYTICS_DB, 'supabase_proxy_events', { group_by: 'tenant' });
		expect(rows).toEqual([]);
	});

	it('every descriptor exposes a tenant group key', () => {
		for (const d of Object.values(METERING_DESCRIPTORS)) {
			expect(d.groupable.tenant).toBe('created_by');
		}
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/analytics-metering.test.ts`
Expected: FAIL with "Cannot find module '../src/analytics-metering'" / `queryMetering is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/analytics-metering.ts`:

<!-- IMPLEMENTED in e28b14c -->

```ts
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
```

- [x] **Step 4: Run test to verify it passes** — 6/6 pass, typecheck + lint clean.

Run: `bunx vitest run test/analytics-metering.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Commit** — committed e28b14c; spec review ✅, code quality APPROVED.

```bash
git add src/analytics-metering.ts test/analytics-metering.test.ts
git commit -m "feat(metering): generic descriptor-driven single-surface rollup engine"
```

---

## Task 2: Cross-surface aggregation ✅ DONE (f5b59ce)

**Files:**
- Modify: `src/analytics-metering.ts`
- Test: `test/analytics-metering.test.ts`

- [x] **Step 1: Write the failing test**

Append to `test/analytics-metering.test.ts`:

```ts
import { queryMeteringAcrossSurfaces } from '../src/analytics-metering';

async function seedCf(rows: Array<{ key_fingerprint: string; action: string; status: number; response_size: number; created_by: string; created_at: number }>) {
	const db = env.ANALYTICS_DB;
	await db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS cf_proxy_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT NOT NULL, key_fingerprint TEXT, action TEXT NOT NULL,
		status INTEGER NOT NULL, upstream_status INTEGER, duration_ms INTEGER NOT NULL, response_size INTEGER,
		created_by TEXT, created_at INTEGER NOT NULL)`)]);
	for (const r of rows) {
		await db.prepare(`INSERT INTO cf_proxy_events (key_id, key_fingerprint, action, status, duration_ms, response_size, created_by, created_at)
			VALUES ('gw_x...y', ?, ?, ?, 5, ?, ?, ?)`)
			.bind(r.key_fingerprint, r.action, r.status, r.response_size, r.created_by, r.created_at).run();
	}
}

describe('queryMeteringAcrossSurfaces', () => {
	beforeEach(async () => {
		await env.ANALYTICS_DB.prepare('DROP TABLE IF EXISTS supabase_proxy_events').run();
		await env.ANALYTICS_DB.prepare('DROP TABLE IF EXISTS cf_proxy_events').run();
	});

	it('unifies a tenant across surfaces on created_by', async () => {
		await seedSupabase([
			{ key_id: 'gw_a...b', key_fingerprint: 'fp1', project_ref: 'projA', action: 'supabase:database:write', status: 200, response_size: 100, created_by: 'user-1', created_at: 1 },
		]);
		await seedCf([
			{ key_fingerprint: 'fp9', action: 'cf:dns:read', status: 200, response_size: 20, created_by: 'user-1', created_at: 2 },
			{ key_fingerprint: 'fp9', action: 'cf:dns:read', status: 503, response_size: 0, created_by: 'user-2', created_at: 3 },
		]);

		const rows = await queryMeteringAcrossSurfaces(env.ANALYTICS_DB, {});
		const u1 = rows.find((r) => r.tenant === 'user-1')!;
		expect(u1.total_requests).toBe(2);
		expect(u1.surfaces.supabase_proxy_events.total_requests).toBe(1);
		expect(u1.surfaces.cf_proxy_events.total_requests).toBe(1);
		expect(u1.total_egress_bytes).toBe(120);
		const u2 = rows.find((r) => r.tenant === 'user-2')!;
		expect(u2.total_requests).toBe(1);
		expect(u2.total_errors).toBe(1);
		// Sorted by total_requests desc — user-1 first.
		expect(rows[0].tenant).toBe('user-1');
	});

	it('returns [] when no tables exist', async () => {
		const rows = await queryMeteringAcrossSurfaces(env.ANALYTICS_DB, {});
		expect(rows).toEqual([]);
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/analytics-metering.test.ts -t "AcrossSurfaces"`
Expected: FAIL with `queryMeteringAcrossSurfaces is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/analytics-metering.ts`:

```ts
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
export async function queryMeteringAcrossSurfaces(
	db: D1Database,
	query: CrossSurfaceMeteringQuery,
): Promise<CrossSurfaceTenantRow[]> {
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
```

- [x] **Step 4: Run test to verify it passes** — 8/8 pass, typecheck + lint clean.

Run: `bunx vitest run test/analytics-metering.test.ts`
Expected: PASS (8 tests).

- [x] **Step 5: Commit** — committed f5b59ce; spec review ✅, code quality APPROVED.

```bash
git add src/analytics-metering.ts test/analytics-metering.test.ts
git commit -m "feat(metering): cross-surface tenant aggregation on created_by"
```

---

## Task 3: Query schemas ✅ DONE (c7c8f16)

**Files:**
- Modify: `src/routes/admin-schemas.ts` (add near the other analytics schemas, ~line 926)

- [x] **Step 1: Write the failing test**

Append to `test/analytics-metering.test.ts`:

```ts
import { meteringQuerySchema, crossSurfaceMeteringQuerySchema } from '../src/routes/admin-schemas';

describe('metering query schemas', () => {
	it('meteringQuerySchema coerces since/until/limit and passes group_by through', () => {
		const parsed = meteringQuerySchema.parse({ group_by: 'project', since: '1000', until: '2000', limit: '5' });
		expect(parsed).toEqual({ group_by: 'project', since: 1000, until: 2000, limit: 5 });
	});
	it('meteringQuerySchema defaults limit', () => {
		const parsed = meteringQuerySchema.parse({});
		expect(parsed.limit).toBeGreaterThan(0);
		expect(parsed.group_by).toBeUndefined();
	});
	it('crossSurfaceMeteringQuerySchema has no group_by field', () => {
		const parsed = crossSurfaceMeteringQuerySchema.parse({ since: '1' });
		expect(parsed.since).toBe(1);
		expect('group_by' in parsed).toBe(false);
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/analytics-metering.test.ts -t "query schemas"`
Expected: FAIL with `meteringQuerySchema` import undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/routes/admin-schemas.ts`, immediately after the `supabaseProxyTimeseriesQuerySchema` block (the last analytics schema), add:

```ts
/** Generic metering: GET /admin/<surface>/analytics/metering */
export const meteringQuerySchema = z.object({
	group_by: z.string().optional(),
	since: z.coerce.number().optional(),
	until: z.coerce.number().optional(),
	limit: z.coerce.number().int().min(1).max(MAX_ANALYTICS_LIMIT).optional().default(DEFAULT_ANALYTICS_LIMIT),
});

export type MeteringQueryParams = z.infer<typeof meteringQuerySchema>;

/** Cross-surface metering: GET /admin/metering */
export const crossSurfaceMeteringQuerySchema = z.object({
	since: z.coerce.number().optional(),
	until: z.coerce.number().optional(),
	limit: z.coerce.number().int().min(1).max(MAX_ANALYTICS_LIMIT).optional().default(DEFAULT_ANALYTICS_LIMIT),
});

export type CrossSurfaceMeteringQueryParams = z.infer<typeof crossSurfaceMeteringQuerySchema>;
```

- [x] **Step 4: Run test to verify it passes** — 3/3 (11/11 whole file), typecheck + lint clean.

Run: `bunx vitest run test/analytics-metering.test.ts -t "query schemas"`
Expected: PASS (3 tests).

- [x] **Step 5: Commit** — committed c7c8f16; spec review ✅, code quality APPROVED.

```bash
git add src/routes/admin-schemas.ts test/analytics-metering.test.ts
git commit -m "feat(metering): add metering query schemas"
```

---

## Task 4: Per-surface `/metering` routes ✅ DONE (99204b6)

**Files:**
- Modify: `src/routes/admin-supabase-analytics.ts`
- Modify: `src/routes/admin-cf-analytics.ts`
- Modify: `src/routes/admin-dns-analytics.ts`
- Modify: `src/routes/admin-analytics.ts` (purge)
- Modify: `src/routes/admin-s3.ts` (s3)
- Test: `test/analytics-metering.test.ts`

- [x] **Step 1: Write the failing test**

Append to `test/analytics-metering.test.ts` (uses the existing `helpers` like other route tests):

```ts
import { SELF } from 'cloudflare:test';
import { adminHeaders } from './helpers';

describe('per-surface /metering routes', () => {
	it('GET /admin/supabase/analytics/metering → 200 success + array', async () => {
		const res = await SELF.fetch('https://gk/admin/supabase/analytics/metering?group_by=project', { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});

	it('GET /admin/supabase/analytics/metering?group_by=bucket → 400 (invalid dim)', async () => {
		const res = await SELF.fetch('https://gk/admin/supabase/analytics/metering?group_by=bucket', { headers: adminHeaders() });
		expect(res.status).toBe(400);
	});

	it('GET /admin/cf/analytics/metering → 200', async () => {
		const res = await SELF.fetch('https://gk/admin/cf/analytics/metering', { headers: adminHeaders() });
		expect(res.status).toBe(200);
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/analytics-metering.test.ts -t "per-surface"`
Expected: FAIL — route returns 404 (not mounted).

- [ ] **Step 3: Write minimal implementation**

In `src/routes/admin-supabase-analytics.ts`: add the engine import and extend the existing `./admin-schemas` import with `meteringQuerySchema`:

```ts
import { queryMetering } from '../analytics-metering';
```

Then append this route (after the `/timeseries` handler):

```ts
// ─── Metering ─────────────────────────────────────────────────────────────────

adminSupabaseAnalyticsApp.get('/metering', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'supabase-proxy-metering' }));
		return jsonError(c, 503, 'Analytics not configured');
	}
	const query = parseQueryParams(c, meteringQuerySchema);
	if (query instanceof Response) return query;
	try {
		const rows = await queryMetering(c.env.ANALYTICS_DB, 'supabase_proxy_events', query);
		return c.json({ success: true, result: rows });
	} catch (e: any) {
		return jsonError(c, 400, e.message);
	}
});
```

Repeat the identical route in each sibling file, changing ONLY the table name, sub-app variable, and breadcrumb:

- `src/routes/admin-cf-analytics.ts` → sub-app `adminCfAnalyticsApp`, table `'cf_proxy_events'`, breadcrumb `cf-proxy-metering`.
- `src/routes/admin-dns-analytics.ts` → sub-app `adminDnsAnalyticsApp`, table `'dns_events'`, breadcrumb `dns-metering`.
- `src/routes/admin-analytics.ts` → sub-app `adminAnalyticsApp`, table `'purge_events'`, breadcrumb `purge-metering`.
- `src/routes/admin-s3.ts` → READ THE FILE FIRST to find its analytics sub-app variable and the exact path of its existing `/analytics/summary` handler. Add a `GET /analytics/metering` handler resolving to `/admin/s3/analytics/metering` with table `'s3_events'`, breadcrumb `s3-metering`.

Each file already imports `jsonError`, `parseQueryParams` from `./admin-schemas` — extend that import to include `meteringQuerySchema`, and add `import { queryMetering } from '../analytics-metering';`.

- [x] **Step 4: Run test to verify it passes** — 3/3 (14/14 whole file), typecheck + lint clean. s3 handled as `/analytics/metering` (sub-app mounted at `/s3`).

Run: `bunx vitest run test/analytics-metering.test.ts -t "per-surface"`
Expected: PASS (3 tests). Then run the full file: `bunx vitest run test/analytics-metering.test.ts` — all green.

- [x] **Step 5: Commit** — committed 99204b6; spec review ✅, code quality APPROVED (RBAC coverage verified).

```bash
git add src/routes/admin-supabase-analytics.ts src/routes/admin-cf-analytics.ts src/routes/admin-dns-analytics.ts src/routes/admin-analytics.ts src/routes/admin-s3.ts test/analytics-metering.test.ts
git commit -m "feat(metering): add /metering route to each per-surface analytics sub-app"
```

---

## Task 5: Unified `/admin/metering` route ✅ DONE (3bfeab8)

**Files:**
- Create: `src/routes/admin-metering.ts`
- Modify: `src/routes/admin.ts`
- Test: `test/analytics-metering.test.ts`

- [x] **Step 1: Write the failing test**

Append to `test/analytics-metering.test.ts`:

```ts
describe('unified /admin/metering route', () => {
	it('GET /admin/metering → 200 success + array', async () => {
		const res = await SELF.fetch('https://gk/admin/metering', { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});

	it('GET /admin/metering requires auth → 401 without admin headers', async () => {
		const res = await SELF.fetch('https://gk/admin/metering');
		expect(res.status).toBe(401);
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bunx vitest run test/analytics-metering.test.ts -t "unified"`
Expected: FAIL — `/admin/metering` returns 404.

- [ ] **Step 3: Write minimal implementation**

Create `src/routes/admin-metering.ts`:

```ts
/**
 * Unified cross-surface metering endpoint.
 *
 * Mounted at /admin/metering. Aggregates per-tenant cost across ALL proxy surfaces
 * (purge, dns, cf, supabase, s3), unifying on created_by — the only column present
 * in every event table.
 */

import { Hono } from 'hono';
import { queryMeteringAcrossSurfaces } from '../analytics-metering';
import { jsonError, parseQueryParams, crossSurfaceMeteringQuerySchema } from './admin-schemas';
import type { HonoEnv } from '../types';

export const adminMeteringApp = new Hono<HonoEnv>();

adminMeteringApp.get('/', async (c) => {
	if (!c.env.ANALYTICS_DB) {
		console.log(JSON.stringify({ breadcrumb: 'analytics-not-configured', route: 'metering' }));
		return jsonError(c, 503, 'Analytics not configured');
	}
	const query = parseQueryParams(c, crossSurfaceMeteringQuerySchema);
	if (query instanceof Response) return query;

	const rows = await queryMeteringAcrossSurfaces(c.env.ANALYTICS_DB, query);

	console.log(JSON.stringify({ route: 'admin.metering', tenants: rows.length, ts: new Date().toISOString() }));

	return c.json({ success: true, result: rows });
});
```

In `src/routes/admin.ts`:

1. Add the import after the other analytics sub-app imports (~line 7):

```ts
import { adminMeteringApp } from './admin-metering';
```

2. Add the RBAC middleware next to the existing `adminApp.use('/analytics/*', requireRole('viewer'));` (~line 69):

```ts
adminApp.use('/metering', requireRole('viewer'));
adminApp.use('/metering/*', requireRole('viewer'));
```

3. Add the mount next to the other `adminApp.route('/analytics', …)` lines (~line 95):

```ts
adminApp.route('/metering', adminMeteringApp);
```

Note: `/admin/*` is already in `run_worker_first` (`wrangler.jsonc:51`), so no asset-layer change is needed. The 401-without-auth assertion is real (the worker test pool DOES exercise `adminAuth`).

- [x] **Step 4: Run test to verify it passes** — 2/2 (16/16 whole file); 401 confirmed from `adminAuth` gate via breadcrumb, not a 404. typecheck + lint clean.

Run: `bunx vitest run test/analytics-metering.test.ts -t "unified"`
Expected: PASS (2 tests). Then full file green: `bunx vitest run test/analytics-metering.test.ts`.

- [x] **Step 5: Commit** — committed 3bfeab8; spec review ✅, code quality APPROVED.

```bash
git add src/routes/admin-metering.ts src/routes/admin.ts test/analytics-metering.test.ts
git commit -m "feat(metering): unified cross-surface /admin/metering endpoint"
```

---

## Task 6: CLI `gk metering` ✅ DONE (76e8ec8)

**Files:**
- Create: `cli/commands/metering.ts`
- Modify: `cli/index.ts`
- Modify: `cli/commands/completions.ts`
- Test: `cli/metering.test.ts` (run with `-c vitest.cli.config.ts`)

- [x] **Step 1: Write the failing test** (NOTE: sibling test is `cli/commands/supabase-analytics.test.ts`, not `cli/supabase-analytics.test.ts`)

READ `cli/supabase-analytics.test.ts` first and copy its exact mock harness (how it stubs the HTTP client and captures the requested path). Create `cli/metering.test.ts` with two real assertions (replace the placeholder bodies using the sibling harness — do NOT ship `expect(true).toBe(true)`):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Mirror the import + mock setup from cli/supabase-analytics.test.ts (apiFetch mock, ui spies).

describe('gk metering', () => {
	beforeEach(() => { /* reset mocks as the sibling test does */ });

	it('cross-surface default calls GET /admin/metering', async () => {
		// Arrange: mock apiFetch to capture path, return { success: true, result: [] }
		// Act: run the metering command with no --surface
		// Assert: captured path starts with '/admin/metering'
	});

	it('--surface supabase calls GET /admin/supabase/analytics/metering', async () => {
		// Assert: captured path starts with '/admin/supabase/analytics/metering'
	});
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bunx vitest run -c vitest.cli.config.ts cli/metering.test.ts`
Expected: FAIL — `cli/commands/metering.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

READ `cli/commands/supabase-analytics.ts` first to copy its exact patterns (`defineCommand`, the global args it declares, `apiFetch` call, `spinner`/`success`/`info`/`dim`/`error` from `ui`, table rendering). Create `cli/commands/metering.ts`:

```ts
import { defineCommand } from 'citty';
// Reuse the same ui + http imports the sibling command uses (apiFetch, success, info, error, dim, formatDuration, spinner).

const SURFACE_PATHS: Record<string, string> = {
	supabase: '/admin/supabase/analytics/metering',
	cf: '/admin/cf/analytics/metering',
	dns: '/admin/dns/analytics/metering',
	purge: '/admin/analytics/metering',
	s3: '/admin/s3/analytics/metering',
};

export default defineCommand({
	meta: { name: 'metering', description: 'Per-tenant cost metering across proxy surfaces' },
	args: {
		// Copy the global url + admin-key args verbatim from the sibling command.
		surface: { type: 'string', description: 'Single surface (supabase|cf|dns|purge|s3); omit for cross-surface' },
		'group-by': { type: 'string', description: 'Per-surface grouping dim (tenant|key|project|zone|credential|bucket)' },
		since: { type: 'string', description: 'Window start (unix ms)' },
		until: { type: 'string', description: 'Window end (unix ms)' },
		limit: { type: 'string', description: 'Max rows (default 100, max 1000)' },
	},
	async run({ args }) {
		const params = new URLSearchParams();
		if (args.since) params.set('since', String(args.since));
		if (args.until) params.set('until', String(args.until));
		if (args.limit) params.set('limit', String(args.limit));

		let path: string;
		if (args.surface) {
			const base = SURFACE_PATHS[args.surface as string];
			if (!base) {
				// Use the sibling's error() + process.exit(1) pattern.
				throw new Error(`Unknown surface '${args.surface}'. One of: ${Object.keys(SURFACE_PATHS).join(', ')}`);
			}
			if (args['group-by']) params.set('group_by', String(args['group-by']));
			const qs = params.toString();
			path = qs ? `${base}?${qs}` : base;
		} else {
			const qs = params.toString();
			path = qs ? `/admin/metering?${qs}` : '/admin/metering';
		}

		// Call apiFetch(path, args) exactly as the sibling command does, then render rows as a table:
		//  - cross-surface (no --surface): columns Tenant | Total req | Errors | Egress (bytes) | per-surface req counts
		//  - single-surface: columns Label | Total req | Read | Write | Error% | Egress (bytes)
		// Copy the spinner + table-render + success-line idioms from cli/commands/supabase-analytics.ts (summary subcommand).
	},
});
```

Fill the `run` body's HTTP call + table rendering by copying the concrete `apiFetch`/spinner/render code from the `summary` subcommand in `cli/commands/supabase-analytics.ts`. The columns are listed in the comments above.

In `cli/index.ts`, add to the lazy command map (next to the other analytics entries, ~line 23):

```ts
		metering: () => import('./commands/metering.js').then((m) => m.default),
```

In `cli/commands/completions.ts`, add `metering` following the existing entries (READ the file first to match its format — flat array vs object).

- [x] **Step 4: Run test to verify it passes** — 2/2; full CLI suite 60/60 (no regression); typecheck + lint clean. Uses `request`/`resolveConfig`/`assertOk` from `../client.js`.

Run: `bunx vitest run -c vitest.cli.config.ts cli/metering.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Commit** — committed 76e8ec8; spec review ✅, code quality APPROVED.

```bash
git add cli/commands/metering.ts cli/index.ts cli/commands/completions.ts cli/metering.test.ts
git commit -m "feat(metering): gk metering CLI command (cross-surface + --surface)"
```

---

## Task 7: Dashboard metering panel ✅ DONE (7a5a23c)

Implemented as a self-contained `dashboard/src/components/analytics/MeteringPanel.tsx` + an Events/Metering view switcher in `AnalyticsPage.tsx` + `formatBytes` in `analytics-helpers.ts`. Build + typecheck + lint clean; events view verified intact (cosmetic re-indent only). Spec review ✅, code quality APPROVED.

**Files:**
- Modify: `dashboard/src/lib/api.ts`
- Modify: `dashboard/src/components/AnalyticsPage.tsx`
- Create: `dashboard/src/components/analytics/MeteringPanel.tsx`
- Modify: `dashboard/src/components/analytics/analytics-helpers.ts` (shared `formatBytes`)

- [x] **Step 1: Add the API client functions**

READ `dashboard/src/lib/api.ts` around `getSupabaseProxySummary` (~line 749) to copy the exact `apiFetch`/return-unwrap idiom (it may already unwrap `{ success, result }` — adapt accordingly). Add:

```ts
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

export interface CrossSurfaceTenantRow {
	tenant: string | null;
	surfaces: Record<string, { total_requests: number; write_requests: number | null; error_count: number; egress_bytes: number | null }>;
	total_requests: number;
	total_errors: number;
	total_egress_bytes: number;
}

export async function getCrossSurfaceMetering(query: { since?: number; until?: number; limit?: number } = {}): Promise<CrossSurfaceTenantRow[]> {
	const params = new URLSearchParams();
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	if (query.limit) params.set('limit', String(query.limit));
	const qs = params.toString();
	const res = await apiFetch(`/admin/metering${qs ? `?${qs}` : ''}`);
	const data = await res.json();
	return data.result as CrossSurfaceTenantRow[];
}

export async function getSurfaceMetering(surface: string, query: { group_by?: string; since?: number; until?: number; limit?: number } = {}): Promise<MeteringRow[]> {
	const base: Record<string, string> = {
		supabase: '/admin/supabase/analytics/metering',
		cf: '/admin/cf/analytics/metering',
		dns: '/admin/dns/analytics/metering',
		purge: '/admin/analytics/metering',
		s3: '/admin/s3/analytics/metering',
	};
	const params = new URLSearchParams();
	if (query.group_by) params.set('group_by', query.group_by);
	if (query.since) params.set('since', String(query.since));
	if (query.until) params.set('until', String(query.until));
	if (query.limit) params.set('limit', String(query.limit));
	const qs = params.toString();
	const res = await apiFetch(`${base[surface]}${qs ? `?${qs}` : ''}`);
	const data = await res.json();
	return data.result as MeteringRow[];
}
```

Match the exact `apiFetch` signature/return handling used by the existing functions in the file.

- [x] **Step 2: Add the panel to AnalyticsPage**

READ `dashboard/src/components/AnalyticsPage.tsx` to find its section/tab structure. Add a "Metering" section that:
- Defaults to the cross-surface view (`getCrossSurfaceMetering`), rendered as a **dense table** (per `design-utilitarian`: rows not cards, no animation), columns: Tenant · Total req · Errors · Egress (bytes) · then one column per surface showing that surface's request count.
- Has a surface dropdown (All / supabase / cf / dns / purge / s3); selecting a single surface switches to `getSurfaceMetering(surface, { group_by })` with a group-by selector populated from that surface's valid dims.
- Marks the Egress column header with a footnote: "best-effort — excludes streamed responses".
- Respects the page's existing time-window state (since/until) if present; otherwise default to last 7 days client-side.

Reuse the same table component / class names as the existing analytics tables in the file.

- [x] **Step 3: Build the dashboard to verify it compiles** — `bun run build` succeeded (10 pages + CLI), typecheck + lint clean.

Run: `bun run build`
Expected: dashboard build succeeds (no TS errors).

- [x] **Step 4: Commit** — committed 7a5a23c.

```bash
git add dashboard/src/lib/api.ts dashboard/src/components/AnalyticsPage.tsx dashboard/src/components/analytics/
git commit -m "feat(metering): dashboard cross-surface + per-surface metering panel"
```

---

## Interlude: API-coverage drift check ✅ DONE (d6af4ef)

Ran `bun run check:api-coverage` mid-stream. Upstream Supabase added 4 endpoints since the last snapshot (`database/jit/invite*` → `supabase:database:*`, `analytics/endpoints/logs` → `supabase:analytics:read`); all already covered by existing classifier rules (gaps: 0), snapshot was stale. Refreshed via `api-coverage:write`, hermetic test 15/15, live check now `all providers covered and snapshots current`. Independent of metering.

---

## Task 8: E2E deploy-gate smoke ✅ DONE (a143167)

Controller ran `bunx playwright test e2e/metering-ui.spec.ts` → **3 passed (3.1s)** against a real `wrangler dev`. Panel rendered with real local data (tenants: 36/6). Selector targets the always-rendered "All (cross-surface)" button (data-independent on cold DB). Spec review ✅, code quality APPROVED.

**Why this task exists:** e2e (`e2e/**/*.spec.ts`, Playwright against `wrangler dev` on `:8787`) is a CI deploy gate — `deploy` needs `[preflight, e2e]`. `bun run preflight` does NOT run Playwright. The worker test pool calls `app.fetch` directly and is blind to the asset layer; e2e is what proves the new dashboard panel actually loads data through the real `run_worker_first` + Hono path in a deployed-like environment. The metering routes sit under `/admin/*` (already whitelisted, so the asset-shadow trap doesn't apply here), but the new UI still needs the gate smoke.

**Files:**
- Create: `e2e/metering-ui.spec.ts`

- [x] **Step 1: Write the e2e spec**

READ `e2e/supabase-ui.spec.ts` first to copy its exact `setupAuth` helper, admin-key constant, and `request`-context seeding idiom. The dashboard analytics page is `dashboard/src/pages/dashboard/analytics.astro` → URL `/dashboard/analytics`. Create `e2e/metering-ui.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

const ANALYTICS_URL = '/dashboard/analytics';
const ADMIN_KEY = 'test-admin-secret-key-12345';

async function setupAuth(page: import('@playwright/test').Page, url: string) {
	await page.goto(url);
	await page.evaluate((key) => localStorage.setItem('adminKey', key), ADMIN_KEY);
	await page.goto(url);
}

test.describe('Metering panel', () => {
	test('cross-surface metering endpoint responds through the real worker path', async ({ request }) => {
		// Hits the deployed-like asset layer + worker (not app.fetch). Proves /admin/metering is
		// not shadowed by the SPA fallback and returns the structured envelope.
		const res = await request.get('/admin/metering', { headers: { 'X-Admin-Key': ADMIN_KEY } });
		expect(res.ok()).toBeTruthy();
		const data = (await res.json()) as any;
		expect(data.success).toBeTruthy();
		expect(Array.isArray(data.result)).toBeTruthy();
	});

	test('analytics page renders the Metering panel', async ({ page }) => {
		await setupAuth(page, ANALYTICS_URL);
		// The Task 7 panel exposes a "Metering" section heading/tab and a table.
		// Use a resilient text selector that MUST match the label chosen in Task 7.
		await expect(page.getByText('Metering', { exact: false }).first()).toBeVisible();
	});

	test('per-surface metering endpoint responds (supabase)', async ({ request }) => {
		const res = await request.get('/admin/supabase/analytics/metering?group_by=project', {
			headers: { 'X-Admin-Key': ADMIN_KEY },
		});
		expect(res.ok()).toBeTruthy();
		const data = (await res.json()) as any;
		expect(data.success).toBeTruthy();
		expect(Array.isArray(data.result)).toBeTruthy();
	});
});
```

The `getByText('Metering')` selector MUST match the section heading/tab label implemented in Task 7. If Task 7 used a different label, update this selector to match — they are coupled.

- [x] **Step 2: Build the dashboard (e2e serves built assets)** — `bun run build` → BUILD_OK.

Run: `bun run build`
Expected: succeeds — Playwright serves `dashboard/dist` via `wrangler dev`, so a stale build would test old UI.

- [x] **Step 3: Run the e2e spec** — 3 passed (3.1s), exit 0. (Benign `workerd` Broken-pipe teardown noise after assertions — not a failure.)

Run: `bunx playwright test e2e/metering-ui.spec.ts`
Expected: PASS (3 tests). Playwright auto-boots `wrangler dev` on `:8787` (or reuses a running one locally).

If the page-render test fails on the selector, reconcile the label between this spec and the Task 7 panel — do not loosen the assertion to always-pass.

- [x] **Step 4: Commit** — committed a143167.

```bash
git add e2e/metering-ui.spec.ts
git commit -m "test(e2e): metering panel deploy-gate smoke"
```

---

## Task 9: Docs ✅ DONE (e8edd12)

Added §7.5 Per-tenant metering to `docs/GUIDE.md` (matches the §7.x numbered + CLI/API idiom). Content verified against the implementation. No TOC/route-list to sync.

**Files:**
- Modify: `docs/GUIDE.md`

- [x] **Step 1: Add a Metering section**

READ `docs/GUIDE.md` to find the analytics section. Add a "Per-tenant metering" subsection:

```markdown
### Per-tenant metering

Gatekeeper rolls up per-tenant cost across every proxy surface from the events it
already logs — no extra instrumentation.

- **Per-surface:** `GET /admin/<surface>/analytics/metering?group_by=<dim>` and
  `gk metering --surface <surface> --group-by <dim>`. Valid `group_by` dims per surface:
  - supabase: `tenant` (created_by), `key`, `project`
  - cf: `tenant`, `key`
  - dns / purge: `tenant`, `key`, `zone`
  - s3: `tenant`, `credential`, `bucket`
- **Cross-surface:** `GET /admin/metering` and `gk metering` (no `--surface`). Aggregates
  every surface into one row per tenant, unified on `created_by` — the only identity
  column present in all five event tables. A tenant holding multiple keys across
  surfaces is summed correctly; per-key grouping is a per-surface view only.

Metrics returned: `total_requests`, `read_requests` / `write_requests` (null on surfaces
with no read/write split — e.g. purge), `error_count` / `error_rate_pct`, and `egress_bytes`.

**Egress is best-effort.** `egress_bytes` sums the `response_size` Gatekeeper buffered, and
is `null` for streamed passthrough (Prometheus metrics scrapes and any streamed body) and on
surfaces with no `response_size` column (purge / dns / s3). Request-count metering is
authoritative (every call is logged); byte/compute metering is not. For true egress GB,
storage GB, function compute, and active compute-hours, query Supabase's own usage endpoints
(classified as `supabase:analytics:read`) — noting that active compute-hours are not
self-serve upstream.
```

- [x] **Step 2: Commit** — committed e8edd12.

```bash
git add docs/GUIDE.md
git commit -m "docs(metering): document per-tenant + cross-surface metering and egress caveat"
```

---

## Task 10: Full preflight + e2e ✅ DONE

- [x] **Step 1: Typecheck + lint + tests + build** — `bun run preflight` green: **1222 tests pass (55 files)**, openapi up to date, dashboard (10 pages) + CLI build complete, exit 0.

Run: `bun run preflight`
Expected: typecheck clean, Prettier clean, all worker + CLI tests pass, openapi + build succeed.

- [x] **Step 2: Run the full e2e suite (the deploy gate — NOT part of preflight)** — `bun run test:e2e` → **47 passed (13.6s)**, exit 0 (purge-profiles, condition-editor, supabase-ui, metering-ui).

Run: `bun run test:e2e`
Expected: all specs pass, including the existing `purge-profiles`, `condition-editor`, `supabase-ui`, and the new `metering-ui`. This mirrors the CI `deploy` gate (`needs: [preflight, e2e]`), which `bun run preflight` does not cover.

- [x] **Step 3: No formatting fixups needed** — lint clean throughout.

```bash
git add -A
git commit -m "chore(metering): preflight formatting"
```

---

## Self-Review notes

- **Spec coverage:** generic engine (T1) + cross-surface (T2) + schemas (T3) + per-surface routes (T4) + unified route (T5) + CLI (T6) + dashboard (T7) + e2e deploy-gate smoke (T8) + docs (T9) + preflight & e2e suite (T10). All five surfaces fold in via `METERING_DESCRIPTORS`.
- **CI gate coverage:** worker tests (T1–T5) run in `preflight`; CLI test (T6) runs in `preflight`; the dashboard build (T7) is verified; the e2e spec (T8) runs in the CI `e2e` job that gates `deploy`. The e2e selector for the panel heading is coupled to the Task 7 label — reconcile if changed.
- **Type consistency:** `MeteringRow`, `CrossSurfaceTenantRow`, `MeteringQuery`, `CrossSurfaceMeteringQuery`, `queryMetering`, `queryMeteringAcrossSurfaces`, `METERING_DESCRIPTORS` are named identically across engine, routes, CLI, dashboard. The dashboard re-declares `MeteringRow` / `CrossSurfaceTenantRow` locally (the dashboard does not import worker `src/` types — this matches the existing `SupabaseProxyEvent` duplication pattern in `dashboard/src/lib/api.ts`).
- **No DB migration:** every column read (`created_by`, `key_fingerprint`, `response_size`, `action`, `operation`, `status`, `created_at`, `zone_id`, `project_ref`, `bucket`, `credential_id`, `key_id`) already exists in `src/schema.ts`.
- **SQL-injection surface:** group-by columns and write-rule prefixes come only from hardcoded descriptor literals; request `group_by` is a logical-key lookup that throws on miss. Same discipline as `ALLOWED_TABLES`.
- **Known pitfall checked:** `/admin/*` already in `run_worker_first`, so the new routes are not shadowed by the SPA asset layer.

## Adding the next surface later

One `METERING_DESCRIPTORS` entry (table, previewColumn, groupable dims, writeRule, hasEgress) + one `/metering` route line in that surface's analytics sub-app. The cross-surface aggregate picks it up automatically (it iterates `Object.keys(METERING_DESCRIPTORS)`). No engine change.
