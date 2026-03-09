# Dev Platform Proxy — Design Plan

## Problem

Cloudflare API tokens have only **four scope levels** for permission groups:

| Scope key                         | Granularity        |
| --------------------------------- | ------------------ |
| `com.cloudflare.api.account`      | Entire account     |
| `com.cloudflare.api.account.zone` | Specific zone      |
| `com.cloudflare.api.user`         | User-level         |
| `com.cloudflare.edge.r2.bucket`   | Specific R2 bucket |

This means:

- **D1 databases** — "D1 Edit" grants access to **every** D1 database in the account.
- **KV namespaces** — "Workers KV Storage Write" grants access to **every** namespace.
- **Worker scripts** — "Workers Scripts Write" grants deploy access to **every** script.
- **Durable Object namespaces** — account-wide only.
- **Queues, Vectorize, Hyperdrive** — all account-scoped, no per-resource granularity.

In a multi-team account, Team A can read/write/delete Team B's D1 databases, KV namespaces, and Worker scripts. Cloudflare's native tokens cannot prevent this.

## Solution

Gatekeeper already proxies Cloudflare APIs (cache purge, DNS records, S3/R2) with per-resource policy enforcement. We extend this to cover **dev platform management APIs**.

Wrangler natively supports a custom API endpoint:

```
CLOUDFLARE_API_BASE_URL=https://gate.erfi.io/cf
```

When set, all wrangler commands (d1, kv, deploy, etc.) hit Gatekeeper instead of `api.cloudflare.com`. Gatekeeper authenticates, evaluates the policy (checking the specific database ID, namespace ID, or script name), and proxies to the real CF API if authorized.

### No chicken-and-egg problem

The deployer who runs `wrangler login` + `wrangler deploy` already has full CF dashboard permissions — they are the trust root. Once Gatekeeper is deployed, it vends scoped API keys to developers whose `wrangler` is configured to use Gatekeeper as the base URL. The deployer never loses direct CF API access.

---

## Architecture

### Request Flow

```
Developer workstation                           Gatekeeper Worker                    Cloudflare API
┌──────────────────────┐                   ┌─────────────────────────┐          ┌──────────────────┐
│ CLOUDFLARE_API_BASE  │                   │                         │          │                  │
│ = gate.erfi.io/cf    │──── wrangler ────▶│ 1. Auth (Bearer key)    │          │                  │
│                      │                   │ 2. Classify (action +   │          │                  │
│ CLOUDFLARE_API_TOKEN │                   │    resource from path)  │          │                  │
│ = gw_xxxx            │                   │ 3. Policy eval          │──proxy──▶│ Real CF API      │
│                      │                   │ 4. Rate limit           │          │ (upstream token)  │
│                      │◀── response ──────│ 5. Proxy + log          │◀─────────│                  │
└──────────────────────┘                   └─────────────────────────┘          └──────────────────┘
```

### Mount Point

All proxied CF API requests are mounted under `/cf/*`, which mirrors the CF API path structure:

```
/cf/accounts/:accountId/d1/database/:dbId/query    →  https://api.cloudflare.com/client/v4/accounts/:accountId/d1/database/:dbId/query
/cf/accounts/:accountId/storage/kv/namespaces/...   →  https://api.cloudflare.com/client/v4/accounts/:accountId/storage/kv/namespaces/...
/cf/accounts/:accountId/workers/scripts/:name       →  https://api.cloudflare.com/client/v4/accounts/:accountId/workers/scripts/:name
```

The `/cf` prefix keeps the proxy namespace cleanly separated from Gatekeeper's own routes (`/v1/`, `/admin/`, `/s3/`, `/dashboard/`).

---

## Phase 1: D1 Proxy

D1 is the highest-value target: it has the smallest API surface (12 endpoints), the clearest resource boundary (database ID), and the most sensitive operations (query, import, export, delete, time-travel restore).

### Actions

