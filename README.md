# Gatekeeper

API gateway on Cloudflare Workers with an AWS IAM-style authorization engine. Fronts the Cloudflare cache purge API and Cloudflare R2 (S3-compatible storage). The IAM layer is service-agnostic — the same policy engine handles both services.

## What it does

1. **IAM policy engine** — fine-grained access control via policy documents. Each API key or S3 credential has an attached policy with actions, resources, and conditions (field/operator/value expressions). Think IAM policies, not flat RBAC.
2. **S3/R2 proxy** — S3-compatible gateway to Cloudflare R2 with per-credential IAM policies. R2's native tokens only support per-bucket read/write — this adds object-level, key-prefix, cross-bucket, and conditional access control. Standard S3 clients (rclone, boto3, aws-cli) work out of the box.
3. **Rate limit headers** — the purge endpoint doesn't return any. This gateway adds `Ratelimit` and `Ratelimit-Policy` (IETF Structured Fields format) so clients know their budget.
4. **Token bucket enforcement** — rejects purge requests client-side before they hit the upstream API. Two buckets: bulk (50/sec, burst 500) and single-file (3,000 URLs/sec, burst 6,000). Enterprise tier defaults.
5. **Request collapsing** — identical concurrent purges get deduplicated at both isolate and Durable Object levels. Only the leader consumes a rate limit token.
6. **Analytics** — every purge and S3 operation is logged to D1. Query events, get summaries, filter by key/credential/zone/bucket/time range.
7. **Dashboard** — Astro SPA served from the same Worker via Static Assets. Overview, key management, S3 credential management, analytics, manual purge.

## Architecture

```
                         ┌─────────────────────────────────────┐
                         │          Cloudflare Access           │
                         │  (identity — who are you?)           │
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
│ (browser) │                               │         │               │        │
└──────────┘                                │         ▼               ▼        │
                                            │  ┌──────────────────────────┐    │
┌──────────┐  AWS Sig V4 (GK creds)        │  │     Service handlers     │    │
│ S3 Client│ ─────────────────────────────▶│  │  ┌─────────┐ ┌────────┐ │    │
│ (rclone, │                               │  │  │  Purge   │ │  S3   │ │    │
│  boto3)  │                               │  │  └─────────┘ └────────┘ │    │
└──────────┘                                │  └──────────────────────────┘    │
                                            └──────────────────────────────────┘
                                                          │
                                   ┌──────────────────────┼───────────────┐
                                   ▼                      ▼               ▼
                         Durable Object            D1 (analytics)   Static Assets
                         - token buckets (purge)                    - dashboard SPA
                         - purge keys (SQLite)
                         - S3 credentials (SQLite)
                         - request collapsing
                                   │
                          ┌────────┴────────┐
                          ▼                 ▼
                api.cloudflare.com    R2 S3 API
                  /purge_cache        (re-signed via aws4fetch)
```

**Identity vs Authorization:** Two separate concerns, deliberately decoupled. Cloudflare Access handles identity (who are you?) via JWT. The IAM engine handles authorization (what can you do?) via policy documents attached to API keys or S3 credentials. Machine clients authenticate via API key (purge) or AWS Sig V4 (S3) and skip Access entirely. Humans authenticate via Access and get implicit admin authorization.

**One DO for the whole gateway.** Holds purge rate limit buckets, purge API keys, and S3 credentials — all in SQLite. The DO soft limit is ~1,000 RPS, well above the Enterprise purge ceiling. S3 credentials use a 60-second in-memory cache for the hot auth path.

**Token bucket is in-memory only.** Not persisted to DO SQLite. If the DO evicts, the bucket resets to full — that's fine, the upstream API is the real enforcer.

---

## Setup

Requires Node.js >= 18 and a Cloudflare account with an API token that has Cache Purge permission.

```bash
git clone https://github.com/erfianugrah/gatekeeper.git
cd gatekeeper
npm install
cd dashboard && npm install && cd ..
```

### Configure `wrangler.jsonc`

1. **Custom domain** — change `gate.erfi.io` to your domain, or remove the `routes` block for `*.workers.dev`:
   ```jsonc
   "routes": [{ "pattern": "purge.yourdomain.com", "custom_domain": true }]
   ```

2. **D1 database** — create one and update the binding:
   ```bash
   npx wrangler d1 create purge-analytics
   # copy the database_id into wrangler.jsonc
   ```

3. **Rate limit vars** — defaults match Enterprise tier. Adjust for your plan.

### Secrets

Local dev — create `.dev.vars`:

```
UPSTREAM_API_TOKEN=<your-cloudflare-api-token>
ADMIN_KEY=<a-strong-secret-for-admin-operations>
R2_ACCESS_KEY_ID=<your-r2-admin-access-key>
R2_SECRET_ACCESS_KEY=<your-r2-admin-secret-key>
R2_ENDPOINT=<your-r2-s3-api-endpoint>
```

