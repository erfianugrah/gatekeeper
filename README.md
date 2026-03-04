# Purge API Gateway

Cloudflare Worker that sits in front of the cache purge API. It does three things the purge endpoint doesn't do on its own:

1. Returns rate limit headers (`Ratelimit`, `Ratelimit-Policy`, `Retry-After`)
2. Tracks token bucket state client-side so it can reject requests before they hit the upstream API
3. Issues scoped API keys — hand out a key that can only purge `host:example.com` instead of sharing a full API token

It also does request collapsing, per-key rate limits, and logs everything to D1 for analytics.

## Background

The Cloudflare purge endpoint (`POST /zones/:zone_id/purge_cache`) has [documented rate limits](https://developers.cloudflare.com/cache/how-to/purge-cache/#availability-and-limits) but doesn't return any rate limit headers. Tested this empirically — `GET /zones/:zone_id` returns `Ratelimit` and `Ratelimit-Policy`, but the purge endpoint returns nothing. So callers have no idea how much budget they have left or when to back off.

## Architecture

```
                         ┌──────── Isolate collapse ────────┐
                         │  Map<zoneId\0body, Promise>      │
  Client ──► Worker ─────┤                                  ├──RPC──► Durable Object: PurgeRateLimiter
                         │  50ms grace window               │           - account-level token buckets
                         └──────────────────────────────────┘           - per-key token buckets (lazy)
                                                                        - IAM keys (SQLite)
                                                                        - DO-level request collapsing
                                                                                │
                                                                                ▼ (if allowed)
                                                                       api.cloudflare.com
                                                                         /client/v4/zones/:zone_id/purge_cache
                                                                                │
                                                                                ▼ (fire-and-forget via waitUntil)
                                                                       D1: purge_events (analytics)
```

**One DO for the whole gateway.** Cloudflare's purge rate limit is [per-account, grouped by plan](https://developers.cloudflare.com/cache/how-to/purge-cache/#availability-and-limits) — all Enterprise zones on the same account share one pool. Since the gateway uses a single upstream API token (one account), there's one DO instance holding the token buckets. The zone ID is still used for upstream routing, IAM scoping, and analytics filtering, but rate limiting is account-wide. The DO soft limit is ~1,000 RPS — way above the Enterprise purge ceiling of 50 bulk req/sec.

**Token bucket is in-memory only.** Not persisted to SQLite. If the DO gets evicted, the bucket resets to full — that's fine, the upstream API is the real enforcer. Keeping it in-memory avoids ~1ms write latency on every request.

**Two-layer request collapsing.** Identical concurrent purges get deduplicated at both the V8 isolate level (before RPC) and inside the DO (before upstream fetch). Only the first request (the "leader") actually consumes a rate limit token and hits the API. Followers piggyback on the leader's result.

**D1 analytics.** Every purge is logged to D1 via `waitUntil()` so it doesn't slow down the response.

Routing is Hono. Logging is one fat JSON object per request via `console.log`, picked up by Cloudflare's built-in observability.

---

## Setup

Requires Node.js >= 18 and a Cloudflare API token with Cache Purge permission.

```bash
npm install
```

### Secrets

For local dev, create `.dev.vars`:

```
UPSTREAM_API_TOKEN=<your-cloudflare-api-token>
ADMIN_KEY=<a-strong-secret-for-admin-operations>
```

For production:

```bash
npx wrangler secret put UPSTREAM_API_TOKEN
npx wrangler secret put ADMIN_KEY
```

### Dev / deploy / types

```bash
npx wrangler dev       # local dev server
npx wrangler deploy    # push to Cloudflare
npx wrangler types     # regenerate types after changing bindings
```

---

## Configuration

Rate limit defaults live in `wrangler.jsonc` env vars. They match Enterprise tier limits:

| Variable | Default | What it does |
|----------|---------|--------------|
| `BULK_RATE` | `50` | Bulk purge refill rate (tokens/sec) |
| `BULK_BUCKET_SIZE` | `500` | Bulk purge burst capacity |
| `BULK_MAX_OPS` | `100` | Max items per bulk request |
| `SINGLE_RATE` | `3000` | Single-file refill rate (URLs/sec) |
| `SINGLE_BUCKET_SIZE` | `6000` | Single-file burst capacity |
| `SINGLE_MAX_OPS` | `500` | Max URLs per request |
| `KEY_CACHE_TTL_MS` | `60000` | IAM key cache lifetime in the DO (ms) |

---

## API

### `GET /health`

Returns `{"ok": true}`.

### `POST /v1/zones/:zoneId/purge_cache`

Proxies to the Cloudflare purge API. Same request body format. Requires `Authorization: Bearer pgw_<key>`.

**Single-file** (costs 1 token per URL from the `single` bucket):
```json
{"files": ["https://example.com/page.html", "https://example.com/style.css"]}
```

Files can be objects too: `{"url": "https://...", "headers": {"Origin": "..."}}`

**Bulk** (costs 1 token from the `bulk` bucket):
```json
{"hosts": ["example.com"]}
{"tags": ["product-page", "header"]}
{"prefixes": ["example.com/blog/"]}
{"purge_everything": true}
```

Mixed bodies (e.g. hosts + tags in one request) count as 1 bulk token.

#### Response headers

Every response gets these added:

```
Ratelimit: "purge-bulk";r=499;t=0
Ratelimit-Policy: "purge-bulk";q=500;w=10
```

Format follows the [IETF rate limit headers draft](https://ietf-wg-httpapi.github.io/ratelimit-headers/draft-ietf-httpapi-ratelimit-headers.html). `r` = remaining, `t` = seconds until next token, `q` = capacity, `w` = window (capacity/rate). `cf-ray` and `cf-auditlog-id` from upstream are forwarded through.

On 429, `Retry-After` is also set.

#### Errors

| Status | Cause |
|--------|-------|
| 400 | Bad zone ID, invalid JSON, unrecognized body, too many items (>500 URLs, >100 bulk ops) |
| 401 | Missing/invalid auth header, unknown key |
| 403 | Key is revoked, expired, wrong zone, or doesn't have the right scopes. Response includes `denied` array showing what failed. |
| 429 | Rate limited (either client-side bucket or upstream). Has `Retry-After`. |
| 502 | Upstream fetch threw (network error) |

---

### Admin endpoints

All require `X-Admin-Key: <admin_key>`.

#### `POST /admin/keys` — create key

```json
{
  "name": "my-service-key",
  "zone_id": "<zone_id>",
  "expires_in_days": 90,
  "scopes": [
    {"scope_type": "host", "scope_value": "example.com"},
    {"scope_type": "tag", "scope_value": "product-page"}
  ],
  "rate_limit": {
    "bulk_rate": 10,
    "bulk_bucket": 20
  }
}
```

`name`, `zone_id`, and `scopes` are required. `expires_in_days` and `rate_limit` are optional.

The response includes the full key ID (`pgw_<hex>`). This is what clients pass as `Authorization: Bearer pgw_...`.

#### `GET /admin/keys?zone_id=<zone_id>[&status=active|revoked]` — list keys

#### `GET /admin/keys/:id?zone_id=<zone_id>` — get key + scopes

#### `DELETE /admin/keys/:id?zone_id=<zone_id>` — revoke key

Soft delete. Sets `revoked = 1`. Also cleans up any per-key rate limit buckets in memory.

#### `GET /admin/analytics/events?zone_id=<zone_id>[&key_id=...][&since=...][&until=...][&limit=...]` — query events

Returns purge events from D1. `since`/`until` are unix ms. `limit` defaults to 100, max 1000.

#### `GET /admin/analytics/summary?zone_id=<zone_id>[&key_id=...][&since=...][&until=...]` — aggregate stats

Returns `total_requests`, `total_cost`, `by_status`, `by_purge_type`, `collapsed_count`, `avg_duration_ms`.

---

## Scopes

Scopes control what a key can purge. Every item in the request body must match at least one scope or the request is rejected.

| Type | Value example | Matching rule |
|------|---------------|---------------|
| `host` | `example.com` | Exact match against `hosts` array |
| `tag` | `product-page` | Exact match against `tags` array |
| `prefix` | `example.com/blog` | `startsWith` against `prefixes` array |
| `url_prefix` | `https://example.com/` | `startsWith` against each URL in `files` |
| `purge_everything` | `true` | Allows `purge_everything: true` |
| `*` | `*` | Wildcard — allows everything for the zone |

Mixed bodies need scopes for each type. A `host` scope doesn't cover `tags`.

---

## Rate limiting

### Token bucket

Two buckets per account, lazy-refill (no timers). All zones share the same pool:

| Bucket | Rate | Capacity | Applies to |
|--------|------|----------|------------|
| `purge-single` | 3,000/sec | 6,000 | `files` (1 token per URL) |
| `purge-bulk` | 50/sec | 500 | `hosts`, `tags`, `prefixes`, `purge_everything` (1 token per request) |

If the gateway's bucket says no, the request gets a 429 without touching Cloudflare. If the upstream API returns 429 anyway (shared account limits, clock drift), the gateway drains its local bucket to zero and forwards the 429. The bucket refills naturally from there.

### Per-key rate limits

Keys can have their own bucket limits. Set `rate_limit` when creating the key:

```json
{
  "rate_limit": {
    "bulk_rate": 5, "bulk_bucket": 10,
    "single_rate": 100, "single_bucket": 200
  }
}
```

All four fields are optional. If a key has custom limits, they're checked *before* the account-level bucket. Per-key 429s use different header names (`purge-bulk-key` / `purge-single-key`) so the client knows which limit it hit.

Per-key buckets are created lazily in the DO on first use, and cleaned up when the key is revoked.

### Request collapsing

Two levels:

1. **Isolate-level** — `Map<zoneId\0bodyText, Promise>`. If an identical request is already flying to the DO, the second one just waits for the first one's result.
2. **DO-level** — same idea, but inside the DO for the upstream fetch. Only the leader consumes a token.

Both have a 50ms grace window after the leader finishes, to catch near-simultaneous arrivals. Collapsed requests show up as `collapsed: "isolate"` or `collapsed: "do"` in logs and analytics.

The maps store `Promise<PurgeResult>` (serialized data), not `Promise<Response>` — because `Response.clone()` blows up after the body is consumed. Each caller builds its own `Response` from the shared data.

---

## Auth

**Admin routes** (`/admin/*`): `X-Admin-Key` header, compared using HMAC-SHA256 + `timingSafeEqual` to avoid timing leaks (including length).

**Purge route**: `Authorization: Bearer pgw_<hex>`. Keys are 32 random hex chars via `crypto.getRandomValues()`. Looked up in DO SQLite, cached in memory for 60 seconds.

Auth check order: key exists → not revoked → not expired → zone matches → scopes cover request body.

### Data model

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,          -- pgw_<hex>
  name TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,  -- unix ms
  expires_at INTEGER,           -- unix ms, NULL = never
  revoked INTEGER DEFAULT 0,
  bulk_rate REAL,               -- per-key, NULL = account default
  bulk_bucket REAL,
  single_rate REAL,
  single_bucket REAL
);

CREATE TABLE key_scopes (
  key_id TEXT NOT NULL REFERENCES api_keys(id),
  scope_type TEXT NOT NULL,     -- host, tag, prefix, url_prefix, purge_everything, *
  scope_value TEXT NOT NULL,
  PRIMARY KEY (key_id, scope_type, scope_value)
);
```

### D1 analytics schema

```sql
CREATE TABLE purge_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  purge_type TEXT NOT NULL,       -- "single" or "bulk"
  cost INTEGER NOT NULL,
  status INTEGER NOT NULL,
  collapsed TEXT,                 -- "isolate", "do", or NULL
  upstream_status INTEGER,        -- NULL if request didn't reach upstream
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL     -- unix ms
);
-- Indexes on (zone_id, created_at DESC) and (key_id, created_at DESC)
```

Tables are created with `CREATE TABLE IF NOT EXISTS` on every write/query call — no migration step needed.

---

## Logging

One JSON log line per request at completion:

```json
{
  "route": "purge",
  "method": "POST",
  "zoneId": "abc123...",
  "purgeType": "bulk",
  "cost": 1,
  "keyId": "pgw_a1b2c3d4...",
  "collapsed": false,
  "rateLimitAllowed": true,
  "rateLimitRemaining": 499,
  "upstreamStatus": 200,
  "status": 200,
  "durationMs": 102
}
```

Cloudflare observability picks these up automatically (`"observability": {"enabled": true}` in wrangler.jsonc).

---

## Edge cases

**Body validation:** Empty body → 400. Malformed JSON → 400. `files` with >500 URLs → 400 (saves a wasted API call). `purge_everything` must be boolean `true`, not truthy. Files can be strings or `{url, headers}` objects — scope checks handle both.

**DO concurrency:** Input/output gates handle it. A revoke followed immediately by a purge attempt won't see stale data. Write coalescing batches concurrent SQLite writes.

**DO eviction:** Token bucket resets to full (safe — upstream enforces). Key cache clears (next request reads SQLite, ~1-2ms). SQLite data persists.

**Isolate recycling:** Worker is stateless, everything lives in the DO. Isolate-level collapse map just clears.

**Upstream 429:** Forwarded to client. Local bucket drained to zero. Self-heals as tokens refill.

**Upstream 5xx / network errors:** Forwarded as-is (5xx) or 502 (network). Token not refunded — upstream may have partially processed the purge.

**DO overload:** Soft limit ~1,000 RPS. You'd need ~20x Enterprise rate to hit it. If it happens, 503 with `Retry-After: 1`.

---

## CLI

`purge-gw` — built with [citty](https://github.com/unjs/citty). Colored output, spinners, rate limit progress bars, confirmation prompts for destructive stuff.

### Setup

```bash
cp .env.example .env   # fill in your values
./purge-gw health      # runs via tsx, no build step
```

The wrapper script uses Node 20.6+ native `--env-file` to load `.env`. Symlink it if you want it on your PATH:

```bash
ln -s "$(pwd)/purge-gw" ~/.local/bin/purge-gw
```

### Config

Set these in `.env` or as env vars:

| Variable | Flag | What |
|----------|------|------|
| `PURGE_GATEWAY_URL` | `--endpoint` | Base URL (default: `https://purge.erfi.io`) |
| `PURGE_GATEWAY_ADMIN_KEY` | `--admin-key` | For `/admin/*` |
| `PURGE_GATEWAY_API_KEY` | `--api-key` | `pgw_...` for purge requests |
| `PURGE_GATEWAY_ZONE_ID` | `--zone-id` / `-z` | Default zone ID |

