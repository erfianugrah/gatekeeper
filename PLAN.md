# Gatekeeper API Expansion Plan

This document tracks candidate Cloudflare APIs that could be proxied through Gatekeeper,
giving them the same IAM policy engine, rate limiting, request collapsing, audit trail,
and delegated credential management that cache purge and R2 already have.

**SDK Reference:** `~/cloudflare-typescript` (cloned from `cloudflare/cloudflare-typescript`).
We use the SDK's type definitions as the canonical reference for request/response shapes,
but do NOT import it at runtime -- Gatekeeper proxies raw JSON via `fetch()` to keep the
bundle small and maintain full control over headers, timeouts, and error handling.

---

## Candidate 1: DNS Records API (High Priority)

### Why

DNS record management is a top delegation target. CI/CD pipelines, ACME certificate
clients (cert-manager, Caddy, Lego), and internal tooling all need to create/update/delete
DNS records -- but giving them a full-zone CF API token is overly broad. Gatekeeper can
scope access down to specific FQDNs, record types, and actions.

### Cloudflare API Surface

**SDK access path:** `client.dns.records.*`
**SDK source:** `~/cloudflare-typescript/src/resources/dns/records.ts` (12,475 lines)

| Method | Endpoint                             | SDK Method         | Description              |
| ------ | ------------------------------------ | ------------------ | ------------------------ |
| POST   | `/zones/:zone_id/dns_records`        | `records.create()` | Create record            |
| GET    | `/zones/:zone_id/dns_records`        | `records.list()`   | List records (paginated) |
| GET    | `/zones/:zone_id/dns_records/:id`    | `records.get()`    | Get single record        |
| PATCH  | `/zones/:zone_id/dns_records/:id`    | `records.edit()`   | Partial update           |
| PUT    | `/zones/:zone_id/dns_records/:id`    | `records.update()` | Full overwrite           |
| DELETE | `/zones/:zone_id/dns_records/:id`    | `records.delete()` | Delete record            |
| POST   | `/zones/:zone_id/dns_records/batch`  | `records.batch()`  | Batch operations         |
| GET    | `/zones/:zone_id/dns_records/export` | `records.export()` | Export BIND zone file    |
| POST   | `/zones/:zone_id/dns_records/import` | `records.import()` | Import BIND zone file    |

**Note:** In-place record type changes are deprecated (June 2026 EOL). The batch endpoint
is the recommended path for atomic create+delete combos.

### Supported Record Types (21 total, from SDK)

The SDK defines a discriminated union of 21 record types. Each has a `type` literal,
a `name` (FQDN), a `ttl` (number or `1` for auto), optional `comment`, optional `tags`,
and type-specific fields:

| Type         | Key Fields                                            | Proxiable |
| ------------ | ----------------------------------------------------- | --------- |
| `A`          | `content: string` (IPv4)                              | Yes       |
| `AAAA`       | `content: string` (IPv6)                              | Yes       |
| `CNAME`      | `content: string` (target), `settings.flatten_cname`  | Yes       |
| `MX`         | `content: string` (mail server), `priority: number`   | No        |
| `NS`         | `content: string` (nameserver)                        | No        |
| `TXT`        | `content: string` (text value)                        | No        |
| `PTR`        | `content: string` (pointer target)                    | No        |
| `SRV`        | `data: { port, priority, target, weight }`            | No        |
| `CAA`        | `data: { flags, tag, value }`                         | No        |
| `CERT`       | `data: { algorithm, certificate, key_tag, type }`     | No        |
| `DNSKEY`     | `data: { algorithm, flags, protocol, public_key }`    | No        |
| `DS`         | `data: { algorithm, digest, digest_type, key_tag }`   | No        |
| `HTTPS`      | `data: { priority, target, value }`                   | No        |
| `LOC`        | `data: { lat/long/altitude fields }`                  | No        |
| `NAPTR`      | `data: { flags, order, preference, regex, ... }`      | No        |
| `OPENPGPKEY` | `content: string` (base64 key)                        | No        |
| `SMIMEA`     | `data: { certificate, matching_type, selector, ... }` | No        |
| `SSHFP`      | `data: { algorithm, fingerprint, type }`              | No        |
| `SVCB`       | `data: { priority, target, value }`                   | No        |
| `TLSA`       | `data: { certificate, matching_type, selector, ... }` | No        |
| `URI`        | `data: { target, weight }`, `priority: number`        | No        |

**Common response fields** (added by CF, not in request):

