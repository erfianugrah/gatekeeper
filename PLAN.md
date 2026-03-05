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

### Key prefix

`gw_*` (gateway). The old `pgw_*` prefix is no longer supported — all code referencing it has been removed.

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

### V1 scope system (removed)

The v1 scope system (`key_scopes` table, `KeyScope` type, `ScopeType` enum, `migrateV1Scopes()`, v1 RPC methods) has been completely removed. The project is not in production use yet, so no backward compatibility is needed. All keys now require a `policy: PolicyDocument` at creation time. The `key_scopes` table no longer exists.

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

## 4. OpenAPI specification

### Goal

Provide a machine-readable API contract (OpenAPI 3.1) that documents every gateway endpoint, its auth requirements, request/response schemas, and error envelopes. This spec is the source of truth for the dashboard, CLI, and any external consumers.

### Endpoints to document

| Method | Path | Auth | Summary |
|--------|------|------|---------|
| `GET` | `/health` | None | Health check |
| `POST` | `/v1/zones/{zoneId}/purge_cache` | API key (`Authorization: Bearer gw_...`) | Purge cache (proxied to Cloudflare) |
| `POST` | `/admin/keys` | Access JWT or `X-Admin-Key` | Create API key with policy |
| `GET` | `/admin/keys` | Access JWT or `X-Admin-Key` | List API keys for a zone |
| `GET` | `/admin/keys/{id}` | Access JWT or `X-Admin-Key` | Get API key details |
| `DELETE` | `/admin/keys/{id}` | Access JWT or `X-Admin-Key` | Revoke API key |
| `GET` | `/admin/analytics/events` | Access JWT or `X-Admin-Key` | Query purge event logs |
| `GET` | `/admin/analytics/summary` | Access JWT or `X-Admin-Key` | Aggregated analytics |

### Shared schemas

- **`PolicyDocument`** — `version`, `statements[]`
- **`Statement`** — `effect`, `actions[]`, `resources[]`, `conditions[]?`
- **`Condition`** — `field`, `operator`, `value` (plus compound: `any`, `all`, `not`)
- **`ApiKey`** — `id`, `name`, `zone_id`, `policy`, `created_at`, `expires_at`, `revoked`, `created_by`, rate limit fields
- **`CreateKeyRequest`** — `name`, `zone_id`, `policy`, `expires_in_days?`, `rate_limit?`
- **`PurgeBody`** — `files?`, `hosts?`, `tags?`, `prefixes?`, `purge_everything?`
- **`ErrorEnvelope`** — `{ success: false, errors: [{ code, message }] }`
- **`SuccessEnvelope<T>`** — `{ success: true, result: T }`

### Security schemes

