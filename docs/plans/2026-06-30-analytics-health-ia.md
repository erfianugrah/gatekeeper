# Analytics Health + IA Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tacked-on Supabase-only health banner with a generic per-surface Health table on the Overview, and promote Metering from an in-Analytics view toggle to its own Observability nav item.

**Architecture:** Frontend-only (dashboard) refactor. A new pure helper (`health.ts`) derives uniform per-surface health (error rate, 5xx, surface-specific signals) from the analytics summaries already fetched by `OverviewDashboard`. The Overview renders that as a dense table (design-utilitarian: tables over banners), eliminating the floating peach banner and the three Supabase-specific stat cards that duplicated it. Metering moves to `/dashboard/metering` rendering the existing self-contained `MeteringPanel`, and the `Events | Metering` toggle is removed from `AnalyticsPage`.

**Tech Stack:** Astro 6 (static) + React islands, shadcn/ui (`Card`, `Table`, `Badge`), Tailwind v4, recharts (unchanged), Playwright e2e.

**No backend changes:** no worker routes, no D1 schema, no `run_worker_first` entries (dashboard pages are static assets, not worker routes). All data comes from existing `getXSummary()` calls.

**Verification gates (dashboard has no unit runner):**
- `bun run build:dashboard` - the type/compile gate for TSX (root `bun run typecheck` does NOT cover `dashboard/`).
- `bunx playwright test e2e/metering-ui.spec.ts` - e2e for the metering page.
- `bunx prettier --write '<touched dashboard files>'` - keep formatting consistent (the repo `lint` script excludes `dashboard/`, so format manually).

---

## File Structure

- **Create** `dashboard/src/components/analytics/health.ts` - pure health model + `computeSurfaceHealth()`. One responsibility: turn summaries into `SurfaceHealth[]`.
- **Modify** `dashboard/src/components/OverviewDashboard.tsx` - delete the Supabase banner + 3 Supabase stat cards + their derived consts; add the Health table using the helper.
- **Create** `dashboard/src/pages/dashboard/metering.astro` - standalone Metering page.
- **Modify** `dashboard/src/layouts/DashboardLayout.astro` - add `metering` nav link + `gauge` icon.
- **Modify** `dashboard/src/components/AnalyticsPage.tsx` - remove the Events/Metering view switcher; Analytics is events-only.
- **Modify** `e2e/metering-ui.spec.ts` - point the UI test at `/dashboard/metering` instead of clicking the toggle.

---

## Task 1: Generic health model helper

**Files:**
- Create: `dashboard/src/components/analytics/health.ts`

- [ ] **Step 1: Write the helper**

Create `dashboard/src/components/analytics/health.ts`:

