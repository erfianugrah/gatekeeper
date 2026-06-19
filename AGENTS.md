# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command                                                  | Purpose                                            |
| -------------------------------------------------------- | -------------------------------------------------- |
| `npx wrangler dev`                                       | Local development                                  |
| `npx wrangler deploy`                                    | Deploy to Cloudflare                               |
| `npx wrangler types`                                     | Generate TypeScript types                          |
| `npm test`                                               | Run all tests (worker + CLI)                       |
| `npm run test:worker`                                    | Run worker tests only (Cloudflare Workers runtime) |
| `npm run test:cli`                                       | Run CLI tests only (Node.js runtime)               |
| `npx vitest run test/iam.test.ts`                        | Run a single worker test file                      |
| `npx vitest run -c vitest.cli.config.ts cli/cli.test.ts` | Run a single CLI test file                         |
| `npx vitest run -t "test name"`                          | Run a single test by name                          |
| `npm run typecheck`                                      | Type-check worker + CLI (no emit)                  |
| `npm run lint`                                           | Check formatting (Prettier)                        |
| `npm run lint:fix`                                       | Auto-fix formatting                                |
| `npm run build`                                          | Build dashboard + CLI                              |
| `npm run build:cli`                                      | Build the CLI only                                 |
| `npm run preflight`                                      | typecheck + lint + test + build (run before PR)    |
| `npm run cli -- <command>`                               | Run the CLI locally (uses tsx + .env)              |
| `npm run test:e2e`                                       | Run Playwright E2E tests (auto-starts wrangler dev) |
| `npx playwright test e2e/supabase-ui.spec.ts`            | Run a single E2E test file                         |
| `GATEKEEPER_URL=http://localhost:8787 npm run smoke`     | Run the live-API smoke suite against a deployment  |

Run `wrangler types` after changing bindings in wrangler.jsonc.

### Test architecture

There are three test layers:

- **worker** (`vitest.worker.config.ts`): Uses `@cloudflare/vitest-pool-workers` to run `test/**/*.test.ts` in the Workers runtime. Tests use `SELF.fetch()` and Durable Object stubs.
- **cli** (`vitest.cli.config.ts`): Runs `cli/**/*.test.ts` in plain Node.js.
- **e2e** (`playwright.config.ts`): Playwright browser tests in `e2e/**/*.spec.ts`, run against `http://localhost:8787`. The Playwright `webServer` config auto-starts `wrangler dev` (injecting `ADMIN_KEY=test-admin-secret-key-12345` via `--var`, since `.dev.vars` is gitignored); locally it reuses a server you already have running, in CI it boots a fresh one. The dashboard must be built first (`assets.directory` → `dashboard/dist`). Specs: purge profiles, pill inputs, condition editor, form validation, and **Supabase UI** (`supabase-ui.spec.ts` — upstream-token scope types + project-ref validation, PolicyBuilder scope-gated action groups). E2e is a **deploy gate in CI** (`deploy` needs `[preflight, e2e]`) because it catches the `run_worker_first` asset-layer class of bug that the worker test pool is blind to (vitest calls `app.fetch` directly).

When running a single worker test file, you do NOT need `-c vitest.worker.config.ts` because the default config includes both projects. For CLI tests, you DO need `-c vitest.cli.config.ts` or run via `npm run test:cli`.

### Live-API smoke suite

`npm run smoke` (entry `cli/smoke-test.ts`) exercises a deployment end-to-end over HTTP. `BASE = GATEKEEPER_URL ?? http://localhost:8787`; `IS_REMOTE` when `https://`. Each surface is a module under `cli/smoke/` (admin, purge, s3, dns, cf-proxy, **supabase**, …). The **supabase** module has two tiers: a synthetic tier (always runs, no real credential — asset-layer wiring, auth ordering, classifier + deny-by-default, token binding) and an opt-in live tier gated on `SUPABASE_SMOKE_PAT` that drives the **official `supabase` CLI** through the proxy (`SUPABASE_API_URL=<gateway>/supabase`, `SUPABASE_ACCESS_TOKEN=<gatekeeper key>`). Smoke is NOT in CI preflight (it needs real upstream credentials and creates real resources) — run it manually / on a schedule.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Deployment & environments