- `ApiKeyAuth` — `http` bearer scheme (`gw_` prefixed keys), used on purge routes
- `AdminKeyAuth` — `apiKey` in `X-Admin-Key` header, used on admin routes
- `CloudflareAccess` — `apiKey` in `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie), used on admin routes

### Serving

- Static file at `/openapi.yaml` (served via Workers Static Assets or a dedicated route)
- Optionally: `GET /admin/openapi` returning the spec as JSON for programmatic access

### Decisions

- **OpenAPI 3.1** (not 3.0) — supports JSON Schema 2020-12 natively, `null` types, `const`
- **Single file** (`openapi.yaml`) — the API surface is small enough; no need for multi-file `$ref` splitting
- **Hand-written, not generated** — keeps the spec readable and intentional. Hono doesn't have a built-in OpenAPI generator worth using for this project size.
- **Spec-first for the dashboard** — the Astro dashboard should consume the spec for type generation or at minimum reference it for API shapes

---

## 5. Dashboard (Astro + shadcn + Workers Static Assets)

### Goal

Serve an analytics/admin dashboard from the same Worker. Query D1 for charts, log tables, key management.

### Design direction

Inspired by the layout and component patterns of **gloryhole** (HTMX surveillance-terminal dashboard) and **caddy-compose/waf-dashboard** (Astro + React + shadcn), but with the **Lovelace** color scheme from iTerm2 instead of the green neon aesthetic.

#### Lovelace palette

Deep charcoal base with warm pastel-neon accents — softer than pure neon, more readable for extended use.

| Token | Hex | Usage |
|-------|-----|-------|
| `--background` | `#1d1f28` | Page background |
| `--surface` | `#282a36` | Card/panel backgrounds |
| `--surface-elevated` | `#414457` | Elevated surfaces, hover states |
| `--border` | `#414457` | Borders, dividers |
| `--foreground` | `#fcfcfc` | Primary text |
| `--muted` | `#bdbdc1` | Secondary text, labels |
| `--primary` | `#c574dd` | Primary accent (Lovelace magenta-purple) — buttons, active nav, cursor |
| `--primary-dim` | `#af43d1` | Brighter purple for emphasis |
| `--success` | `#5adecd` | Green — allowed, cached, healthy |
| `--success-bright` | `#17e2c7` | Bright teal for highlights |
| `--danger` | `#f37e96` | Soft red-pink — blocked, errors |
| `--danger-bright` | `#ff4870` | Hot pink for critical alerts |
| `--warning` | `#f1a171` | Warm peach — warnings, rate-limited |
| `--warning-bright` | `#ff8037` | Bright orange for emphasis |
| `--info` | `#8796f4` | Periwinkle blue — informational, links |
| `--info-bright` | `#546eff` | Bright blue for active filters |
| `--cyan` | `#79e6f3` | Cyan — secondary data accent |
| `--cyan-bright` | `#3edced` | Bright cyan for sparklines |
| `--selection` | `#c1ddff` | Selection highlight |

Chart slots: `#c574dd`, `#5adecd`, `#f37e96`, `#f1a171`, `#8796f4`

#### Typography

| Role | Font |
|------|------|
| Body text | **Space Grotesk** (geometric sans-serif) |
| Data, code, stat values, table cells | **JetBrains Mono** (monospace) |

Same approach as gloryhole — monospace for anything data-oriented, sans-serif for prose/labels.

#### Layout

Fixed sidebar + header shell, same pattern as both reference projects:

```
+--[SIDEBAR w-60]---+--[HEADER h-14]--------------------+
| Shield logo       | Page title     Status dot (pulse)  |
| + "PURGE CTL"     +------------------------------------+
| ─────────────     |                                    |
| Overview          | MAIN CONTENT (scrollable, p-6)     |
| Keys              |                                    |
| Analytics         |                                    |
| Purge             |                                    |
| Settings          |                                    |
| ─────────────     |                                    |
| version footer    | Scroll-to-top FAB (bottom-right)   |
+-------------------+------------------------------------+
```

- Sidebar: `navy-950` equivalent (`#1d1f28`), active nav item highlighted with `primary/10` bg + `primary` text
- Header: semi-transparent with backdrop blur, pulsing status dot
- Mobile: hamburger toggle, sidebar as overlay
- Content: responsive max-width container

#### Visual effects

- **Subtle glow** on primary accent elements (purple glow instead of green)
- **No scanlines/CRT effect** — keep it clean
- **Fade-in-up** entrance animations on stat cards
- **Count-up** animation for stat numbers
- **Custom scrollbar** — thin, purple thumb on hover
- **Button micro-interactions** — `active:scale-[0.97]` press effect

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

**Astro 5 static output mode** — no SSR, no adapter. Astro pre-renders to HTML/JS/CSS. The dashboard is a client-side SPA with React islands fetching from `/admin/*`.

**Stack:** Astro 5 + React 19 + Tailwind CSS 4 + shadcn/ui + Recharts. Same stack as caddy-compose/waf-dashboard (proven to work well for this pattern).

**Separate workspace** — `dashboard/` has its own `package.json`. Build pipeline: `cd dashboard && npm run build` → output to `dashboard/dist/` → `wrangler deploy` picks it up via assets config.

### Pages

