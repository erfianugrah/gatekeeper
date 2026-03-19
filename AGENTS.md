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
| `npx playwright test`                                    | Run Playwright E2E tests (needs wrangler dev)      |
| `npx playwright test e2e/purge-profiles.spec.ts`         | Run a single E2E test file                         |

Run `wrangler types` after changing bindings in wrangler.jsonc.

### Test architecture

There are three test layers:

- **worker** (`vitest.worker.config.ts`): Uses `@cloudflare/vitest-pool-workers` to run `test/**/*.test.ts` in the Workers runtime. Tests use `SELF.fetch()` and Durable Object stubs.
- **cli** (`vitest.cli.config.ts`): Runs `cli/**/*.test.ts` in plain Node.js.
- **e2e** (`playwright.config.ts`): Playwright browser tests in `e2e/**/*.spec.ts`. Runs against `http://localhost:8787` (start `npx wrangler dev` first). Tests dashboard UI interactions: purge profiles, pill inputs, condition editor, form validation.

When running a single worker test file, you do NOT need `-c vitest.worker.config.ts` because the default config includes both projects. For CLI tests, you DO need `-c vitest.cli.config.ts` or run via `npm run test:cli`.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

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

### Known Pitfalls

- **DO NOT add module-level caching flags to `ensureTables()` in analytics modules** (`src/analytics.ts`, `src/s3/analytics.ts`). A pattern like `let tablesInitialized = false` that skips `CREATE TABLE IF NOT EXISTS` after the first call **breaks tests** because `@cloudflare/vitest-pool-workers` gives each test file its own D1 instance while sharing the module scope. The flag gets set `true` for one D1 instance, then a different test file's D1 (with no tables) silently skips initialization and all queries return 500. `CREATE TABLE IF NOT EXISTS` is a no-op metadata check in D1 — it costs microseconds and must not be "optimized" away.