| Action                   | HTTP      | CF API Path                                              |
| ------------------------ | --------- | -------------------------------------------------------- |
| `d1:create`              | POST      | `/accounts/:acct/d1/database`                            |
| `d1:list`                | GET       | `/accounts/:acct/d1/database`                            |
| `d1:read`                | GET       | `/accounts/:acct/d1/database/:dbId`                      |
| `d1:update`              | PUT/PATCH | `/accounts/:acct/d1/database/:dbId`                      |
| `d1:delete`              | DELETE    | `/accounts/:acct/d1/database/:dbId`                      |
| `d1:query`               | POST      | `/accounts/:acct/d1/database/:dbId/query`                |
| `d1:raw`                 | POST      | `/accounts/:acct/d1/database/:dbId/raw`                  |
| `d1:export`              | POST      | `/accounts/:acct/d1/database/:dbId/export`               |
| `d1:import`              | POST      | `/accounts/:acct/d1/database/:dbId/import`               |
| `d1:time-travel-read`    | GET       | `/accounts/:acct/d1/database/:dbId/time_travel/bookmark` |
| `d1:time-travel-restore` | POST      | `/accounts/:acct/d1/database/:dbId/time_travel/restore`  |

### Resources

```
database:*                    — all databases in the account
database:<database_id>        — specific database
database:prod-*               — prefix wildcard (convention-based naming)
account:<account_id>          — account-level ops (list, create)
```

### Condition Fields

| Field              | Source                                       | Example                          |
| ------------------ | -------------------------------------------- | -------------------------------- |
| `d1.database_id`   | URL path param                               | `"abc-123-..."`                  |
| `d1.database_name` | Could be resolved from list cache (future)   | `"my-analytics-db"`              |
| `d1.sql`           | Body of query/raw requests (first statement) | `"SELECT * FROM users"`          |
| `d1.sql_command`   | Parsed first keyword of SQL                  | `"SELECT"`, `"INSERT"`, `"DROP"` |
| `d1.action_type`   | Import action discriminator                  | `"init"`, `"ingest"`, `"poll"`   |
| `client_ip`        | Request header                               | (standard)                       |
| `client_country`   | Request header                               | (standard)                       |
| `time.hour`        | UTC clock                                    | (standard)                       |
| `time.day_of_week` | UTC clock                                    | (standard)                       |

The `d1.sql_command` field is particularly powerful — it allows policies like "allow SELECT and INSERT, deny DROP and ALTER" without needing a full SQL parser. Extract the first non-whitespace keyword from the `sql` string.

### Example Policies

**Team A: read-only access to their analytics DB**

```json
{
	"version": "2025-01-01",
	"statements": [
		{
			"effect": "allow",
			"actions": ["d1:query", "d1:raw", "d1:read"],
			"resources": ["database:a1b2c3d4-..."],
			"conditions": [{ "field": "d1.sql_command", "operator": "in", "value": ["SELECT"] }]
		}
	]
}
```

**Team B: full access to their databases, no time-travel restore**

```json
{
	"version": "2025-01-01",
	"statements": [
		{ "effect": "deny", "actions": ["d1:time-travel-restore", "d1:delete"], "resources": ["*"] },
		{ "effect": "allow", "actions": ["d1:*"], "resources": ["database:x1y2z3-...", "database:p4q5r6-..."] }
	]
}
```

### Files to Create

| File                      | Purpose                                           | Pattern from            |
| ------------------------- | ------------------------------------------------- | ----------------------- |
| `src/cf/d1/operations.ts` | Action classification, condition field extraction | `src/dns/operations.ts` |
| `src/cf/d1/routes.ts`     | Hono sub-app with route handlers                  | `src/dns/routes.ts`     |
| `src/cf/d1/analytics.ts`  | D1-backed event logging                           | `src/dns/analytics.ts`  |
| `test/cf-d1.test.ts`      | Integration tests                                 | `test/dns.test.ts`      |

### Files to Modify

| File                     | Change                                                                       |
| ------------------------ | ---------------------------------------------------------------------------- |
| `src/index.ts`           | Mount `cfRoute` at `/cf`                                                     |
| `src/durable-object.ts`  | Add `resolveUpstreamAccountToken(accountId)` RPC method                      |
| `src/upstream-tokens.ts` | Extend to support account-scoped tokens (not just zone-scoped)               |
| `src/types.ts`           | Add `CfProxyEvent` type or reuse pattern                                     |
| `wrangler.jsonc`         | No binding changes needed — uses existing `ANALYTICS_DB` and `GATEKEEPER` DO |

---

## Phase 2: KV Proxy

### Actions