The R2 credentials are the **admin-level** S3 API token for your Cloudflare account. Generate one in the Cloudflare dashboard under R2 → Manage R2 API Tokens. The endpoint format is `https://<account_id>.r2.cloudflarestorage.com`. These are only needed if you use the S3 proxy feature.

Production:

```bash
npx wrangler secret put UPSTREAM_API_TOKEN
npx wrangler secret put ADMIN_KEY
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put R2_ENDPOINT
```

Optional (for Cloudflare Access identity):

```bash
npx wrangler secret put CF_ACCESS_TEAM_NAME
npx wrangler secret put CF_ACCESS_AUD
```

### Dev / Build / Deploy

```bash
npm run dev              # wrangler dev (local)
npm run build            # build dashboard + CLI
npm run deploy           # build dashboard, then wrangler deploy
npm test                 # run all tests (367 across worker + CLI)
npm run test:worker      # worker tests only
npm run test:cli         # CLI tests only
npx wrangler types       # regenerate types after changing wrangler.jsonc
```

On first deploy, wrangler creates the DO namespace and runs the SQLite migration automatically.

---

## Configuration

All in `wrangler.jsonc` vars. Strings, cast to numbers in code.

| Variable | Default | What it does |
|----------|---------|--------------|
| `BULK_RATE` | `50` | Bulk purge refill rate (tokens/sec) |
| `BULK_BUCKET_SIZE` | `500` | Bulk purge burst capacity |
| `BULK_MAX_OPS` | `100` | Max items per bulk request |
| `SINGLE_RATE` | `3000` | Single-file refill rate (URLs/sec) |
| `SINGLE_BUCKET_SIZE` | `6000` | Single-file burst capacity |
| `SINGLE_MAX_OPS` | `500` | Max URLs per request |
| `KEY_CACHE_TTL_MS` | `60000` | IAM key/credential cache lifetime in the DO (ms). Applies to both purge keys and S3 credentials. |
| `RETENTION_DAYS` | `30` | D1 analytics retention — cron deletes older purge and S3 events daily at 03:00 UTC |

---

## IAM Policy Engine

Each API key has a policy document — a JSON structure with statements, modeled after AWS IAM.

### Concepts

| Concept | AWS IAM equivalent | Our system |
|---------|-------------------|------------|
| **Principal** | IAM user / role | API key holder (key ID) or Access-authenticated user (email) |
| **Action** | `s3:GetObject` | `purge:url`, `purge:host`, `purge:tag`, `s3:GetObject`, `s3:PutObject` |
| **Resource** | `arn:aws:s3:::bucket/*` | `zone:<zone-id>`, `bucket:<name>`, `object:<bucket>/<key>` |
| **Condition** | `StringLike`, `IpAddress` | Expression engine: `eq`, `contains`, `starts_with`, `matches`, etc. |
| **Effect** | Allow / Deny | Allow only (deny-by-default). Explicit deny can be added later. |
| **Policy** | IAM policy document | JSON document with statements, attached to API keys |

### Policy document