```ts
{
  id: string;                    // Record identifier (used in update/delete paths)
  created_on: string;            // ISO timestamp
  modified_on: string;           // ISO timestamp
  proxiable: boolean;            // Whether the record CAN be proxied
  meta: unknown;                 // Extra Cloudflare metadata
  comment_modified_on?: string;
  tags_modified_on?: string;
}
```

### SDK List Filters (RecordListParams)

The list endpoint supports rich filtering that Gatekeeper should pass through:

```ts
interface RecordListParams {
  zone_id: string;
  type?: 'A' | 'AAAA' | 'CAA' | 'CERT' | 'CNAME' | ... | 'URI';
  name?: { exact?: string; contains?: string; startswith?: string; endswith?: string };
  content?: { exact?: string; contains?: string; startswith?: string; endswith?: string };
  comment?: { exact?: string; contains?: string; startswith?: string; endswith?: string;
              present?: string; absent?: string };
  tag?: { exact?: string; contains?: string; startswith?: string; endswith?: string;
          present?: string; absent?: string };
  proxied?: boolean;
  search?: string;               // Full-text search across multiple fields
  match?: 'any' | 'all';         // Logical AND/OR between filters
  tag_match?: 'any' | 'all';
  order?: 'type' | 'name' | 'content' | 'ttl' | 'proxied';
  direction?: 'asc' | 'desc';
  // Standard pagination: page, per_page
}
```

### SDK Batch Semantics (RecordBatchParams)

```ts
interface RecordBatchParams {
	zone_id: string;
	deletes?: Array<{ id: string }>;
	patches?: Array<{ id: string } & RecordFields>; // Partial update
	puts?: Array<{ id: string } & RecordFields>; // Full overwrite
	posts?: Array<RecordFields>; // Create new
}

// Execution order is always: deletes -> patches -> puts -> posts
```

Response:

```ts
interface RecordBatchResponse {
	deletes?: Array<RecordResponse>;
	patches?: Array<RecordResponse>;
	posts?: Array<RecordResponse>;
	puts?: Array<RecordResponse>;
}
```

### Rate Limits

DNS falls under the global CF API limit: **1,200 requests / 5 minutes** per token.
Zone file import has a stricter limit of 3 requests/minute. Gatekeeper's token-bucket
rate limiter can protect the shared upstream token from being exhausted by a single caller.

### Proposed IAM Actions

| Action       | Description                                                  |
| ------------ | ------------------------------------------------------------ |
| `dns:create` | Create a DNS record                                          |
| `dns:read`   | Get or list DNS records                                      |
| `dns:update` | Edit (PATCH) or overwrite (PUT) a DNS record                 |
| `dns:delete` | Delete a DNS record                                          |
| `dns:batch`  | Batch create/update/delete (each sub-operation also checked) |
| `dns:export` | Export zone file (BIND format)                               |
| `dns:import` | Import zone file (BIND format) -- powerful, admin-only       |
| `dns:*`      | Wildcard for all DNS operations                              |

### Proposed Resource Format

```
zone:<zone_id>
```

Same as purge -- DNS is zone-scoped.

### Proposed Condition Fields

This is where the real value is -- scoping to specific FQDNs and record types:

| Field         | Type     | Example                               | Description                      |
| ------------- | -------- | ------------------------------------- | -------------------------------- |
| `dns.name`    | string   | `_acme-challenge.staging.example.com` | The FQDN being modified          |
| `dns.type`    | string   | `TXT`, `A`, `CNAME`                   | The DNS record type              |
| `dns.content` | string   | `1.2.3.4`                             | The record content/value         |
| `dns.proxied` | boolean  | `true`                                | Whether the record is CF-proxied |
| `dns.ttl`     | number   | `300`                                 | The TTL in seconds               |
| `dns.comment` | string   | `managed by cert-manager`             | The record comment               |
| `dns.tags`    | string[] | `["ci", "staging"]`                   | Record tags (if present)         |

**Example policy -- ACME client scoped to challenge records:**

```json
{
	"version": "2025-01-01",
	"statement": [
		{
			"effect": "allow",
			"action": ["dns:create", "dns:read", "dns:delete"],
			"resource": ["zone:abc123def456..."],
			"condition": {
				"all": [
					{ "field": "dns.type", "operator": "eq", "value": "TXT" },
					{ "field": "dns.name", "operator": "ends_with", "value": ".example.com" },
					{ "field": "dns.name", "operator": "starts_with", "value": "_acme-challenge." }
				]
			}
		}
	]
}
```

**Example policy -- CI scoped to staging A records:**