```ts
import type {
	AnalyticsSummary,
	S3AnalyticsSummary,
	DnsAnalyticsSummary,
	CfProxyAnalyticsSummary,
	SupabaseProxyAnalyticsSummary,
} from '@/lib/api';

// ─── Health model ───────────────────────────────────────────────────

export type HealthLevel = 'ok' | 'warn' | 'crit';

export interface SurfaceHealth {
	/** Stable surface id (used as React key). */
	surface: string;
	/** Display label. */
	label: string;
	total: number;
	errorCount: number;
	/** Error rate as a percentage (0..100). */
	errorRate: number;
	count5xx: number;
	level: HealthLevel;
	/** Notable surface-specific signals (e.g. '401 18.2%'); does NOT include 5xx (own column). */
	signals: string[];
}

// Generic thresholds (percentages of total requests).
export const WARN_ERROR_PCT = 5;
export const CRIT_ERROR_PCT = 15;
// Supabase-specific thresholds (mirror the previous banner logic).
export const SUPABASE_TIMEOUT_WARN_PCT = 2;
export const SUPABASE_UNAUTHORIZED_WARN_PCT = 5;

function countWhere(byStatus: Record<string, number>, pred: (n: number) => boolean): number {
	let acc = 0;
	for (const [k, v] of Object.entries(byStatus)) {
		if (pred(Number(k))) acc += v;
	}
	return acc;
}

/** Generic health from a status histogram. 5xx is surfaced as a column, not a signal. */
function baseHealth(surface: string, label: string, total: number, byStatus: Record<string, number>): SurfaceHealth {
	const errorCount = countWhere(byStatus, (n) => n >= 400);
	const count5xx = countWhere(byStatus, (n) => n >= 500);
	const errorRate = total > 0 ? (errorCount / total) * 100 : 0;
	let level: HealthLevel = 'ok';
	if (errorRate >= CRIT_ERROR_PCT) level = 'crit';
	else if (errorRate >= WARN_ERROR_PCT || count5xx > 0) level = 'warn';
	return { surface, label, total, errorCount, errorRate, count5xx, level, signals: [] };
}

export interface HealthInputs {
	purge: AnalyticsSummary | null;
	purgeTotal: number;
	s3: S3AnalyticsSummary | null;
	s3Total: number;
	dns: DnsAnalyticsSummary | null;
	dnsTotal: number;
	cf: CfProxyAnalyticsSummary | null;
	cfTotal: number;
	supabase: SupabaseProxyAnalyticsSummary | null;
	supaTotal: number;
}

/**
 * Compute uniform per-surface health for every surface that has traffic.
 * Supabase gets extra signals (timeouts / 401 / upstream 5xx) layered on top
 * of the generic error-rate model, replacing the old Supabase-only banner.
 */
export function computeSurfaceHealth(inp: HealthInputs): SurfaceHealth[] {
	const out: SurfaceHealth[] = [];
	if (inp.purgeTotal > 0 && inp.purge) out.push(baseHealth('purge', 'Purge', inp.purgeTotal, inp.purge.by_status));
	if (inp.s3Total > 0 && inp.s3) out.push(baseHealth('s3', 'S3', inp.s3Total, inp.s3.by_status));
	if (inp.dnsTotal > 0 && inp.dns) out.push(baseHealth('dns', 'DNS', inp.dnsTotal, inp.dns.by_status));
	if (inp.cfTotal > 0 && inp.cf) out.push(baseHealth('cf', 'CF', inp.cfTotal, inp.cf.by_status));
	if (inp.supaTotal > 0 && inp.supabase) {
		const h = baseHealth('supabase', 'Supabase', inp.supaTotal, inp.supabase.by_status);
		const s = inp.supabase;
		const timeoutRate = (s.timeout_count / inp.supaTotal) * 100;
		const unauthorizedRate = (s.unauthorized_count / inp.supaTotal) * 100;
		if (timeoutRate >= SUPABASE_TIMEOUT_WARN_PCT) {
			h.signals.push(`Timeouts ${timeoutRate.toFixed(1)}%`);
			if (h.level === 'ok') h.level = 'warn';
		}
		if (unauthorizedRate >= SUPABASE_UNAUTHORIZED_WARN_PCT) {
			h.signals.push(`401 ${unauthorizedRate.toFixed(1)}%`);
			if (h.level === 'ok') h.level = 'warn';
		}
		if (s.upstream_5xx_count > 0) {
			h.signals.push(`Upstream 5xx ${s.upstream_5xx_count}`);
			if (h.level === 'ok') h.level = 'warn';
		}
		out.push(h);
	}
	return out;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /home/erfi/gatekeeper && bunx tsc --noEmit -p dashboard/tsconfig.json 2>&1 | head -20`
Expected: no errors referencing `health.ts`. (If `dashboard/tsconfig.json` has no `noEmit`-friendly setup, defer to the Task-2 `bun run build:dashboard` gate instead - the file is consumed there.)

> Note: there is no dashboard unit-test runner, so this helper is covered by the `build:dashboard` compile gate and the Overview rendering in Task 2. Standing up vitest for the dashboard is out of scope (YAGNI).

---

## Task 2: Health table on Overview (delete banner + Supabase cards)

**Files:**
- Modify: `dashboard/src/components/OverviewDashboard.tsx`

- [ ] **Step 1: Add imports**

In `OverviewDashboard.tsx`, add the Table primitives and the health helper near the existing imports (after the `Badge` / `Card` imports):

```ts
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { computeSurfaceHealth, WARN_ERROR_PCT, type HealthLevel } from '@/components/analytics/health';
```

- [ ] **Step 2: Add the health-dot color map + compute the rows**

Inside `OverviewDashboard()`, in the "Derived data" region (right after `const supaTotal = ...; const totalRequests = ...`), add:

```ts
const HEALTH_DOT: Record<HealthLevel, string> = {
	ok: 'bg-lv-green',
	warn: 'bg-lv-peach',
	crit: 'bg-lv-red',
};

const surfaceHealth = computeSurfaceHealth({
	purge: purgeSummary,
	purgeTotal,
	s3: s3Summary,
	s3Total,
	dns: dnsSummary,
	dnsTotal,
	cf: cfSummary,
	cfTotal,
	supabase: supabaseSummary,
	supaTotal,
});
```

