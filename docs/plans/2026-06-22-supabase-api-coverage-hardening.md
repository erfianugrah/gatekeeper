# Supabase API Coverage Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Supabase gaps with API-first coverage (raw HTTP proxy paths first, CLI as secondary), and keep schema/docs/UI/CLI in sync.

**Architecture:** Keep the current Supabase proxy design (classification + policy + bound credential swap) unchanged, and harden the verification surfaces around it: (1) live smoke for real API behavior, (2) OpenAPI schema parity for `/supabase/*` and `/admin/supabase/analytics/*`, (3) CLI and dashboard parity for analytics/timeseries and operator UX. Add only non-destructive live probes.

**Tech Stack:** Cloudflare Workers + Hono, Vitest (worker + cli), Playwright, Bun, OpenAPI generator script, GitHub Actions.

---

## Scope and acceptance criteria

This plan is complete when all of the following are true:

1. `openapi.json` contains explicit Supabase proxy + Supabase analytics admin paths.
2. `smoke:supabase` validates real API behavior for:
   - `/supabase/v1/*` (already),
   - `/supabase/v0/projects/:ref/analytics/metrics` (live positive),
   - `/supabase/metrics/:ref` live positive with `supabase_metrics` secret,
   - at least one write-classified Management API call via raw HTTP (non-destructive payload).
3. CI live-smoke can exercise the new live checks when secrets exist, and self-skips cleanly when they do not.
4. CLI surface includes `gk supabase-analytics timeseries` (parity with existing API endpoint).
5. Dashboard e2e includes Supabase analytics visibility/filters.
6. Docs reflect API-first smoke behavior and no longer claim “CLI-only/not using official CLI”.

---

## Task 1: Add Supabase paths to OpenAPI schema + schema contract test

**Files:**
- Modify: `scripts/generate-openapi.ts`
- Modify: `openapi.json` (generated)
- Create: `test/openapi-supabase-schema.test.ts`

- [ ] **Step 1: Write failing OpenAPI contract test first**

```ts
// test/openapi-supabase-schema.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

function readOpenApi() {
	return JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as any;
}

describe('OpenAPI — Supabase paths', () => {
	it('documents supabase proxy and supabase analytics endpoints', () => {
		const doc = readOpenApi();
		const paths = doc.paths ?? {};

		expect(paths['/supabase/v1/{path}']).toBeDefined();
		expect(paths['/supabase/v0/{path}']).toBeDefined();
		expect(paths['/supabase/metrics/{ref}']).toBeDefined();
		expect(paths['/admin/supabase/analytics/events']).toBeDefined();
		expect(paths['/admin/supabase/analytics/summary']).toBeDefined();
		expect(paths['/admin/supabase/analytics/timeseries']).toBeDefined();
	});
});
```

- [ ] **Step 2: Run the failing test**

Run:
```bash
bunx vitest run test/openapi-supabase-schema.test.ts
```

Expected: fail because `/supabase/*` paths are absent from `openapi.json`.

- [ ] **Step 3: Add Supabase path definitions in generator**

Add concrete path entries in `scripts/generate-openapi.ts` (proxy passthrough + admin analytics). Use wildcard tail path params and security:

```ts
'/supabase/v1/{path}': {
	get: { tags: ['Supabase'], security: purgeKeySecurity, requestParams: { path: z.object({ path: z.string() }) }, responses: { '200': proxyAnyJson } },
	post: { tags: ['Supabase'], security: purgeKeySecurity, requestParams: { path: z.object({ path: z.string() }) }, responses: { '200': proxyAnyJson } },
	patch: { tags: ['Supabase'], security: purgeKeySecurity, requestParams: { path: z.object({ path: z.string() }) }, responses: { '200': proxyAnyJson } },
	put: { tags: ['Supabase'], security: purgeKeySecurity, requestParams: { path: z.object({ path: z.string() }) }, responses: { '200': proxyAnyJson } },
	delete: { tags: ['Supabase'], security: purgeKeySecurity, requestParams: { path: z.object({ path: z.string() }) }, responses: { '200': proxyAnyJson } },
},
'/supabase/v0/{path}': {
	get: { tags: ['Supabase'], security: purgeKeySecurity, requestParams: { path: z.object({ path: z.string() }) }, responses: { '200': proxyAnyJson } },
},
'/supabase/metrics/{ref}': {
	get: {
		tags: ['Supabase'],
		security: purgeKeySecurity,
		requestParams: { path: z.object({ ref: z.string().regex(/^[a-z0-9]{20}$/) }) },
		responses: {
			'200': { description: 'Prometheus text response', content: { 'text/plain': { schema: z.string() } } },
		},
	},
},
```

- [ ] **Step 4: Regenerate schema and re-run test**