```json
{
	"version": "2025-01-01",
	"statement": [
		{
			"effect": "allow",
			"action": ["dns:create", "dns:update", "dns:delete"],
			"resource": ["zone:abc123def456..."],
			"condition": {
				"all": [
					{ "field": "dns.type", "operator": "in", "value": ["A", "AAAA", "CNAME"] },
					{ "field": "dns.name", "operator": "wildcard", "value": "*.staging.example.com" }
				]
			}
		}
	]
}
```

**Example policy -- read-only access, no mutations:**

```json
{
	"version": "2025-01-01",
	"statement": [
		{
			"effect": "allow",
			"action": ["dns:read"],
			"resource": ["zone:*"]
		}
	]
}
```

**Example policy -- deny proxy toggling on apex records:**

```json
{
	"version": "2025-01-01",
	"statement": [
		{
			"effect": "deny",
			"action": ["dns:update"],
			"resource": ["zone:abc123def456..."],
			"condition": {
				"all": [
					{ "field": "dns.name", "operator": "eq", "value": "example.com" },
					{ "field": "dns.proxied", "operator": "exists" }
				]
			}
		},
		{
			"effect": "allow",
			"action": ["dns:*"],
			"resource": ["zone:abc123def456..."]
		}
	]
}
```

### Implementation Notes

#### Route Structure

```
POST   /v1/zones/:zoneId/dns_records              -> dns:create
GET    /v1/zones/:zoneId/dns_records               -> dns:read (list)
GET    /v1/zones/:zoneId/dns_records/export        -> dns:export
GET    /v1/zones/:zoneId/dns_records/:recordId     -> dns:read (get)
PATCH  /v1/zones/:zoneId/dns_records/:recordId     -> dns:update
PUT    /v1/zones/:zoneId/dns_records/:recordId     -> dns:update
DELETE /v1/zones/:zoneId/dns_records/:recordId     -> dns:delete
POST   /v1/zones/:zoneId/dns_records/batch         -> dns:batch
POST   /v1/zones/:zoneId/dns_records/import        -> dns:import
```

**Important:** The route for `/batch` and `/import` must be matched BEFORE the
`/:recordId` wildcard. Hono matches routes in definition order, so define the
specific POST routes first.

#### Upstream Token Reuse

DNS operations are zone-scoped and use `Authorization: Bearer <token>` -- exactly
the same as cache purge. The existing `UpstreamTokenManager` and its zone-to-token
resolution logic can be reused without modification. A CF API token with `DNS:Edit`
permission on a zone serves both DNS and purge (purge uses `Cache Purge` permission,
so in practice they may be different tokens -- but the resolution logic is identical).

#### Condition Field Extraction

For **create** and **update** (PATCH/PUT), the request body contains all the fields
we need (`name`, `type`, `content`, `proxied`, `ttl`, `comment`, `tags`). Extract
them directly from the parsed JSON body.

For **delete** and **get-by-id**, the request only contains a record ID -- no FQDN.
Two options:

1. **Pre-flight GET (recommended):** Before authorizing a delete/update-by-id, make a
   GET request to `/zones/:zone_id/dns_records/:record_id` using the upstream token
   to resolve the record's FQDN and type. Then authorize against the resolved fields.
   This adds one upstream round-trip but ensures policies cannot be bypassed by
   targeting record IDs directly. Cache the record metadata for the duration of the
   request.

2. **Require name in body:** The CF API accepts `name` in update bodies. For delete,
   this is not possible (DELETE has no body). So pre-flight GET is the only option
   for delete authorization when the policy has `dns.name` conditions.

**Decision: Pre-flight GET for delete/update when the policy has name/type conditions.**
If the policy has no `dns.*` conditions (e.g., `"action": ["dns:*"], "resource": ["zone:abc"]`
with no conditions), skip the pre-flight GET -- the zone-level auth is sufficient.

#### Batch Decomposition

The batch endpoint accepts `{ deletes, patches, puts, posts }` and executes them in
that order. Gatekeeper should:

1. Parse the batch body.
2. For each sub-operation, build a `RequestContext` with the appropriate action
   (`dns:delete`, `dns:update`, `dns:update`, `dns:create`) and condition fields.
3. Authorize ALL sub-operations before forwarding ANY to the upstream.
4. If any sub-operation is denied, reject the entire batch (do not partially execute).
5. For deletes within a batch that need pre-flight resolution: batch-fetch all record
   IDs in a single list call with ID filtering, rather than N individual GETs.
6. Forward the original batch body to CF unchanged.

This mirrors the S3 `DeleteObjects` pattern where each key is individually authorized.

#### Request Collapsing

Request collapsing applies to **read** operations (list, get) but NOT to writes.
DNS reads are a natural fit for collapsing -- multiple callers listing the same zone
with the same filters can share one upstream call.

DNS writes should NOT be collapsed -- each write is a distinct mutation.