| Action                | HTTP   | CF API Path                                                 |
| --------------------- | ------ | ----------------------------------------------------------- |
| `kv:create-namespace` | POST   | `/accounts/:acct/storage/kv/namespaces`                     |
| `kv:list-namespaces`  | GET    | `/accounts/:acct/storage/kv/namespaces`                     |
| `kv:read-namespace`   | GET    | `/accounts/:acct/storage/kv/namespaces/:nsId`               |
| `kv:update-namespace` | PUT    | `/accounts/:acct/storage/kv/namespaces/:nsId`               |
| `kv:delete-namespace` | DELETE | `/accounts/:acct/storage/kv/namespaces/:nsId`               |
| `kv:list-keys`        | GET    | `/accounts/:acct/storage/kv/namespaces/:nsId/keys`          |
| `kv:read`             | GET    | `/accounts/:acct/storage/kv/namespaces/:nsId/values/:key`   |
| `kv:write`            | PUT    | `/accounts/:acct/storage/kv/namespaces/:nsId/values/:key`   |
| `kv:delete`           | DELETE | `/accounts/:acct/storage/kv/namespaces/:nsId/values/:key`   |
| `kv:read-metadata`    | GET    | `/accounts/:acct/storage/kv/namespaces/:nsId/metadata/:key` |
| `kv:bulk-write`       | PUT    | `/accounts/:acct/storage/kv/namespaces/:nsId/bulk`          |
| `kv:bulk-delete`      | POST   | `/accounts/:acct/storage/kv/namespaces/:nsId/bulk/delete`   |
| `kv:bulk-read`        | POST   | `/accounts/:acct/storage/kv/namespaces/:nsId/bulk/get`      |

### Resources

```
namespace:*                   — all namespaces
namespace:<namespace_id>      — specific namespace
account:<account_id>          — account-level ops (list/create namespaces)
```

### Condition Fields

| Field              | Source                                                |
| ------------------ | ----------------------------------------------------- |
| `kv.namespace_id`  | URL path param                                        |
| `kv.key`           | URL path param (for single-key ops)                   |
| `kv.key.prefix`    | Key prefix (for list-keys filter, or key name prefix) |
| `kv.key.extension` | File extension from key name (if dot-separated)       |

### Special Handling

- **`kv:read` (values.get)** returns raw binary (`application/octet-stream`), not JSON. The proxy must forward the response body as-is without parsing.
- **`kv:write` (values.update)** uses `multipart/form-data`. The proxy must forward the `Content-Type` header including the boundary, same pattern as DNS import.

### Files to Create

| File                      | Purpose               |
| ------------------------- | --------------------- |
| `src/cf/kv/operations.ts` | Action classification |
| `src/cf/kv/routes.ts`     | Route handlers        |
| `src/cf/kv/analytics.ts`  | Event logging         |
| `test/cf-kv.test.ts`      | Integration tests     |

---

## Phase 3: Workers Scripts Proxy

The largest surface area (~35 endpoints for scripts alone), but also the highest value for multi-team isolation — controlling who can deploy which Worker.

### Actions (core — deploy/manage lifecycle)

| Action           | HTTP   | CF API Path                              |
| ---------------- | ------ | ---------------------------------------- |
| `workers:deploy` | PUT    | `/accounts/:acct/workers/scripts/:name`  |
| `workers:list`   | GET    | `/accounts/:acct/workers/scripts`        |
| `workers:read`   | GET    | `/accounts/:acct/workers/scripts/:name`  |
| `workers:delete` | DELETE | `/accounts/:acct/workers/scripts/:name`  |
| `workers:search` | GET    | `/accounts/:acct/workers/scripts-search` |

### Actions (sub-resources — settings, secrets, versions, deployments)