Flags win over env vars.

### Commands

```
purge-gw health
purge-gw keys create  --name <n> --scope <type:value>  [--expires-in-days N]
purge-gw keys list    [--active-only]
purge-gw keys get     --key-id <pgw_...>
purge-gw keys revoke  --key-id <pgw_...>
purge-gw purge hosts       --host <h1,h2>
purge-gw purge tags        --tag <t1,t2>
purge-gw purge prefixes    --prefix <p1,p2>
purge-gw purge urls        --url <url1,url2>
purge-gw purge everything  [-f to skip confirmation]
purge-gw analytics events  [--key-id ...] [--since ...]
purge-gw analytics summary [--key-id ...] [--since ...]
```

All commands support `--json` for raw output and `--help`.

Scopes for key creation: `--scope "host:example.com,tag:blog,url_prefix:https://example.com/assets/"`. Bad format shows all valid types with examples.

Human output goes to stderr, JSON to stdout. `NO_COLOR=1` disables colors.

---

## Tests

```bash
npm test              # runs everything via vitest workspace
npm run test:worker   # worker + DO + integration tests only
npm run test:cli      # CLI unit tests only
```

108 tests across 4 files:

- `test/token-bucket.test.ts` (16) — consume, refill, drain, clock skew, fractional tokens
- `test/iam.test.ts` (29) — key CRUD, auth gates, scope matching for all types, expiration, revocation, list filters
- `test/integration.test.ts` (35) — full request flow with `SELF` + `fetchMock`: health, admin, auth, body validation, all purge types, upstream errors, rate limiting, per-key limits, D1 analytics
- `cli/cli.test.ts` (28) — scope parsing, config resolution, formatting