#### Analytics (D1)

Log DNS operations to a `dns_events` table in D1, similar to `purge_events` and
`s3_events`:

```sql
CREATE TABLE IF NOT EXISTS dns_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id     TEXT    NOT NULL,
  key_name   TEXT,
  zone_id    TEXT    NOT NULL,
  action     TEXT    NOT NULL,       -- dns:create, dns:read, dns:update, dns:delete, dns:batch
  dns_name   TEXT,                   -- FQDN of the record
  dns_type   TEXT,                   -- A, AAAA, CNAME, TXT, etc.
  record_id  TEXT,                   -- CF record ID (for update/delete)
  batch_size INTEGER,                -- Number of sub-operations (for batch)
  upstream_status INTEGER,           -- HTTP status from CF API
  client_ip  TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dns_zone_time ON dns_events (zone_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dns_key_time  ON dns_events (key_id, created_at DESC);
```

#### New Files (Implemented)

| File                                | Purpose                                             |
| ----------------------------------- | --------------------------------------------------- |
| `src/dns/routes.ts`                 | Hono sub-app for all 9 DNS record endpoints         |
| `src/dns/operations.ts`             | Action classification, condition fields, contexts   |
| `src/dns/analytics.ts`              | D1 event logging, query, and summary                |
| `src/routes/admin-dns-analytics.ts` | Admin analytics endpoints for DNS events/summary    |
| `test/dns.test.ts`                  | 27 integration tests (auth, CRUD, IAM, batch, etc.) |

#### Modified Files

| File                    | Change                                                 |
| ----------------------- | ------------------------------------------------------ |
| `src/schema.ts`         | Added `dns_events` table + indexes SQL                 |
| `src/durable-object.ts` | Added generic `authorize()` RPC method                 |
| `src/index.ts`          | Mounted `dnsRoute`, added `deleteOldDnsEvents` to cron |
| `src/routes/admin.ts`   | Mounted DNS analytics at `/admin/dns/analytics/*`      |

#### Pending Files

| File                                            | Purpose                           |
| ----------------------------------------------- | --------------------------------- |
| `dashboard/src/components/DnsPage.tsx`          | Dashboard page for DNS analytics  |
| `dashboard/src/components/DnsPolicyBuilder.tsx` | DNS-specific policy builder hints |

#### Resolved Questions

- [x] **Same key type** for DNS and purge. Actions differentiate (`purge:*` vs `dns:*`).
      A single key with `["purge:*", "dns:create", "dns:delete"]` and a condition on
      `dns.name` gives an ACME client purge + DNS challenge in one credential.
- [x] **Separate actions** for export/import (`dns:export`, `dns:import`) since import is a
      bulk mutation that bypasses per-record authorization.
- [x] **Shared bulk rate-limit bucket** for DNS and purge. DNS operations consume 1 token
      per request from the bulk bucket. Same global CF API limit applies.

---

## Ruled Out / Deferred

### Workers Deployments

**Reason: Chicken-and-egg problem.** Gatekeeper itself runs on Workers. Proxying the
Workers deployment API through Gatekeeper creates a circular dependency -- a bad deploy
could lock you out of the gateway that manages deploys. Wrangler + CF dashboard are
the right tools for this.

### Firewall / WAF Rulesets

**Reason: Monolithic blob architecture.** The Rulesets API operates on entire phase
rulesets as one JSON blob. You cannot create, update, or delete individual rules via
separate API calls -- it is always a full ruleset PUT. This makes fine-grained IAM
scoping impractical: you would be authorizing "can modify the entire http_request_firewall_custom
phase" which is effectively all-or-nothing. The policy engine's per-action/per-resource
model does not map well here.

### Load Balancers / Pools

**Deferred.** Reasonable fit but lower demand than DNS and analytics. The API is
straightforward (CRUD on pools, origins, monitors) and would map cleanly to the IAM
model. Could be a future candidate if there is demand for delegating pool drain/enable
operations to on-call teams.

### Cloudflare Images / Stream

**Deferred.** Good fit for upload delegation and rate limiting, but these are
account-scoped (not zone-scoped) APIs. Would require extending the resource model
from `zone:<id>` to also support `account:<id>`. Not blocking, but adds scope to v1.

---

## Implementation Priority

| Phase       | API             | Rationale                                                         |
| ----------- | --------------- | ----------------------------------------------------------------- |
| **Phase 1** | DNS Records     | Highest demand, cleanest IAM mapping, reuses zone-scoped patterns |
| **Phase 2** | Evaluate demand | GraphQL Analytics, Load Balancers, Images, etc.                   |

### Phase 1 Task Breakdown (DNS)