Run:
```bash
bun run openapi
bunx vitest run test/openapi-supabase-schema.test.ts
```

Expected: passing test with new paths present.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-openapi.ts openapi.json test/openapi-supabase-schema.test.ts
git commit -m "test(openapi): document supabase proxy and analytics paths"
```

---

## Task 2: API-first live smoke hardening (v0 + metrics + write probe)

**Files:**
- Modify: `cli/smoke/supabase.ts`
- Modify: `cli/smoke-supabase.ts`

- [ ] **Step 1: Add new live smoke env knobs**

In `cli/smoke/supabase.ts`, add:

```ts
const SUPABASE_SMOKE_METRICS_SECRET = process.env['SUPABASE_SMOKE_METRICS_SECRET'];
const SUPABASE_SMOKE_METRICS_REF = process.env['SUPABASE_SMOKE_METRICS_REF'] ?? process.env['SUPABASE_SMOKE_REF'];
const SUPABASE_SMOKE_ENABLE_WRITE_PROBE = process.env['SUPABASE_SMOKE_ENABLE_WRITE_PROBE'] === '1';
```

- [ ] **Step 2: Add live `/v0` positive check (raw API, not CLI)**

Inside `runLiveApiTier()` after resolving `liveRef`:

```ts
const v0Metrics = await sb(ALL_KEY, 'GET', `/v0/projects/${liveRef}/analytics/metrics`);
assertReached('live: v0 metrics path reaches Supabase', v0Metrics);
```

- [ ] **Step 3: Add live Basic metrics positive check**

Use optional metrics secret + ref:

```ts
if (SUPABASE_SMOKE_METRICS_SECRET && SUPABASE_SMOKE_METRICS_REF) {
	const mReg = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-sb-live-metrics',
		token: SUPABASE_SMOKE_METRICS_SECRET,
		scope_type: 'supabase_metrics',
		auth_type: 'basic',
		username: 'service_role',
		zone_ids: [SUPABASE_SMOKE_METRICS_REF],
		validate: true,
	});
	assertStatus('register live metrics credential (validated) -> 200', mReg, 200);
	const metricsTid = mReg.body?.result?.id;
	if (metricsTid) state.createdUpstreamTokens.push(metricsTid);

	const { keyId: METRICS_LIVE_KEY } = await createSbKey(
		'smoke-sb-live-metrics-key',
		policy(['supabase:metrics:read'], [`project:${SUPABASE_SMOKE_METRICS_REF}`]),
		metricsTid,
	);
	const mRes = await sb(METRICS_LIVE_KEY, 'GET', `/metrics/${SUPABASE_SMOKE_METRICS_REF}`);
	assertStatus('live: GET /metrics/:ref through proxy -> 200', mRes, 200);
	assertTruthy('live: metrics payload is Prometheus text', mRes.raw.includes('# HELP') || mRes.raw.includes('\n'));
} else {
	section('Supabase Proxy — Live metrics through /metrics/:ref (skipped)');
	console.log(`  ${dim('Set SUPABASE_SMOKE_METRICS_SECRET and SUPABASE_SMOKE_METRICS_REF to run live Basic metrics checks.')}`);
}
```

- [ ] **Step 4: Add non-destructive write-classified probe (API path)**

Use `POST /database/query` with `select 1` and assert it reaches upstream (not 401/403):

```ts
if (SUPABASE_SMOKE_ENABLE_WRITE_PROBE && liveRef) {
	const { keyId: DB_WRITE_KEY } = await createSbKey(
		'smoke-sb-live-db-write-probe',
		policy(['supabase:database:write'], [`project:${liveRef}`]),
		liveId,
	);
	const wr = await sb(DB_WRITE_KEY, 'POST', `/v1/projects/${liveRef}/database/query`, { query: 'select 1' });
	assertReached('live: write-classified POST /database/query reaches Supabase', wr);
}
```

- [ ] **Step 5: Keep CLI tier secondary, API tier primary in output text**

Update section labels in `cli/smoke-supabase.ts`/`cli/smoke/supabase.ts` so the run output clearly presents raw API checks first, then official CLI as an additional client check.

- [ ] **Step 6: Run focused live smoke**

Run (real):
```bash
tmp=$(mktemp)
sops -d --input-type dotenv --output-type dotenv .env > "$tmp"
SUPABASE_SMOKE_ENABLE_WRITE_PROBE=1 node --env-file="$tmp" --import tsx cli/smoke-supabase.ts
rm -f "$tmp"
```

Expected: all Supabase smoke tests pass; live metrics/write probes either pass or explicit skip with clear reason.

- [ ] **Step 7: Commit**

```bash
git add cli/smoke/supabase.ts cli/smoke-supabase.ts
git commit -m "test(smoke): expand live supabase api coverage for v0 metrics and write probe"
```

---

## Task 3: Wire new live smoke inputs in CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add optional secrets/env for live metrics + write probe**

In `live-smoke` job env block:

```yaml
env:
  GATEKEEPER_URL: https://gatekeeper-staging.anugrah.workers.dev
  GATEKEEPER_ADMIN_KEY: ${{ secrets.STAGING_ADMIN_KEY }}
  SUPABASE_SMOKE_PAT: ${{ secrets.SUPABASE_SMOKE_PAT }}
  SUPABASE_SMOKE_METRICS_SECRET: ${{ secrets.SUPABASE_SMOKE_METRICS_SECRET }}
  SUPABASE_SMOKE_METRICS_REF: ${{ secrets.SUPABASE_SMOKE_METRICS_REF }}
  SUPABASE_SMOKE_ENABLE_WRITE_PROBE: "1"
