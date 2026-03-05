# V2 Plan

Four workstreams: dashboard, auth, scope expressions, and cache key purging.

---

## 1. Dashboard (Astro + shadcn + Workers Static Assets)

### Goal

Serve an analytics/admin dashboard from the same Worker using the static assets binding. Query D1 for charts, log tables, key management.

### Research findings

**Workers Static Assets** — Add `assets.directory` and `assets.binding` to `wrangler.jsonc`. The Worker code runs via `run_worker_first` for API routes; everything else falls through to static files. Pattern-based routing is supported:

```jsonc
{
  "main": "src/index.ts",
  "assets": {
    "directory": "./dashboard/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/v1/*", "/admin/*", "/health"]
  }
}
```

This means `/v1/*` (purge), `/admin/*` (API), and `/health` hit the Hono app. Everything else serves the SPA. No second Worker needed.

**Astro on Cloudflare** — Use `@astrojs/cloudflare` adapter. Generates `dist/_worker.js/index.js` (SSR entry) and `dist/` (client assets). For our case we want a static SPA (no SSR from Astro — our Hono Worker IS the server). Two options:

1. **Static output mode** (`output: 'static'` in `astro.config.mjs`) — Astro pre-renders everything to HTML/JS/CSS. We point `assets.directory` at `./dashboard/dist`. No Astro adapter needed. Dashboard fetches data from `/admin/analytics/*` endpoints via client-side JS. Simplest approach.

2. **Hybrid mode** (`output: 'hybrid'`) — Astro SSR handles some routes, static for others. Requires wiring the Astro handler into our Worker fetch. More complex, less benefit for a dashboard.

**Recommendation: static output mode.** The dashboard is a client-side SPA that calls our existing `/admin/*` API. No server rendering needed.

**shadcn/ui** — shadcn works with React, and Astro supports React islands (`@astrojs/react`). The dashboard pages would be React components using shadcn for:
- Tables (key list, event log)
- Cards (summary stats)
- Charts (recharts or chart.js wrapped in shadcn cards)
- Forms (key creation, purge actions)
- Dialogs (confirmation for revoke, purge everything)
- Badges, alerts, toasts for status

The Astro shell provides routing (`/dashboard`, `/dashboard/keys`, `/dashboard/analytics`). Each page loads a React island with shadcn components that fetch from the admin API.

### Dashboard pages

| Route | Content |
|-------|---------|
| `/dashboard` | Summary cards: total requests, cost, by-status pie chart, by-type bar chart, collapsed %. Time range selector. |
| `/dashboard/keys` | Key list table (sortable, filterable by zone/status). Create key form. Revoke button with confirmation. |
| `/dashboard/keys/:id` | Key detail: scopes, rate limits, creation/expiry dates, per-key analytics. |
| `/dashboard/analytics` | Event log table with filters (zone, key, status, purge type, time range). Pagination. CSV export. |
| `/dashboard/purge` | Manual purge form: select type (URLs/hosts/tags/prefixes/everything), enter values, submit. Shows rate limit status. |

### Implementation plan

1. Add `dashboard/` directory with Astro project (`npm create astro`)
2. Configure `output: 'static'`, add `@astrojs/react`
3. Install shadcn/ui, tailwind, configure for Astro
4. Build pages as React islands fetching from `/admin/*`
5. Add `assets` config to `wrangler.jsonc` with `run_worker_first` for API routes
6. Build step: `cd dashboard && npm run build` before `wrangler deploy`
7. Add auth to dashboard (see section 2)

### Open questions

- Do we want the dashboard behind Cloudflare Access, our own admin key auth, or both?
- Should the dashboard bundle live in the same `package.json` or be a separate workspace?
- Chart library: recharts (React-native) vs chart.js (universal)?

---

## 2. Auth: Cloudflare Access for SaaS (OAuth/OIDC)

### Goal

Replace or supplement the `X-Admin-Key` header with Cloudflare Access JWT validation. This enables SSO (Google, GitHub, SAML, etc.) for the dashboard and programmatic access via service tokens.

### Research findings

**Cloudflare Access for SaaS (OIDC)** — Access can act as an OIDC identity provider. You register the gateway as a "SaaS application" in Zero Trust, get a `client_id` and `client_secret`, and Access provides standard OIDC endpoints:

- Authorization: `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/authorization`
- Token: `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/token`
- JWKS: `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/jwks`
- UserInfo: `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/userinfo`

**Simpler approach: Access in front of the Worker** — Enable Cloudflare Access on the custom domain (`purge.erfi.io`). Access injects `Cf-Access-Jwt-Assertion` header on every request. The Worker validates the JWT using `jose` (or manual JWKS fetch + `crypto.subtle.verify`). This is the recommended pattern from Cloudflare docs.