| Route | Content |
|-------|---------|
| `/dashboard` | Summary stat cards (total requests, by-status, collapsed %, avg latency). Traffic timeline chart (Recharts area). Purge type distribution (donut). Top zones bar chart. Recent events feed. Time range selector. |
| `/dashboard/keys` | Key list table (filterable by zone/status, sortable). Create key dialog with policy builder. Revoke with confirmation dialog. |
| `/dashboard/keys/:id` | Key detail: policy document (syntax-highlighted JSON), rate limit config, created_by, per-key analytics charts. |
| `/dashboard/analytics` | Event log table with filter bar (zone, key, status, action, time range). Expandable rows with detail panels. Pagination. CSV export. |
| `/dashboard/purge` | Manual purge form: select type (URL/host/tag/prefix/everything), enter values, zone picker, submit. Live rate limit status display. |

### Key creation flow in dashboard

The "create key" form needs a **policy builder UI** (similar to caddy-compose's condition builder):

1. Add statements (action checkboxes, resource input, condition builder)
2. Condition builder: pick field → pick operator → enter value. Add/remove conditions.
3. Preview the generated policy JSON (syntax-highlighted, read-only)
4. Submit → `POST /admin/keys` with the policy document
5. Key created with `created_by` from Access JWT email
6. Show the secret key **once** in a copy-to-clipboard dialog

### Key components to build

| Component | Purpose |
|-----------|---------|
| `DashboardLayout` | Astro layout: sidebar, header, slot for content |
| `Sidebar` | Nav links with icons, active state, mobile toggle |
| `StatCard` | Metric card with label, value (count-up), icon, click-to-filter |
| `TimeRangePicker` | Quick presets + custom range, auto-refresh toggle |
| `FilterBar` | Cloudflare-style field/operator/value filter chips |
| `EventsTable` | Sortable, filterable, expandable rows, pagination |
| `PolicyBuilder` | Statement editor: actions, resources, condition builder |
| `ConditionBuilder` | AND/OR condition tree with field/operator/value inputs |
| `PolicyPreview` | Read-only JSON view of the constructed policy |
| `PurgeForm` | Type selector, value inputs, zone picker, submit |
| `TrafficChart` | Recharts area chart for request timeline |
| `TypeDistribution` | Recharts donut for purge type breakdown |

---

## 6. Wrangler config

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
Phase 1: IAM policy engine + cache key support           ✅ COMPLETE
Phase 2: Cloudflare Access identity                       ✅ COMPLETE
Phase 2.5: Modularization + v1 nuke                       ✅ COMPLETE
Phase 3: OpenAPI spec + Dashboard
Phase 4: Polish + future services
```

### Phase 1: IAM policy engine + cache key support — COMPLETE

All implemented. 169 tests passing across 8 test files.

**Delivered:**
- `src/policy-engine.ts` — condition evaluator (all operators, compound logic, regex safety validation)
- `src/policy-types.ts` — `PolicyDocument`, `Statement`, `Condition`, `RequestContext` types
- `src/iam.ts` — `authorize()` takes `RequestContext[]`, evaluates key's policy. `createKey()` requires `PolicyDocument`.
- `src/routes/purge.ts` — `classifyPurge` returns `RequestContext[]` including URL-parsed fields and cache key headers
- `cli/commands/keys.ts` — `--policy` flag (JSON string), v2-only key display
- `cli/ui.ts` — policy rendering, `formatPolicy`/`parsePolicy`
- `test/policy-engine.test.ts` — 45 tests (all operators, compound conditions, edge cases)
- `test/iam.test.ts` — 30 tests (DO-level IAM with v2 policies)

### Phase 2: Cloudflare Access identity — COMPLETE

**Delivered:**
- `src/auth-access.ts` — JWT parsing, JWKS fetch + 1h in-memory cache, RS256 verification via `crypto.subtle`, ~80 lines no deps
- Admin auth middleware in `src/routes/admin.ts` — Access JWT → `X-Admin-Key` fallback → 401
- `src/env.d.ts` — `CF_ACCESS_TEAM_NAME?`, `CF_ACCESS_AUD?` optional secrets
- `test/auth-access.test.ts` — 14 tests (mock RSA keys, expiry, bad signatures, JWKS caching, cookie extraction)

### Phase 2.5: Modularization + v1 nuke — COMPLETE

**Source split** (from 990-line `src/index.ts`):
- `src/durable-object.ts` (~290 lines) — `PurgeRateLimiter` DO class
- `src/routes/purge.ts` (~230 lines) — purge route handler, isolate-level collapsing
- `src/routes/admin.ts` (~300 lines) — admin sub-app with auth middleware, key CRUD, analytics
- `src/index.ts` (~20 lines) — thin entrypoint

**Test split** (from 850-line `test/integration.test.ts`):
- `test/helpers.ts` — shared constants, HTTP helpers, upstream mocks, policy factories
- `test/admin.test.ts` — 12 tests
- `test/purge.test.ts` — 29 tests
- `test/analytics.test.ts` — 9 tests

**V1 nuke:** Removed all v1 scope types, RPC methods, migration code, `key_scopes` table. `gw_` prefix only.

### Phase 3: OpenAPI spec + Dashboard

**OpenAPI spec:**
- `openapi.yaml` — OpenAPI 3.1 schema describing all gateway endpoints
- Serves as the contract for the dashboard, CLI, and external consumers
- Can be served at `/openapi.yaml` or `/admin/openapi` for discoverability
- Consider generating route validation from the spec (or at least keeping spec and Hono routes in sync)

**Dashboard:**
- Astro project in `dashboard/`
- shadcn/ui + React islands
- Policy builder UI for key creation
- Summary, keys, analytics, purge pages
- Static assets config in wrangler
- Build pipeline: `cd dashboard && npm run build` → `wrangler deploy`
- Auth: Access handles login redirect, Worker validates JWT for API calls

### Phase 4: Polish + extensibility

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
| Policy schema too rigid for future services | Refactoring later | Version field in policy doc. Engine dispatches on version. |
| Static assets + Worker in same deploy | Build complexity | Separate build scripts, CI runs dashboard build then wrangler deploy |

---

## Current file layout

```
src/
├── index.ts              — Thin entrypoint: mounts routes, re-exports DO
├── durable-object.ts     — PurgeRateLimiter DO class, parseConfig, buildRateLimitResult
├── routes/
│   ├── purge.ts          — POST /v1/zones/:zoneId/purge_cache, isolate collapsing, classifyPurge
│   └── admin.ts          — Admin sub-app: auth middleware, key CRUD, analytics routes
├── types.ts              — Shared types: HonoEnv, PurgeBody, ApiKey, CreateKeyRequest, PurgeResult
├── policy-types.ts       — PolicyDocument, Statement, Condition, RequestContext
├── policy-engine.ts      — evaluatePolicy(), validatePolicy()
├── auth-access.ts        — Cloudflare Access JWT validation (no deps)
├── iam.ts                — IamManager: createKey(policy), authorize(contexts), authorizeFromBody()
├── token-bucket.ts       — TokenBucket class
├── analytics.ts          — D1 analytics
└── env.d.ts              — Env type extensions

cli/
├── index.ts              — CLI entry point (citty)
├── client.ts             — HTTP client
├── ui.ts                 — formatPolicy/parsePolicy, colored output
├── cli.test.ts           — parsePolicy tests
└── commands/
    ├── health.ts
    ├── keys.ts           — --policy required, v2-only display
    ├── purge.ts
    └── analytics.ts

test/
├── helpers.ts            — Shared constants, HTTP helpers, upstream mocks, policy factories
├── admin.test.ts         — Admin auth, key lifecycle, validation (12 tests)
├── purge.test.ts         — Purge auth, body validation, happy path, rate limiting, policy auth (29 tests)
├── analytics.test.ts     — Analytics validation, event logging, filtering (9 tests)
├── iam.test.ts           — DO-level IAM tests with v2 policies (30 tests)
├── auth-access.test.ts   — Access JWT validation (14 tests)
├── policy-engine.test.ts — Policy engine unit tests (45 tests)
└── token-bucket.test.ts  — Token bucket tests (16 tests)
```

## Files still to add

- `openapi.yaml` — OpenAPI 3.1 spec for all gateway endpoints
- `dashboard/` — Astro project (Phase 3)
- `wrangler.jsonc` — `assets` config for dashboard static files
- `README.md` — full rewrite for gateway + IAM framing (Phase 4)