```

- [ ] **Step 2: Keep skip behavior explicit and non-blocking for missing optional secrets**

Update shell notices:

```bash
if [ -z "$SUPABASE_SMOKE_METRICS_SECRET" ] || [ -z "$SUPABASE_SMOKE_METRICS_REF" ]; then
  echo "::notice::Metrics live smoke vars not set — metrics live tier will self-skip."
fi
```

- [ ] **Step 3: Verify workflow YAML and smoke command locally**

Run:
```bash
bun run smoke:supabase
```

Expected: synthetic tier always runs; live tier sections self-skip cleanly without breaking run when secrets missing.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: extend staging live-smoke with supabase metrics env wiring"
```

---

## Task 4: CLI parity — add `supabase-analytics timeseries`

**Files:**
- Modify: `cli/commands/supabase-analytics.ts`
- Modify: `cli/commands/completions.ts`
- Modify: `cli/cli.test.ts`

- [ ] **Step 1: Write failing CLI test first**

Add a test section in `cli/cli.test.ts` to assert completions include `timeseries` under `supabase-analytics`:

```ts
it('completions include supabase-analytics timeseries', async () => {
	const mod = await import('./commands/completions.js');
	const out: string[] = [];
	vi.spyOn(console, 'log').mockImplementation((s: any) => out.push(String(s)));
	await (mod.default as any).run?.({ args: { shell: 'bash' } });
	expect(out.join('\n')).toMatch(/supabase-analytics\).*events summary timeseries/);
});
```

- [ ] **Step 2: Implement `timeseries` subcommand**

In `cli/commands/supabase-analytics.ts`, add:

```ts
const timeseries = defineCommand({
	meta: { name: 'timeseries', description: 'Get hourly Supabase proxy timeseries buckets' },
	args: { ...baseArgs, 'project-ref': { type: 'string' }, 'key-id': { type: 'string' }, category: { type: 'string' }, action: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' } },
	async run({ args }) {
		const config = resolveConfig(args);
		const params = new URLSearchParams();
		if (args['project-ref']) params.set('project_ref', args['project-ref']);
		if (args['key-id']) params.set('key_id', args['key-id']);
		if (args.category) params.set('category', args.category);
		if (args.action) params.set('action', args.action);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));
		const qs = params.toString();
		const path = qs ? `/admin/supabase/analytics/timeseries?${qs}` : '/admin/supabase/analytics/timeseries';
		const { status, data } = await request(config, 'GET', path, { auth: 'admin', label: 'Fetching Supabase proxy timeseries...' });
		assertOk(status, data);
		printJson(data);
	},
});

export default defineCommand({
	meta: { name: 'supabase-analytics', description: 'View Supabase proxy analytics' },
	subCommands: { events, summary, timeseries },
});
```

- [ ] **Step 3: Update completions command tree**

In `cli/commands/completions.ts`:

```ts
'supabase-analytics': ['events', 'summary', 'timeseries'],
```

- [ ] **Step 4: Run CLI tests**

Run:
```bash
bun run test:cli
```

Expected: passing tests, including new completion assertion.

- [ ] **Step 5: Commit**

```bash
git add cli/commands/supabase-analytics.ts cli/commands/completions.ts cli/cli.test.ts
git commit -m "feat(cli): add supabase analytics timeseries command"
```

---

## Task 5: Dashboard UX parity + e2e for Supabase analytics visibility

**Files:**
- Modify: `e2e/supabase-ui.spec.ts`
- Modify: `dashboard/src/components/AnalyticsPage.tsx`

- [ ] **Step 1: Write failing e2e test for Supabase analytics tab visibility**

Add to `e2e/supabase-ui.spec.ts`:

```ts
test('Analytics page shows Supabase source tab when supabase events exist', async ({ page, request }) => {
	await setupAuth(page, '/dashboard/analytics');
	// seed: create supabase token+key, trigger a denied supabase request (403) to produce an event
	// then check source tab appears
	await expect(page.locator('button:has-text("supabase")')).toBeVisible({ timeout: 10000 });
});
```