| Action                          | HTTP   | CF API Path                                                   |
| ------------------------------- | ------ | ------------------------------------------------------------- |
| `workers:read-content`          | GET    | `/accounts/:acct/workers/scripts/:name/content/v2`            |
| `workers:update-content`        | PUT    | `/accounts/:acct/workers/scripts/:name/content`               |
| `workers:create-version`        | POST   | `/accounts/:acct/workers/scripts/:name/versions`              |
| `workers:list-versions`         | GET    | `/accounts/:acct/workers/scripts/:name/versions`              |
| `workers:read-version`          | GET    | `/accounts/:acct/workers/scripts/:name/versions/:vId`         |
| `workers:create-deployment`     | POST   | `/accounts/:acct/workers/scripts/:name/deployments`           |
| `workers:list-deployments`      | GET    | `/accounts/:acct/workers/scripts/:name/deployments`           |
| `workers:read-deployment`       | GET    | `/accounts/:acct/workers/scripts/:name/deployments/:dId`      |
| `workers:delete-deployment`     | DELETE | `/accounts/:acct/workers/scripts/:name/deployments/:dId`      |
| `workers:read-secrets`          | GET    | `/accounts/:acct/workers/scripts/:name/secrets`               |
| `workers:write-secrets`         | PUT    | `/accounts/:acct/workers/scripts/:name/secrets`               |
| `workers:delete-secret`         | DELETE | `/accounts/:acct/workers/scripts/:name/secrets/:sName`        |
| `workers:read-settings`         | GET    | `/accounts/:acct/workers/scripts/:name/settings`              |
| `workers:write-settings`        | PATCH  | `/accounts/:acct/workers/scripts/:name/settings`              |
| `workers:read-script-settings`  | GET    | `/accounts/:acct/workers/scripts/:name/script-settings`       |
| `workers:write-script-settings` | PATCH  | `/accounts/:acct/workers/scripts/:name/script-settings`       |
| `workers:read-schedules`        | GET    | `/accounts/:acct/workers/scripts/:name/schedules`             |
| `workers:write-schedules`       | PUT    | `/accounts/:acct/workers/scripts/:name/schedules`             |
| `workers:read-subdomain`        | GET    | `/accounts/:acct/workers/scripts/:name/subdomain`             |
| `workers:write-subdomain`       | POST   | `/accounts/:acct/workers/scripts/:name/subdomain`             |
| `workers:delete-subdomain`      | DELETE | `/accounts/:acct/workers/scripts/:name/subdomain`             |
| `workers:create-tail`           | POST   | `/accounts/:acct/workers/scripts/:name/tails`                 |
| `workers:read-tail`             | GET    | `/accounts/:acct/workers/scripts/:name/tails`                 |
| `workers:delete-tail`           | DELETE | `/accounts/:acct/workers/scripts/:name/tails/:tId`            |
| `workers:upload-assets`         | POST   | `/accounts/:acct/workers/scripts/:name/assets-upload-session` |

### Actions (account-level)

| Action                             | HTTP   | CF API Path                                |
| ---------------------------------- | ------ | ------------------------------------------ |
| `workers:list-domains`             | GET    | `/accounts/:acct/workers/domains`          |
| `workers:write-domain`             | PUT    | `/accounts/:acct/workers/domains`          |
| `workers:read-domain`              | GET    | `/accounts/:acct/workers/domains/:domId`   |
| `workers:delete-domain`            | DELETE | `/accounts/:acct/workers/domains/:domId`   |
| `workers:read-account-subdomain`   | GET    | `/accounts/:acct/workers/subdomain`        |
| `workers:write-account-subdomain`  | PUT    | `/accounts/:acct/workers/subdomain`        |
| `workers:delete-account-subdomain` | DELETE | `/accounts/:acct/workers/subdomain`        |
| `workers:read-account-settings`    | GET    | `/accounts/:acct/workers/account-settings` |
| `workers:write-account-settings`   | PUT    | `/accounts/:acct/workers/account-settings` |
| `workers:upload-account-assets`    | POST   | `/accounts/:acct/workers/assets/upload`    |

### Actions (zone-level routes)

| Action                 | HTTP   | CF API Path                              |
| ---------------------- | ------ | ---------------------------------------- |
| `workers:create-route` | POST   | `/zones/:zoneId/workers/routes`          |
| `workers:list-routes`  | GET    | `/zones/:zoneId/workers/routes`          |
| `workers:read-route`   | GET    | `/zones/:zoneId/workers/routes/:routeId` |
| `workers:update-route` | PUT    | `/zones/:zoneId/workers/routes/:routeId` |
| `workers:delete-route` | DELETE | `/zones/:zoneId/workers/routes/:routeId` |

### Resources

```
script:*                      — all scripts
script:<script_name>          — specific script
script:team-a-*               — prefix wildcard for team naming conventions
domain:<domain_id>            — specific custom domain
route:<route_id>              — specific zone route
account:<account_id>          — account-level ops
zone:<zone_id>                — zone-level route ops
```