```json
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow",
      "actions": ["purge:host", "purge:tag"],
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

**Purge service:**

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

**S3/R2 service:**

| Action | Description |
|--------|-------------|
| `s3:GetObject` | Read objects (also covers HeadObject) |
| `s3:PutObject` | Write objects (also covers CopyObject, multipart upload) |
| `s3:DeleteObject` | Delete objects (single and batch) |
| `s3:ListBucket` | List bucket contents (v1 and v2) |
| `s3:ListAllMyBuckets` | List all buckets |
| `s3:CreateBucket` | Create bucket |
| `s3:DeleteBucket` | Delete bucket |
| `s3:AbortMultipartUpload` | Abort multipart upload |
| `s3:ListMultipartUploadParts` | List parts of a multipart upload |
| `s3:*` | All S3 actions (66 operations mapped) |

### Resources

Typed identifiers with optional wildcards.

| Pattern | Matches |
|---------|---------|
| `zone:<id>` | Specific zone (purge service) |
| `zone:*` | All zones |
| `bucket:<name>` | Specific R2 bucket (S3 service) |
| `bucket:staging-*` | Buckets matching prefix |
| `object:<bucket>/<key>` | Specific object |
| `object:<bucket>/*` | All objects in a bucket |
| `object:<bucket>/public/*` | Objects under a key prefix |
| `account:*` | Account-level (ListBuckets) |
| `*` | Everything (dangerous — use sparingly) |

Matching rules:
- Exact: `zone:abc` matches `zone:abc`
- Wildcard suffix: `zone:*` matches any zone, `bucket:prod-*` matches `bucket:prod-images`
- Universal: `*` matches any resource

### Condition operators

| Operator | Types | Description |
|----------|-------|-------------|
| `eq` | string, bool | Exact equality (case-sensitive) |
| `ne` | string, bool | Not equal |
| `contains` | string | Substring match |
| `not_contains` | string | Substring exclusion |
| `starts_with` | string | Prefix match |
| `ends_with` | string | Suffix match |
| `matches` | string | Regex match (max 256 chars, catastrophic backtracking rejected at key creation) |
| `not_matches` | string | Regex exclusion |
| `in` | string | Value in a set (`{"value": ["a", "b"]}`) |
| `not_in` | string | Value not in set |
| `wildcard` | string | Glob-style (`*` = any chars) |
| `exists` | any | Field is present |
| `not_exists` | any | Field is absent |

### Condition fields (purge service)

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

**S3/R2 service:**

| Field | Source | Description |
|-------|--------|-------------|
| `bucket` | Parsed from path | Bucket name |
| `key` | Parsed from path | Full object key |
| `key.prefix` | Derived from key | Key prefix (up to last `/`) |
| `key.filename` | Derived from key | Filename after last `/` |
| `key.extension` | Derived from key | File extension |
| `method` | HTTP method | `GET`, `PUT`, `DELETE`, etc. |
| `content_type` | `Content-Type` header | MIME type |
| `content_length` | `Content-Length` header | Request body size |
| `source_bucket` | `x-amz-copy-source` | Copy source bucket |
| `source_key` | `x-amz-copy-source` | Copy source key |
| `list_prefix` | `?prefix=` query param | List operations prefix filter |

The expression engine is **service-agnostic** — it evaluates conditions against a `Record<string, string | boolean | string[]>`. Each service handler is responsible for building the request context from the incoming request.

### Compound conditions

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

Top-level conditions: AND. `any: [...]`: OR. `all: [...]`: explicit AND. `not: {...}`: negation.

Most policies won't need compound conditions. Multiple statements with different conditions handle most OR cases naturally.

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
  ├── /s3/*
  │     │
  │     ├── Verify AWS Sig V4 (header auth or presigned URL)
  │     ├── Look up credential by access_key_id → get policy + secret
  │     ├── Verify signature against stored secret
  │     ├── Detect S3 operation from HTTP method + path + query params
  │     ├── Build request context (bucket, key, key.prefix, content_type, etc.)
  │     ├── Evaluate policy: any statement allows (action + resource + conditions)?
  │     │     ├── Yes → re-sign with admin R2 creds (aws4fetch) → forward to R2
  │     │     └── No  → 403 AccessDenied
  │     └── Log: credential_id, operation, bucket, key, status, duration
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

**Wildcard — full access to one zone:**
```json
{
  "version": "2025-01-01",
  "statements": [{
    "effect": "allow",
    "actions": ["purge:*"],
    "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
  }]
}
```

**CI/CD key — only purge tags matching a release pattern:**
```json
{
  "version": "2025-01-01",
  "statements": [{
    "effect": "allow",
    "actions": ["purge:tag"],
    "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"],
    "conditions": [
      { "field": "tag", "operator": "matches", "value": "^release-v[0-9]+\\.[0-9]+$" }
    ]
  }]
}
```

**Scoped — only purge specific hosts by URL or tag:**
```json
{
  "version": "2025-01-01",
  "statements": [{
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
  }]
}
```

**Multi-zone with host restriction:**
```json
{
  "version": "2025-01-01",
  "statements": [{
    "effect": "allow",
    "actions": ["purge:url", "purge:host"],
    "resources": ["zone:*"],
    "conditions": [
      { "field": "host", "operator": "ends_with", "value": ".example.com" }
    ]
  }]
}
```

**S3 — read-only access to a bucket prefix:**
```json
{
  "version": "2025-01-01",
  "statements": [{
    "effect": "allow",
    "actions": ["s3:GetObject", "s3:ListBucket"],
    "resources": ["object:my-assets/public/*", "bucket:my-assets"],
    "conditions": [
      { "field": "key.prefix", "operator": "starts_with", "value": "public/" }
    ]
  }]
}
```

**S3 — full access to one bucket, read-only to another:**
```json
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow",
      "actions": ["s3:*"],
      "resources": ["bucket:staging", "object:staging/*"]
    },
    {
      "effect": "allow",
      "actions": ["s3:GetObject", "s3:ListBucket"],
      "resources": ["bucket:production", "object:production/*"]
    }
  ]
}
```

**S3 — restrict uploads by content type and key extension:**
```json
{
  "version": "2025-01-01",
  "statements": [{
    "effect": "allow",
    "actions": ["s3:PutObject"],
    "resources": ["object:media/*"],
    "conditions": [
      { "field": "key.extension", "operator": "in", "value": ["jpg", "png", "webp"] },
      { "field": "content_type", "operator": "starts_with", "value": "image/" }
    ]
  }]
}
```

### Regex safety

- Max pattern length: 256 characters
- Reject patterns with known catastrophic backtracking constructs (nested quantifiers: `(a+)+`, `(a*)*`)
- Compile with `new RegExp()` — catch syntax errors at key creation time, not at request time
- Cache compiled regexes per key in the DO (alongside the key cache, same 60s TTL)
- No lookbehind/lookahead (reject at validation)

### API key schema

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,                    -- random ID (e.g., gw_xxxxxxxxxxxx)
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

Key prefix is `gw_*` (gateway). The old `pgw_*` prefix is no longer supported — all code referencing it has been removed.

### V1 scope system (removed)

The v1 scope system (`key_scopes` table, `KeyScope` type, `ScopeType` enum, `migrateV1Scopes()`, v1 RPC methods) has been completely removed. The project is not in production use yet, so no backward compatibility is needed. All keys now require a `policy: PolicyDocument` at creation time.

---

## API

Full spec: [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1).

### `GET /health`

Returns `{"ok": true}`.

### `POST /v1/zones/:zoneId/purge_cache`

Proxies to the Cloudflare purge API. Same request body format. Requires `Authorization: Bearer gw_<key_id>`.

**Single-file** (1 token per URL from the `single` bucket):
```json
{"files": ["https://example.com/page.html", "https://example.com/style.css"]}
```

Files can be objects: `{"url": "https://...", "headers": {"CF-Device-Type": "mobile"}}`

**Bulk** (1 token from the `bulk` bucket):
```json
{"hosts": ["example.com"]}
{"tags": ["product-page", "header"]}
{"prefixes": ["example.com/blog/"]}
{"purge_everything": true}
```

#### Cache key purging

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

The policy condition engine evaluates against headers and parsed URL components, not just the raw URL string. For `files[]` with multiple entries, each entry is evaluated independently — if **any** entry fails the policy check, the entire request is denied. For bulk types (`hosts[]`, `tags[]`, `prefixes[]`), each value in the array is evaluated as a separate context.

#### Response headers

```
Ratelimit: "purge-bulk";r=499;t=0
Ratelimit-Policy: "purge-bulk";q=500;w=10
```

IETF Structured Fields format. `r` = remaining, `t` = retry-after seconds, `q` = capacity, `w` = window. On 429, `Retry-After` is also set.

Non-200 responses from the upstream Cloudflare API (429, 500, etc.) are passed through with their original status code and body.

#### Errors

| Status | Cause |
|--------|-------|
| 400 | Bad zone ID, invalid JSON, unrecognized body, oversized request |
| 401 | Missing/invalid auth header, unknown key |
| 403 | Revoked, expired, wrong zone, or policy denial. Response includes `denied` array. |
| 429 | Rate limited. Has `Retry-After`. |
| 502 | Upstream network error |

---

---

### S3 proxy — `GET|PUT|POST|DELETE|HEAD /s3/*`

S3-compatible proxy to Cloudflare R2 with per-credential IAM policies. Clients use standard S3 SDKs pointed at `https://<gateway>/s3` as the endpoint. Path-style addressing only (no virtual-hosted buckets).

#### Why

R2's native API tokens are bucket-level only. No key-prefix scoping, no object-level permissions, no cross-bucket mixed policies, no conditional access. Gatekeeper sits in front with a full-admin R2 token and applies AWS IAM-style policies per credential.

#### Client setup (rclone example)

```ini
[gatekeeper]
type = s3
provider = Other
endpoint = https://gate.erfi.io/s3
access_key_id = GK1A2B3C4D5E6F7890AB
secret_access_key = <your-secret-key>
```

Then: `rclone ls gatekeeper:my-bucket/prefix/`

Works the same with boto3, aws-cli, or any S3-compatible SDK — set the endpoint URL and provide the GK credentials.

#### Authentication

Two modes, both using AWS Signature Version 4:

1. **Header auth** — standard `Authorization: AWS4-HMAC-SHA256 Credential=GK.../...` header. Sent automatically by S3 clients.
2. **Presigned URLs** — query-string auth via `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Signature`, etc. Max expiry: 604,800 seconds (7 days).

Credentials are issued via `POST /admin/s3/credentials`. The `access_key_id` has a `GK` prefix (20 chars total). The `secret_access_key` is 64 hex chars. Both are generated server-side.

#### Supported operations

66 S3 operations are detected for IAM policy evaluation. All are forwarded to R2 — R2 handles its own errors for unsupported operations (501 NotImplemented, 404, etc.).

**26 R2-native operations** (fully functional):

| Category | Operations |
|----------|------------|
| Buckets | ListBuckets, HeadBucket, CreateBucket, DeleteBucket, GetBucketLocation, GetBucketEncryption |
| Bucket config | GetBucketCors, PutBucketCors, DeleteBucketCors, GetBucketLifecycle, PutBucketLifecycle |
| Listing | ListObjects, ListObjectsV2, ListMultipartUploads |
| Objects | GetObject, HeadObject, PutObject, CopyObject, DeleteObject, DeleteObjects |
| Multipart | CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload, ListParts |

**40 extended operations** (detected for IAM, forwarded to R2 which returns its own errors):

Tagging, ACLs, versioning, policy, website, logging, notifications, replication, object lock, retention, legal hold, public access block, accelerate, request payment, object ACL, restore, select.

#### Batch delete

`POST /<bucket>?delete` (DeleteObjects) parses the XML body and authorizes each key individually as a separate `s3:DeleteObject` action. If any key is denied by the IAM policy, the entire batch is rejected.

#### S3 errors

The proxy returns standard S3 XML error responses:

| Status | Cause |
|--------|-------|
| 400 | Malformed Sig V4 auth, bad request |
| 403 | Bad signature, revoked credential, expired credential, IAM policy denial |
| 501 | Operation not implemented by R2 (returned by R2 itself) |

All other R2 responses (404, 409, etc.) are passed through unchanged.

---

### Admin endpoints

All require either `X-Admin-Key: <admin_key>` or a valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header / `CF_Authorization` cookie).

#### `POST /admin/keys` — create key

```json
{
  "name": "my-service-key",
  "zone_id": "<zone_id>",
  "expires_in_days": 90,
  "policy": {
    "version": "2025-01-01",
    "statements": [{
      "effect": "allow",
      "actions": ["purge:host"],
      "resources": ["zone:<zone_id>"],
      "conditions": [
        { "field": "host", "operator": "eq", "value": "example.com" }
      ]
    }]
  },
  "rate_limit": {
    "bulk_rate": 10,
    "bulk_bucket": 20
  }
}
```

`name`, `zone_id`, and `policy` are required. The response includes the key ID (`gw_<hex>`) — this is the Bearer token. Show it once to the user.

Policy is validated at creation time: version must be `2025-01-01`, statements must have `effect: "allow"`, regex patterns are checked for catastrophic backtracking, per-key rate limits can't exceed account defaults.

#### `GET /admin/keys?zone_id=<zone_id>[&status=active|revoked]` — list keys

#### `GET /admin/keys/:id?zone_id=<zone_id>` — get key details

#### `DELETE /admin/keys/:id?zone_id=<zone_id>` — revoke key

Soft delete. Sets `revoked = 1`. Cleans up any per-key rate limit buckets.

#### `GET /admin/analytics/events?zone_id=<zone_id>[&key_id=...][&since=...][&until=...][&limit=...]`

Returns purge events from D1. `since`/`until` are unix ms. `limit` defaults to 100, max 1000.

#### `GET /admin/analytics/summary?zone_id=<zone_id>[&key_id=...][&since=...][&until=...]`

Returns `total_requests`, `total_urls_purged`, `by_status`, `by_purge_type`, `collapsed_count`, `avg_duration_ms`.

#### `POST /admin/s3/credentials` — create S3 credential

```json
{
  "name": "cdn-reader",
  "policy": {
    "version": "2025-01-01",
    "statements": [{
      "effect": "allow",
      "actions": ["s3:GetObject", "s3:ListBucket"],
      "resources": ["object:my-bucket/public/*", "bucket:my-bucket"]
    }]
  },
  "expires_in_days": 90
}
```

`name` and `policy` are required. The response includes both `access_key_id` (GK prefix) and `secret_access_key` — the secret is only shown once.

#### `GET /admin/s3/credentials[?status=active|revoked]` — list S3 credentials

Returns all credentials with secrets redacted.

#### `GET /admin/s3/credentials/:id` — get S3 credential details

Returns credential metadata with secret redacted.

#### `DELETE /admin/s3/credentials/:id` — revoke S3 credential

Soft revoke. The credential is immediately rejected on subsequent S3 requests (up to 60s cache TTL).

#### `GET /admin/s3/analytics/events[?credential_id=...][&bucket=...][&operation=...][&since=...][&until=...][&limit=...]`

Returns S3 proxy events from D1. Account-level (no zone_id required). `limit` defaults to 100, max 1000.

#### `GET /admin/s3/analytics/summary[?credential_id=...][&bucket=...][&operation=...][&since=...][&until=...]`

Returns `total_requests`, `by_status`, `by_operation` (top 20), `by_bucket` (top 20), `avg_duration_ms`.

### OpenAPI specification

The OpenAPI 3.1 spec (`openapi.yaml`) documents all gateway endpoints across 7 tags (System, Purge, Keys, Analytics, S3Credentials, S3Analytics, S3Proxy) with four security schemes: `ApiKeyAuth` (bearer), `AdminKeyAuth` (X-Admin-Key header), `CloudflareAccess` (Cf-Access-Jwt-Assertion header), and `S3SigV4Auth` (AWS Sig V4).

Decisions:
- **OpenAPI 3.1** (not 3.0) — supports JSON Schema 2020-12 natively, `null` types, `const`
- **Single file** — the API surface is small enough; no need for multi-file `$ref` splitting
- **Hand-written, not generated** — keeps the spec readable and intentional

---

## Auth tiers

| Tier | Principal | Mechanism | Routes |
|------|-----------|-----------|--------|
| API key (`gw_*`) | Services, CI/CD | `Authorization: Bearer gw_...` | `/v1/*` |
| S3 credential (`GK*`) | S3 clients | AWS Sig V4 (header or presigned URL) | `/s3/*` |
| Access JWT | Humans (dashboard) | `Cf-Access-Jwt-Assertion` / cookie | `/admin/*`, `/dashboard/*` |
| Admin key | CLI, automation | `X-Admin-Key` header | `/admin/*` |

Admin key comparison uses HMAC-SHA256 + `crypto.subtle.timingSafeEqual` to prevent timing attacks.

### Identity: Cloudflare Access

Access is configured as a **self-hosted application**. It gates `/admin/*` and `/dashboard/*`. When a browser hits these paths, Access redirects to the configured IdP (Google, GitHub, SAML, OTP, etc.). After login, Access injects:

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

#### Access application setup

1. Cloudflare One → Access → Applications → Add → Self-hosted
2. Domain: your gateway domain
3. Paths: `/admin/*`, `/dashboard/*` (leave `/v1/*` and `/health` unprotected)
4. Policy: Allow → emails/groups you control
5. Copy the **Application Audience (AUD) tag**

#### Identity decisions

- **No `jose`.** `crypto.subtle` does RSA verification natively. ~60 lines vs ~50KB dependency.
- **No `workers-oauth-provider`.** We don't need to be an OAuth provider. We're a resource server that validates Access JWTs for identity, and uses our own IAM for authorization. The `workers-oauth-provider` library is for when third-party clients need to do OAuth with your server (MCP servers, API-as-a-service). If we need that later, it's additive — doesn't affect the IAM design.
- **Self-hosted Access app, not SaaS.** SaaS apps are for when Access acts as an OIDC IdP to external services. Self-hosted is for protecting your own origin.
- **JWKS cache.** In-memory, 1-hour TTL. Access key rotation is infrequent.

---

## Rate limiting

### Token bucket

Two buckets per account, lazy-refill:

| Bucket | Rate | Capacity | Applies to |
|--------|------|----------|------------|
| `purge-single` | 3,000/sec | 6,000 | `files` (1 token per URL) |
| `purge-bulk` | 50/sec | 500 | `hosts`, `tags`, `prefixes`, `purge_everything` |

If the gateway's bucket says no, 429 without touching Cloudflare. If the upstream returns 429 anyway, the local bucket drains to zero and the 429 is forwarded.

### Per-key rate limits

Optional. Set `rate_limit` when creating the key. Checked before the account-level bucket. Per-key 429s use different header names (`purge-bulk-key` / `purge-single-key`).

### Request collapsing

1. **Isolate-level** — `Map<string, Promise<PurgeResult>>`. Identical requests in the same isolate share the leader's result.
2. **DO-level** — same, but inside the DO before the upstream fetch.

Both have a 50ms grace window. Collapsed requests show as `collapsed: "isolate"` or `collapsed: "do"` in analytics.

---

## Dashboard

Astro 5 + React 19 + Tailwind CSS 4 + shadcn/ui + Recharts. Served at `/dashboard/` via Workers Static Assets with SPA fallback.

Pages: overview (stats, charts), keys (CRUD, policy display), analytics (event log, summary), manual purge form.

### Design

Inspired by the layout and component patterns of **gloryhole** (HTMX surveillance-terminal dashboard) and **caddy-compose/waf-dashboard** (Astro + React + shadcn), using the **Lovelace** color scheme from iTerm2.

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

#### Layout

Fixed sidebar + header shell:

```
+--[SIDEBAR w-60]---+--[HEADER h-14]--------------------+
| Shield logo       | Page title     Status dot (pulse)  |
| + "GATEKEEPER"    +------------------------------------+
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
    "run_worker_first": ["/v1/*", "/admin/*", "/health", "/s3/*"]
  }
}
```

`/v1/*`, `/admin/*`, `/health`, `/s3/*` hit the Hono Worker. Everything else serves the SPA.

**Astro 5 static output mode** — no SSR, no adapter. Astro pre-renders to HTML/JS/CSS. The dashboard is a client-side SPA with React islands fetching from `/admin/*`.

**Separate workspace** — `dashboard/` has its own `package.json`. Build pipeline: `cd dashboard && npm run build` → output to `dashboard/dist/` → `wrangler deploy` picks it up via assets config.

### Dashboard pages

| Route | Content |
|-------|---------|
| `/dashboard` | Summary stat cards (total requests, by-status, collapsed %, avg latency). Traffic timeline chart (Recharts area). Purge type distribution (donut). Top zones bar chart. Recent events feed. Time range selector. |
| `/dashboard/keys` | Key list table (filterable by zone/status, sortable). Create key dialog with policy builder. Revoke with confirmation dialog. |
| `/dashboard/keys/:id` | Key detail: policy document (syntax-highlighted JSON), rate limit config, created_by, per-key analytics charts. |
| `/dashboard/analytics` | Event log table with filter bar (zone, key, status, action, time range). Expandable rows with detail panels. Pagination. CSV export. |
| `/dashboard/purge` | Manual purge form: select type (URL/host/tag/prefix/everything), enter values, zone picker, submit. Live rate limit status display. |

### Key creation flow in dashboard

The "create key" form has a **policy builder UI** (similar to caddy-compose's condition builder):

1. Add statements (action checkboxes, resource input, condition builder)
2. Condition builder: pick field → pick operator → enter value. Add/remove conditions.
3. Preview the generated policy JSON (syntax-highlighted, read-only)
4. Submit → `POST /admin/keys` with the policy document
5. Key created with `created_by` from Access JWT email
6. Show the secret key **once** in a copy-to-clipboard dialog

### Key components

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

## CLI

`gk` — built with [citty](https://github.com/unjs/citty). Colored output, spinners, `--json` flag.

```bash
npm run cli -- health
npm run cli -- keys create --name test --zone-id <id> --policy '{"version":"2025-01-01","statements":[...]}'
npm run cli -- keys list --zone-id <id>
npm run cli -- keys get --key-id gw_...  --zone-id <id>
npm run cli -- keys revoke --key-id gw_... --zone-id <id>
npm run cli -- purge hosts --host example.com --zone-id <id>
npm run cli -- purge tags --tag blog --zone-id <id>
npm run cli -- purge urls --url https://example.com/page --zone-id <id>
npm run cli -- purge everything --zone-id <id> [-f]
npm run cli -- analytics events --zone-id <id>
npm run cli -- analytics summary --zone-id <id>
npm run cli -- s3-credentials create --name my-cred --policy '{"version":"2025-01-01","statements":[...]}'
npm run cli -- s3-credentials list [--active-only]
npm run cli -- s3-credentials get --access-key-id GK...
npm run cli -- s3-credentials revoke --access-key-id GK... [-f]
```

Config via env vars (`GATEKEEPER_URL`, `GATEKEEPER_ADMIN_KEY`, `GATEKEEPER_API_KEY`, `GATEKEEPER_ZONE_ID`) or flags. Flags take precedence.

---

## Tests

367 tests across 13 test files:

```bash
npm test              # all (vitest workspace: worker + CLI)
npm run test:worker   # worker tests only (Cloudflare Workers runtime via @cloudflare/vitest-pool-workers)
npm run test:cli      # CLI tests only (Node.js)
```

| File | Tests | What |
|------|-------|------|
| `test/s3-e2e.test.ts` | 102 | S3 proxy end-to-end: header auth, presigned URLs, batch delete, analytics, special chars |
| `test/s3-operations.test.ts` | 64 | S3 path parsing + operation detection (66 operations) |
| `test/policy-engine.test.ts` | 45 | All operators, compound conditions, regex safety, edge cases |
| `test/iam.test.ts` | 30 | DO-level IAM with v2 policies, key CRUD, auth gates |
| `test/purge.test.ts` | 29 | Full request flow, auth, body validation, all purge types, rate limiting |
| `test/token-bucket.test.ts` | 16 | Consume, refill, drain, clock skew, fractional tokens |
| `cli/cli.test.ts` | 16 | Policy parsing, config resolution |
| `test/auth-access.test.ts` | 14 | Access JWT validation with mock RSA keys, expiry, JWKS caching |
| `test/perf.test.ts` | 13 | Performance benchmarks |
| `test/admin.test.ts` | 12 | Admin auth, key lifecycle, validation |
| `test/s3-sigv4.test.ts` | 10 | Sig V4 parsing + auth rejection |
| `test/s3-credentials.test.ts` | 9 | S3 credential CRUD |
| `test/analytics.test.ts` | 9 | D1 event logging, filtering, summary |

Smoke tests: `./smoke-test.sh` (120 tests against a running `wrangler dev` instance).

---

## Logging

One JSON object per request via `console.log`. Cloudflare observability picks it up.

```json
{
  "route": "purge",
  "method": "POST",
  "zoneId": "abc123...",
  "purgeType": "bulk",
  "cost": 1,
  "keyId": "gw_a1b2c3d4...",
  "collapsed": false,
  "rateLimitAllowed": true,
  "rateLimitRemaining": 499,
  "upstreamStatus": 200,
  "status": 200,
  "durationMs": 102
}
```

---

## Project layout

```
wrangler.jsonc                   Worker config: DO, D1, Static Assets, rate limits, cron
openapi.yaml                     OpenAPI 3.1 spec (all endpoints)
PLAN.md                          S3/R2 proxy design document
smoke-test.sh                    120-case smoke test suite
src/
  index.ts                       Entrypoint: Hono app + cron (mounts s3App, purge+S3 retention)
  durable-object.ts              PurgeRateLimiter DO (purge rate limiting, IAM keys, S3 credentials)
  routes/
    purge.ts                     POST /v1/zones/:zoneId/purge_cache
    admin.ts                     Admin sub-app (key CRUD, S3 credential CRUD, analytics)
  types.ts                       Shared types (HonoEnv, purge types, IAM types)
  policy-types.ts                PolicyDocument, Statement, Condition, RequestContext
  policy-engine.ts               evaluatePolicy(), validatePolicy()
  auth-access.ts                 Cloudflare Access JWT validation (~80 lines, no deps)
  iam.ts                         IamManager: createKey, authorize, authorizeFromBody
  token-bucket.ts                Token bucket (lazy refill, no I/O)
  analytics.ts                   D1 analytics for purge (events, summary, retention)
  env.d.ts                       Env type extensions (R2_* secrets)
  s3/
    types.ts                     S3Credential, S3Operation, SigV4Components (66 operations)
    operations.ts                detectOperation (66 ops), parsePath, buildConditionFields
    iam.ts                       S3CredentialManager (CRUD, 60s cache, auth)
    sig-v4-verify.ts             verifySigV4 (header), verifySigV4Presigned (query)
    sig-v4-sign.ts               forwardToR2 via aws4fetch (re-signing, param stripping)
    routes.ts                    Hono sub-app: auth, batch delete, analytics logging
    analytics.ts                 D1 analytics for S3 (logS3Event, queryS3Events, queryS3Summary)
cli/
  index.ts                       Entry point (citty)
  client.ts                      HTTP client
  ui.ts                          Colors, spinners, tables
  commands/
    health.ts                    gk health
    keys.ts                      gk keys {create,list,get,revoke}
    purge.ts                     gk purge {hosts,tags,prefixes,urls,everything}
    analytics.ts                 gk analytics {events,summary}
    s3-credentials.ts            gk s3-credentials {create,list,get,revoke}
test/                            13 test files (367 tests)
dashboard/
  src/                           Astro 5 + React 19 + Tailwind 4 + shadcn/ui + Recharts
    components/
      S3CredentialsPage.tsx      S3 credential CRUD UI
      S3PolicyBuilder.tsx        Visual S3 policy editor
  dist/                          Built output (served via Static Assets)
```

---

## Dependencies

| Package | What |
|---------|------|
| `hono` | Routing (Worker runtime dep) |
| `aws4fetch` | AWS Sig V4 re-signing for R2 outbound requests |
| `wrangler` | Dev/build/deploy |
| `vitest` + `@cloudflare/vitest-pool-workers` | Tests in Workers runtime |
| `citty` | CLI framework |
| `tsx` | Runs CLI without build |
| `astro` + `react` + `tailwindcss` + `recharts` | Dashboard |

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Regex ReDoS in conditions | DO CPU spike, 1102 errors | Max 256 chars, reject nested quantifiers, validate at credential creation |
| Policy evaluation overhead | Latency on every request | Cache compiled conditions per key. Short-circuit: no conditions = instant allow. |
| S3 Sig V4 verification overhead | +2-5ms per S3 request | HMAC-SHA256 via `crypto.subtle` is fast. Credential cache (60s TTL) avoids DO round-trips. |
| S3 credential cache staleness | Revoked cred works up to 60s | Acceptable trade-off for performance. Cache TTL is configurable via `KEY_CACHE_TTL_MS`. |
| R2 admin token exposure | Full R2 access if leaked | Token is a wrangler secret, never in code. Only used server-side for re-signing. |
| Dashboard bundle size | Slow first load | Code split per route, lazy-load charts, precompress with brotli |
| Access JWT validation latency | +10-50ms per admin request | Cache JWKS in-memory (1h TTL), `crypto.subtle.verify` is fast |
| Policy schema too rigid for future services | Refactoring later | Version field in policy doc. Engine dispatches on version. |
| Static assets + Worker in same deploy | Build complexity | Separate build scripts, CI runs dashboard build then wrangler deploy |