- [ ] **Step 2: Implement small UX improvements in Analytics page**

Ensure Supabase row presentation clearly distinguishes management vs metrics actions:

```tsx
const isSupabaseMetricsAction = ev.source === 'supabase' && ev.action === 'supabase:metrics:read';
// render badge text:
{isSupabaseMetricsAction ? 'metrics' : ev.category}
```

And keep source tab ordering stable with Supabase near core sources.

- [ ] **Step 3: Run focused e2e then full e2e**

Run:
```bash
bunx playwright test e2e/supabase-ui.spec.ts
bun run test:e2e
```

Expected: Supabase UI tests green, including analytics visibility.

- [ ] **Step 4: Commit**

```bash
git add e2e/supabase-ui.spec.ts dashboard/src/components/AnalyticsPage.tsx
git commit -m "test(e2e): cover supabase analytics visibility and badges"
```

---

## Task 6: Docs sync (API-first behavior, env vars, and corrected CLI statement)

**Files:**
- Modify: `docs/CONTRIBUTING.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/GUIDE.md`
- Modify: `docs/API.md`

- [ ] **Step 1: Fix outdated CONTRIB statement about official CLI usage**

Replace stale sentence claiming official CLI is not used with the current contract:

```md
The Supabase smoke suite is API-first (raw `/supabase/*` HTTP assertions) and, when the `supabase` binary is available, additionally verifies official CLI compatibility with `sbp_`-shaped Gatekeeper keys.
```

- [ ] **Step 2: Document new live-smoke env vars and skip semantics**

Add to deployment/live-smoke docs:

```md
- `SUPABASE_SMOKE_METRICS_SECRET` + `SUPABASE_SMOKE_METRICS_REF`: enables live `/supabase/metrics/:ref` verification
- `SUPABASE_SMOKE_ENABLE_WRITE_PROBE=1`: enables non-destructive write-classified probe (`POST /database/query` with `select 1`)
```

- [ ] **Step 3: Update API/GUIDE examples for API-first verification**

Add an explicit section showing raw HTTP verification endpoints before CLI snippet.

- [ ] **Step 4: Commit**

```bash
git add docs/CONTRIBUTING.md docs/DEPLOYMENT.md docs/GUIDE.md docs/API.md
git commit -m "docs: align supabase smoke docs with api-first live coverage"
```

---

## Task 7: Thorough verification matrix (must pass before merge)

**Files:**
- No code changes; verification-only task

- [ ] **Step 1: Fast local quality gates**

Run:
```bash
bun run typecheck
bun run lint
bun run test
bun run check:openapi
```

Expected: all pass.

- [ ] **Step 2: Browser and runtime integration**

Run:
```bash
bun run test:e2e
```

Expected: Playwright suite pass, including `e2e/supabase-ui.spec.ts`.

- [ ] **Step 3: Focused live Supabase smoke (real API path)**

Run:
```bash
tmp=$(mktemp)
sops -d --input-type dotenv --output-type dotenv .env > "$tmp"
SUPABASE_SMOKE_ENABLE_WRITE_PROBE=1 node --env-file="$tmp" --import tsx cli/smoke-supabase.ts
rm -f "$tmp"
```

Expected: `ALL N TESTS PASSED` with live API sections passing or explicit skip messages for missing optional vars.

- [ ] **Step 4: Full regression gate**

Run:
```bash
bun run preflight
```

Expected: pass.

- [ ] **Step 5: Optional full multi-surface smoke (recommended before release)**

Run:
```bash
tmp=$(mktemp)
sops -d --input-type dotenv --output-type dotenv .env > "$tmp"
node --env-file="$tmp" --import tsx cli/smoke-test.ts
rm -f "$tmp"
```

Expected: full smoke pass for purge/S3/DNS/CF/Supabase surfaces.

- [ ] **Step 6: Final commit for any verification-only adjustments**

```bash
git add -A
git commit -m "chore: finalize supabase api coverage hardening"
```

---

## Risk controls

- Keep all live write probes non-destructive (`select 1`), and gate them behind env.
- Keep optional live metrics tier self-skipping if secrets are absent.
- Do not weaken deny-by-default behavior; only expand verification and schema/docs parity.
- Preserve existing key-shape behavior (`sbp_` for PAT-bound keys, `gw_` for metrics-bound keys).

---

## Rollback strategy

If any hardening changes cause instability:
1. Revert Task 2 smoke-only changes first (isolated to test surface).
2. Keep OpenAPI + docs changes if accurate; they are non-runtime.
3. Re-run `bun run preflight` and `bun run smoke:supabase` to confirm baseline restored.