- [ ] **Step 3: Delete the old Supabase health-alert derived consts**

Remove this block (currently ~lines 580-588 - the `supabaseTimeouts`/`supabaseUnauthorized`/`supabaseUpstream5xx`/`supabaseTimeoutRate`/`supabaseUnauthorizedRate`/`supabaseAlerts` computation). Exact text to delete:

```ts
	const supabaseTimeouts = supabaseSummary?.timeout_count ?? 0;
	const supabaseUnauthorized = supabaseSummary?.unauthorized_count ?? 0;
	const supabaseUpstream5xx = supabaseSummary?.upstream_5xx_count ?? 0;
	const supabaseTimeoutRate = supaTotal > 0 ? (supabaseTimeouts / supaTotal) * 100 : 0;
	const supabaseUnauthorizedRate = supaTotal > 0 ? (supabaseUnauthorized / supaTotal) * 100 : 0;
	const supabaseAlerts: string[] = [];
	if (supaTotal > 0) {
		if (supabaseTimeoutRate >= 2) supabaseAlerts.push(`Timeouts ${supabaseTimeoutRate.toFixed(1)}%`);
		if (supabaseUnauthorizedRate >= 5) supabaseAlerts.push(`401 ${supabaseUnauthorizedRate.toFixed(1)}%`);
		if (supabaseUpstream5xx > 0) supabaseAlerts.push(`Upstream 5xx ${supabaseUpstream5xx}`);
	}
```

Keep the `collapsedPct` line that precedes it.

- [ ] **Step 4: Delete the floating Supabase banner**

Remove the banner JSX (currently ~lines 607-625):

```tsx
				{/* ── Supabase health alerts ─────────────────────────────── */}
				{!error && supabaseAlerts.length > 0 && (
					<div className="rounded-lg border border-lv-peach/30 bg-lv-peach/10 px-4 py-3">
						<div className="mb-2 flex items-center gap-2 text-sm text-lv-peach">
							<AlertTriangle className="h-4 w-4" />
							<span className="font-medium">Supabase upstream health signals</span>
						</div>
						<div className="flex flex-wrap gap-2">
							{supabaseAlerts.map((msg) => (
								<Badge key={msg} className="bg-lv-peach/20 text-lv-peach border-lv-peach/30">
									{msg}
								</Badge>
							))}
						</div>
					</div>
				)}
```

- [ ] **Step 5: Insert the Health table at the top of the data region**

