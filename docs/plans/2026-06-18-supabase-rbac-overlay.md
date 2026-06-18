# Supabase RBAC Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a fine-grained authorization overlay in front of the Supabase Management API and the per-project Metrics API, so a Gatekeeper-issued key gets per-endpoint / per-project / conditional access that Supabase Personal Access Tokens (all-or-nothing) and OAuth scopes (9 coarse read/write categories) cannot express — including a metrics-only credential that does NOT also grant read/write to all project data.

**Architecture:** Two new request paths mounted under `/supabase`, reusing Gatekeeper's existing IAM + policy engine + Durable Object credential store:
1. **Management API proxy** — a single table-driven catch-all (`/supabase/v1/*`) that classifies `(method, path)` → a Gatekeeper action (e.g. `supabase:database:write`) + project ref, runs `stub.authorize()`, then proxies to `https://api.supabase.com` with a stored Personal Access Token (PAT) swapped into the `Authorization: Bearer` header. No 165 hand-written routes — the classifier table IS the RBAC surface.
2. **Metrics proxy** — `/supabase/metrics/:ref` authorizes `supabase:metrics:read`, resolves a stored **Basic Auth** secret key, and proxies to `https://<ref>.supabase.co/customer/v1/privileged/metrics`, streaming Prometheus text back. This is the slice that directly kills the "scrape metrics ⇒ hand out a god-mode key" problem.

The credential store (`src/upstream-tokens.ts`) is extended with an `auth_type` (`bearer` | `basic`) column, a nullable `username` column, and two new `scope_type` values (`supabase` for the PAT, `supabase_metrics` for the Basic secret). Everything else — auth, rate limiting, analytics, the policy condition engine — is reused unchanged.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers + Durable Objects (SQLite), D1 (analytics), Vitest (`@cloudflare/vitest-pool-workers`), `fetchMock` from `cloudflare:test`.

**Sources reviewed (verified against the OpenAPI spec on 2026-06-18):**
- `/docs/supabase/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes.md` — the 9 coarse scope categories (Auth, Database, Domains, Edge Functions, Environment, Organizations, Projects, Rest, Secrets, Storage), read/write only; "Scopes are only available for OAuth apps" (PATs have none). **Verified.**
- `/docs/supabase/guides/integrations/build-a-supabase-oauth-integration.md:158` — "Only some features are available until we roll out fine-grained access control." **Verified.**
- `/docs/supabase/guides/telemetry/metrics/grafana-self-hosted.md:11,23-27` — Metrics endpoint `https://<ref>.supabase.co/customer/v1/privileged/metrics`, HTTP Basic Auth, password = Secret API key (`sb_secret_...`). **Verified against a live project (`dewddkcmwrzbpynylyhg`) on 2026-06-18:** HTTP Basic Auth authenticates on the **password only** — username is ignored (`service_role`, the ref, and an empty username all return 200; `apikey:`/`Authorization: Bearer` headers return 401). Returns `text/plain` Prometheus exposition (~321 metrics). The stored `username` is therefore cosmetic; default it to `service_role` and do not require it.
- `/docs/supabase-api/api/overview.md` + the per-group files (`database.md`, `auth.md`, `projects.md`, `environments.md`, `secrets.md`, `edge-functions.md`, ...) — Management API endpoint groups (165 endpoints): environments(17), projects(29), organizations(7), oauth(4), database(43), profile(1), secrets(12), domains(9), rest(2), auth(18), billing(3), advisors(2), analytics(4), edge-functions(8), storage(3), realtime(3). **Verified** — and the actual nested paths drove the longest-prefix classifier design in Task 2 (a segment-exact table was wrong for paths this deep).

**Schema-verification findings that shaped this plan:**
- The Management API nests deeply (e.g. `config/auth/sso/providers/{id}`, `database/backups/schedule`, `functions/{slug}/body`). A fixed-segment classifier mis-handles depth → Task 2 uses **longest-prefix category matching**.
- Several `POST` endpoints are semantically **reads**: `database/query/read-only`, `network-bans/retrieve`, `network-bans/retrieve/enriched`. These require a **read-override set** (method alone is insufficient to derive read/write).
- `GET /v1/projects/available-regions` and `GET /v1/projects` have no ref — the ref segment is sometimes a literal. The classifier must not assume segment[2] is always a ref.
- The OpenAPI `ref` parameter is typed only as `string` with no documented format constraint, but a **live project ref is 20 lowercase alphanumeric chars** (confirmed: `dewddkcmwrzbpynylyhg`). Validate as `/^[a-z0-9]{20}$/` — tight enough to reject SSRF/garbage in the metrics host, loose enough to accept any real ref.

---

## Scope & Sequencing

This plan is **RBAC-first**: it deliberately does NOT clone the per-endpoint route explosion of `src/cf/`. Tasks 1–5 deliver a working, testable end-to-end RBAC overlay (both proxy paths). Tasks 6–8 add analytics, admin CRUD, and wiring. Dashboard + CLI surfaces are explicitly **out of scope** for this plan (noted in "Follow-on work") — the value proposition is the authorization layer, exercisable via `curl` and tests on day one.

**Recommended build order if shipping incrementally:** Task 1 → Task 3 → Task 5 (metrics slice, smallest, highest-ROI, solves the named pain) → Task 2 → Task 4 (Management API RBAC) → Tasks 6–8.

---

## File Structure

New files:
- `src/supabase/constants.ts` — base URLs, ref regex, scope-category list.
- `src/supabase/classify.ts` — the `(method, path) → SupabaseAction + projectRef` classifier table + lookup. **The RBAC surface.**
- `src/supabase/proxy-helpers.ts` — ref validation, bearer/basic upstream proxy, response/error helpers (Supabase returns plain JSON, not the CF envelope).
- `src/supabase/router.ts` — Hono sub-app: catch-all Management proxy + metrics proxy + shared middleware.
- `src/supabase/analytics.ts` — `supabase_proxy_events` D1 writer/query (clone of `src/cf/analytics.ts`).
- `src/routes/admin-supabase-analytics.ts` — admin read endpoint for the analytics.
- `test/supabase-classify.test.ts`, `test/supabase-mgmt.test.ts`, `test/supabase-metrics.test.ts`, `test/supabase-credentials.test.ts`.

Modified files:
- `src/upstream-tokens.ts` — add `auth_type` + `username` columns, new scope_types, `resolveBasicCredentialForRef()` / generalize resolution; new `CreateUpstreamTokenRequest` fields.
- `src/durable-object.ts` — RPC pass-throughs: `resolveSupabaseToken`, `resolveSupabaseMetricsCredential`.
- `src/schema.ts` — `SUPABASE_PROXY_EVENTS_*` SQL constants.
- `src/index.ts` — mount `supabaseApp` at `/supabase`; add `deleteOldSupabaseProxyEvents` to cron.
- `src/routes/admin.ts` — mount `admin-supabase-analytics`.
- `test/helpers.ts` — `registerSupabaseToken`, `registerSupabaseMetricsCredential`, `createSupabaseKey`.