| #   | Task                                             | Depends On | Status                             |
| --- | ------------------------------------------------ | ---------- | ---------------------------------- |
| 1   | ~~Define `src/dns/types.ts`~~                    | --         | Skipped (inlined in operations.ts) |
| 2   | Implement `src/dns/operations.ts`                | --         | Done                               |
| 3   | Implement `src/dns/routes.ts`                    | 2          | Done                               |
| 4   | Implement pre-flight GET for delete/update by ID | 3          | Done                               |
| 5   | Implement batch decomposition                    | 3          | Done                               |
| 6   | Implement `src/dns/analytics.ts`                 | --         | Done                               |
| 7   | Wire routes into `src/index.ts`                  | 3          | Done                               |
| 8   | Add `src/routes/admin-dns-analytics.ts`          | 6          | Done                               |
| 9   | Add wrangler.jsonc route patterns                | 7          | N/A (catch-all route)              |
| 10  | Write `test/dns.test.ts` (27 tests)              | 3          | Done                               |
| 11  | ~~Separate test files per concern~~              | --         | Consolidated into test/dns.test.ts |
| 12  | Dashboard: `DnsPage.tsx`                         | 8          | Pending                            |
| 13  | Dashboard: DNS policy builder hints              | --         | Pending                            |
| 14  | CLI: `gk dns-analytics` command                  | 8          | Pending                            |
| 15  | Docs: update API.md, GUIDE.md, SECURITY.md       | all        | Pending                            |

**Implementation notes:**

- Types were inlined in `src/dns/operations.ts` rather than a separate types file (not enough types to justify a separate module).
- Tests were consolidated into a single `test/dns.test.ts` (27 tests) covering auth, CRUD, policy enforcement, batch, export, upstream errors, and analytics.
- DNS uses the generic `authorize()` RPC method added to the Durable Object, which accepts an array of `RequestContext` objects and returns the auth result.
- Pre-flight GET is always performed for DELETE operations (to extract `dns.name` and `dns.type` for policy evaluation).
- Batch operations decompose into individual contexts per sub-operation, all authorized before forwarding.
- DNS shares the bulk rate-limit bucket (1 token per request).
- Retention cron deletes old `dns_events` rows alongside purge and S3 events.

---

## Code Review Findings (for reference)

Issues found during the thorough review that led to this plan. None are blockers
but should be addressed alongside or before new feature work.

### Minor Issues

1. **Per-key bucket eviction is FIFO, not LRU** (`src/durable-object.ts`):
   `Map.keys().next().value` evicts the oldest-inserted key, not least-recently-used.
   An active key created early could be evicted before idle keys created later.

2. **`ensureTables` on every analytics write** (`src/analytics.ts`, `src/s3/analytics.ts`):
   Runs `CREATE TABLE IF NOT EXISTS` on every fire-and-forget log call. A per-isolate
   "initialized" flag would eliminate redundant D1 round-trips.

3. **Regex compiled on every policy evaluation** (`src/policy-engine.ts`):
   `new RegExp(pattern)` in `evalRegex` is called per-evaluation. Caching compiled
   regexes by pattern string would avoid repeated compilation for hot policies.

4. **Access JWT group resolution takes first source only** (`src/auth-access.ts`):
   Checks `body.groups`, `body.custom.groups`, `body.oidc_fields.groups` but breaks
   on the first non-empty one. Groups split across locations are not merged.

5. **RBAC group matching is case-sensitive** (`src/auth-admin.ts`):
   `includes()` for group names. IdPs with inconsistent casing would fail silently.

### Duplicated Constants (Dashboard / Worker)

These are duplicated between the worker and dashboard builds (separate build targets,
so sharing is not trivial, but drift is a risk):

| Constant           | Worker location       | Dashboard location                              |
| ------------------ | --------------------- | ----------------------------------------------- |
| `POLICY_VERSION`   | `src/policy-types.ts` | `dashboard/src/lib/api.ts:9`                    |
| `ADMIN_KEY_HEADER` | `src/constants.ts:30` | `dashboard/src/lib/api.ts:11`                   |
| `ZONE_ID_RE`       | `src/constants.ts:41` | `PurgePage.tsx:11`, `UpstreamTokensPage.tsx:19` |

### Hardcoded Values Audit: Clean

- Logout URL: dynamically constructed from `CF_ACCESS_TEAM_NAME` env var (`src/routes/admin.ts:44`)
- `CF_API_BASE`: canonical Cloudflare API URL, appropriate to hardcode
- All secrets, domains, team names sourced from env vars or DO state
- No hardcoded tokens, IDs, or credentials anywhere in the codebase