The data region begins with `{!loading && totalRequests > 0 && (` then `<>` then `{/* Row 1: Traffic stat cards */}`. Insert the Health card immediately after the opening `<>` and before the `{/* Row 1: Traffic stat cards */}` comment. Note the empty-marker cell uses `{'\u2014'}` (a real em-dash at runtime, matching the dashboard's existing empty-marker convention):

```tsx
						{/* Row 0: Per-surface health */}
						{surfaceHealth.length > 0 && (
							<Card>
								<CardHeader>
									<CardTitle className={T.sectionHeading}>
										<div className="flex items-center gap-2">
											<Activity className="h-4 w-4 text-muted-foreground" />
											Health
										</div>
									</CardTitle>
								</CardHeader>
								<CardContent className="p-0">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className={T.sectionLabel}>Surface</TableHead>
												<TableHead className={cn(T.sectionLabel, 'text-right')}>Requests</TableHead>
												<TableHead className={cn(T.sectionLabel, 'text-right')}>Error %</TableHead>
												<TableHead className={cn(T.sectionLabel, 'text-right')}>5xx</TableHead>
												<TableHead className={T.sectionLabel}>Signals</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{surfaceHealth.map((h) => (
												<TableRow key={h.surface}>
													<TableCell>
														<div className="flex items-center gap-2">
															<span className={cn('h-2 w-2 rounded-full', HEALTH_DOT[h.level])} />
															<span className={T.tableCellMono}>{h.label}</span>
														</div>
													</TableCell>
													<TableCell className={T.tableCellNumeric}>{formatNumber(h.total)}</TableCell>
													<TableCell className={cn(T.tableCellNumeric, h.errorRate >= WARN_ERROR_PCT && 'text-lv-red')}>
														{h.errorRate.toFixed(1)}%
													</TableCell>
													<TableCell className={cn(T.tableCellNumeric, h.count5xx > 0 && 'text-lv-red')}>{h.count5xx}</TableCell>
													<TableCell>
														{h.signals.length === 0 ? (
															<span className="text-muted-foreground/40">{'\u2014'}</span>
														) : (
															<div className="flex flex-wrap gap-1.5">
																{h.signals.map((sig) => (
																	<Badge key={sig} className="bg-lv-peach/20 text-lv-peach border-lv-peach/30">
																		{sig}
																	</Badge>
																))}
															</div>
														)}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</CardContent>
							</Card>
						)}

```

- [ ] **Step 6: Delete the three Supabase-specific stat cards**

In the "Row 1: Traffic stat cards" grid, remove the three conditional cards (currently ~lines 688-722): the `label="Supabase"`, `label="Supabase 401"`, and `label="Supabase Timeouts"` `<StatCard>` blocks (each wrapped in `{supaTotal > 0 && ( ... )}`). Exact text to delete:

```tsx
							{supaTotal > 0 && (
								<StatCard
									label="Supabase"
									value={formatNumber(supaTotal)}
									icon={<Database className="h-5 w-5 text-lv-peach" />}
									iconBg="bg-lv-peach/15"
									delay={172}
								/>
							)}
							{supaTotal > 0 && (
								<StatCard
									label="Supabase 401"
									value={formatNumber(supabaseUnauthorized)}
									icon={<AlertTriangle className="h-5 w-5 text-lv-peach" />}
									iconBg="bg-lv-peach/15"
									delay={176}
								/>
							)}
							{supaTotal > 0 && (
								<StatCard
									label="Supabase Timeouts"
									value={formatNumber(supabaseTimeouts)}
									icon={<Timer className="h-5 w-5 text-lv-red" />}
									iconBg="bg-lv-red/15"
									delay={178}
								/>
							)}
```

Leave the generic `Total Requests` / `Purge` / `S3` / `DNS` / `CF Services` / `Avg Latency` / `Error Rate` / `URLs Purged` / `Collapsed %` cards intact. (The Supabase request count is now the `supabase` row of the Health table; 401/Timeout are its Signals.)

- [ ] **Step 7: Build the dashboard to verify it compiles + no orphaned references**

Run: `cd /home/erfi/gatekeeper && bun run build:dashboard 2>&1 | tail -25`
Expected: build succeeds. No `supabaseAlerts` / `supabaseTimeouts` / `supabaseUnauthorized` / `supabaseUpstream5xx` references remain (they were deleted). `AlertTriangle`, `Timer`, `Database` imports are still used by other cards/icons so they stay.

Confirm no stragglers: `rg -n 'supabaseAlerts|supabaseTimeoutRate|supabaseUnauthorizedRate|supabaseUpstream5xx' dashboard/src/components/OverviewDashboard.tsx`
Expected: no output.

- [ ] **Step 8: Format + commit**

```bash
cd /home/erfi/gatekeeper
bunx prettier --write dashboard/src/components/analytics/health.ts dashboard/src/components/OverviewDashboard.tsx
git add dashboard/src/components/analytics/health.ts dashboard/src/components/OverviewDashboard.tsx
git commit -m "feat(dashboard): replace Supabase health banner with generic per-surface Health table"
```

---

## Task 3: Promote Metering to its own Observability page

**Files:**
- Create: `dashboard/src/pages/dashboard/metering.astro`
- Modify: `dashboard/src/layouts/DashboardLayout.astro:12-19` (nav links) + the section-icon switch (~line 140)
- Modify: `dashboard/src/components/AnalyticsPage.tsx`

- [ ] **Step 1: Create the Metering page**

Create `dashboard/src/pages/dashboard/metering.astro`:

```astro
---
import DashboardLayout from "../../layouts/DashboardLayout.astro";
import { MeteringPanel } from "../../components/analytics/MeteringPanel";
---

<DashboardLayout title="gatekeeper - Metering" active="metering">
  <MeteringPanel client:load />
</DashboardLayout>
```

- [ ] **Step 2: Add the nav link**

In `DashboardLayout.astro`, in the `navLinks` array, add a `metering` entry right after the `analytics` entry:

```js
  { id: "analytics", label: "Analytics", href: "/dashboard/analytics", icon: "list", section: "Observability" },
  { id: "metering", label: "Metering", href: "/dashboard/metering", icon: "gauge", section: "Observability" },
```

- [ ] **Step 3: Add the `gauge` icon**

In `DashboardLayout.astro`, in the section-links icon switch, add a `gauge` block immediately after the `{link.icon === "list" && ( ... )}` block:

```astro
                        {link.icon === "gauge" && (
                          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
                            <path d="M13.4 12.6 19 7" />
                            <path d="M4 20a8 8 0 1 1 16 0" />
                          </svg>
                        )}
```

- [ ] **Step 4: Remove the Events/Metering toggle from AnalyticsPage**

In `AnalyticsPage.tsx`:

(a) Remove the `MeteringPanel` import line:

```ts
import { MeteringPanel } from './analytics/MeteringPanel';
```

(b) Remove `Gauge, ListOrdered` from the lucide-react import (they were only used by the switcher). The import line currently ends `RefreshCw, Gauge, ListOrdered }` - change it to end `RefreshCw }`:

```ts
import { ChevronRight, ChevronsDownUp, Clock, Copy, Download, Search, ArrowUpDown, ArrowUp, ArrowDown, RefreshCw } from 'lucide-react';
```

(c) Remove the `AnalyticsView` type alias and the `view` state. Delete:

```ts
type AnalyticsView = 'events' | 'metering';
```

and delete:

```ts
	const [view, setView] = useState<AnalyticsView>('events');
```

(d) Remove the switcher block and unwrap the events content. The current JSX is:

```tsx
		<TooltipProvider delayDuration={200}>
			<div className="space-y-6">
				{/* ── View switcher: events log vs metering rollups ── */}
				<div className="flex rounded-md border border-border w-fit">
					<button
						onClick={() => setView('events')}
						className={cn(
							'inline-flex items-center gap-1.5 px-3 py-1 text-xs font-data transition-colors',
							view === 'events' ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
						)}
					>
						<ListOrdered className="h-3.5 w-3.5" />
						Events
					</button>
					<button
						onClick={() => setView('metering')}
						className={cn(
							'inline-flex items-center gap-1.5 px-3 py-1 text-xs font-data transition-colors border-l border-border',
							view === 'metering' ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
						)}
					>
						<Gauge className="h-3.5 w-3.5" />
						Metering
					</button>
				</div>

				{view === 'metering' && <MeteringPanel />}

				{view === 'events' && (
				<>
				{/* ── Controls row 1: source tabs + status filter + export ── */}
```

Replace that entire span (from `<div className="flex rounded-md border border-border w-fit">` through the `{view === 'events' && (` + `<>`) with just the controls comment, so it becomes:

```tsx
		<TooltipProvider delayDuration={200}>
			<div className="space-y-6">
				{/* ── Controls row 1: source tabs + status filter + export ── */}
```

(e) At the end of the component, remove the matching closing of the `view === 'events'` wrapper. The current tail is:

```tsx
					</Card>
				)}
				</>
				)}
			</div>
		</TooltipProvider>
```

Change it to:

```tsx
					</Card>
				)}
			</div>
		</TooltipProvider>
```

(Only the `</>` and the `)}` that closed `{view === 'events' && (` are removed; the `)}` that closes the `{!loading && filteredEvents.length > 0 && (` Card stays.)

- [ ] **Step 5: Build to verify**

Run: `cd /home/erfi/gatekeeper && bun run build:dashboard 2>&1 | tail -25`
Expected: build succeeds. `/dashboard/metering` is emitted as a page.

Confirm no orphaned references: `rg -n "AnalyticsView|setView|MeteringPanel|Gauge|ListOrdered" dashboard/src/components/AnalyticsPage.tsx`
Expected: no output.

- [ ] **Step 6: Format + commit**

```bash
cd /home/erfi/gatekeeper
bunx prettier --write dashboard/src/components/AnalyticsPage.tsx
git add dashboard/src/pages/dashboard/metering.astro dashboard/src/layouts/DashboardLayout.astro dashboard/src/components/AnalyticsPage.tsx
git commit -m "feat(dashboard): promote Metering to its own Observability nav page"
```

---

## Task 4: Update the metering e2e for the standalone page

**Files:**
- Modify: `e2e/metering-ui.spec.ts`

- [ ] **Step 1: Repoint the UI test**

In `e2e/metering-ui.spec.ts`, add a `METERING_URL` const next to `ANALYTICS_URL`:

```ts
const ANALYTICS_URL = '/dashboard/analytics';
const METERING_URL = '/dashboard/metering';
```

Replace the existing metering UI describe block. The current block (note: the real describe title uses a literal em-dash glyph in the repo, render it as a real em-dash when editing, not the ASCII hyphen shown here):

```ts
test.describe('Metering - dashboard panel', () => {
	test('clicking the Metering view switcher mounts the MeteringPanel', async ({ page }) => {
		await setupAuth(page, ANALYTICS_URL);

		// View switcher is a <button>Metering</button> (with a Gauge icon) in AnalyticsPage.tsx.
		await page.getByRole('button', { name: 'Metering' }).click();

		// MeteringPanel always renders its surface selector, regardless of data:
		// the first surface button is "All (cross-surface)".
		await expect(page.getByRole('button', { name: 'All (cross-surface)' })).toBeVisible();
	});
});
```

with (keep the same em-dash style in the title for consistency with the other describe blocks in the file):

```ts
test.describe('Metering - dashboard page', () => {
	test('the /dashboard/metering page mounts the MeteringPanel', async ({ page }) => {
		await setupAuth(page, METERING_URL);

		// MeteringPanel always renders its surface selector, regardless of data:
		// the first surface button is "All (cross-surface)".
		await expect(page.getByRole('button', { name: 'All (cross-surface)' })).toBeVisible();
	});
});
```

- [ ] **Step 2: Run the e2e**

Run: `cd /home/erfi/gatekeeper && bunx playwright test e2e/metering-ui.spec.ts`
Expected: all tests pass (Playwright `webServer` auto-starts `wrangler dev`; the dashboard `dist` must be built - it is, from Task 2/3 `build:dashboard`). The API-smoke tests are unchanged and still pass.

- [ ] **Step 3: Commit**

```bash
cd /home/erfi/gatekeeper
git add e2e/metering-ui.spec.ts
git commit -m "test(e2e): point metering UI test at the standalone /dashboard/metering page"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full dashboard build**

Run: `cd /home/erfi/gatekeeper && bun run build:dashboard 2>&1 | tail -15`
Expected: success.

- [ ] **Step 2: Worker + CLI typecheck unaffected**

Run: `cd /home/erfi/gatekeeper && bun run typecheck`
Expected: passes (no dashboard files in scope; this just confirms nothing in `src/`/`cli/` was touched).

- [ ] **Step 3: e2e suite for metering + supabase UI (touched surfaces)**

Run: `cd /home/erfi/gatekeeper && bunx playwright test e2e/metering-ui.spec.ts e2e/supabase-ui.spec.ts`
Expected: pass.

- [ ] **Step 4: Manual visual smoke (optional, if a dev server is up)**

- `/dashboard/` -> Health table at top (one row per active surface, green/amber/red dot; Supabase row shows `401`, `Timeouts`, `Upstream 5xx` badges in Signals); no floating peach banner; no `Supabase` / `Supabase 401` / `Supabase Timeouts` stat cards in Row 1.
- `/dashboard/metering` -> MeteringPanel renders with the surface selector; `Metering` appears in the sidebar under Observability with a gauge icon.
- `/dashboard/analytics` -> events log only, no Events/Metering toggle.

---

## Self-Review

**Spec coverage:**
- "Generic Health table replacing banner + Supabase cards" -> Tasks 1-2.
- "Metering own nav item under Observability" -> Task 3 (page + nav + icon) and removal of toggle.
- e2e kept green -> Task 4.

**Placeholder scan:** none - all edits show exact text.

**Type consistency:** `SurfaceHealth` / `HealthLevel` / `computeSurfaceHealth` / `HealthInputs` defined in Task 1 and consumed verbatim in Task 2 (`computeSurfaceHealth({...})`, `HEALTH_DOT: Record<HealthLevel, string>`, `WARN_ERROR_PCT`). `MeteringPanel` import path (`'./analytics/MeteringPanel'` in AnalyticsPage; `'../../components/analytics/MeteringPanel'` in metering.astro) matches the file's real location (`dashboard/src/components/analytics/MeteringPanel.tsx`). Nav `id: "metering"` matches `active="metering"` in metering.astro.

**Known caveat:** CF health is a single aggregate `cf` row (the CF summary exposes `by_status` only in aggregate, not per-service), which is honest given the available data; per-service CF health would require a backend change and is explicitly out of scope.