---

## Action Taxonomy (locked here, referenced by all tasks)

Transcribed from the OAuth scopes table. Category-level actions (the floor; the classifier may emit finer ones later without breaking policies that use the category):

```
supabase:auth:read           supabase:auth:write
supabase:database:read       supabase:database:write
supabase:domains:read        supabase:domains:write
supabase:edge_functions:read supabase:edge_functions:write
supabase:environment:read    supabase:environment:write
supabase:organizations:read  supabase:organizations:write
supabase:projects:read       supabase:projects:write
supabase:rest:read           supabase:rest:write
supabase:secrets:read        supabase:secrets:write
supabase:storage:read        supabase:storage:write
supabase:metrics:read        (per-project Metrics API — NOT a Management API scope)
```

`resource` strings:
- Management API: `project:<ref>` when a project ref is in the path, else `org:<slug>` or `supabase:account` for account-wide endpoints.
- Metrics: `project:<ref>`.

Condition `fields` populated for policy use (in addition to the request-level `client_ip` / `client_country` / `client_asn` / `time.*` from `extractRequestFields`):
- `supabase.project_ref` (string) — when present in path.
- `supabase.method` (string) — HTTP method.
- `supabase.category` (string) — e.g. `database`.
- `supabase.write` (boolean) — true for mutating verbs.

---

## Task 1: Credential model — Basic auth + Supabase scope types

**Files:**
- Modify: `src/upstream-tokens.ts`
- Modify: `src/durable-object.ts`
- Test: `test/supabase-credentials.test.ts`

The store already has `scope_type` (`zone`|`account`) and resolves by exact-id-then-wildcard over a comma-separated `zone_ids` column (see `resolveTokenForAccount`, line 295). We add `auth_type`+`username` columns, two new scope_type values, and a Basic-credential resolver.

- [ ] **Step 1: Write the failing test**

```ts
// test/supabase-credentials.test.ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { getStub } from '../src/do-stub';

const REF = 'abcdefghijklmnopqrst'; // 20-char project ref

describe('supabase credential resolution', () => {
	it('resolves a supabase PAT (bearer) by project ref', async () => {
		const stub = getStub(env);
		await stub.createUpstreamToken({
			name: 'pat-prod',
			token: 'sbp_pat_secret_value',
			scope_type: 'supabase',
			zone_ids: [REF],
		});
		expect(await stub.resolveSupabaseToken(REF)).toBe('sbp_pat_secret_value');
		expect(await stub.resolveSupabaseToken('zzzzzzzzzzzzzzzzzzzz')).toBeNull();
	});

	it('resolves a metrics Basic credential (username + secret) by project ref', async () => {
		const stub = getStub(env);
		await stub.createUpstreamToken({
			name: 'metrics-prod',
			token: 'sb_secret_metrics_value',
			scope_type: 'supabase_metrics',
			auth_type: 'basic',
			username: 'service_role',
			zone_ids: [REF],
		});
		const cred = await stub.resolveSupabaseMetricsCredential(REF);
		expect(cred).toEqual({ username: 'service_role', secret: 'sb_secret_metrics_value' });
	});

	it('does not leak secrets via listTokens', async () => {
		const stub = getStub(env);
		const list = await stub.listUpstreamTokens();
		for (const t of list) expect((t as any).token).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/supabase-credentials.test.ts`
Expected: FAIL — `stub.resolveSupabaseToken is not a function`.

- [ ] **Step 3: Extend the types and schema in `src/upstream-tokens.ts`**

Add to the type definitions near the top of the file:

```ts
/** Token scope: zone/account (Cloudflare) or supabase/supabase_metrics. */
export type UpstreamTokenScopeType = 'zone' | 'account' | 'supabase' | 'supabase_metrics';

/** How the upstream credential is presented. 'bearer' (default) or 'basic' (username+secret). */
export type UpstreamAuthType = 'bearer' | 'basic';
```

Add `auth_type` and `username` to the `UpstreamToken` interface and `CreateUpstreamTokenRequest`:

```ts
// in UpstreamToken
auth_type: UpstreamAuthType;
username: string | null;
// in CreateUpstreamTokenRequest
auth_type?: UpstreamAuthType;
username?: string | null;
```

In `initTables()`, after the existing `expires_at` migration block, add:

```ts
const colsAuth = queryAll<{ name: string }>(this.sql, `PRAGMA table_info('upstream_tokens')`);
if (!colsAuth.some((c) => c.name === 'auth_type')) {
	console.log(JSON.stringify({ migration: 'upstream_tokens', action: 'add_column_auth_type', ts: new Date().toISOString() }));
	this.sql.exec(`ALTER TABLE upstream_tokens ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'bearer'`);
}
if (!colsAuth.some((c) => c.name === 'username')) {
	console.log(JSON.stringify({ migration: 'upstream_tokens', action: 'add_column_username', ts: new Date().toISOString() }));
	this.sql.exec(`ALTER TABLE upstream_tokens ADD COLUMN username TEXT`);
}
```

- [ ] **Step 4: Persist the new columns in `createToken`, `listTokens`, `getToken`**

In `createToken`, extend the INSERT and the returned object:

```ts
const authType = req.auth_type ?? 'bearer';
const username = req.username ?? null;

this.sql.exec(
	`INSERT INTO upstream_tokens (id, name, token, token_preview, zone_ids, scope_type, auth_type, username, created_at, expires_at, created_by)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	id, req.name, req.token, preview, zoneIdsStr, scopeType, authType, username, now, expiresAt, req.created_by ?? null,
);
// ...add to returned token object:
auth_type: authType,
username,
```

Add `auth_type, username` to the SELECT column lists in `listTokens` and `getToken` (both currently select `id, name, scope_type, zone_ids, token_preview, created_at, expires_at, created_by`).

- [ ] **Step 5: Add the resolvers in `src/upstream-tokens.ts`**

Generalize the exact-then-wildcard loop already used by `resolveTokenForAccount`. Add:

```ts
/** Resolve a Supabase Management API PAT (bearer) for a project ref or org slug. */
resolveSupabaseToken(ref: string): string | null {
	const row = this.resolveRowByScope('supabase', ref);
	return row ? row.token : null;
}

/** Resolve a Supabase Metrics Basic credential for a project ref. */
resolveSupabaseMetricsCredential(ref: string): { username: string; secret: string } | null {
	const row = this.resolveRowByScope('supabase_metrics', ref);
	if (!row) return null;
	// The metrics endpoint's HTTP Basic Auth validates the PASSWORD (the sb_secret_ key) only —
	// the username is ignored by Supabase (verified against a live project 2026-06-18). We send
	// 'service_role' by convention; a stored username override is honoured but functionally moot.
	return { username: row.username ?? 'service_role', secret: row.token };
}