**JWT validation in Workers** — Cloudflare's own docs show this pattern:

```typescript
import { jwtVerify, createRemoteJWKSet } from 'jose';

const token = request.headers.get('cf-access-jwt-assertion');
const JWKS = createRemoteJWKSet(
  new URL(`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`)
);
const { payload } = await jwtVerify(token, JWKS, {
  audience: env.POLICY_AUD,
  issuer: `https://<team>.cloudflareaccess.com`,
});
```

**Two auth tiers:**

| Tier | Who | How | Protects |
|------|-----|-----|----------|
| **Purge keys** (`pgw_*`) | Services, CI/CD | `Authorization: Bearer pgw_...` | `POST /v1/zones/:zoneId/purge_cache` |
| **Access JWT** | Humans via dashboard, admin tools | `Cf-Access-Jwt-Assertion` header (set by Access) or `CF_Authorization` cookie | `/admin/*`, `/dashboard/*` |
| **Admin key** (legacy) | Backward compat | `X-Admin-Key` header | `/admin/*` (falls back if no JWT) |

The purge route stays key-based (machine-to-machine). The admin/dashboard routes gain Access JWT validation. The `X-Admin-Key` remains as a fallback for CLI usage and backward compatibility.

### Implementation plan

1. Add `jose` as a dependency
2. New middleware: `src/auth-access.ts` — validates `Cf-Access-Jwt-Assertion` or `CF_Authorization` cookie
3. Admin middleware checks: Access JWT first, then falls back to `X-Admin-Key`
4. Dashboard pages include Access login redirect for unauthenticated users
5. New env vars: `CF_ACCESS_TEAM_NAME`, `CF_ACCESS_AUD` (both in wrangler secrets)
6. CLI continues using `X-Admin-Key` (no change to CLI auth flow)

### New wrangler secrets

```
CF_ACCESS_TEAM_NAME=<your-team-name>
CF_ACCESS_AUD=<application-audience-tag>
```

### Open questions

- Do we want RBAC? e.g., "viewer" can see analytics but not create/revoke keys. Access groups could map to roles.
- Should the purge route also accept Access JWTs (for the dashboard purge form)?
- Service tokens vs API keys for CI/CD — keep both or migrate?

---

## 3. Scope expression engine

### Goal

Replace the current flat scope model (`host:example.com`, `tag:blog`) with an expression-based system inspired by Cloudflare's ruleset engine. Support operators like `eq`, `contains`, `starts_with`, `matches` (regex), and `in`. Support logical combinators (`and`, `or`, `not`).

### Current model

```json
{
  "scopes": [
    {"scope_type": "host", "scope_value": "example.com"},
    {"scope_type": "tag", "scope_value": "blog"}
  ]
}
```

Each scope is a simple exact-match or prefix-match. No way to say "host ends with `.example.com`" or "tag matches regex `^v[0-9]+$`". Multiple scopes are OR'd together. No AND/NOT logic.

### Proposed model

Inspired by Cloudflare's ruleset engine but using JSON syntax (not wirefilter):

```json
{
  "scopes": [
    {
      "field": "host",
      "operator": "ends_with",
      "value": ".example.com"
    },
    {
      "field": "tag",
      "operator": "matches",
      "value": "^release-v[0-9]+$"
    },
    {
      "field": "url",
      "operator": "contains",
      "value": "/api/"
    },
    {
      "field": "header.CF-Device-Type",
      "operator": "eq",
      "value": "mobile"
    }
  ]
}
```

### Fields

Derived from the purge API request body and the `files` object format:

| Field | Source | Description |
|-------|--------|-------------|
| `host` | `hosts[]` | Hostname in a bulk host purge |
| `tag` | `tags[]` | Cache tag in a bulk tag purge |
| `prefix` | `prefixes[]` | URL prefix in a bulk prefix purge |
| `url` | `files[]` (string or `.url`) | Full URL in a single-file purge |
| `url.path` | Parsed from URL | Path component only |
| `url.query` | Parsed from URL | Full query string |
| `url.query.<param>` | Parsed from URL | Specific query parameter value |
| `header.<name>` | `files[].headers.<name>` | Custom header in file object (e.g., `CF-Device-Type`, `CF-IPCountry`, `Origin`) |
| `purge_everything` | `purge_everything` | Boolean — is this a purge-everything request? |

### Operators

| Operator | Types | Description |
|----------|-------|-------------|
| `eq` | string, bool | Exact equality (case-sensitive) |
| `ne` | string, bool | Not equal |
| `contains` | string | Substring match |
| `not_contains` | string | Substring exclusion |
| `starts_with` | string | Prefix match |
| `ends_with` | string | Suffix match |
| `matches` | string | Regex match (RE2/JS regex subset) |
| `not_matches` | string | Regex exclusion |
| `in` | string | Value is in a set: `{"operator": "in", "value": ["a", "b", "c"]}` |
| `not_in` | string | Value is not in a set |
| `wildcard` | string | Glob-style matching (`*` = any chars, case-insensitive) |

### Logical combinators

Scopes at the top level are OR'd (any scope match = allowed). For AND/NOT logic, introduce compound expressions:

```json
{
  "scopes": [
    {
      "all": [
        {"field": "host", "operator": "eq", "value": "example.com"},
        {"field": "url.path", "operator": "starts_with", "value": "/blog/"}
      ]
    },
    {
      "not": {"field": "tag", "operator": "eq", "value": "internal"}
    }
  ]
}
```

- Top-level array: OR (any match grants access)
- `all: [...]`: AND (all must match)
- `not: {...}`: Negation
- `any: [...]`: Explicit OR within a compound (same as top-level, for nesting)

### Backward compatibility

The old format (`{"scope_type": "host", "scope_value": "example.com"}`) is equivalent to `{"field": "host", "operator": "eq", "value": "example.com"}` (with `starts_with` for `prefix` and `url_prefix` types). Support both formats during a migration period. The DB schema stores the new format; a migration converts old scopes on read.

### DB schema change

Current `key_scopes` table has `(key_id, scope_type, scope_value)`. New schema:

```sql
CREATE TABLE key_scopes_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL REFERENCES api_keys(id),
  expression TEXT NOT NULL  -- JSON blob: {"field":"host","operator":"eq","value":"example.com"}
);
CREATE INDEX idx_key_scopes_v2_key ON key_scopes_v2(key_id);
```

Each row is one scope expression (or compound expression). Scopes for a key are OR'd.

### Implementation plan

1. Define `ScopeExpression` type hierarchy in `src/types.ts`
2. Write `src/scope-engine.ts` — `evaluateScope(expression, purgeBody): boolean`
3. Regex support: use JS `RegExp` with a complexity/length limit (max 256 chars, no lookbehind)
4. URL parsing: lazy `new URL()` for `url.path`, `url.query`, `url.query.<param>` fields
5. Header field access: `header.<name>` reads from `files[].headers`
6. Update `IamManager.authorize()` to use the new engine
7. Migration: convert old `key_scopes` rows to expressions on read
8. Update CLI `--scope` syntax: `--scope "host eq example.com"` or `--scope "url.path starts_with /blog/"`
9. Update admin API: accept both old and new formats in `POST /admin/keys`

### Regex safety

- Max pattern length: 256 chars
- Execution timeout: use `RegExp` with a sanity check (test against empty string first to catch catastrophic backtracking? Or just document the risk.)
- No lookbehind/lookahead (strip or reject)
- Compiled and cached per key in the DO (alongside the key cache)

---

## 4. Cache key purging (HTTP headers + query params in `files`)

### Goal

Support the full `files` object format for purging resources with custom cache keys. Currently, scope checking only looks at the `url` field. It needs to also consider the `headers` object for cache key components.

### Research findings

**Cloudflare purge-by-URL with custom cache keys** — When a resource is cached with a custom cache key (via Cache Rules), purging it requires passing the same headers in the `files` object:

```json
{
  "files": [
    {
      "url": "https://example.com/",
      "headers": {
        "CF-Device-Type": "mobile",
        "CF-IPCountry": "ES",
        "accept-language": "en-US"
      }
    }
  ]
}
```

The `headers` object in the purge request must match the headers that were part of the custom cache key. Common cache key headers:
- `CF-Device-Type` — `mobile`, `desktop`, `tablet`
- `CF-IPCountry` — two-letter country code
- `accept-language` — language preference
- `Origin` — for CORS-variant caching
- `X-Forwarded-Host`, `X-Host`, `X-Forwarded-Scheme`, `X-Original-URL`, `X-Rewrite-URL`, `Forwarded`

**Query string in URLs** — URLs in `files` can include query parameters: `https://example.com/page?v=2&lang=en`. When custom cache keys include specific query params, the purge URL must include them too. The scope engine needs to be able to match on individual query parameters.

### What changes

1. **Scope engine** (covered in section 3): The `header.<name>` field reads from `files[].headers.<name>`. The `url.query.<param>` field reads parsed query params from the URL.

2. **Scope checking**: For each file entry, extract:
   - URL string (from `files[i]` if string, or `files[i].url` if object)
   - Headers map (from `files[i].headers` if object, or empty)
   - Parsed URL components (scheme, host, path, query string, individual query params)

3. **Authorization flow**: For each file entry, ALL scope expressions must be evaluated against that entry's full context (URL + headers + parsed components). If any file entry fails scope check, the request is denied.

### Implementation plan

This is mostly handled by the scope expression engine (section 3). Additional work:

1. Parse `files[]` entries into a structured `PurgeFileContext`:
   ```typescript
   interface PurgeFileContext {
     url: string;
     parsedUrl: URL;
     headers: Record<string, string>;
   }
   ```
2. The scope engine evaluates expressions against this context
3. For bulk purge types (hosts/tags/prefixes), the context is simpler (just the value itself)
4. Update `classifyPurge` to extract file contexts
5. Tests for header-based scope matching, query param scope matching

---

## 5. Wrangler config mechanism

### Current state

Rate limit config is via `wrangler.jsonc` env vars (strings, cast to numbers in code). This works but is flat — no way to configure per-zone overrides, dashboard settings, or feature flags.

### Proposed approach

Keep env vars for simple numeric config (rate limits). Add a JSON config object for complex settings:

```jsonc
// wrangler.jsonc vars
{
  "BULK_RATE": "50",
  "BULK_BUCKET_SIZE": "500",
  // ... existing vars stay as-is

  // New: JSON config blob for complex settings
  "GATEWAY_CONFIG": "{\"dashboard\":{\"enabled\":true},\"access\":{\"required\":false}}"
}
```

Or better: use a KV namespace or D1 table for runtime config that doesn't require redeployment. But that adds complexity. For now, env vars + a JSON blob is fine.

Alternative: use `wrangler.jsonc` vars for feature flags:

```jsonc
{
  "DASHBOARD_ENABLED": "true",
  "ACCESS_REQUIRED": "false",
  "SCOPE_ENGINE_V2": "true"
}
```

**Recommendation:** Keep it simple. Env vars for toggles, wrangler secrets for credentials. No KV/D1 config store yet — that's premature until we have a real need for runtime config changes.

---

## Implementation order

These workstreams have dependencies:

```
1. Scope expression engine (section 3 + 4)
   └── No dependencies, pure logic. Do first.

2. Auth: Cloudflare Access (section 2)
   └── Independent of scopes. Can parallel with #1.

3. Dashboard (section 1)
   └── Depends on: auth (needs login), scope engine (key creation form needs to know new format)
   └── Can start UI scaffolding in parallel, wire up data after #1 and #2.
```

### Phase 1: Scope engine + cache key support
- New `ScopeExpression` types
- `scope-engine.ts` with all operators
- `PurgeFileContext` extraction
- Backward-compatible `IamManager.authorize()`
- CLI `--scope` syntax update
- Migration for existing scopes
- Tests

### Phase 2: Cloudflare Access auth
- `jose` dependency
- JWT validation middleware
- Admin route auth: JWT || admin key
- New secrets: `CF_ACCESS_TEAM_NAME`, `CF_ACCESS_AUD`
- Tests

### Phase 3: Dashboard
- Astro project in `dashboard/`
- shadcn/ui + React islands
- Summary, keys, analytics, purge pages
- Static assets config in wrangler
- Build pipeline
- Auth integration (redirect to Access login)

### Phase 4: Polish
- Config mechanism review
- D1 retention cron
- README update
- Performance testing (DO under load with regex scopes)

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Regex ReDoS in scope expressions | DO CPU spike, 1102 errors | Limit pattern length (256 chars), reject known-bad patterns, consider RE2 via wasm |
| Dashboard bundle size | Slow first load | Code split per route, lazy-load charts, precompress with brotli |
| Access JWT validation latency | +10-50ms per admin request | Cache JWKS (it rarely changes), use `jose` which handles this |
| Scope migration breaks existing keys | Auth failures for existing services | Dual-read: try v2 format first, fall back to v1. Never delete old table until confirmed. |
| Static assets + Worker in same deploy | Build complexity | Separate build scripts, CI runs `dashboard build` then `wrangler deploy` |

---

## Files to change/add

### New files
- `src/scope-engine.ts` — expression evaluator
- `src/auth-access.ts` — Access JWT validation
- `dashboard/` — entire Astro project (astro.config.mjs, src/pages/*, src/components/*)

### Modified files
- `wrangler.jsonc` — add `assets` config, new secrets
- `src/types.ts` — `ScopeExpression`, `PurgeFileContext`, compound types
- `src/iam.ts` — `authorize()` uses scope engine, `key_scopes_v2` table
- `src/index.ts` — admin middleware accepts JWT, `classifyPurge` extracts file context
- `cli/ui.ts` — new scope syntax parsing
- `cli/commands/keys.ts` — new `--scope` format
- `package.json` — add `jose`, dashboard workspace
- `README.md` — document everything
