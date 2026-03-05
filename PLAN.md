# V2 Plan — API Gateway + IAM

The project is evolving from a Cloudflare cache purge proxy into a **general-purpose API gateway with its own IAM system**. Purge is the first service it fronts. The IAM layer — identity, keys, policies, authorization — is designed to be service-agnostic so it can later front R2, KV, or any Cloudflare (or AWS) service.

## Architecture overview

```
                          ┌─────────────────────────────────────┐
                          │          Cloudflare Access           │
                          │  (identity layer — who are you?)     │
                          │  Self-hosted app on purge.erfi.io    │
                          │  Gates: /admin/*, /dashboard/*       │
                          └──────────────┬──────────────────────┘
                                         │ Cf-Access-Jwt-Assertion
                                         ▼
┌──────────┐  Authorization: Bearer gw_xxx  ┌──────────────────────────────────┐
│  Client   │ ─────────────────────────────▶│         API Gateway Worker        │
│ (CI/CD,   │                               │                                  │
│  service) │                               │  ┌────────────┐  ┌────────────┐  │
└──────────┘                                │  │  Identity   │  │    IAM     │  │
                                            │  │  (Access    │  │  (policy   │  │
┌──────────┐  Cf-Access-Jwt-Assertion       │  │   JWT)      │  │  engine)   │  │
│  Human    │ ─────────────────────────────▶│  └──────┬─────┘  └──────┬─────┘  │
│ (browser, │                               │         │               │        │
│  dashboard│                               │         ▼               ▼        │
└──────────┘                                │  ┌──────────────────────────┐    │
                                            │  │     Service handlers     │    │
                                            │  │  ┌─────────┐ ┌────────┐ │    │
                                            │  │  │  Purge   │ │  R2    │ │    │
                                            │  │  │  (v1)    │ │ (future│ │    │
                                            │  │  └─────────┘ └────────┘ │    │
                                            │  └──────────────────────────┘    │
                                            └──────────────────────────────────┘
```

**Two separate concerns:**

1. **Identity** (Cloudflare Access) — authenticates humans via SSO. Injects JWT with email/sub. The gateway validates the JWT. This is the "who are you?" layer.

2. **Authorization** (our IAM) — evaluates whether a principal (API key or authenticated user) is allowed to perform an action on a resource, given conditions. This is the "what can you do?" layer. It uses AWS IAM-style policy documents.

These are deliberately decoupled. Access handles identity. Our IAM handles authorization. A machine client with an API key skips Access entirely — it authenticates via the key and is authorized via the key's attached policy. A human authenticates via Access and gets implicit admin authorization (for now; RBAC can layer on later).

---

## 1. Identity: Cloudflare Access

### Goal

Authenticate humans (dashboard users, admin tool operators) via Cloudflare Access. Extract identity (email, user ID) for audit trails and key attribution.

### How it works

Access is configured as a **self-hosted application** on `purge.erfi.io`. It gates `/admin/*` and `/dashboard/*`. When a browser hits these paths, Access redirects to the configured IdP (Google, GitHub, SAML, OTP, etc.). After login, Access injects:

- `Cf-Access-Jwt-Assertion` header — signed JWT on every proxied request
- `CF_Authorization` cookie — same JWT, for browser-initiated requests

The Worker validates whichever is present:

```typescript
// ~60 lines, no dependencies — crypto.subtle handles RSA-PKCS1-v1_5 natively
const token = request.headers.get('Cf-Access-Jwt-Assertion')
  ?? getCookie(request, 'CF_Authorization');

const resp = await fetch(`https://${env.CF_ACCESS_TEAM_NAME}.cloudflareaccess.com/cdn-cgi/access/certs`);
const { keys } = await resp.json();

const jwt = parseJWT(token);
const jwk = keys.find(k => k.kid === jwt.header.kid);
const key = await crypto.subtle.importKey('jwk', jwk,
  { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);

const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
  base64urlDecode(jwt.signature), new TextEncoder().encode(jwt.data));