/** Shared exact-then-wildcard resolution over the comma-separated zone_ids column. */
private resolveRowByScope(scopeType: UpstreamTokenScopeType, id: string): UpstreamTokenRow | null {
	const cacheKey = `${scopeType}:${id}`;
	const cached = this.resolveCache.get(cacheKey);
	if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
		return cached.row ?? null;
	}
	const rows = queryAll<UpstreamTokenRow>(
		this.sql,
		`SELECT * FROM upstream_tokens WHERE scope_type = ? ORDER BY created_at DESC`,
		scopeType,
	);
	const now = Date.now();
	let wildcard: UpstreamTokenRow | null = null;
	for (const row of rows) {
		if (row.expires_at !== null && row.expires_at <= now) continue;
		const ids = row.zone_ids.split(',');
		if (ids.includes(id)) {
			this.resolveCache.set(cacheKey, { row, cachedAt: Date.now() });
			return row;
		}
		if (ids.includes('*') && !wildcard) wildcard = row;
	}
	if (wildcard) this.resolveCache.set(cacheKey, { row: wildcard, cachedAt: Date.now() });
	return wildcard;
}
```

Update the `resolveCache` type to carry an optional row:
```ts
private resolveCache = new Map<string, { token?: string; row?: UpstreamTokenRow; cachedAt: number }>();
```
(The existing `token`-only cache entries still work; new entries set `row`.)

- [ ] **Step 6: Add DO RPC pass-throughs in `src/durable-object.ts`**

After `resolveUpstreamTokenById` (line ~660):

```ts
/** Resolve a Supabase Management API PAT for a project ref / org slug. */
async resolveSupabaseToken(ref: string): Promise<string | null> {
	return this.upstreamTokens.resolveSupabaseToken(ref);
}