### Condition Fields

| Field                 | Source         |
| --------------------- | -------------- |
| `workers.script_name` | URL path param |
| `workers.domain_id`   | URL path param |
| `workers.route_id`    | URL path param |
| `workers.version_id`  | URL path param |

### Special Handling

- **`workers:deploy` (scripts.update)** is a `PUT` with `multipart/form-data` body (script content + metadata). Must forward with original `Content-Type` boundary. Same pattern as DNS import.
- **`workers:read` (scripts.get)** returns raw JavaScript (`application/javascript`), not JSON.
- **`workers:update-content`** also multipart.
- **`workers:upload-assets`** and **`workers:upload-account-assets`** are multipart uploads.

### Files to Create

| File                           | Purpose                                   |
| ------------------------------ | ----------------------------------------- |
| `src/cf/workers/operations.ts` | Action classification                     |
| `src/cf/workers/routes.ts`     | Route handlers (will be the largest file) |
| `src/cf/workers/analytics.ts`  | Event logging                             |
| `test/cf-workers.test.ts`      | Integration tests                         |

---

## Phase 4: Queues, Vectorize, Hyperdrive

Lower priority — smaller user base and less sensitive. Follow the same pattern.

### Queues Actions (summary)

```
queues:create, queues:list, queues:read, queues:update, queues:delete
queues:push, queues:pull, queues:ack, queues:bulk-push
queues:create-consumer, queues:list-consumers, queues:read-consumer, queues:update-consumer, queues:delete-consumer
queues:purge, queues:purge-status
```

Resource: `queue:<queue_id>`

### Vectorize Actions (summary)

```
vectorize:create-index, vectorize:list-indexes, vectorize:read-index, vectorize:delete-index
vectorize:insert, vectorize:upsert, vectorize:query, vectorize:get-by-ids, vectorize:delete-by-ids
vectorize:info, vectorize:list-vectors
```

Resource: `index:<index_name>`

### Hyperdrive Actions (summary)

```
hyperdrive:create, hyperdrive:list, hyperdrive:read, hyperdrive:update, hyperdrive:delete
```

Resource: `config:<hyperdrive_id>`

---

## Shared Infrastructure Changes

### 1. Upstream Account Tokens

The current `UpstreamTokenManager` resolves tokens by **zone ID** (for cache purge and DNS). The dev platform APIs are scoped by **account ID**. We need a parallel resolution mechanism.

**Option A (recommended): Extend existing manager with a `scope_type` column.**

```sql
ALTER TABLE upstream_tokens ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'zone';
-- scope_type: 'zone' (existing behavior) or 'account'
-- zone_ids column repurposed: holds zone IDs when scope_type='zone', account IDs when scope_type='account'
```

New RPC method on the Durable Object:

```typescript
async resolveUpstreamAccountToken(accountId: string): Promise<string | null>
```

Resolution follows the same algorithm as `resolveUpstreamToken` but filters on `scope_type = 'account'` and matches against account IDs.

**Why not a separate table?** The CRUD operations (create, list, get, delete, bulk ops) are identical. The admin routes and CLI commands already work. Adding a `scope_type` field and a new resolution method is minimal change.

### 2. CF API Proxy Router (`src/cf/router.ts`)

A top-level Hono sub-app that mounts each service's routes:

```typescript
import { Hono } from 'hono';
import { d1Route } from './d1/routes';
import { kvRoute } from './kv/routes';
import { workersRoute } from './workers/routes';

export const cfRoute = new Hono<HonoEnv>();

cfRoute.route('/accounts/:accountId/d1', d1Route);
cfRoute.route('/accounts/:accountId/storage/kv', kvRoute);
cfRoute.route('/accounts/:accountId/workers', workersRoute);
// zone-scoped worker routes:
cfRoute.route('/zones/:zoneId/workers', workersZoneRoute);
```

Mounted in `src/index.ts`:

```typescript
app.route('/cf', cfRoute);
```

### 3. Account ID Validation

A shared middleware or helper that:

1. Extracts `accountId` from the path.
2. Validates format (32-char hex, same as zone IDs).
3. Optionally validates the key is scoped to this account (similar to the zone_id check on API keys).