Type checking:

```bash
npx tsc --noEmit              # worker
npx tsc -p cli/tsconfig.json  # cli
```

(`tsc --noEmit` will complain about test files importing `cloudflare:test` — that's a known moduleResolution mismatch, tests run fine through vitest.)

---

## Dependencies

| Package | What |
|---------|------|
| `hono` | Routing (only runtime dep) |
| `wrangler` | Dev/build/deploy |
| `typescript` | Types |
| `vitest` + `@cloudflare/vitest-pool-workers` | Tests in Workers runtime |
| `citty` | CLI framework |
| `tsx` | Runs CLI without a build step |

---

## Project layout

```
purge-gw                     CLI wrapper (bash, auto-loads .env)
.env.example                 CLI env template
wrangler.jsonc               Worker config, DO + D1 bindings, rate limit vars
vitest.config.ts             Workspace: Workers pool + Node.js CLI test projects
src/
  index.ts                   Hono app, PurgeRateLimiter DO, routes, collapsing, analytics
  token-bucket.ts            Token bucket (lazy refill, no I/O)
  iam.ts                     Key CRUD, scope checking, in-memory cache
  analytics.ts               D1 reads/writes for purge events
  types.ts                   Shared interfaces
  env.d.ts                   Secret type augmentation
cli/
  index.ts                   Entry point (citty, lazy subcommands)
  client.ts                  HTTP client, config resolution
  ui.ts                      Colors, spinners, tables, rate limit bars
  cli.test.ts                28 tests
  commands/{health,keys,purge,analytics}.ts
test/
  token-bucket.test.ts       16 tests
  iam.test.ts                29 tests
  integration.test.ts        35 tests
```

---

## Future work

- Webhook/Slack notifications when rate limits get tight or upstream 429s happen
- Key rotation with grace periods
- D1 retention cleanup (cron job to prune old events)