Two Workers, one codebase, via wrangler [environments](https://developers.cloudflare.com/workers/wrangler/environments/):

| Env | Worker name | Route | D1 (`ANALYTICS_DB`) |
| --- | --- | --- | --- |
| **production** (top-level config) | `gatekeeper` | `gate.erfi.io` (custom domain) | `gatekeeper-analytics` |
| **staging** (`env.staging`) | `gatekeeper-staging` | `gatekeeper-staging.anugrah.workers.dev` | `gatekeeper-analytics-staging` |

- **Top-level config IS production.** Bare `wrangler deploy` (and `npm run deploy` / `ship`) deploys prod. The `@cloudflare/vitest-pool-workers` test pool also reads the top-level config (no `environment` set), so the top-level bindings must stay intact.
- **`env.staging` repeats the bindings on purpose.** `durable_objects` and `d1_databases` are [non-inheritable](https://developers.cloudflare.com/workers/wrangler/configuration/#non-inheritable-keys) — once any one is overridden in an env, all bindings must be redeclared there. `routes` is inheritable, so staging overrides it to `[]` + `workers_dev: true` to avoid claiming `gate.erfi.io`. Staging gets its own isolated DO namespace automatically (separate Worker script).
- `account_id` is pinned in `wrangler.jsonc` because the dev-box global API key spans multiple accounts; without it wrangler errors on account ambiguity.
- Deploy staging manually with `npm run deploy:staging` (or `ship:staging` to gate on preflight first).
- **CD lives in `ci.yml`** (`deploy` job, `needs: preflight` so a red suite never ships): push to `main` → staging, push tag `v*` → production, `workflow_dispatch` → chosen env. Auth is the scoped `CLOUDFLARE_API_TOKEN` repo secret (Workers Scripts + D1 on the account, Workers Routes + Zone Read on erfi.io) — **never** the global API key.
- Secrets are per-environment (`wrangler secret put <NAME> --env staging`). Staging has its own `ADMIN_KEY`; the other secrets (CF_ACCESS_*, RBAC_*) are unset on staging until needed.

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

---

## Code Style

### Formatting (Prettier + EditorConfig)

- Tabs for indentation (not spaces)
- Single quotes
- Semicolons required
- Print width: 140
- LF line endings
- Trailing whitespace trimmed, final newline inserted
- YAML files use spaces for indentation

### Imports

- Use **named imports** (not default) for all internal modules.
- Separate `import type { ... }` from value imports on distinct lines.
- Order: (1) platform modules (`cloudflare:workers`, `cloudflare:test`), (2) external libs (`hono`, `citty`, `vitest`), (3) local value imports, (4) local type-only imports.
- **Worker source (`src/`)**: No file extensions in import paths (bundled by wrangler).
- **CLI source (`cli/`)**: Always use `.js` extensions in import paths (ESM requirement).
- No barrel/index re-export files. Import directly from the source module.

### Types

- **`interface`** for object/record shapes with multiple fields.
- **`type`** for unions, string literals, and simple aliases (e.g., Hono env wiring).
- Shared worker types go in `src/types.ts`. Domain-specific types live in their own module.
- Explicit return types on public/exported methods. Type inference is fine for short private helpers.
- All env vars are string-typed; cast to numbers at point of use: `Number(env.BULK_RATE) || 50`.

### Naming Conventions

| Category                | Convention                                   | Example                               |
| ----------------------- | -------------------------------------------- | ------------------------------------- |
| Files                   | `kebab-case.ts`                              | `token-bucket.ts`                     |
| Classes                 | `PascalCase`                                 | `Gatekeeper`, `TokenBucket`           |
| Interfaces/Types        | `PascalCase`                                 | `PurgeBody`, `AuthResult`             |
| Functions               | `camelCase`                                  | `classifyPurge`, `resolveZoneId`      |
| Variables               | `camelCase`                                  | `cacheTtlMs`, `singleBucket`          |
| Module constants        | `UPPER_SNAKE_CASE`                           | `DO_NAME`, `CREATE_TABLE_SQL`         |
| Env bindings            | `UPPER_SNAKE_CASE`                           | `ADMIN_KEY`, `ANALYTICS_DB`           |
| DB columns / API fields | `snake_case`                                 | `zone_id`, `scope_type`, `created_at` |
| CLI args                | `kebab-case`                                 | `zone-id`, `admin-key`                |
| Private class fields    | `camelCase` with `private` keyword (not `#`) | `private tokens`                      |
| Test-only exports       | `__testPrefixed` double-underscore           | `__testClearInflightCache()`          |

### Functions

- Use `function` declarations for top-level/named helpers.
- Use arrow functions for inline callbacks, Hono route handlers, and middleware.
- Use `async`/`await` exclusively. No raw `.then()` chains (`.finally()` for cleanup is fine).

### Error Handling

- **Worker routes**: try/catch returning Cloudflare API-style JSON:
  `{ success: false, errors: [{ code: 400, message: "..." }] }`
- **Validation helpers**: Throw `new Error(...)` with descriptive messages; caught by route handler.
- **Fire-and-forget** (analytics, etc.): try/catch with `console.error(JSON.stringify({...}))`, never propagate.
- **CLI**: Call `error(msg)` (from `ui.ts`) then `process.exit(1)` for fatal errors. Use `assertOk()` for HTTP response checks.
- Catch clauses: `catch (e: any)` when the error value is used, bare `catch` when unused.
- No generic Result/Either monad. `AuthResult` uses `{ authorized: boolean, error?: string }` pattern.

### Breadcrumb Logging

Structured breadcrumb logs are emitted at every significant decision point. They help operators debug auth failures, IdP misconfigurations, upstream resolution, and request flow without reading source code.

Format:

```ts
console.log(JSON.stringify({ breadcrumb: 'descriptive-name', ...contextFields }));
```

Conventions:

- `breadcrumb` is always a **kebab-case** string prefixed with the module area (e.g., `iam-authorize-ok`, `upstream-token-not-found`, `do-upstream-429-drain`).
- Context fields are whatever is useful for debugging that specific decision point -- key IDs, zone IDs, email, role, cache hit/miss, error messages, etc.
- Breadcrumbs are for **decision points and failures**, not for every function call. If a code path has only one possible outcome, it does not need a breadcrumb.
- Fire-and-forget errors (analytics, etc.) use `console.error(JSON.stringify({...}))` instead.
- Pure crypto / math modules (e.g., `sig-v4-verify.ts`, `sig-v4-sign.ts`) do not emit breadcrumbs -- the calling layer logs all outcomes.

### Comments

- **Section dividers** in source files use Unicode box-drawing (`─`):
  `// ─── App types ──────────────────────────────────────────────────`
- JSDoc `/** ... */` for exported functions/methods. No `@param`/`@returns` tags; rely on TS types.
- Inline `//` comments for brief explanations. Use em-dashes in prose.
- Tests use `// --- Section ---` with regular dashes.

### Exports

- Named exports for nearly everything.
- `export default app` only for the Hono app (Workers fetch handler requirement).
- CLI command files export `defineCommand(...)` as default (for lazy dynamic import).

### Hono Patterns

- Multiple Hono sub-apps: `authApp` (`/auth`), `oauthApp` (`/auth/oauth`), `adminApp` (`/admin`), `purgeRoute` (`/`), `s3App` (`/s3`), `cfApp` (`/cf`).
- **Route mounting order matters**: more specific prefixes must be mounted before less specific ones (e.g. `/auth/oauth` before `/auth`) because Hono's prefix matching is first-match.
- Typed environment: `type HonoEnv = { Bindings: Env }` passed to `new Hono<HonoEnv>()`.
- Access bindings via `c.env`, params via `c.req.param()`, query via `c.req.query()`.
- Use `c.executionCtx.waitUntil()` for fire-and-forget async work.

### Env / Bindings

- `worker-configuration.d.ts` is auto-generated by `wrangler types`. Do not edit manually.
- `src/env.d.ts` extends `Cloudflare.Env` with secrets not in wrangler.jsonc.
- `test/env.d.ts` wires `Env` into `cloudflare:test`'s `ProvidedEnv`.

### Testing Conventions

- Vitest with `describe()`/`it()` blocks. Test names use natural language with arrow notation: `"revoked key -> rejected"`.
- `beforeAll` for one-time setup, `beforeEach`/`afterEach` for per-test state reset.
- Worker integration tests use `SELF.fetch()` from `cloudflare:test`.
- Durable Object tests obtain stubs via `env.GATEKEEPER.get(id)`.
- HTTP mocking: `fetchMock` from `cloudflare:test` with `fetchMock.activate()` in `beforeAll`.
- Time-dependent tests: `vi.useFakeTimers()` / `vi.setSystemTime()` / `vi.advanceTimersByTime()`.
- CLI tests mock `process.exit` via `vi.spyOn()`.
- Assertions use `expect()` with `.toBe()`, `.toEqual()`, `.toMatch(/regex/)`, etc.
- Parse responses with `res.json<any>()`.

### Built-in Authentication

- `src/password.ts` — PBKDF2-SHA256 password hashing via Web Crypto API. 100k iterations (Workers Web Crypto max), 16-byte random salt, timing-safe verification. PHC string format: `$pbkdf2-sha256$iterations$base64salt$base64hash`.
- `src/user-manager.ts` — User CRUD in DO SQLite. Stores hashed passwords, never returns hashes to clients. Dummy hash on unknown emails to prevent timing-based user enumeration.
- `src/session-manager.ts` — Session management in DO SQLite. 256-bit random tokens, 24h default TTL (30d max). HttpOnly/Secure/SameSite=Lax cookies. Lazy expiry cleanup + cron cleanup.
- `dashboard/src/components/LoginPage.tsx` — React login page with shadcn/ui. Handles both login and bootstrap (first-run) flows. Progressive enhancement: native `method="POST"` forms work without JS; JS enhances with inline errors and bootstrap detection.
- `src/routes/auth.ts` — Auth endpoints: `POST /auth/login`, `POST /auth/logout`, `GET /auth/session`, `POST /auth/bootstrap`.
- `src/routes/admin-users.ts` — Admin user CRUD: list, create, get, update role, change password, delete. Admin-only with audit logging.
- `src/auth-admin.ts` — Three auth paths checked in order: Access JWT → X-Admin-Key → session cookie. When an Access SSO user has a matching built-in user record, the built-in user's role takes precedence.
- Session cookie name: `gk_session`. Cookie parsing is duplicated in `auth-admin.ts` and `routes/auth.ts` (both need it independently).
- Password changes and user deletions automatically revoke all sessions for that user.
- Bootstrap endpoint (`POST /auth/bootstrap`) only works when zero users exist. After the first user is created, it returns 403 permanently.

### OAuth / OIDC Authentication (Access for SaaS)

- `src/auth-oauth.ts` — Generic OAuth2/OIDC client using `arctic` library. Works with any OIDC provider (Cloudflare Access for SaaS, Auth0, Okta, Keycloak, Google, Entra ID, etc.).
- Uses **PKCE (S256)** for the authorization code flow. State and code verifier stored in short-lived HttpOnly cookies (10 min TTL).
- Flow: `GET /auth/oauth/login` → redirect to IdP → `GET /auth/oauth/callback` → exchange code for tokens → decode ID token → create session → redirect to `/dashboard/`.
- ID token is decoded (not signature-verified) via `arctic.decodeIdToken()`. This is acceptable because the token comes from a direct HTTPS call to the token endpoint, not via the browser.
- `OAUTH_CLIENT_SECRET` is optional (supports public clients with PKCE-only).
- Configurable claim names: `OAUTH_EMAIL_CLAIM` (default: `email`), `OAUTH_GROUPS_CLAIM` (default: `groups`).
- The `LoginPage.tsx` SSO button checks `oauth_enabled` from `/auth/config` to decide between the OAuth flow (`/auth/oauth/login`) and legacy Access self-hosted (`/dashboard/`).

### RBAC (Role-Based Access Control)

- `resolveRole()` in `auth-admin.ts` resolves the highest matching role from three sources (checked in priority order):
  1. **Email match** — `RBAC_ADMIN_EMAILS`, `RBAC_OPERATOR_EMAILS`, `RBAC_VIEWER_EMAILS`
  2. **Domain match** — `RBAC_ADMIN_DOMAINS`, `RBAC_OPERATOR_DOMAINS`, `RBAC_VIEWER_DOMAINS`
  3. **IdP group** — `RBAC_ADMIN_GROUPS`, `RBAC_OPERATOR_GROUPS`, `RBAC_VIEWER_GROUPS`
- If no RBAC env vars are set, all authenticated users get `admin` (backward compatible).
- Email/domain matching is useful when IdPs don't provide group claims (e.g. Google, Cloudflare Access PIN).

### Dashboard Architecture

- **Astro** with `output: "static"` and `base: "/"`. Assets served from `/_astro/` (outside Access protection).
- **React islands** via `client:load`. No SPA routing — each page is a full Astro page load.
- Pages at `src/pages/dashboard/*.astro` → URL `/dashboard/*`. Login at `src/pages/login.astro` → URL `/login`.
- `PillInput` component (`dashboard/src/components/PillInput.tsx`) — reusable pill/tag input with Enter/comma/paste commit, backspace removal, deduplication, validation, and optional max count.
- Purge page profiles stored in `localStorage` (zone ID, name, purge type, values, URL entries with headers — no secrets). Last-used profile auto-restored with all saved values. Revert button restores the last saved state when the form is dirty.
- `UrlEntryEditor` component (`dashboard/src/components/PurgePage.tsx`) — URL purge type uses a list-based editor instead of PillInput. Each URL entry has an expandable headers section for custom cache key headers (CF-Device-Type, Accept-Language, etc.). Entries with headers emit `{ url, headers }` objects in the API body; plain strings otherwise.
- Condition editor shows AND/OR separators between conditions, clickable to toggle join mode. Inapplicable conditions (e.g. `host` field on `dns:*` actions) show warnings with the `appliesTo` field metadata.

### Policy Engine — Inapplicable Condition Handling

The policy engine uses **effect-aware skip** for conditions on fields that are absent from the request context (`src/policy-engine.ts`):

- **Allow statements**: Missing field → condition is vacuously satisfied (skipped). This lets `allow purge:* where host contains erfi.io` also allow tag/prefix/everything purges that have no `host` field.
- **Deny statements**: Missing field → condition fails → deny does not fire. This ensures `deny purge:* where host contains evil.com` does not block tag purges.
- **`exists`/`not_exists` operators**: Never affected by skip behavior — they explicitly test for field presence.
- **`not` compound condition**: The `not` wrapper inverts the vacuously-true result, causing `allow ... where NOT(field eq X)` to fail when the field is missing. This is a known limitation — recommend using the `deny` effect for exclusion patterns instead (e.g., `deny ... where field eq X`).
- **Request-scoped fields** (`client_ip`, `client_country`, `client_asn`, `time.hour`, `time.day_of_week`): Always populated by `src/request-fields.ts`, never missing in practice. The skip behavior does not affect these fields.

The `skipMissing` flag is threaded from `matchesStatement` (based on `stmt.effect`) through `evaluateCondition` into `evaluateLeaf`. A breadcrumb log is emitted when a condition is skipped: `{ breadcrumb: 'condition-field-missing-skipped', field, operator }`.

### Supabase Management API + Metrics Proxy (RBAC overlay)

Fronts a stored Supabase Personal Access Token (PAT) / metrics secret with Gatekeeper's IAM + policy engine, so a coarse account-level Supabase credential can be handed out as narrowly-scoped Gatekeeper keys. Lives in `src/supabase/`.

- `src/supabase/classify.ts` — **the RBAC surface**. Table-driven `classifySupabaseRequest(method, path)` maps an inbound `(method, path)` to a Gatekeeper action (`supabase:<category>:<read|write>`) + project ref. Longest-prefix matching on the path tail after `/v1/projects/{ref}/`; read/write derived from HTTP method with an explicit `READ_OVERRIDES` set for the POST-but-read endpoints. Unmapped paths return `null` → deny-by-default (404). Adding coverage = a new `PROJECT_TAIL_CATEGORIES` prefix or `READ_OVERRIDES` entry + a test, never a per-endpoint row. Coverage against the live Supabase OpenAPI spec is enforced by the API-coverage framework (see below) — deny-by-default fails safe but lags silently when an upstream moves an endpoint, so drift is made loud rather than discovered in production.
- `src/supabase/router.ts` — two proxy surfaces, both authorize BEFORE resolving the upstream credential (so unauthenticated callers can't probe which refs have a stored credential via 502-vs-401):
  - `ALL /supabase/v1/*` and `ALL /supabase/v0/*` — Management API, swaps in the stored PAT (Bearer). The `/v0` surface is treated as external/unstable: only `GET /v0/projects/{ref}/analytics/metrics` is classified, everything else under `/v0` denies by default.
  - `GET /supabase/metrics/:ref` — per-project metrics over HTTP Basic, swapping in the stored secret-key credential, streaming Prometheus text through unchanged.
- **Two metrics backends, same action** (`supabase:metrics:read`): the Basic-auth secret-swap path (`/supabase/metrics/:ref`) and the experimental PAT path (`/supabase/v0/projects/{ref}/analytics/metrics`). Pick whichever credential is on file; neither makes assumptions about upstream internals.
- **Credential types** live in the existing upstream-token store (DO SQLite), NOT wrangler bindings: `scope_type: 'supabase'` (PAT, Bearer) and `scope_type: 'supabase_metrics'` (secret, `auth_type: 'basic'`, optional `username` defaulting to `service_role`). `createUpstreamTokenSchema` enforces well-formedness via `superRefine` (metrics ⇒ `auth_type=basic`; 20-char project-ref shape via `SUPABASE_REF_RE`). On registration the credential is also probed against its real upstream (`validateSupabaseToken` in `src/routes/admin-helpers.ts`, mirroring the CF `validateCfToken` path) unless `validate: false`: a PAT hits `GET /v1/projects` (401/403 rejects; concrete refs must appear in the accessible-projects list; wildcard warns on 0 projects), a metrics secret hits the per-project metrics endpoint over HTTP Basic for each concrete ref (wildcard metrics tokens can't be probed — the endpoint is per-project — so they're skipped). Failures surface as non-fatal `warnings` on the 200 response, not hard errors.
- `src/supabase/analytics.ts` — `supabase_proxy_events` D1 table + `logSupabaseProxyEvent` (fire-and-forget via `waitUntil`) + `querySupabaseProxyEvents` / `querySupabaseProxySummary` / `deleteOldSupabaseProxyEvents`. Cron retention wired in `src/index.ts`.
- `src/routes/admin-supabase-analytics.ts` — `GET /admin/supabase/analytics/{events,summary,timeseries}`. **Follow the sibling convention** (`/events` + `/summary` + `/timeseries`), not a bare `/`. Timeseries requires `supabase_proxy_events` in the `ALLOWED_TABLES` safelist in `src/analytics-timeseries.ts`.
- CLI: `gk supabase-analytics {events,summary}` (`cli/commands/supabase-analytics.ts`), registered in `cli/index.ts` + `cli/commands/completions.ts`.
- **Dashboard UI** (the proxy is fully driveable from the dashboard, not just CLI/API): (1) `UpstreamTokensPage.tsx` scope select offers `supabase` (Bearer PAT) + `supabase_metrics` (HTTP Basic, with a username field defaulting to `service_role`); project refs validated as 20-char `[a-z0-9]` instead of 32-hex. (2) `PolicyBuilder.tsx` has two scope-gated action groups — `supabase` (Management API: `supabase:*` + per-category read/write across the 11 `SupabaseCategory` values) and `supabase_metrics` (`supabase:metrics:read`). `KeysPage.tsx` threads the new scope types through `makeDefaultPolicy` / `buildResourceHint` / `buildDefaultResources` (resources are `project:<ref>`) + the token dropdown groups. (3) `AnalyticsPage.tsx` surfaces `supabase_proxy_events` as a `supabase` source (mapper `fromSupabase` in `analytics-types.ts`, badge in `analytics-badges.tsx`, `getSupabaseProxyEvents` in `lib/api.ts`). NOTE: S3 has a SEPARATE policy surface (`S3PolicyBuilder` used by `S3CredentialsPage` — s3 keys use the S3-credentials model, not upstream tokens), so s3 actions deliberately do NOT appear in the main `PolicyBuilder`.
- **PolicyBuilder scope-gating**: `visibleGroups = ACTION_GROUPS.filter((g) => g.scope === tokenScopeType)` — an action group only shows when its `scope` matches the selected upstream token's `scope_type`. Adding a fronted upstream that uses the key/upstream-token model means: a new `scope_type` (in `src/upstream-tokens.ts` + `lib/api.ts`), action group(s) with that `scope`, and threading it through `KeysPage` defaults. `ALL_PREFIXES` is de-duped because the two Supabase groups share the `supabase:` prefix.

### API Coverage & Upstream Drift Detection

The proxy classifies every inbound request and **denies anything unclassified by default**. That fails safe, but it means an upstream can add/move an endpoint and the proxy silently stops covering it with no error. `scripts/api-coverage/` makes that drift loud. It is a **provider registry** (`registry.ts`) behind a common `CoverageProvider` interface (`types.ts`) — adding the next spec-backed upstream is one conforming module under `providers/` + one registration line + one committed snapshot, never a bespoke bolt-on. Full detail in `scripts/api-coverage/README.md`.

- **Two layers, two concerns.** `test/api-coverage.test.ts` is the **hermetic** invariant (no network, runs in the Workers pool on every `npm test`): it reads each provider's committed snapshot fixture and re-runs every op through the proxy's own classifier, asserting no silent gap, that the committed `covered` flag matches the classifier, and that the allowlist has no stale/now-covered entries. `scripts/api-coverage/refresh.ts` is the **live drift** check (hits the network, run via `npm run check:api-coverage`): it fetches the upstream OpenAPI doc and fails when an endpoint is added/moved/removed vs the committed snapshot or is uncovered-and-not-allowlisted.
- **`check:api-coverage` is deliberately NOT in `preflight`** — preflight must stay offline-safe (like `check:openapi`, which regenerates locally). The hermetic test in `npm test` is what runs in preflight. Run `check:api-coverage` on a schedule / before a release; on drift, run `npm run api-coverage:write` and commit the snapshot diff after deciding whether each new op needs a classifier rule or an allowlist entry.
- **Snapshot fixtures** (`scripts/api-coverage/fixtures/*.ops.json`) are statically imported by their provider (`snapshot: snapshotJson as SnapshotOp[]`) so the test reads them without `node:fs` in the Workers pool. They are deterministic (sorted by `METHOD path`, tab-indented, trailing newline) so git diffs are stable — no timestamps in the file.
- **Providers must not import `cloudflare:workers`** — `refresh.ts` runs in plain tsx. The classifiers they depend on (`classifySupabaseRequest`, S3 `detectOperation`, CF per-service `operations.ts`) are all pure, so this holds.
- **All three fronted upstreams are registered, each with the coverage model that fits its surface** — one uniform `CoverageProvider` interface, three different surface sources: `supabase` (live OpenAPI spec vs `classifySupabaseRequest`; 165 ops, 158 covered, 7 allowlisted), `s3` (runtime enum `S3_OPERATIONS` from `src/s3/operations.ts` vs the real `detectOperation` routing, each op carrying a representative probe; 66 ops, all covered, completeness-guarded so the enum can't grow without a probe), `cloudflare` (live CF OpenAPI filtered to the proxied sub-resources, matched against the real Hono `app.routes` of each service sub-app; 128 in-surface ops, 115 covered, 13 deliberately allowlisted). The CF provider imports the service route sub-apps purely to read `.routes` — safe because nothing under `src/cf/` imports `cloudflare:workers` (only `durable-object.ts` does, via type-only edges). The discipline that keeps this honest: only filter CF ops *under prefixes we actually proxy* into the surface — never the whole CF API — so the allowlist stays small and meaningful instead of a 99% tautology.

### Known Pitfalls

- **New proxy/API routes MUST be added to `assets.run_worker_first` in `wrangler.jsonc`.** With `assets.not_found_handling: "single-page-application"`, Cloudflare's asset layer serves the dashboard `index.html` for any path NOT in `run_worker_first` — BEFORE the worker runs. A new route that returns 401/404/JSON in tests will silently return the dashboard HTML (HTTP 200) in `wrangler dev` / prod until its prefix is whitelisted (e.g. `/supabase/v1/*`, `/supabase/v0/*`, `/supabase/metrics/*`). This is invisible to `vitest` (which calls the worker's `app.fetch` directly, bypassing the asset layer), so it only surfaces at deploy time. Symptom: route returns `<!DOCTYPE html>` instead of the expected response.
- **Breadcrumb logging on proxy decision points**: the proxy routers (`src/cf/router.ts`, `src/supabase/router.ts`) build a per-request `log` object emitted once via `console.log(JSON.stringify(log))`. Failure/decision branches set a kebab-case `log.breadcrumb` (e.g. `supabase-mgmt-authz-denied`, `supabase-mgmt-pat-not-found`, `supabase-metrics-credential-not-found`, `supabase-mgmt-unmapped`) per the Breadcrumb Logging convention — do not emit bare `error: '...'` fields without a `breadcrumb`.
- **DO NOT add module-level caching flags to `ensureTables()` in analytics modules** (`src/analytics.ts`, `src/s3/analytics.ts`). A pattern like `let tablesInitialized = false` that skips `CREATE TABLE IF NOT EXISTS` after the first call **breaks tests** because `@cloudflare/vitest-pool-workers` gives each test file its own D1 instance while sharing the module scope. The flag gets set `true` for one D1 instance, then a different test file's D1 (with no tables) silently skips initialization and all queries return 500. `CREATE TABLE IF NOT EXISTS` is a no-op metadata check in D1 — it costs microseconds and must not be "optimized" away.