API keys will need an optional `account_id` scope field alongside the existing `zone_id`.

### 4. Auth Header Forwarding

Wrangler sends `CLOUDFLARE_API_TOKEN` as `Authorization: Bearer <token>`. Currently, Gatekeeper's purge/DNS routes expect `Authorization: Bearer <gw_key_id>` — the Gatekeeper key ID, not a CF API token.

For the CF proxy routes under `/cf/*`, the same convention applies: the Bearer token IS the Gatekeeper key ID (`gw_xxx`). The developer sets `CLOUDFLARE_API_TOKEN=gw_xxx` in their environment. Gatekeeper strips this, authorizes via policy, then replaces it with the real upstream CF API token for the forwarded request.

### 5. Analytics Table

One new table for all CF proxy events (shared across D1, KV, Workers, etc.):

```sql
CREATE TABLE IF NOT EXISTS cf_proxy_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    service TEXT NOT NULL,         -- 'd1', 'kv', 'workers', 'queues', etc.
    action TEXT NOT NULL,          -- 'd1:query', 'kv:write', 'workers:deploy', etc.
    resource_id TEXT,              -- database ID, namespace ID, script name, etc.
    status INTEGER NOT NULL,
    upstream_status INTEGER,
    duration_ms INTEGER NOT NULL,
    response_detail TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cf_proxy_key_created ON cf_proxy_events (key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cf_proxy_account_created ON cf_proxy_events (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cf_proxy_service_created ON cf_proxy_events (service, created_at DESC);
```

This avoids creating a separate table per service (which is the current pattern for purge/DNS/S3 — a legacy of each being added independently). A unified table with a `service` column is simpler.

### 6. Rate Limiting