// + check exp, iss, aud
```

JWT claims: `sub`, `email`, `iss`, `aud`, `exp`, `iat`, `type` (`app` for users, `service-token` for service tokens).

### Access application setup

1. Cloudflare One → Access → Applications → Add → Self-hosted
2. Domain: `purge.erfi.io`
3. Paths: `/admin/*`, `/dashboard/*` (leave `/v1/*` and `/health` unprotected)
4. Policy: Allow → emails/groups you control
5. Copy the **Application Audience (AUD) tag**

### Auth tiers

| Tier | Principal | Mechanism | Routes |
|------|-----------|-----------|--------|
| **API key** (`gw_*`) | Services, CI/CD | `Authorization: Bearer gw_...` | `/v1/*` (purge), future service routes |
| **Access JWT** | Humans (dashboard) | `Cf-Access-Jwt-Assertion` / `CF_Authorization` cookie | `/admin/*`, `/dashboard/*` |
| **Admin key** (legacy) | CLI, backward compat | `X-Admin-Key` header | `/admin/*` (fallback when Access not configured) |

### Wrangler secrets

```
CF_ACCESS_TEAM_NAME=<your-team-name>
CF_ACCESS_AUD=<application-audience-tag>
```

### Decisions

- **No `jose`.** `crypto.subtle` does RSA verification natively. ~60 lines vs ~50KB dependency.
- **No `workers-oauth-provider`.** We don't need to be an OAuth provider. We're a resource server that validates Access JWTs for identity, and uses our own IAM for authorization. The `workers-oauth-provider` library is for when third-party clients need to do OAuth with your server (MCP servers, API-as-a-service). If we need that later, it's additive — doesn't affect the IAM design.
- **Self-hosted Access app, not SaaS.** SaaS apps are for when Access acts as an OIDC IdP to external services. Self-hosted is for protecting your own origin.
- **JWKS cache.** In-memory, 1-hour TTL. Access key rotation is infrequent.

---

## 2. IAM: Policies, keys, and authorization

This is the core of v2. The current flat scope model (`host:example.com`, `tag:blog`) becomes a proper policy-based IAM system inspired by AWS IAM.

### Concepts

| Concept | AWS IAM equivalent | Our system |
|---------|-------------------|------------|
| **Principal** | IAM user / role | API key holder (key ID) or Access-authenticated user (email) |
| **Action** | `s3:GetObject` | `purge:url`, `purge:host`, `purge:tag`, `admin:keys:create`, `r2:GetObject` |
| **Resource** | `arn:aws:s3:::bucket/*` | `zone:<zone-id>`, `bucket:<name>` (future) |
| **Condition** | `StringLike`, `IpAddress` | Expression engine: `eq`, `contains`, `starts_with`, `matches`, etc. |
| **Effect** | Allow / Deny | Allow only (deny-by-default). Explicit deny can be added later. |
| **Policy** | IAM policy document | JSON document with statements, attached to API keys |

### Policy document schema

```json
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow",
      "actions": ["purge:url", "purge:host", "purge:tag"],
      "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"],
      "conditions": [
        { "field": "host", "operator": "ends_with", "value": ".example.com" }
      ]
    }
  ]
}
```

A key can have one policy document. The policy has one or more statements. A request is allowed if **any** statement allows it (OR across statements). Within a statement, **all** of the following must be true (AND):

1. The requested **action** matches one of the statement's actions
2. The targeted **resource** matches one of the statement's resources
3. **All** conditions evaluate to true against the request context

### Actions

Namespaced by service. Wildcard suffix supported (`purge:*` matches all purge actions).

**Purge service (v1):**

| Action | Description |
|--------|-------------|
| `purge:url` | Purge by URL(s) via `files[]` |
| `purge:host` | Purge by hostname(s) via `hosts[]` |
| `purge:tag` | Purge by cache tag(s) via `tags[]` |
| `purge:prefix` | Purge by URL prefix(es) via `prefixes[]` |
| `purge:everything` | Purge everything in a zone |
| `purge:*` | All purge actions |

**Admin service:**

| Action | Description |
|--------|-------------|
| `admin:keys:create` | Create API keys |
| `admin:keys:list` | List API keys |
| `admin:keys:revoke` | Revoke API keys |
| `admin:keys:read` | Read key details |
| `admin:analytics:read` | Read analytics data |
| `admin:*` | All admin actions |

**Future (R2 example):**

| Action | Description |
|--------|-------------|
| `r2:GetObject` | Read objects |
| `r2:PutObject` | Write objects |
| `r2:DeleteObject` | Delete objects |
| `r2:ListBucket` | List bucket contents |
| `r2:*` | All R2 actions |

### Resources

Typed identifiers with optional wildcards.

| Pattern | Matches |
|---------|---------|
| `zone:aaaa1111...` | Specific zone |
| `zone:*` | All zones |
| `bucket:my-assets` | Specific R2 bucket |
| `bucket:staging-*` | Buckets matching prefix |
| `*` | Everything (dangerous — use sparingly) |

Matching rules:
- Exact: `zone:abc` matches `zone:abc`
- Wildcard suffix: `zone:*` matches any zone, `bucket:prod-*` matches `bucket:prod-images`
- Universal: `*` matches any resource

### Conditions (expression engine)

Conditions are the fine-grained part. They evaluate against the **request context** — a flat key-value map extracted from the incoming request. The keys in this map are service-specific.

#### Operators

| Operator | Types | Description |
|----------|-------|-------------|
| `eq` | string, bool | Exact equality (case-sensitive) |
| `ne` | string, bool | Not equal |
| `contains` | string | Substring match |
| `not_contains` | string | Substring exclusion |
| `starts_with` | string | Prefix match |
| `ends_with` | string | Suffix match |
| `matches` | string | Regex match (JS RegExp, length-limited) |
| `not_matches` | string | Regex exclusion |
| `in` | string | Value is in a set: `{"value": ["a", "b", "c"]}` |
| `not_in` | string | Value is not in a set |
| `wildcard` | string | Glob-style (`*` = any chars, case-insensitive) |
| `exists` | any | Field is present (non-null) in request context |
| `not_exists` | any | Field is absent |

#### Compound conditions

Within a single statement, conditions are AND'd (all must match). For OR logic within conditions, use multiple statements. For complex logic, compound wrappers:

```json
{
  "conditions": [
    {
      "any": [
        { "field": "host", "operator": "eq", "value": "a.example.com" },
        { "field": "host", "operator": "eq", "value": "b.example.com" }
      ]
    },
    { "field": "url.path", "operator": "starts_with", "value": "/api/" }
  ]
}
```

- Top-level conditions array: AND (all must match)
- `any: [...]`: OR (any must match)
- `all: [...]`: AND (explicit, for nesting)
- `not: {...}`: Negation of a single condition

Most policies won't need compound conditions. Multiple statements with different conditions handle most OR cases naturally.

#### Request context fields (per service)

**Purge service:**

| Field | Source | Description |
|-------|--------|-------------|
| `host` | `hosts[]` item | Hostname in a bulk host purge |
| `tag` | `tags[]` item | Cache tag in a bulk tag purge |
| `prefix` | `prefixes[]` item | URL prefix in a bulk prefix purge |
| `url` | `files[]` item (string or `.url`) | Full URL |
| `url.path` | Parsed from URL | Path component |
| `url.query` | Parsed from URL | Full query string |
| `url.query.<param>` | Parsed from URL | Specific query parameter |
| `header.<name>` | `files[].headers.<name>` | Custom cache key header (e.g., `header.CF-Device-Type`) |
| `purge_everything` | `purge_everything` field | Boolean — is this purge-everything? |

**Future R2 service (example):**

| Field | Source | Description |
|-------|--------|-------------|
| `key` | Object key | Full object key |
| `key.prefix` | Parsed from key | Key prefix (up to last `/`) |
| `key.extension` | Parsed from key | File extension |
| `content-type` | Request header | MIME type |

The expression engine is **service-agnostic** — it evaluates conditions against a `Record<string, string | boolean | string[]>`. Each service handler is responsible for building the request context from the incoming request.

### API key schema

Replace the current two-table design (`api_keys` + `key_scopes`) with a single table where the policy is a JSON column:

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,                    -- random ID (e.g., key_xxxxxxxxxxxx)
  key_hash TEXT NOT NULL UNIQUE,          -- HMAC-SHA256 hash of the key
  name TEXT NOT NULL,                     -- human-readable label
  policy TEXT NOT NULL,                   -- JSON policy document
  created_by TEXT,                        -- email from Access JWT (null if created via admin key)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,                        -- optional expiration
  revoked_at TEXT,                        -- null if active
  rate_limit INTEGER                      -- per-key rate limit override (req/sec), null = use default
);
```

The `key_scopes` table is kept during migration but no longer written to. Old scopes are auto-converted to policy documents on read.

### Key prefix change

Currently `pgw_*` (purge gateway). Since this is now a general-purpose gateway, the prefix should be `gw_*`. Both prefixes are accepted during migration. New keys are issued with `gw_*`.

### Authorization flow

```
Request arrives
  │
  ├── /v1/zones/:zoneId/purge_cache
  │     │
  │     ├── Extract key from Authorization header
  │     ├── Look up key → get policy document
  │     ├── Determine action from request body (purge:url, purge:host, etc.)
  │     ├── Determine resource: zone:<zoneId>
  │     ├── Build request context (host, tag, url, headers, etc.)
  │     ├── Evaluate policy: any statement allows (action + resource + conditions)?
  │     │     ├── Yes → proceed to rate limiting → upstream
  │     │     └── No  → 403 Forbidden
  │     └── Log: key_id, action, resource, allowed/denied, created_by
  │
  ├── /admin/*
  │     │
  │     ├── Check Access JWT first
  │     │     ├── Valid → extract email, full admin access (for now)
  │     │     └── No JWT → check X-Admin-Key → full admin access
  │     └── Neither → 401
  │
  └── /dashboard/*
        └── Access JWT required (Access handles redirect to login)
```

### Policy examples

**Minimal — purge everything on one zone:**
```json
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow",
      "actions": ["purge:*"],
      "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
    }
  ]
}
```

**Scoped — only purge specific hosts by URL or tag:**
```json
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow",
      "actions": ["purge:url", "purge:tag"],
      "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"],
      "conditions": [
        {
          "any": [
            { "field": "host", "operator": "eq", "value": "cdn.example.com" },
            { "field": "host", "operator": "eq", "value": "static.example.com" }
          ]
        }
      ]
    }
  ]
}
```

**Multi-zone with host restriction:**
```json
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow",
      "actions": ["purge:url", "purge:host"],
      "resources": ["zone:*"],
      "conditions": [
        { "field": "host", "operator": "ends_with", "value": ".example.com" }
      ]
    }
  ]
}
```

**CI/CD key — purge tags matching release pattern:**
```json
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow",
      "actions": ["purge:tag"],
      "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"],
      "conditions": [
        { "field": "tag", "operator": "matches", "value": "^release-v[0-9]+\\.[0-9]+$" }
      ]
    }
  ]
}
```

**Future R2 — read-only access to a bucket prefix:**
```json
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow",
      "actions": ["r2:GetObject", "r2:ListBucket"],
      "resources": ["bucket:my-assets"],
      "conditions": [
        { "field": "key", "operator": "starts_with", "value": "public/" }
      ]
    }
  ]
}
```

### Backward compatibility

The v1 scope format maps to v2 policies:

| v1 scope | v2 policy statement |
|----------|-------------------|
| `{"scope_type": "host", "scope_value": "example.com"}` | `{"actions": ["purge:*"], "resources": ["zone:*"], "conditions": [{"field": "host", "operator": "eq", "value": "example.com"}]}` |
| `{"scope_type": "tag", "scope_value": "blog"}` | `{"actions": ["purge:*"], "resources": ["zone:*"], "conditions": [{"field": "tag", "operator": "eq", "value": "blog"}]}` |
| `{"scope_type": "prefix", "scope_value": "https://example.com/api/"}` | `{"actions": ["purge:*"], "resources": ["zone:*"], "conditions": [{"field": "prefix", "operator": "starts_with", "value": "https://example.com/api/"}]}` |
| No scopes (unrestricted) | `{"actions": ["purge:*"], "resources": ["zone:*"]}` (no conditions) |

Migration: on key read, if `policy` column is null, read from `key_scopes` table, convert, and backfill `policy` column. Once all keys are migrated, drop `key_scopes`.

### Regex safety

- Max pattern length: 256 characters
- Reject patterns with known catastrophic backtracking constructs (nested quantifiers: `(a+)+`, `(a*)*`)
- Compile with `new RegExp()` — catch syntax errors at key creation time, not at request time
- Cache compiled regexes per key in the DO (alongside the key cache, same 60s TTL)
- No lookbehind/lookahead (reject at validation)

---

## 3. Cache key purging (headers + query params in `files`)

### Goal

Support the full `files` object format for purging resources with custom cache keys. The policy condition engine needs to evaluate against headers and parsed URL components, not just the raw URL string.

### Background

Cloudflare purge-by-URL with custom cache keys requires passing headers in the `files` object:

```json
{
  "files": [
    {
      "url": "https://example.com/",
      "headers": {
        "CF-Device-Type": "mobile",
        "CF-IPCountry": "ES"
      }
    }
  ]
}
```

Common cache key headers: `CF-Device-Type`, `CF-IPCountry`, `accept-language`, `Origin`.

### Request context extraction

For each item in the purge request, the purge service handler builds a request context:

```typescript
interface PurgeRequestContext {
  // Action determined from body shape
  action: 'purge:url' | 'purge:host' | 'purge:tag' | 'purge:prefix' | 'purge:everything';

  // Resource is always the zone
  resource: string; // 'zone:<zone-id>'

  // Fields for condition evaluation
  fields: Record<string, string | boolean>;
  // Populated fields depend on purge type:
  // - purge:url → host, url, url.path, url.query, url.query.<param>, header.<name>
  // - purge:host → host
  // - purge:tag → tag
  // - purge:prefix → prefix
  // - purge:everything → purge_everything: true
}
```

For `files[]` with multiple entries, each entry is evaluated independently. If **any** entry fails the policy check, the entire request is denied (a key shouldn't be able to sneak in unauthorized URLs alongside authorized ones).

For bulk types (`hosts[]`, `tags[]`, `prefixes[]`), each value in the array is evaluated as a separate context.

### Changes from v1

1. `classifyPurge` returns structured contexts, not just the purge type
2. `IamManager.authorize()` takes an array of request contexts, evaluates the key's policy against each
3. URL parsing is lazy — only done if the policy has `url.path`, `url.query.*`, or `header.*` conditions

---

## 4. Dashboard (Astro + shadcn + Workers Static Assets)

### Goal

Serve an analytics/admin dashboard from the same Worker. Query D1 for charts, log tables, key management.

### Technical approach

**Workers Static Assets** with `run_worker_first` for API routes:

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

`/v1/*`, `/admin/*`, `/health` hit the Hono Worker. Everything else serves the SPA.

**Astro static output mode** — no SSR, no adapter. Astro pre-renders to HTML/JS/CSS. The dashboard is a client-side SPA with React islands fetching from `/admin/*`.

**shadcn/ui** via `@astrojs/react` — tables, cards, charts, forms, dialogs.

### Pages

| Route | Content |
|-------|---------|
| `/dashboard` | Summary cards: total requests, by-status chart, by-type chart, collapsed %. Time range selector. |
| `/dashboard/keys` | Key list table (filterable by zone/status). Create key form with policy builder. Revoke with confirmation. |
| `/dashboard/keys/:id` | Key detail: policy document (rendered), rate limits, created_by, per-key analytics. |
| `/dashboard/analytics` | Event log table with filters (zone, key, status, action, time range). Pagination. CSV export. |
| `/dashboard/purge` | Manual purge form: select type, enter values, submit. Shows rate limit status. |

### Key creation flow in dashboard

The "create key" form in the dashboard needs a **policy builder UI**:

1. Add statements (action checkboxes, resource input, condition builder)
2. Condition builder: pick field → pick operator → enter value. Add more conditions.
3. Preview the generated policy JSON
4. Submit → `POST /admin/keys` with the policy document
5. The key is created with `created_by` set to the logged-in user's email (from Access JWT)

### Open questions

- Dashboard bundle in same `package.json` or separate workspace?
- Chart library: recharts vs chart.js?

---

## 5. Wrangler config

### Current state

Rate limit config via `wrangler.jsonc` env vars (strings, cast to numbers in code). Works fine for simple numeric config.

### Approach

Keep it simple. Env vars for numeric config and feature flags. Wrangler secrets for credentials. No KV/D1 config store.

```jsonc
{
  "BULK_RATE": "50",
  "BULK_BUCKET_SIZE": "500",
  "DASHBOARD_ENABLED": "true",
  "ACCESS_REQUIRED": "false"
}
```

---

## Implementation order

```
Phase 1: IAM policy engine + cache key support
   └── Core of v2. No external dependencies. Pure logic + DB migration.

Phase 2: Cloudflare Access identity
   └── Independent of policy engine. Can parallel with Phase 1.

Phase 3: Dashboard
   └── Depends on: identity (login), policy engine (key creation form)
   └── UI scaffolding can start in parallel.

Phase 4: Polish + future services
   └── Config review, D1 retention cron, README, performance testing.
   └── R2 service handler (when ready).
```

### Phase 1: IAM policy engine + cache key support

**New files:**
- `src/policy-engine.ts` — condition evaluator (operators, compound logic, field resolution)
- `src/policy-types.ts` — `PolicyDocument`, `Statement`, `Condition`, `RequestContext` types

**Modified files:**
- `src/types.ts` — action/resource types, key schema with `policy` and `created_by`
- `src/iam.ts` — `authorize()` takes `RequestContext[]`, evaluates policy. Key creation accepts policy document. Migration from `key_scopes` to `policy` column.
- `src/index.ts` — `classifyPurge` returns `RequestContext[]`. Purge route passes contexts to `authorize()`.
- `cli/commands/keys.ts` — new `--policy` flag (JSON) or `--action`/`--resource`/`--condition` flags for simple policies
- `cli/ui.ts` — policy rendering

**Tests:**
- `test/policy-engine.test.ts` — all operators, compound conditions, edge cases
- Update `test/iam.test.ts` — policy-based authorization, migration from v1 scopes
- Update `test/integration.test.ts` — end-to-end with policy-based keys, cache key headers

**Key prefix migration:** Accept both `pgw_*` and `gw_*`. New keys issued as `gw_*`.

### Phase 2: Cloudflare Access identity

**New files:**
- `src/auth-access.ts` — JWT parsing, JWKS fetch + in-memory cache, signature verification, claims extraction

**Modified files:**
- `src/index.ts` — admin middleware: Access JWT → `X-Admin-Key` fallback → 401
- `src/iam.ts` — key creation stores `created_by` from Access JWT email
- `src/env.d.ts` — `CF_ACCESS_TEAM_NAME`, `CF_ACCESS_AUD` secrets

**Tests:**
- `test/auth-access.test.ts` — JWT validation with mock keys, expiry, bad signatures, JWKS caching

### Phase 3: Dashboard

- Astro project in `dashboard/`
- shadcn/ui + React islands
- Policy builder UI for key creation
- Summary, keys, analytics, purge pages
- Static assets config in wrangler
- Build pipeline: `cd dashboard && npm run build` → `wrangler deploy`
- Auth: Access handles login redirect, Worker validates JWT for API calls

### Phase 4: Polish + extensibility

- Config mechanism review
- D1 retention cron job
- README rewrite (it's a gateway now, not just a purge proxy)
- Performance testing (DO under load with regex conditions)
- Design doc for next service (R2 proxy? KV proxy?)

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Regex ReDoS in conditions | DO CPU spike, 1102 errors | Max 256 chars, reject nested quantifiers, validate at key creation |
| Policy evaluation overhead | Latency on every request | Cache compiled conditions per key. Short-circuit: no conditions = instant allow. |
| Dashboard bundle size | Slow first load | Code split per route, lazy-load charts, precompress with brotli |
| Access JWT validation latency | +10-50ms per admin request | Cache JWKS in-memory (1h TTL), `crypto.subtle.verify` is fast |
| v1 scope migration breaks keys | Auth failures for existing services | Dual-read: try policy column first, fall back to key_scopes. Never delete old table until confirmed. |
| Policy schema too rigid for future services | Refactoring later | Version field in policy doc. Engine dispatches on version. |
| Static assets + Worker in same deploy | Build complexity | Separate build scripts, CI runs dashboard build then wrangler deploy |

---

## Files to change/add

### New files
- `src/policy-engine.ts` — condition evaluator (operators, compound logic)
- `src/policy-types.ts` — policy document, statement, condition, request context types
- `src/auth-access.ts` — Access JWT validation
- `dashboard/` — entire Astro project

### Modified files
- `wrangler.jsonc` — add `assets` config, declare new secrets
- `src/types.ts` — action/resource enums, updated key interface
- `src/iam.ts` — policy-based authorize(), key creation with policy + created_by, v1 migration
- `src/index.ts` — admin auth middleware (JWT + admin key), classifyPurge returns RequestContext[]
- `src/analytics.ts` — log created_by, action, resource in events
- `cli/commands/keys.ts` — policy flags, display policy in key detail
- `cli/ui.ts` — policy rendering, action/resource formatting
- `package.json` — dashboard workspace (no new runtime deps)
- `README.md` — full rewrite for gateway + IAM framing