/** Resolve a Supabase Metrics Basic credential for a project ref. */
async resolveSupabaseMetricsCredential(ref: string): Promise<{ username: string; secret: string } | null> {
	return this.upstreamTokens.resolveSupabaseMetricsCredential(ref);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/supabase-credentials.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add src/upstream-tokens.ts src/durable-object.ts test/supabase-credentials.test.ts
git commit -m "feat(supabase): extend credential store with basic-auth + supabase scope types"
```

---

## Task 2: Management API endpoint classifier

**Files:**
- Create: `src/supabase/constants.ts`
- Create: `src/supabase/classify.ts`
- Test: `test/supabase-classify.test.ts`

This is the RBAC surface. A table of `{ method, pattern, action }` rules maps any Management API request to one action. Patterns use a tiny segment matcher (`:ref` captures the project ref). First match wins; longest patterns are listed first.

- [ ] **Step 1: Write the failing test**

```ts
// test/supabase-classify.test.ts
import { describe, it, expect } from 'vitest';
import { classifySupabaseRequest } from '../src/supabase/classify';

const REF = 'abcdefghijklmnopqrst';

describe('classifySupabaseRequest', () => {
	it('classifies a SQL query as database:write with the project ref', () => {
		const r = classifySupabaseRequest('POST', `/v1/projects/${REF}/database/query`);
		expect(r).toEqual({ action: 'supabase:database:write', category: 'database', write: true, projectRef: REF, resource: `project:${REF}` });
	});

	it('classifies the read-only SQL endpoint as database:READ despite being POST', () => {
		const r = classifySupabaseRequest('POST', `/v1/projects/${REF}/database/query/read-only`);
		expect(r?.action).toBe('supabase:database:read');
		expect(r?.write).toBe(false);
	});

	it('classifies a deeply-nested auth path (sso provider by id) as auth', () => {
		const r = classifySupabaseRequest('DELETE', `/v1/projects/${REF}/config/auth/sso/providers/p123`);
		expect(r?.action).toBe('supabase:auth:write');
		expect(r?.category).toBe('auth');
	});

	it('classifies reading auth config as auth:read', () => {
		const r = classifySupabaseRequest('GET', `/v1/projects/${REF}/config/auth`);
		expect(r?.action).toBe('supabase:auth:read');
	});

	it('classifies network-bans/retrieve as projects:READ despite being POST', () => {
		expect(classifySupabaseRequest('POST', `/v1/projects/${REF}/network-bans/retrieve`)?.write).toBe(false);
	});

	it('classifies edge function body fetch (6 segments) as edge_functions:read', () => {
		const r = classifySupabaseRequest('GET', `/v1/projects/${REF}/functions/my-fn/body`);
		expect(r?.action).toBe('supabase:edge_functions:read');
	});

	it('classifies listing projects as projects:read with no ref', () => {
		const r = classifySupabaseRequest('GET', '/v1/projects');
		expect(r).toEqual({ action: 'supabase:projects:read', category: 'projects', write: false, projectRef: null, resource: 'supabase:account' });
	});

	it('treats /v1/projects/available-regions as a projects read, not a ref', () => {
		const r = classifySupabaseRequest('GET', '/v1/projects/available-regions');
		expect(r?.projectRef).toBeNull();
		expect(r?.action).toBe('supabase:projects:read');
	});

	it('classifies creating a project as projects:write', () => {
		expect(classifySupabaseRequest('POST', '/v1/projects')?.action).toBe('supabase:projects:write');
	});

	it('binds /v1/branches/{id} to a branch resource under environment scope', () => {
		const r = classifySupabaseRequest('GET', '/v1/branches/br_abc');
		expect(r?.category).toBe('environment');
		expect(r?.resource).toBe('branch:br_abc');
	});

	it('returns null for out-of-scope groups so the proxy can deny-by-default', () => {
		expect(classifySupabaseRequest('GET', '/v1/oauth/authorize')).toBeNull();
		expect(classifySupabaseRequest('GET', '/v1/some/unmapped/route')).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/supabase-classify.test.ts`
Expected: FAIL — cannot find module `../src/supabase/classify`.

- [ ] **Step 3: Write `src/supabase/constants.ts`**

```ts
export const SUPABASE_API_BASE = 'https://api.supabase.com';
/** Per-project data-plane host template; `<ref>` replaced at call time. */
export const SUPABASE_PROJECT_HOST = (ref: string) => `https://${ref}.supabase.co`;
export const SUPABASE_METRICS_PATH = '/customer/v1/privileged/metrics';

// A Supabase project ref is 20 lowercase alphanumeric chars (confirmed against a live project
// `dewddkcmwrzbpynylyhg` on 2026-06-18). Tight enough to block SSRF via the metrics host
// (`https://<ref>.supabase.co`), loose enough to accept any real ref.
export const SUPABASE_REF_RE = /^[a-z0-9]{20}$/;

/** Path segments that appear in the ref position but are NOT refs (collection routes). */
export const PROJECT_REF_LITERALS = new Set(['available-regions']);

export type SupabaseCategory =
	| 'auth' | 'database' | 'domains' | 'edge_functions' | 'environment'
	| 'organizations' | 'projects' | 'rest' | 'secrets' | 'storage' | 'metrics';
```

- [ ] **Step 4: Write `src/supabase/classify.ts`**

Longest-prefix design: extract the ref (if the route has one), then match the *tail* against a prefix table. This handles arbitrary nesting depth (`config/auth/sso/providers/{id}`, `database/backups/schedule`, `functions/{slug}/body`) without a row per endpoint. read/write is derived from the HTTP method, with an explicit **read-override set** for the `POST`-but-read endpoints the spec exposed.

```ts
import { SUPABASE_REF_RE, PROJECT_REF_LITERALS, type SupabaseCategory } from './constants';

export interface SupabaseClassification {
	action: string;            // e.g. 'supabase:database:write'
	category: SupabaseCategory;
	write: boolean;
	projectRef: string | null; // ref when the route is project-scoped
	resource: string;          // 'project:<ref>' | 'branch:<id>' | 'org:<slug>' | 'supabase:account'
}

// Tail-prefix → category. Tail = the path AFTER `/v1/projects/{ref}/`. Longest prefix wins.
// Verified against /docs/supabase-api/api/*.md on 2026-06-18.
const PROJECT_TAIL_CATEGORIES: Array<[string, SupabaseCategory]> = [
	['config/auth', 'auth'],
	['config/database', 'database'],
	['database', 'database'],
	['postgrest', 'rest'],
	['secrets', 'secrets'],
	['api-keys', 'secrets'],
	['pgsodium', 'secrets'],
	['functions', 'edge_functions'],
	['storage', 'storage'],
	['custom-hostname', 'domains'],
	['vanity-subdomain', 'domains'],
	['branches', 'environment'],
	['actions', 'environment'],
	// everything else under a ref (health, upgrade, pause, restart, restore,
	// config/disk, network-bans, network-restrictions, claim-token) is `projects`.
];

// POST/PATCH/PUT/DELETE that are semantically reads. Keyed by `${method} ${tail-prefix}`.
const READ_OVERRIDES = new Set<string>([
	'POST database/query/read-only',
	'POST network-bans/retrieve',
	'POST network-bans/retrieve/enriched',
]);

function isRead(method: string, tail: string): boolean {
	if (method === 'GET' || method === 'HEAD') return true;
	for (const ov of READ_OVERRIDES) {
		const [m, prefix] = ov.split(' ');
		if (m === method && (tail === prefix || tail.startsWith(prefix + '/'))) return true;
	}
	return false;
}

function categoryForProjectTail(tail: string): SupabaseCategory {
	let best: SupabaseCategory = 'projects';
	let bestLen = -1;
	for (const [prefix, cat] of PROJECT_TAIL_CATEGORIES) {
		if ((tail === prefix || tail.startsWith(prefix + '/')) && prefix.length > bestLen) {
			best = cat; bestLen = prefix.length;
		}
	}
	return best;
}

/** Classify a Management API request to a Gatekeeper action. Returns null for unmapped paths (deny-by-default). */
export function classifySupabaseRequest(method: string, path: string): SupabaseClassification | null {
	const segs = path.split('?')[0].split('/').filter(Boolean); // e.g. ['v1','projects','<ref>','database','query']
	if (segs[0] !== 'v1') return null;
	const root = segs[1];

	const mk = (category: SupabaseCategory, projectRef: string | null, resource: string): SupabaseClassification => {
		const write = !isRead(method, segs.slice(projectRef ? 3 : 2).join('/'));
		return { action: `supabase:${category}:${write ? 'write' : 'read'}`, category, write, projectRef, resource };
	};

	if (root === 'projects') {
		const maybeRef = segs[2];
		// /v1/projects  and  /v1/projects/available-regions  are project collection reads (no ref).
		if (maybeRef === undefined || PROJECT_REF_LITERALS.has(maybeRef)) {
			return mk('projects', null, 'supabase:account');
		}
		if (!SUPABASE_REF_RE.test(maybeRef)) return null; // garbage ref → deny
		const tail = segs.slice(3).join('/');
		return mk(categoryForProjectTail(tail), maybeRef, `project:${maybeRef}`);
	}

	if (root === 'branches') {
		const id = segs[2];
		if (!id) return null;
		// branch id-or-ref is not necessarily a project ref — bind to branch resource.
		return mk('environment', null, `branch:${id}`);
	}

	if (root === 'organizations') {
		const slug = segs[2];
		// /v1/organizations/{slug}/projects is a projects-group read per the spec, but org-scoped;
		// keep it under organizations for the scope, resource is the org.
		return mk('organizations', null, slug ? `org:${slug}` : 'supabase:account');
	}

	return null; // oauth/profile/billing/advisors/analytics groups: out of scope for v1, deny-by-default
}
```

> **Read/write derivation note:** `isRead` is the single source of truth. GET/HEAD are reads; everything else is a write UNLESS in `READ_OVERRIDES`. When extending coverage, the only judgement call is adding a tail-prefix to `PROJECT_TAIL_CATEGORIES` (new category bucket) or `READ_OVERRIDES` (POST-but-read). Each addition gets a test row in Step 1.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/supabase-classify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/supabase/constants.ts src/supabase/classify.ts test/supabase-classify.test.ts
git commit -m "feat(supabase): table-driven Management API request classifier"
```

> **Note for the implementer:** the longest-prefix design covers every endpoint under the in-scope groups (projects, database, auth, rest, secrets, edge_functions, storage, domains, environment, organizations) at any nesting depth — verified against the per-group spec files. Out-of-scope groups (oauth, profile, billing, advisors, analytics) return `null` and are denied by default. Extending coverage = adding a tail-prefix to `PROJECT_TAIL_CATEGORIES` or a `READ_OVERRIDES` entry, with a test per addition. Do NOT add a permissive catch-all.
>
> **Optional hardening:** for an authoritative read/write split per endpoint, generate `READ_OVERRIDES` from the OpenAPI spec by flagging any non-GET operation whose summary/operationId implies a read (`retrieve`, `read-only`, `list`, `check`, `eligibility`). The hand-curated set above already covers the cases the spec exposed on 2026-06-18; regenerate if Supabase adds endpoints.

---

## Task 3: Supabase proxy helpers

**Files:**
- Create: `src/supabase/proxy-helpers.ts`
- Test: covered indirectly by Tasks 4 & 5 (these are thin pure functions; no dedicated test file).

- [ ] **Step 1: Write `src/supabase/proxy-helpers.ts`**

```ts
import { BEARER_PREFIX, MAX_LOG_VALUE_LENGTH } from '../constants';
import { SUPABASE_API_BASE, SUPABASE_PROJECT_HOST, SUPABASE_METRICS_PATH, SUPABASE_REF_RE } from './constants';

export function isValidSupabaseRef(ref: string): boolean {
	return SUPABASE_REF_RE.test(ref);
}

export function extractBearerKey(authHeader: string | undefined): string | null {
	if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) return null;
	const key = authHeader.slice(BEARER_PREFIX.length).trim();
	return key.length > 0 ? key : null;
}

/** Plain JSON error (Supabase Management API uses `{ message }`, not the CF envelope). */
export function sbJsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const FORWARDED_HEADERS = ['Content-Type', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'];

/** Proxy to the Supabase Management API, swapping in the stored PAT. */
export async function proxyToManagementApi(
	path: string, pat: string, method: string, body?: BodyInit | null, queryString?: string, contentType?: string | null,
): Promise<Response> {
	const url = `${SUPABASE_API_BASE}${path}${queryString ? `?${queryString}` : ''}`;
	const headers: Record<string, string> = { Authorization: `Bearer ${pat}` };
	if (contentType) headers['Content-Type'] = contentType;
	return fetch(url, { method, headers, body: method !== 'GET' && method !== 'HEAD' ? body : undefined });
}

/** Proxy to the per-project Metrics endpoint with HTTP Basic Auth. */
export async function proxyToMetrics(ref: string, username: string, secret: string): Promise<Response> {
	const url = `${SUPABASE_PROJECT_HOST(ref)}${SUPABASE_METRICS_PATH}`;
	const basic = btoa(`${username}:${secret}`);
	return fetch(url, { method: 'GET', headers: { Authorization: `Basic ${basic}` } });
}

export function buildProxyResponse(upstream: Response, body: BodyInit | null, statusOverride?: number): Response {
	const headers = new Headers();
	for (const name of FORWARDED_HEADERS) {
		const v = upstream.headers.get(name);
		if (v) headers.set(name, v);
	}
	return new Response(body ?? upstream.body, { status: statusOverride ?? upstream.status, headers });
}

export function extractResponseDetail(body: string): string | null {
	if (!body) return null;
	const slice = body.length > MAX_LOG_VALUE_LENGTH ? body.slice(0, MAX_LOG_VALUE_LENGTH) : body;
	try {
		const p = JSON.parse(body);
		if (p && typeof p === 'object' && 'message' in p) {
			const m = JSON.stringify({ message: (p as any).message });
			return m.length > MAX_LOG_VALUE_LENGTH ? m.slice(0, MAX_LOG_VALUE_LENGTH) : m;
		}
	} catch { /* fall through */ }
	return slice;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` (or `npm run typecheck`)
Expected: no errors in `src/supabase/proxy-helpers.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/supabase/proxy-helpers.ts
git commit -m "feat(supabase): proxy helpers for Management + Metrics upstreams"
```

---

## Task 4: Management API catch-all proxy router (RBAC core)

**Files:**
- Create: `src/supabase/router.ts`
- Modify: `test/helpers.ts`
- Test: `test/supabase-mgmt.test.ts`

The catch-all authorizes via the classifier, resolves the PAT, proxies. Auth happens BEFORE token resolution (same ordering rule as `src/cf/service-handler.ts`) so unauthenticated callers cannot probe which refs have a stored PAT.

- [ ] **Step 1: Add test helpers in `test/helpers.ts`**

```ts
/** Register a Supabase Management PAT covering the given refs (or ['*']). Returns the upstream token id. */
export async function registerSupabaseToken(refs: string[] = ['*'], token = 'sbp_test_pat'): Promise<string> {
	const res = await SELF.fetch('https://gk/admin/upstream-tokens', {
		method: 'POST', headers: adminHeaders(),
		body: JSON.stringify({ name: 'sb-pat', token, scope_type: 'supabase', zone_ids: refs }),
	});
	const json = await res.json<any>();
	return json.token.id;
}

/** Create a Gatekeeper key with a Supabase policy, bound to an upstream token. */
export async function createSupabaseKey(policy: object, upstreamTokenId: string): Promise<string> {
	const res = await SELF.fetch('https://gk/admin/keys', {
		method: 'POST', headers: adminHeaders(),
		body: JSON.stringify({ name: 'sb-key', policy, upstream_token_id: upstreamTokenId }),
	});
	const json = await res.json<any>();
	return json.key.secret ?? json.secret;
}
```

(Confirm the exact admin key-create response shape against existing `createAccountKey` in `test/helpers.ts` and match it.)

- [ ] **Step 2: Write the failing test**

```ts
// test/supabase-mgmt.test.ts
import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { registerSupabaseToken, createSupabaseKey, adminHeaders } from './helpers';

const REF = 'abcdefghijklmnopqrst';
const V = '2025-01-01' as const;

beforeAll(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('supabase management proxy RBAC', () => {
	it('allows database:read but denies database:write for a read-only key', async () => {
		const tid = await registerSupabaseToken([REF]);
		const policy = { version: V, statements: [
			{ effect: 'allow', actions: ['supabase:database:read'], resources: [`project:${REF}`] },
		]};
		const key = await createSupabaseKey(policy, tid);

		// upstream mock for the allowed read
		fetchMock.get('https://api.supabase.com')
			.intercept({ path: `/v1/projects/${REF}/config/database`, method: 'GET' })
			.reply(200, { ok: true });

		const ok = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(ok.status).toBe(200);

		// write must be denied at the gateway — no upstream call
		const denied = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/database/query`, {
			method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: 'drop table users' }),
		});
		expect(denied.status).toBe(403);
	});

	it('rejects unauthenticated requests with 401', async () => {
		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/auth`);
		expect(res.status).toBe(401);
	});

	it('returns 404-style deny for unmapped paths', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey({ version: V, statements: [
			{ effect: 'allow', actions: ['supabase:*'], resources: ['*'] },
		]}, tid);
		const res = await SELF.fetch(`https://gk/supabase/v1/totally/unmapped`, { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(404);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/supabase-mgmt.test.ts`
Expected: FAIL — `/supabase` route not mounted (404 on everything, or route missing).

- [ ] **Step 4: Write `src/supabase/router.ts`**

```ts
import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { extractRequestFields } from '../request-fields';
import { AUDIT_CREATED_BY_API_KEY } from '../constants';
import { classifySupabaseRequest } from './classify';
import {
	extractBearerKey, isValidSupabaseRef, sbJsonError,
	proxyToManagementApi, proxyToMetrics, buildProxyResponse, extractResponseDetail,
} from './proxy-helpers';
import { logSupabaseProxyEvent, type SupabaseProxyEvent } from './analytics';
import type { RequestContext } from '../policy-types';

type SupabaseEnv = { Bindings: Env };

export const supabaseApp = new Hono<SupabaseEnv>();

// ─── Metrics proxy (mounted before the catch-all so /metrics/:ref is matched first) ───
supabaseApp.get('/metrics/:ref', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'supabase-metrics', ts: new Date().toISOString() };
	const env = c.env;
	const ref = c.req.param('ref');
	const keyId = extractBearerKey(c.req.header('Authorization'));
	if (!keyId) return sbJsonError(401, 'Missing or invalid Authorization: Bearer <key>');
	if (!isValidSupabaseRef(ref)) return sbJsonError(400, 'Invalid project ref');

	const rf = extractRequestFields(c.req.raw);
	const ctx: RequestContext = {
		action: 'supabase:metrics:read', resource: `project:${ref}`,
		fields: { ...rf, 'supabase.project_ref': ref, 'supabase.category': 'metrics', 'supabase.method': 'GET', 'supabase.write': false },
	};
	const stub = getStub(env);
	const auth = await stub.authorize(keyId, ref, [ctx]);
	if (!auth.authorized) {
		const status = auth.error === 'Invalid API key' ? 401 : 403;
		return sbJsonError(status, auth.error ?? 'Forbidden');
	}
	const cred = await stub.resolveSupabaseMetricsCredential(ref);
	if (!cred) return sbJsonError(502, `No metrics credential registered for project ${ref}`);

	const upstreamStart = Date.now();
	const upstream = await proxyToMetrics(ref, cred.username, cred.secret);
	log.status = upstream.status;
	log.durationMs = Date.now() - start;
	console.log(JSON.stringify(log));

	if (env.ANALYTICS_DB) {
		const event: SupabaseProxyEvent = {
			key_id: keyId, project_ref: ref, category: 'metrics', action: 'supabase:metrics:read',
			status: upstream.status, upstream_status: upstream.status, duration_ms: Date.now() - start,
			upstream_latency_ms: Date.now() - upstreamStart, response_size: null, response_detail: null,
			created_by: auth.keyName ? `key:${auth.keyName}` : AUDIT_CREATED_BY_API_KEY, created_at: Date.now(),
		};
		c.executionCtx.waitUntil(logSupabaseProxyEvent(env.ANALYTICS_DB, event));
	}
	// Metrics is Prometheus text — stream the body through unchanged.
	return buildProxyResponse(upstream, null);
});

// ─── Management API catch-all ──────────────────────────────────────────────
supabaseApp.all('/v1/*', async (c) => {
	const start = Date.now();
	const log: Record<string, unknown> = { route: 'supabase-mgmt', ts: new Date().toISOString() };
	const env = c.env;
	const method = c.req.method;
	const url = new URL(c.req.url);
	const path = url.pathname.replace(/^\/supabase/, ''); // strip mount prefix

	const keyId = extractBearerKey(c.req.header('Authorization'));
	if (!keyId) return sbJsonError(401, 'Missing or invalid Authorization: Bearer <key>');

	const cls = classifySupabaseRequest(method, path);
	if (!cls) {
		log.status = 404; log.error = 'unmapped_endpoint'; log.path = path;
		console.log(JSON.stringify(log));
		return sbJsonError(404, `Endpoint not mapped in Gatekeeper policy surface: ${method} ${path}`);
	}
	log.action = cls.action; log.projectRef = cls.projectRef;

	const rf = extractRequestFields(c.req.raw);
	const ctx: RequestContext = {
		action: cls.action, resource: cls.resource,
		fields: {
			...rf,
			'supabase.category': cls.category, 'supabase.method': method, 'supabase.write': cls.write,
			...(cls.projectRef ? { 'supabase.project_ref': cls.projectRef } : {}),
		},
	};

	const stub = getStub(env);
	const auth = await stub.authorize(keyId, cls.projectRef ?? '', [ctx]);
	if (!auth.authorized) {
		const status = auth.error === 'Invalid API key' ? 401 : 403;
		log.status = status; log.error = 'auth_failed'; log.authError = auth.error;
		console.log(JSON.stringify(log));
		return sbJsonError(status, auth.error ?? 'Forbidden');
	}

	// Resolve PAT by project ref (or '*' wildcard via the account-level fallback).
	const pat = await stub.resolveSupabaseToken(cls.projectRef ?? '*');
	if (!pat) {
		log.status = 502; log.error = 'no_upstream_pat';
		console.log(JSON.stringify(log));
		return sbJsonError(502, 'No Supabase Personal Access Token registered for this project');
	}

	const body = method !== 'GET' && method !== 'HEAD' ? await c.req.arrayBuffer() : undefined;
	const upstreamStart = Date.now();
	const upstream = await proxyToManagementApi(path, pat, method, body, url.search.slice(1), c.req.header('content-type') ?? null);
	const upstreamLatency = Date.now() - upstreamStart;
	const text = await upstream.text();

	log.status = upstream.status; log.upstreamLatencyMs = upstreamLatency; log.durationMs = Date.now() - start;
	console.log(JSON.stringify(log));

	if (env.ANALYTICS_DB) {
		const event: SupabaseProxyEvent = {
			key_id: keyId, project_ref: cls.projectRef, category: cls.category, action: cls.action,
			status: upstream.status, upstream_status: upstream.status, duration_ms: Date.now() - start,
			upstream_latency_ms: upstreamLatency, response_size: new TextEncoder().encode(text).byteLength,
			response_detail: extractResponseDetail(text),
			created_by: auth.keyName ? `key:${auth.keyName}` : AUDIT_CREATED_BY_API_KEY, created_at: Date.now(),
		};
		c.executionCtx.waitUntil(logSupabaseProxyEvent(env.ANALYTICS_DB, event));
	}
	return buildProxyResponse(upstream, text);
});
```

- [ ] **Step 5: Mount in `src/index.ts`**

Add import near the other sub-app imports:
```ts
import { supabaseApp } from './supabase/router';
```
Add the mount after `app.route('/cf', cfApp);`:
```ts
app.route('/supabase', supabaseApp);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/supabase-mgmt.test.ts`
Expected: PASS (3 tests). (Task 6 must land for `logSupabaseProxyEvent` to import; if running this task in isolation, stub `src/supabase/analytics.ts` exports first — see Task 6 Step 3.)

- [ ] **Step 7: Commit**

```bash
git add src/supabase/router.ts src/index.ts test/helpers.ts test/supabase-mgmt.test.ts
git commit -m "feat(supabase): Management API RBAC proxy + metrics proxy routes"
```

---

## Task 5: Metrics proxy test (the headline slice)

**Files:**
- Test: `test/supabase-metrics.test.ts`

The route was implemented in Task 4. This task locks in the behaviour that distinguishes the product: a metrics-only key cannot touch data, and only `supabase:metrics:read` unlocks scraping.

- [ ] **Step 1: Write the failing test**

```ts
// test/supabase-metrics.test.ts
import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { adminHeaders, createSupabaseKey } from './helpers';

const REF = 'abcdefghijklmnopqrst';
const V = '2025-01-01' as const;

async function registerMetricsCred(): Promise<string> {
	const res = await SELF.fetch('https://gk/admin/upstream-tokens', {
		method: 'POST', headers: adminHeaders(),
		body: JSON.stringify({ name: 'metrics', token: 'sb_secret_xyz', scope_type: 'supabase_metrics', auth_type: 'basic', username: 'service_role', zone_ids: [REF] }),
	});
	return (await res.json<any>()).token.id;
}

beforeAll(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('supabase metrics proxy', () => {
	it('lets a metrics:read key scrape, swapping in Basic auth', async () => {
		const tid = await registerMetricsCred();
		const key = await createSupabaseKey({ version: V, statements: [
			{ effect: 'allow', actions: ['supabase:metrics:read'], resources: [`project:${REF}`] },
		]}, tid);

		fetchMock.get(`https://${REF}.supabase.co`)
			.intercept({ path: '/customer/v1/privileged/metrics', method: 'GET' })
			.reply(200, 'pg_stat_database_blks_hit 42', { headers: { 'Content-Type': 'text/plain' } });

		const res = await SELF.fetch(`https://gk/supabase/metrics/${REF}`, { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('pg_stat_database_blks_hit');
	});

	it('denies a metrics key from calling the Management API (no data access)', async () => {
		const tid = await registerMetricsCred();
		const key = await createSupabaseKey({ version: V, statements: [
			{ effect: 'allow', actions: ['supabase:metrics:read'], resources: [`project:${REF}`] },
		]}, tid);
		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/database/query`, {
			method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: 'select 1' }),
		});
		expect(res.status).toBe(403);
	});
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run test/supabase-metrics.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add test/supabase-metrics.test.ts
git commit -m "test(supabase): metrics-only credential cannot reach data plane"
```

---

## Task 6: Analytics table + admin read endpoint

**Files:**
- Modify: `src/schema.ts`
- Create: `src/supabase/analytics.ts`
- Create: `src/routes/admin-supabase-analytics.ts`
- Modify: `src/routes/admin.ts`, `src/index.ts`
- Test: assertions added to `test/supabase-mgmt.test.ts`

Clone the `cf_proxy_events` pattern (`src/cf/analytics.ts`) with a Supabase-shaped row.

- [ ] **Step 1: Add SQL constants to `src/schema.ts`**

Mirror the `CF_PROXY_EVENTS_*` block (lines 98–131). Add:

```ts
export const SUPABASE_PROXY_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS supabase_proxy_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	key_id TEXT NOT NULL,
	project_ref TEXT,
	category TEXT NOT NULL,
	action TEXT NOT NULL,
	status INTEGER NOT NULL,
	upstream_status INTEGER,
	duration_ms INTEGER NOT NULL,
	upstream_latency_ms INTEGER,
	response_size INTEGER,
	response_detail TEXT,
	created_by TEXT,
	created_at INTEGER NOT NULL
)`;
export const SUPABASE_PROXY_EVENTS_INDEX_KEY_SQL = `CREATE INDEX IF NOT EXISTS idx_sb_proxy_key ON supabase_proxy_events(key_id, created_at)`;
export const SUPABASE_PROXY_EVENTS_INDEX_REF_SQL = `CREATE INDEX IF NOT EXISTS idx_sb_proxy_ref ON supabase_proxy_events(project_ref, created_at)`;
export const SUPABASE_PROXY_EVENTS_INDEX_ACTION_SQL = `CREATE INDEX IF NOT EXISTS idx_sb_proxy_action ON supabase_proxy_events(action, created_at)`;
```

- [ ] **Step 2: Write `src/supabase/analytics.ts`**

Clone `src/cf/analytics.ts` structure: `SupabaseProxyEvent` interface (fields exactly as constructed in `router.ts`), `ensureTables()` running the three SQL constants in `db.batch()`, `logSupabaseProxyEvent()`, `querySupabaseProxyEvents()`, `querySupabaseProxySummary()` (group by status / category / action), and `deleteOldSupabaseProxyEvents(db, retentionDays)`. Do NOT add a module-level `tablesInitialized` flag — see Known Pitfalls in `AGENTS.md` (it breaks the per-file D1 isolation in vitest-pool-workers).

- [ ] **Step 3: Write `src/routes/admin-supabase-analytics.ts`**

Clone `src/routes/admin-cf-analytics.ts`: a Hono sub-app with `GET /` (recent events, query params `project_ref`, `key_id`, `action`, `since`, `until`, `limit`) and `GET /summary`. Admin-auth via the existing admin middleware on the parent `adminApp`.

- [ ] **Step 4: Mount it in `src/routes/admin.ts`**

Find where `admin-cf-analytics` is mounted and add the parallel line, e.g.:
```ts
import { adminSupabaseAnalytics } from './admin-supabase-analytics';
// ...
adminApp.route('/supabase/analytics', adminSupabaseAnalytics);
```

- [ ] **Step 5: Add retention to cron in `src/index.ts`**

Add import `import { deleteOldSupabaseProxyEvents } from './supabase/analytics';` and call it inside the existing `scheduled()` handler alongside `deleteOldCfProxyEvents(...)`, using the same retention env var.

- [ ] **Step 6: Add an analytics assertion to `test/supabase-mgmt.test.ts`**

After the allowed read in the first test, query `https://gk/admin/supabase/analytics?project_ref=${REF}` with `adminHeaders()` and assert at least one row with `action: 'supabase:database:read'` and `status: 200`.

- [ ] **Step 7: Run the full supabase suite**

Run: `npx vitest run test/supabase-mgmt.test.ts test/supabase-metrics.test.ts test/supabase-classify.test.ts test/supabase-credentials.test.ts`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/schema.ts src/supabase/analytics.ts src/routes/admin-supabase-analytics.ts src/routes/admin.ts src/index.ts test/supabase-mgmt.test.ts
git commit -m "feat(supabase): D1 analytics + admin read endpoint"
```

---

## Task 7: Admin CRUD validation + types regen

**Files:**
- Modify: `src/routes/admin-upstream-tokens.ts` (validation only)
- Modify: `worker-configuration.d.ts` (regenerated)
- Test: `test/supabase-credentials.test.ts` (HTTP-level)

The existing `POST /admin/upstream-tokens` route already persists arbitrary `scope_type` / `zone_ids`. Add validation so Supabase credentials are well-formed.

- [ ] **Step 1: Write the failing test (HTTP validation)**

```ts
it('rejects a supabase_metrics credential without auth_type=basic', async () => {
	const res = await SELF.fetch('https://gk/admin/upstream-tokens', {
		method: 'POST', headers: adminHeaders(),
		body: JSON.stringify({ name: 'bad', token: 'x', scope_type: 'supabase_metrics', zone_ids: ['abcdefghijklmnopqrst'] }),
	});
	expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails** (currently returns 200/201).

Run: `npx vitest run test/supabase-credentials.test.ts -t "rejects a supabase_metrics"`
Expected: FAIL.

- [ ] **Step 3: Add validation in `src/routes/admin-upstream-tokens.ts`**

In the create handler, after parsing the body and before calling `stub.createUpstreamToken`:

```ts
import { SUPABASE_REF_RE } from '../supabase/constants';
// ...
if (body.scope_type === 'supabase_metrics') {
	if (body.auth_type !== 'basic') return adminJsonError(c, 400, 'supabase_metrics credentials require auth_type=basic');
	// username is optional — Supabase ignores it for metrics Basic Auth (resolver defaults to 'service_role').
}
if (body.scope_type === 'supabase' || body.scope_type === 'supabase_metrics') {
	for (const ref of body.zone_ids) {
		// Loose validation only — the OpenAPI spec does not constrain ref format (see Task 2).
		if (ref !== '*' && !SUPABASE_REF_RE.test(ref)) return adminJsonError(c, 400, `Invalid project ref: ${ref}`);
	}
}
```
(Match the actual error helper used in that file — likely `adminJsonError` or an inline `c.json({ success:false, ... }, 400)`. Use the existing pattern.)

- [ ] **Step 4: Regenerate types**

Run: `npx wrangler types`
Expected: `worker-configuration.d.ts` updated (no manual edits). No new bindings are required by this plan — Supabase upstreams are stored in the existing DO, not as wrangler bindings.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/supabase-credentials.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin-upstream-tokens.ts worker-configuration.d.ts test/supabase-credentials.test.ts
git commit -m "feat(supabase): validate supabase credential creation"
```

---

## Task 8: Preflight + smoke

**Files:** none (verification task)

- [ ] **Step 1: Typecheck + lint + full test + build**

Run: `npm run preflight`
Expected: typecheck clean, prettier clean, all tests pass (including the four new `supabase-*` files), build succeeds.

- [ ] **Step 2: Manual smoke against `wrangler dev` (optional)**

Start `npx wrangler dev` in a separate terminal, then:
```bash
# register a metrics credential (admin)
curl -sX POST localhost:8787/admin/upstream-tokens -H "X-Admin-Key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"m","token":"sb_secret_x","scope_type":"supabase_metrics","auth_type":"basic","username":"service_role","zone_ids":["abcdefghijklmnopqrst"]}'
# create a metrics-only key (admin) — capture .key.secret
# then scrape:
curl -s localhost:8787/supabase/metrics/abcdefghijklmnopqrst -H "Authorization: Bearer $METRICS_KEY"
```
Expected: 200 with Prometheus text (or 502 if the ref/secret are fake — proves the gateway path, not Supabase).

- [ ] **Step 3: Commit any preflight fixups**

```bash
git add -A && git commit -m "chore(supabase): preflight fixups"
```

---

## Follow-on work (explicitly out of scope here)

- **Dashboard surfaces** — a `SupabaseCredentialsPage.tsx` + `SupabaseProxyAnalyticsPage.tsx` (clone `UpstreamTokensPage.tsx` / `S3CredentialsPage.tsx`). Not needed for the RBAC value prop; curl + admin API suffice.
- **CLI commands** — `cli/commands/supabase-analytics.ts` (clone `cf-analytics.ts`). Add to `cli/index.ts` lazy command map.
- **Finer-grained actions** — split category actions into per-endpoint actions (e.g. `supabase:database:run_sql` distinct from `supabase:database:config_write`) by emitting a finer tail-derived action segment in `classifySupabaseRequest`. The policy engine already supports wildcard suffix matching, so `supabase:database:*` keeps working.
- **SQL-statement conditions** — a policy condition field like `supabase.sql_operation` (parse the `query` body of `database/query` to expose `select`/`insert`/`drop`) so policies can allow `SELECT` but deny `DROP`. Requires a body-parsing hook in the catch-all before `authorize`.
- **Data-plane APIs** (PostgREST `/rest/v1`, GoTrue `/auth/v1`, Storage native, Realtime WS) — these need per-project upstream hosts (partially built here) plus dynamic resource matching and, for Realtime, WebSocket proxying (a capability Gatekeeper does not yet have). Separate plan.

---

## Self-Review

**Spec coverage:**
- "Scopes issue for metrics API" → Task 5 (metrics-only credential, Basic-auth swap, cannot reach data plane). ✓
- "More that needs scopes/RBAC" → Tasks 2+4 (full Management API surface behind the policy engine via the classifier). ✓
- PATs have no scopes → solved by fronting a stored PAT with Gatekeeper keys (Tasks 1, 4). ✓
- OAuth scopes too coarse → category actions are the floor; conditions (project_ref, write, time, IP) add the granularity Supabase lacks (Task 2 fields + existing policy engine). ✓

**Placeholder scan:** Step 3 of Task 6 and Step 2 of Task 6 say "clone X" rather than transcribing the full file — acceptable because the source file (`src/cf/analytics.ts`, `src/routes/admin-cf-analytics.ts`) is named exactly and the row shape is fully specified in `router.ts` (Task 4 Step 4). The classifier (Task 2) uses longest-prefix matching verified against the per-group OpenAPI files, covering all in-scope groups at any depth; out-of-scope groups deny-by-default.

**Schema verification (2026-06-18):** classifier paths cross-checked against `/docs/supabase-api/api/{database,auth,projects,environments,secrets,edge-functions}.md`. Confirmed the `POST`-but-read endpoints (`database/query/read-only`, `network-bans/retrieve[/enriched]`), deep nesting (`config/auth/sso/providers/{id}`, `functions/{slug}/body`), and the ref-position literals (`available-regions`). Both previously-open items were then **verified against a live project** (`dewddkcmwrzbpynylyhg`) on 2026-06-18: (a) metrics Basic Auth validates the password only — username ignored, `apikey`/`Bearer` rejected, returns `text/plain` Prometheus; (b) ref format is 20 lowercase alphanumeric chars → `SUPABASE_REF_RE = /^[a-z0-9]{20}$/`.

**Type consistency:** `SupabaseProxyEvent` fields constructed in `router.ts` (Task 4) match the interface to be defined in `analytics.ts` (Task 6) — both use `project_ref`, `category`, `action`, `status`, `upstream_status`, `duration_ms`, `upstream_latency_ms`, `response_size`, `response_detail`, `created_by`, `created_at`. `resolveSupabaseMetricsCredential` returns `{ username, secret }` in Task 1 and is consumed as `cred.username` / `cred.secret` in Task 4. `classifySupabaseRequest` return shape matches its consumers in Task 4 and tests in Task 2.

**Cross-task ordering caveat:** Task 4 imports from `src/supabase/analytics.ts` (Task 6). If building strictly in number order, add a minimal stub export of `logSupabaseProxyEvent` + `SupabaseProxyEvent` in Task 4 Step 4, then flesh it out in Task 6. The recommended build order (1→3→5→2→4→6) avoids this by noting the dependency.