The Cloudflare API already enforces its own rate limits (1200 req/5min for most management endpoints) and returns standard headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After` on 429). The CF proxy routes **must forward these upstream headers** to the client so wrangler and SDK clients see them natively — unlike the DNS proxy which currently only forwards `Content-Type` and `Cf-Ray`.

Gatekeeper-side rate limiting is optional and secondary. Its value is **per-key fairness** in a multi-team account — preventing one noisy team from exhausting the shared account-wide CF API quota. If enabled:

```
cf_proxy_rps       — default: 200  (generous — CF's own limit is the real ceiling)
cf_proxy_burst     — default: 400
```

When the upstream returns 429, Gatekeeper should drain the local bucket (existing `drainBucket` pattern) to fail-fast subsequent requests without burning round-trips.

Headers to forward from upstream responses (in addition to `Content-Type` and `Cf-Ray`):

```
RateLimit-Limit
RateLimit-Remaining
RateLimit-Reset
Retry-After
```

---

## CLI Extensions

### New Commands

```
gk cf-analytics events   --account-id <id> [--service d1|kv|workers] [--action ...] [--since ...] [--until ...]
gk cf-analytics summary  --account-id <id> [--service d1|kv|workers]
```

### Modified Commands

```
gk upstream-tokens create  --scope-type account --account-ids <id1,id2|*> --token <cf_token> [--validate]
gk upstream-tokens create  --scope-type zone    --zone-ids <id1,id2|*>     --token <cf_token> [--validate]
```

The `--scope-type` flag defaults to `zone` for backward compatibility. When `account` is specified, `--account-ids` replaces `--zone-ids`.

### Updated Key Commands

```
gk keys create --name "team-a-d1" --account-id <id> --policy @team-a-d1-policy.json
```

The `--account-id` flag scopes the key to a specific account (parallel to the existing `--zone-id`). A key can have `zone_id`, `account_id`, both, or neither.

---

## Implementation Order

### Milestone 1: Foundations (est. 2-3 days)

1. Extend `upstream_tokens` with `scope_type` column via DO storage migration.
2. Add `resolveUpstreamAccountToken(accountId)` RPC method.
3. Create `src/cf/router.ts` — the top-level CF proxy mount point.
4. Create shared helpers: `validateAccountId()`, `proxyToCfApi()` (generalized from DNS), `buildCfProxyEvent()`.
5. Create `cf_proxy_events` analytics table and logging functions.
6. Add `cf_proxy` rate-limit bucket to config registry.
7. Update CLI `upstream-tokens create` to support `--scope-type account`.
8. Tests for upstream account token resolution.

### Milestone 2: D1 Proxy (est. 2-3 days)

1. `src/cf/d1/operations.ts` — 11 actions, field extraction (SQL command parsing).
2. `src/cf/d1/routes.ts` — 8 path patterns, 12 verb+path handlers.
3. `src/cf/d1/analytics.ts` — event logging.
4. Mount in `src/cf/router.ts`.
5. Integration tests: auth, policy deny, SQL command conditions, upstream proxy.
6. CLI: `gk cf-analytics` commands.

### Milestone 3: KV Proxy (est. 2 days)

1. `src/cf/kv/operations.ts` — 13 actions, field extraction.
2. `src/cf/kv/routes.ts` — 9 path patterns, 13 handlers. Special handling for binary values and multipart writes.
3. `src/cf/kv/analytics.ts` — event logging.
4. Tests.

### Milestone 4: Workers Proxy (est. 3-4 days)

1. `src/cf/workers/operations.ts` — ~35 actions.
2. `src/cf/workers/routes.ts` — largest file, ~30 path patterns. Special handling for multipart script uploads and raw JS responses.
3. `src/cf/workers/analytics.ts` — event logging.
4. Zone-scoped route handlers for `/zones/:zoneId/workers/routes/*`.
5. Tests.

### Milestone 5: Queues / Vectorize / Hyperdrive (est. 2-3 days)

1. Follow the same pattern for each.
2. These can be done in parallel by different contributors if needed.

### Milestone 6: Dashboard + Docs (est. 1-2 days)

1. Dashboard views for CF proxy analytics.
2. Usage documentation: how to configure `wrangler` to use Gatekeeper.
3. Example policy documents for common multi-team scenarios.

---

## What Does NOT Change

- **Policy engine** (`src/policy-engine.ts`) — completely namespace-agnostic. `d1:query`, `kv:write`, `workers:deploy` are just strings. Wildcard matching (`d1:*`, `workers:*`) already works.
- **Credential manager** (`src/credential-manager.ts`) — generic over any credential type. No changes needed.
- **Admin RBAC** (`src/auth-admin.ts`) — role hierarchy stays the same. New admin routes for CF proxy analytics use the same `requireRole`/`requireRoleByMethod` guards.
- **API key format** — existing `gw_` prefix keys work for CF proxy auth. No new credential type needed.
- **S3 proxy** — completely independent, no changes.
- **Cache purge proxy** — completely independent, no changes.
- **DNS proxy** — completely independent, no changes.
- **Dashboard auth** — CF Access JWT flow stays the same.
- **D1 analytics DB binding** — reused for CF proxy events.
- **Durable Object** — same singleton, new RPC methods added alongside existing ones.

---

## Open Questions

1. **Account ID scoping on keys**: Should we add an `account_id` column to `api_keys` (parallel to `zone_id`)? Or is policy-level resource matching (`resources: ["database:specific-id"]`) sufficient? The zone_id column is a convenience shortcut — policies can already enforce zone scoping via `resources: ["zone:xxx"]`. Same logic applies to account scoping. **Leaning toward: policy-only, no new column.** Keeps the schema stable.

2. **Passthrough mode**: Should there be an option to proxy CF API requests without policy evaluation (for admin-level keys that just need audit logging)? Could be a policy shorthand: `{ "effect": "allow", "actions": ["*"], "resources": ["*"] }`.

3. **Binary/streaming responses**: KV `values.get` returns raw binary. Worker `scripts.get` returns raw JS. Should Gatekeeper stream these responses or buffer them? Buffering is simpler and matches the current DNS proxy pattern. Streaming is better for large objects but adds complexity. **Leaning toward: buffer for now, stream later if size becomes an issue.** CF API responses for management endpoints are typically small.

4. **wrangler compatibility testing**: Need to verify that wrangler correctly sends all requests to `CLOUDFLARE_API_BASE_URL` for every command (d1, kv, deploy, etc.) without path munging. Should be a manual test early in Milestone 1 before committing to the architecture.

5. **Observability/telemetry endpoints**: The Workers observability endpoints (`/workers/observability/telemetry/*`) are POST-based query endpoints. Should these be proxied? They're read-only analytics queries. **Leaning toward: yes, with a `workers:read-telemetry` action.**
