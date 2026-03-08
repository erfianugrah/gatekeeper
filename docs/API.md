# Gatekeeper API Reference

Complete reference for the Gatekeeper API gateway (v1.0.0). All endpoints are documented with request/response shapes, authentication requirements, and error codes.

The machine-readable OpenAPI 3.1 specification is available at [`openapi.json`](../openapi.json). It is auto-generated from the Zod schemas defined in `src/routes/admin-schemas.ts`.

---

## Table of Contents

- [Authentication](#authentication)
- [Standard Response Envelope](#standard-response-envelope)
- [Rate Limit Headers](#rate-limit-headers)
- [1. System](#1-system)
- [2. Purge](#2-purge)
- [3. Keys](#3-keys)
- [4. Analytics](#4-analytics)
- [5. S3 Credentials](#5-s3-credentials)
- [6. S3 Analytics](#6-s3-analytics)
- [7. DNS Proxy](#7-dns-proxy)
- [8. DNS Analytics](#8-dns-analytics)
- [9. S3 Proxy](#9-s3-proxy)
- [10. Upstream Tokens](#10-upstream-tokens)
- [11. Upstream R2](#11-upstream-r2)
- [12. Config](#12-config)

---

## Authentication

Four security schemes are used across the API:

| Scheme               | Header / Mechanism                                                                                             | Used By                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **ApiKeyAuth**       | `Authorization: Bearer gw_<key_id>`                                                                            | Purge endpoint, DNS proxy              |
| **AdminKeyAuth**     | `X-Admin-Key: <admin_key>`                                                                                     | All `/admin/*` endpoints               |
| **CloudflareAccess** | `Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie                                                  | All `/admin/*` endpoints (alternative) |
| **S3SigV4Auth**      | AWS Signature Version 4 (`Authorization: AWS4-HMAC-SHA256 Credential=GK.../...`) or presigned URL query params | S3 proxy endpoints                     |

Admin endpoints accept either `AdminKeyAuth` or `CloudflareAccess`. Both are not required simultaneously.

---

## Standard Response Envelope

All JSON endpoints follow the Cloudflare API response envelope convention.

**Success:**

```json
{
  "success": true,
  "result": { ... }
}
```

**Error:**

```json
{
	"success": false,
	"errors": [{ "code": 400, "message": "Invalid JSON body" }]
}
```

The `errors` array contains one or more `ApiError` objects, each with an integer `code` and a `message` string. Validation errors may include multiple entries with dotted paths (e.g., `"policy.statements: Required"`).

---

## Rate Limit Headers

Purge responses include rate limit information in IETF Structured Fields format:

```
Ratelimit: "purge-bulk";r=499;t=0
Ratelimit-Policy: "purge-bulk";q=500;w=10
```

| Field | Meaning                                    |
| ----- | ------------------------------------------ |
| `r`   | Remaining tokens                           |
| `t`   | Retry-after seconds (0 when not throttled) |
| `q`   | Bucket capacity                            |
| `w`   | Window size in seconds                     |

On `429 Too Many Requests`, a standard `Retry-After` header is also included.

Additional purge response headers:

| Header                    | Description                          |
| ------------------------- | ------------------------------------ |
| `X-Ratelimit-Remaining`   | Remaining rate-limit tokens          |
| `X-Ratelimit-Reset`       | Seconds until bucket refill          |
| `X-Ratelimit-Bucket-Size` | Bucket capacity                      |
| `X-Ratelimit-Rate`        | Refill rate (tokens/sec)             |
| `X-Purge-Flight-Id`       | Stable ID linking collapsed requests |

---

## 1. System

### `GET /health`

Health check. No authentication required.

**Response `200`:**

```json
{ "ok": true }
```

---

## 2. Purge

### `POST /v1/zones/:zoneId/purge_cache`

Proxies to the Cloudflare cache purge API with IAM policy authorization, token-bucket rate limiting, and request collapsing. The request body must contain exactly one purge type.

**Auth:** `Authorization: Bearer gw_<key_id>`

**Path parameters:**

| Param    | Type   | Required | Description                                              |
| -------- | ------ | -------- | -------------------------------------------------------- |
| `zoneId` | string | yes      | 32-character hex Cloudflare zone ID (`/^[a-f0-9]{32}$/`) |

**Request body** -- exactly one of the following five variants:

#### Variant 1: Single-file purge

Costs 1 token per URL from the `single` bucket.

```json
{
	"files": ["https://example.com/page.html", "https://example.com/style.css"]
}
```

Files can also be objects with custom cache key headers:

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

#### Variant 2: Purge by hosts

Costs 1 token from the `bulk` bucket.

```json
{ "hosts": ["example.com"] }
```

#### Variant 3: Purge by tags

Costs 1 token from the `bulk` bucket.

```json
{ "tags": ["product-page", "header"] }
```

#### Variant 4: Purge by prefixes

Costs 1 token from the `bulk` bucket.

```json
{ "prefixes": ["example.com/blog/"] }
```

#### Variant 5: Purge everything

Costs 1 token from the `bulk` bucket.

```json
{ "purge_everything": true }
```

**Response `200`:**

The response body is proxied directly from the Cloudflare API:

```json
{
	"success": true,
	"errors": [],
	"messages": [],
	"result": { "id": "..." }
}
```

Non-200 responses from the upstream Cloudflare API (429, 500, etc.) are passed through with their original status code and body.

**Policy evaluation:** For `files[]` entries, each is evaluated independently -- if any entry fails the policy check, the entire request is denied. For bulk types (`hosts[]`, `tags[]`, `prefixes[]`), each value in the array is evaluated as a separate context.

**Error codes:**

| Status | Cause                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 400    | Bad zone ID, invalid JSON, unrecognized body, oversized request, body contains more than one purge type |
| 401    | Missing/invalid auth header, unknown key                                                                |
| 403    | Revoked, expired, wrong zone, or policy denial. Response includes `denied` array.                       |
| 429    | Rate limited. Includes `Retry-After` header.                                                            |
| 502    | Upstream network error, no upstream token configured for zone                                           |

---

## 3. Keys

All key management endpoints require admin auth (`X-Admin-Key` or Cloudflare Access JWT).

### `POST /admin/keys`

Create a purge API key with an attached IAM policy document.

**Request body:**

| Field                      | Type           | Required | Description                                             |
| -------------------------- | -------------- | -------- | ------------------------------------------------------- |
| `name`                     | string         | yes      | Human-readable key name (min 1 char)                    |
| `policy`                   | PolicyDocument | yes      | IAM policy (see below)                                  |
| `zone_id`                  | string         | no       | Restrict key to a specific zone. Omit for any-zone key. |
| `expires_in_days`          | number         | no       | Positive number of days until expiry                    |
| `created_by`               | string         | no       | Audit trail identifier                                  |
| `rate_limit`               | object         | no       | Per-key rate limit overrides                            |
| `rate_limit.bulk_rate`     | number         | no       | Bulk token refill rate                                  |
| `rate_limit.bulk_bucket`   | number         | no       | Bulk bucket capacity                                    |
| `rate_limit.single_rate`   | number         | no       | Single-file token refill rate                           |
| `rate_limit.single_bucket` | number         | no       | Single-file bucket capacity                             |

**PolicyDocument:**

```json
{
	"version": "2025-01-01",
	"statements": [
		{
			"effect": "allow",
			"actions": ["purge:host"],
			"resources": ["zone:<zone_id>"],
			"conditions": [{ "field": "host", "operator": "eq", "value": "example.com" }]
		}
	]
}
```

- `version` must be `"2025-01-01"`
- `statements` must have at least 1 entry
- `effect`: `"allow"` or `"deny"`
- `actions`: non-empty array of action strings
- `resources`: non-empty array of resource strings
- `conditions`: optional array of condition objects (leaf or compound `any`/`all`/`not`)

Condition operators: `eq`, `ne`, `contains`, `not_contains`, `starts_with`, `ends_with`, `matches`, `not_matches`, `in`, `not_in`, `wildcard`, `exists`, `not_exists`, `lt`, `gt`, `lte`, `gte`.

**Example request:**

```json
{
	"name": "my-service-key",
	"zone_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
	"expires_in_days": 90,
	"policy": {
		"version": "2025-01-01",
		"statements": [
			{
				"effect": "allow",
				"actions": ["purge:host"],
				"resources": ["zone:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"],
				"conditions": [{ "field": "host", "operator": "eq", "value": "example.com" }]
			}
		]
	},
	"rate_limit": {
		"bulk_rate": 10,
		"bulk_bucket": 20
	}
}
```

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"key": {
			"id": "gw_a1b2c3d4e5f6...",
			"name": "my-service-key",
			"zone_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
			"created_at": 1704067200000,
			"expires_at": 1711843200000,
			"revoked": 0,
			"policy": "{\"version\":\"2025-01-01\",\"statements\":[...]}",
			"created_by": null,
			"bulk_rate": 10,
			"bulk_bucket": 20,
			"single_rate": null,
			"single_bucket": null
		}
	}
}
```

The `id` field (prefixed `gw_`) is the Bearer token. Show it once to the user -- it cannot be retrieved again.

**Error codes:** 400 (validation), 401 (unauthorized), 403 (forbidden/role)

---

### `GET /admin/keys`

List purge API keys.

**Query parameters:**

| Param     | Type   | Required | Description               |
| --------- | ------ | -------- | ------------------------- |
| `zone_id` | string | no       | Filter by zone            |
| `status`  | string | no       | `"active"` or `"revoked"` |

**Response `200`:**

```json
{
	"success": true,
	"result": [
		{
			"id": "gw_a1b2c3d4...",
			"name": "my-service-key",
			"zone_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
			"created_at": 1704067200000,
			"expires_at": 1711843200000,
			"revoked": 0,
			"policy": "{...}",
			"created_by": null,
			"bulk_rate": null,
			"bulk_bucket": null,
			"single_rate": null,
			"single_bucket": null
		}
	]
}
```

**Error codes:** 401 (unauthorized)

---

### `GET /admin/keys/:id`

Get details for a specific key.

**Path parameters:**

| Param | Type   | Required | Description         |
| ----- | ------ | -------- | ------------------- |
| `id`  | string | yes      | Key ID (min 1 char) |

**Query parameters:**

| Param     | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `zone_id` | string | no       | Zone scope  |

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"key": {
			"id": "gw_a1b2c3d4...",
			"name": "my-service-key",
			"zone_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
			"created_at": 1704067200000,
			"expires_at": 1711843200000,
			"revoked": 0,
			"policy": "{...}",
			"created_by": null,
			"bulk_rate": null,
			"bulk_bucket": null,
			"single_rate": null,
			"single_bucket": null
		}
	}
}
```

**Error codes:** 401 (unauthorized), 404 (key not found)

---

### `DELETE /admin/keys/:id`

Revoke or permanently delete a key.

**Path parameters:**

| Param | Type   | Required | Description |
| ----- | ------ | -------- | ----------- |
| `id`  | string | yes      | Key ID      |

**Query parameters:**

| Param       | Type   | Required | Description                                                 |
| ----------- | ------ | -------- | ----------------------------------------------------------- |
| `permanent` | string | no       | `"true"` for hard delete, `"false"` or omit for soft revoke |
| `zone_id`   | string | no       | Zone scope                                                  |

Without `permanent`: soft revoke. Sets `revoked = 1`. Cleans up any per-key rate limit buckets.

With `permanent=true`: hard delete. Removes the key row entirely. Works on keys in any state (active or revoked). D1 analytics rows referencing this key are preserved as orphaned historical data.

**Response `200` (revoke):**

```json
{ "success": true, "result": { "revoked": true } }
```

**Response `200` (delete):**

```json
{ "success": true, "result": { "deleted": true } }
```

**Error codes:** 401 (unauthorized), 404 (key not found)

---

### `POST /admin/keys/bulk-revoke`

Bulk revoke multiple keys. Supports dry-run preview.

**Request body:**

| Field           | Type     | Required | Description                                                      |
| --------------- | -------- | -------- | ---------------------------------------------------------------- |
| `ids`           | string[] | yes      | Array of key IDs (1-100 items)                                   |
| `confirm_count` | integer  | yes      | Must exactly match `ids.length` (fat-finger guard)               |
| `dry_run`       | boolean  | no       | Default `false`. When `true`, returns preview without executing. |

**Example request:**

```json
{
	"ids": ["gw_abc123...", "gw_def456..."],
	"confirm_count": 2,
	"dry_run": false
}
```

**Response `200` (execute):**

```json
{
	"success": true,
	"result": {
		"processed": 2,
		"results": [
			{ "id": "gw_abc123...", "status": "revoked" },
			{ "id": "gw_def456...", "status": "already_revoked" }
		]
	}
}
```

Per-item statuses: `revoked`, `already_revoked`, `deleted`, `not_found`.

**Response `200` (dry run):**

```json
{
	"success": true,
	"result": {
		"dry_run": true,
		"would_process": 2,
		"items": [
			{ "id": "gw_abc123...", "current_status": "active", "would_become": "revoked" },
			{ "id": "gw_def456...", "current_status": "revoked", "would_become": "already_revoked" }
		]
	}
}
```

Dry-run `current_status` values: `active`, `revoked`, `expired`, `not_found`.

**Error codes:** 400 (validation, confirm_count mismatch), 401 (unauthorized)

---

### `POST /admin/keys/bulk-delete`

Bulk permanently delete multiple keys. Same request body and response shapes as `bulk-revoke`.

**Request body:** Same as `bulk-revoke` above.

**Response `200`:** Same structure. Per-item statuses include `deleted` and `not_found`.

**Error codes:** 400 (validation), 401 (unauthorized)

---

## 4. Analytics

Admin auth required for all analytics endpoints.

### `GET /admin/analytics/events`

Query purge analytics events from D1.

**Query parameters:**

| Param     | Type    | Required | Default | Description                         |
| --------- | ------- | -------- | ------- | ----------------------------------- |
| `zone_id` | string  | no       | --      | Filter by zone                      |
| `key_id`  | string  | no       | --      | Filter by key                       |
| `since`   | number  | no       | --      | Start time (unix ms, exclusive > 0) |
| `until`   | number  | no       | --      | End time (unix ms, exclusive > 0)   |
| `limit`   | integer | no       | 100     | Max rows returned (1-1000)          |

**Response `200`:**

```json
{
	"success": true,
	"result": [
		{
			"key_id": "gw_a1b2c3d4...",
			"zone_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
			"purge_type": "hosts",
			"purge_target": "example.com",
			"tokens": 1,
			"status": 200,
			"collapsed": false,
			"upstream_status": 200,
			"duration_ms": 142,
			"created_at": 1704067200000,
			"response_detail": null,
			"created_by": null,
			"flight_id": "abc123"
		}
	]
}
```

**PurgeEvent fields:**

| Field             | Type            | Description                                                 |
| ----------------- | --------------- | ----------------------------------------------------------- |
| `key_id`          | string          | Key that made the request                                   |
| `zone_id`         | string          | Target zone                                                 |
| `purge_type`      | string          | `files`, `hosts`, `tags`, `prefixes`, or `purge_everything` |
| `purge_target`    | string or null  | The specific target value                                   |
| `tokens`          | number          | Rate limit tokens consumed                                  |
| `status`          | number          | HTTP status returned to client                              |
| `collapsed`       | string or false | Flight ID if collapsed, `false` otherwise                   |
| `upstream_status` | number or null  | Status from Cloudflare API                                  |
| `duration_ms`     | number          | Request duration                                            |
| `created_at`      | number          | Unix ms timestamp                                           |
| `response_detail` | string or null  | Truncated upstream response body                            |
| `created_by`      | string or null  | Audit trail                                                 |
| `flight_id`       | string          | Stable request collapsing ID                                |

**Error codes:** 401 (unauthorized), 503 (analytics not configured / no D1 binding)

---

### `GET /admin/analytics/summary`

Aggregate purge analytics summary.

**Query parameters:**

| Param     | Type   | Required | Description          |
| --------- | ------ | -------- | -------------------- |
| `zone_id` | string | no       | Filter by zone       |
| `key_id`  | string | no       | Filter by key        |
| `since`   | number | no       | Start time (unix ms) |
| `until`   | number | no       | End time (unix ms)   |

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"total_requests": 1542,
		"total_urls_purged": 8231,
		"by_status": { "200": 1500, "403": 30, "429": 12 },
		"by_purge_type": { "files": 1200, "hosts": 200, "tags": 100, "purge_everything": 42 },
		"collapsed_count": 85,
		"avg_duration_ms": 127.5
	}
}
```

**Error codes:** 401 (unauthorized), 503 (analytics not configured)

---

## 5. S3 Credentials

Admin auth required for all S3 credential endpoints.

### `POST /admin/s3/credentials`

Create an S3-compatible credential with an IAM policy. Returns the `secret_access_key` only once.

**Request body:**

| Field             | Type           | Required | Description                                                         |
| ----------------- | -------------- | -------- | ------------------------------------------------------------------- |
| `name`            | string         | yes      | Human-readable name (min 1 char)                                    |
| `policy`          | PolicyDocument | yes      | IAM policy (same schema as key policies, with S3 actions/resources) |
| `expires_in_days` | number         | no       | Positive number of days until expiry                                |
| `created_by`      | string         | no       | Audit trail identifier                                              |

**Example request:**

```json
{
	"name": "cdn-reader",
	"policy": {
		"version": "2025-01-01",
		"statements": [
			{
				"effect": "allow",
				"actions": ["s3:GetObject", "s3:ListBucket"],
				"resources": ["object:my-bucket/public/*", "bucket:my-bucket"]
			}
		]
	},
	"expires_in_days": 90
}
```

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"credential": {
			"access_key_id": "GK1A2B3C4D5E6F7890AB",
			"secret_access_key": "a1b2c3d4e5f6...64hexchars...",
			"name": "cdn-reader",
			"created_at": 1704067200000,
			"expires_at": 1711843200000,
			"revoked": 0,
			"policy": "{\"version\":\"2025-01-01\",\"statements\":[...]}",
			"created_by": null
		}
	}
}
```

The `access_key_id` has a `GK` prefix (20 chars total). The `secret_access_key` is 64 hex chars. Both are generated server-side. The secret is only shown once.

**Error codes:** 400 (validation), 401 (unauthorized)

---

### `GET /admin/s3/credentials`

List S3 credentials with secrets redacted.

**Query parameters:**

| Param    | Type   | Required | Description               |
| -------- | ------ | -------- | ------------------------- |
| `status` | string | no       | `"active"` or `"revoked"` |

**Response `200`:**

```json
{
	"success": true,
	"result": [
		{
			"access_key_id": "GK1A2B3C4D5E6F7890AB",
			"secret_access_key": "****",
			"name": "cdn-reader",
			"created_at": 1704067200000,
			"expires_at": 1711843200000,
			"revoked": 0,
			"policy": "{...}",
			"created_by": null
		}
	]
}
```

**Error codes:** 401 (unauthorized)

---

### `GET /admin/s3/credentials/:id`

Get details for a specific S3 credential (secret redacted).

**Path parameters:**

| Param | Type   | Required | Description                |
| ----- | ------ | -------- | -------------------------- |
| `id`  | string | yes      | Access key ID (min 1 char) |

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"credential": {
			"access_key_id": "GK1A2B3C4D5E6F7890AB",
			"secret_access_key": "****",
			"name": "cdn-reader",
			"created_at": 1704067200000,
			"expires_at": 1711843200000,
			"revoked": 0,
			"policy": "{...}",
			"created_by": null
		}
	}
}
```

**Error codes:** 401 (unauthorized), 404 (credential not found)

---

### `DELETE /admin/s3/credentials/:id`

Revoke or permanently delete an S3 credential.

**Path parameters:**

| Param | Type   | Required | Description   |
| ----- | ------ | -------- | ------------- |
| `id`  | string | yes      | Access key ID |

**Query parameters:**

| Param       | Type   | Required | Description              |
| ----------- | ------ | -------- | ------------------------ |
| `permanent` | string | no       | `"true"` for hard delete |
| `zone_id`   | string | no       | --                       |

Without `permanent`: soft revoke. The credential is immediately rejected on subsequent S3 requests (up to 60s cache TTL).

With `permanent=true`: hard delete. Removes the credential row entirely. D1 analytics rows are preserved.

**Response `200` (revoke):**

```json
{ "success": true, "result": { "revoked": true } }
```

**Response `200` (delete):**

```json
{ "success": true, "result": { "deleted": true } }
```

**Error codes:** 401 (unauthorized), 404 (credential not found)

---

### `POST /admin/s3/credentials/bulk-revoke`

Bulk revoke S3 credentials.

**Request body:**

| Field            | Type     | Required | Description                           |
| ---------------- | -------- | -------- | ------------------------------------- |
| `access_key_ids` | string[] | yes      | Array of access key IDs (1-100 items) |
| `confirm_count`  | integer  | yes      | Must exactly match array length       |
| `dry_run`        | boolean  | no       | Default `false`                       |

Note: uses `access_key_ids` instead of `ids`.

**Example request:**

```json
{
	"access_key_ids": ["GK1A2B3C...", "GK4D5E6F..."],
	"confirm_count": 2,
	"dry_run": false
}
```

**Response `200`:** Same structure as key bulk operations (see [Keys bulk-revoke](#post-adminkeysbulk-revoke)).

**Error codes:** 400 (validation), 401 (unauthorized)

---

### `POST /admin/s3/credentials/bulk-delete`

Bulk permanently delete S3 credentials.

**Request body:** Same as `bulk-revoke` above (`access_key_ids`, `confirm_count`, `dry_run`).

**Response `200`:** Same structure as key bulk operations.

**Error codes:** 400 (validation), 401 (unauthorized)

---

## 6. S3 Analytics

Admin auth required. Account-level -- no `zone_id` scoping.

### `GET /admin/s3/analytics/events`

Query S3 proxy analytics events from D1.

**Query parameters:**

| Param           | Type    | Required | Default | Description                         |
| --------------- | ------- | -------- | ------- | ----------------------------------- |
| `credential_id` | string  | no       | --      | Filter by credential                |
| `bucket`        | string  | no       | --      | Filter by bucket name               |
| `operation`     | string  | no       | --      | Filter by S3 operation name         |
| `since`         | number  | no       | --      | Start time (unix ms, exclusive > 0) |
| `until`         | number  | no       | --      | End time (unix ms, exclusive > 0)   |
| `limit`         | integer | no       | 100     | Max rows returned (1-1000)          |

**Response `200`:**

```json
{
	"success": true,
	"result": [
		{
			"credential_id": "GK1A2B3C4D5E6F7890AB",
			"operation": "GetObject",
			"bucket": "my-bucket",
			"key": "images/photo.jpg",
			"status": 200,
			"duration_ms": 45,
			"created_at": 1704067200000,
			"response_detail": null,
			"created_by": null
		}
	]
}
```

**S3Event fields:**

| Field             | Type           | Description                                        |
| ----------------- | -------------- | -------------------------------------------------- |
| `credential_id`   | string         | Credential that made the request                   |
| `operation`       | string         | S3 operation name (e.g., `GetObject`, `PutObject`) |
| `bucket`          | string or null | Target bucket                                      |
| `key`             | string or null | Object key                                         |
| `status`          | number         | HTTP status returned to client                     |
| `duration_ms`     | number         | Request duration                                   |
| `created_at`      | number         | Unix ms timestamp                                  |
| `response_detail` | string or null | Truncated response body                            |
| `created_by`      | string or null | Audit trail                                        |

**Error codes:** 401 (unauthorized), 503 (analytics not configured)

---

### `GET /admin/s3/analytics/summary`

Aggregate S3 proxy analytics summary.

**Query parameters:**

| Param           | Type   | Required | Description          |
| --------------- | ------ | -------- | -------------------- |
| `credential_id` | string | no       | Filter by credential |
| `bucket`        | string | no       | Filter by bucket     |
| `operation`     | string | no       | Filter by operation  |
| `since`         | number | no       | Start time (unix ms) |
| `until`         | number | no       | End time (unix ms)   |

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"total_requests": 5420,
		"by_status": { "200": 5100, "403": 200, "404": 120 },
		"by_operation": { "GetObject": 3000, "PutObject": 1500, "ListObjectsV2": 920 },
		"by_bucket": { "my-bucket": 3500, "other-bucket": 1920 },
		"avg_duration_ms": 52.3
	}
}
```

`by_operation` and `by_bucket` return the top 20 entries each.

**Error codes:** 401 (unauthorized), 503 (analytics not configured)

---

## 7. DNS Proxy

DNS record management proxied through the Gatekeeper IAM layer. Uses the same API keys as purge -- actions differentiate (`purge:*` vs `dns:*`).

Authentication: `Authorization: Bearer gw_<key_id>`

### POST `/v1/zones/:zoneId/dns_records`

Create a DNS record.

**IAM action:** `dns:create`

**Request body:** Forwarded to Cloudflare DNS API. Typical fields:

| Field     | Type    | Description                   |
| --------- | ------- | ----------------------------- |
| `type`    | string  | Record type (A, AAAA, CNAME…) |
| `name`    | string  | FQDN (e.g. `sub.example.com`) |
| `content` | string  | Record value                  |
| `proxied` | boolean | Cloudflare proxy enabled      |
| `ttl`     | number  | TTL in seconds (1 = auto)     |
| `comment` | string  | Optional comment              |
| `tags`    | array   | Optional tags                 |

**Response:** Upstream Cloudflare API response forwarded as-is.

### GET `/v1/zones/:zoneId/dns_records`

List DNS records. All query parameters are forwarded to the upstream Cloudflare API (supports `type`, `name`, `content`, `proxied`, `search`, `order`, `direction`, pagination, etc.).

**IAM action:** `dns:read`

### GET `/v1/zones/:zoneId/dns_records/:recordId`

Get a single DNS record by ID.

**IAM action:** `dns:read`

### PATCH `/v1/zones/:zoneId/dns_records/:recordId`

Partially update a DNS record.

**IAM action:** `dns:update`

### PUT `/v1/zones/:zoneId/dns_records/:recordId`

Fully overwrite a DNS record.

**IAM action:** `dns:update`

### DELETE `/v1/zones/:zoneId/dns_records/:recordId`

Delete a DNS record. A pre-flight GET is performed to resolve the record's name and type for policy condition evaluation.

**IAM action:** `dns:delete`

### POST `/v1/zones/:zoneId/dns_records/batch`

Batch create/update/delete DNS records. Each sub-operation is individually authorized before the batch is forwarded. If any sub-operation is denied, the entire batch is rejected.

**IAM action:** `dns:batch` (plus `dns:create`, `dns:update`, `dns:delete` for each sub-operation)

**Request body:**

```json
{
	"deletes": [{ "id": "record_id" }],
	"patches": [{ "id": "record_id", "content": "1.2.3.4" }],
	"puts": [{ "id": "record_id", "type": "A", "name": "...", "content": "..." }],
	"posts": [{ "type": "A", "name": "new.example.com", "content": "1.2.3.4" }]
}
```

### GET `/v1/zones/:zoneId/dns_records/export`

Export zone file in BIND format.

**IAM action:** `dns:export`

### POST `/v1/zones/:zoneId/dns_records/import`

Import zone file. Body is `multipart/form-data` forwarded as-is.

**IAM action:** `dns:import`

---

## 8. DNS Analytics

Admin endpoints for querying DNS proxy event logs. Requires admin authentication.

### GET `/admin/dns/analytics/events`

List recent DNS proxy events.

**Query parameters:**

| Parameter     | Type   | Description                                  |
| ------------- | ------ | -------------------------------------------- |
| `zone_id`     | string | Filter by zone ID                            |
| `key_id`      | string | Filter by API key ID                         |
| `action`      | string | Filter by DNS action (e.g. `dns:create`)     |
| `record_type` | string | Filter by record type (e.g. `A`, `CNAME`)    |
| `since`       | number | Start time (unix milliseconds)               |
| `until`       | number | End time (unix milliseconds)                 |
| `limit`       | number | Max events to return (default 100, max 1000) |

**Response:**

```json
{
	"success": true,
	"result": [
		{
			"id": 1,
			"key_id": "gw_...",
			"zone_id": "abc123...",
			"action": "dns:create",
			"record_name": "sub.example.com",
			"record_type": "A",
			"status": 200,
			"upstream_status": 200,
			"duration_ms": 142,
			"response_detail": "...",
			"created_by": "api-key",
			"created_at": 1700000000000
		}
	]
}
```

### GET `/admin/dns/analytics/summary`

Aggregated DNS analytics summary.

**Query parameters:** Same as events, except no `limit`.

**Response:**

```json
{
	"success": true,
	"result": {
		"total_requests": 1234,
		"avg_duration_ms": 87,
		"by_status": { "200": 1100, "403": 50, "429": 84 },
		"by_action": { "dns:read": 800, "dns:create": 300, "dns:update": 134 },
		"by_record_type": { "A": 500, "CNAME": 400, "TXT": 334 }
	}
}
```

---

## 9. S3 Proxy

### `GET|PUT|POST|DELETE|HEAD /s3/*`

S3-compatible proxy to Cloudflare R2 with per-credential IAM policies. Clients use standard S3 SDKs pointed at `https://<gateway>/s3` as the endpoint. Path-style addressing only (no virtual-hosted buckets).

**Auth:** AWS Signature Version 4 -- either header auth or presigned URLs.

- **Header auth:** Standard `Authorization: AWS4-HMAC-SHA256 Credential=GK.../...` header. Sent automatically by S3 clients.
- **Presigned URLs:** Query-string auth via `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Signature`, etc. Max expiry: 604,800 seconds (7 days).

Credentials are issued via `POST /admin/s3/credentials`. The `access_key_id` has a `GK` prefix (20 chars). The `secret_access_key` is 64 hex chars.

### Client setup (rclone)

```ini
[gatekeeper]
type = s3
provider = Other
endpoint = https://gate.erfi.io/s3
access_key_id = GK1A2B3C4D5E6F7890AB
secret_access_key = <your-secret-key>
```

```
rclone ls gatekeeper:my-bucket/prefix/
```

Works with boto3, aws-cli, or any S3-compatible SDK by setting the endpoint URL and GK credentials.

### Supported operations

66 S3 operations are detected for IAM policy evaluation. All are forwarded to R2.

**26 R2-native operations (fully functional):**

| Category      | Operations                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Buckets       | ListBuckets, HeadBucket, CreateBucket, DeleteBucket, GetBucketLocation, GetBucketEncryption                 |
| Bucket config | GetBucketCors, PutBucketCors, DeleteBucketCors, GetBucketLifecycle, PutBucketLifecycle                      |
| Listing       | ListObjects, ListObjectsV2, ListMultipartUploads                                                            |
| Objects       | GetObject, HeadObject, PutObject, CopyObject, DeleteObject, DeleteObjects                                   |
| Multipart     | CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload, ListParts |

**40 extended operations** (detected for IAM, forwarded to R2 which returns its own errors):

Tagging, ACLs, versioning, policy, website, logging, notifications, replication, object lock, retention, legal hold, public access block, accelerate, request payment, object ACL, restore, select.

### Batch delete

`POST /<bucket>?delete` (DeleteObjects) parses the XML body and authorizes each key individually as a separate `s3:DeleteObject` action. If any key is denied by the IAM policy, the entire batch is rejected. Maximum body size: 1 MiB.

### S3 error codes

The proxy returns standard S3 XML error responses:

| Status | Cause                                                                    |
| ------ | ------------------------------------------------------------------------ |
| 400    | Malformed Sig V4 auth, bad request                                       |
| 403    | Bad signature, revoked credential, expired credential, IAM policy denial |
| 501    | Operation not implemented by R2 (returned by R2 itself)                  |
| 502    | No upstream R2 endpoint configured for bucket                            |

All other R2 responses (404, 409, etc.) are passed through unchanged.

---

## 10. Upstream Tokens

Manage upstream Cloudflare API tokens used for proxying cache purge requests. Admin auth required.

### `POST /admin/upstream-tokens`

Register an upstream Cloudflare API token.

**Request body:**

| Field        | Type     | Required | Description                                                                         |
| ------------ | -------- | -------- | ----------------------------------------------------------------------------------- |
| `name`       | string   | yes      | Human-readable name (min 1 char)                                                    |
| `token`      | string   | yes      | Cloudflare API token (min 1 char)                                                   |
| `zone_ids`   | string[] | yes      | Non-empty array. Use `["*"]` for wildcard (all zones), or specific 32-hex zone IDs. |
| `created_by` | string   | no       | Audit trail identifier                                                              |
| `validate`   | boolean  | no       | When `true`, validates the token against the Cloudflare API                         |

**Example request:**

```json
{
	"name": "prod-purge",
	"token": "<your-cloudflare-api-token>",
	"zone_ids": ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"]
}
```

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"id": "upt_a1b2c3d4...",
		"name": "prod-purge",
		"zone_ids": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
		"token_preview": "abcd...wxyz",
		"created_at": 1704067200000,
		"created_by": null
	},
	"warnings": []
}
```

The actual token value is never returned after creation -- only `token_preview` (first 4 + last 4 chars). The `warnings` array is present when `validate: true` is used and issues are detected.

When a purge request arrives, the gateway looks up the best matching upstream token: exact zone match first, then wildcard. If no upstream token matches, the request fails with 502.

**Error codes:** 400 (validation), 401 (unauthorized)

---

### `GET /admin/upstream-tokens`

List all upstream tokens. Actual token values are never included.

**Response `200`:**

```json
{
	"success": true,
	"result": [
		{
			"id": "upt_a1b2c3d4...",
			"name": "prod-purge",
			"zone_ids": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
			"token_preview": "abcd...wxyz",
			"created_at": 1704067200000,
			"created_by": null
		}
	]
}
```

**Error codes:** 401 (unauthorized)

---

### `GET /admin/upstream-tokens/:id`

Get details for a specific upstream token.

**Path parameters:**

| Param | Type   | Required | Description           |
| ----- | ------ | -------- | --------------------- |
| `id`  | string | yes      | Token ID (min 1 char) |

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"id": "upt_a1b2c3d4...",
		"name": "prod-purge",
		"zone_ids": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
		"token_preview": "abcd...wxyz",
		"created_at": 1704067200000,
		"created_by": null
	}
}
```

**Error codes:** 401 (unauthorized), 404 (token not found)

---

### `DELETE /admin/upstream-tokens/:id`

Delete an upstream token. This is always a hard delete.

**Path parameters:**

| Param | Type   | Required | Description |
| ----- | ------ | -------- | ----------- |
| `id`  | string | yes      | Token ID    |

If you delete all upstream tokens for a zone, purge requests to that zone will return 502.

**Response `200`:**

```json
{ "success": true, "result": { "deleted": true } }
```

**Error codes:** 401 (unauthorized), 404 (token not found)

---

### `POST /admin/upstream-tokens/bulk-delete`

Bulk delete upstream tokens.

**Request body:**

| Field           | Type     | Required | Description                      |
| --------------- | -------- | -------- | -------------------------------- |
| `ids`           | string[] | yes      | Array of token IDs (1-100 items) |
| `confirm_count` | integer  | yes      | Must exactly match `ids.length`  |
| `dry_run`       | boolean  | no       | Default `false`                  |

**Example request:**

```json
{
	"ids": ["upt_abc123...", "upt_def456..."],
	"confirm_count": 2,
	"dry_run": false
}
```

**Response `200`:** Same structure as key bulk operations.

**Error codes:** 400 (validation), 401 (unauthorized)

---

## 11. Upstream R2

Manage upstream R2 endpoints for S3 proxy forwarding. Admin auth required.

### `POST /admin/upstream-r2`

Register an upstream R2 endpoint.

**Request body:**

| Field               | Type     | Required | Description                                                      |
| ------------------- | -------- | -------- | ---------------------------------------------------------------- |
| `name`              | string   | yes      | Human-readable name (min 1 char)                                 |
| `access_key_id`     | string   | yes      | R2 access key ID (min 1 char)                                    |
| `secret_access_key` | string   | yes      | R2 secret access key (min 1 char)                                |
| `endpoint`          | string   | yes      | R2 endpoint URL (must be HTTPS)                                  |
| `bucket_names`      | string[] | yes      | Non-empty array. Use `["*"]` for all buckets, or specific names. |
| `created_by`        | string   | no       | Audit trail identifier                                           |
| `validate`          | boolean  | no       | When `true`, validates connectivity to the R2 endpoint           |

**Example request:**

```json
{
	"name": "prod-r2",
	"access_key_id": "<r2-access-key-id>",
	"secret_access_key": "<r2-secret-access-key>",
	"endpoint": "https://<account-id>.r2.cloudflarestorage.com",
	"bucket_names": ["*"]
}
```

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"id": "upr2_a1b2c3d4...",
		"name": "prod-r2",
		"bucket_names": "*",
		"access_key_preview": "abcd...wxyz",
		"endpoint": "https://<account-id>.r2.cloudflarestorage.com",
		"created_at": 1704067200000,
		"created_by": null
	},
	"warnings": []
}
```

Credentials are stored in the DO and never returned after creation (only `access_key_preview`). The `warnings` array is present when `validate: true` is used.

When an S3 request arrives, the gateway resolves the R2 endpoint for the target bucket: exact match first, then wildcard. For `ListBuckets` (no specific bucket), the first wildcard endpoint is used. If no endpoint matches, the request fails with 502.

**Error codes:** 400 (validation), 401 (unauthorized)

---

### `GET /admin/upstream-r2`

List all upstream R2 endpoints with secrets redacted (preview only).

**Response `200`:**

```json
{
	"success": true,
	"result": [
		{
			"id": "upr2_a1b2c3d4...",
			"name": "prod-r2",
			"bucket_names": "*",
			"access_key_preview": "abcd...wxyz",
			"endpoint": "https://<account-id>.r2.cloudflarestorage.com",
			"created_at": 1704067200000,
			"created_by": null
		}
	]
}
```

**Error codes:** 401 (unauthorized)

---

### `GET /admin/upstream-r2/:id`

Get details for a specific upstream R2 endpoint.

**Path parameters:**

| Param | Type   | Required | Description                 |
| ----- | ------ | -------- | --------------------------- |
| `id`  | string | yes      | R2 endpoint ID (min 1 char) |

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"id": "upr2_a1b2c3d4...",
		"name": "prod-r2",
		"bucket_names": "*",
		"access_key_preview": "abcd...wxyz",
		"endpoint": "https://<account-id>.r2.cloudflarestorage.com",
		"created_at": 1704067200000,
		"created_by": null
	}
}
```

**Error codes:** 401 (unauthorized), 404 (R2 endpoint not found)

---

### `DELETE /admin/upstream-r2/:id`

Delete an upstream R2 endpoint. This is always a hard delete.

**Path parameters:**

| Param | Type   | Required | Description    |
| ----- | ------ | -------- | -------------- |
| `id`  | string | yes      | R2 endpoint ID |

If you delete all R2 endpoints for a bucket, S3 requests to that bucket will return 502.

**Response `200`:**

```json
{ "success": true, "result": { "deleted": true } }
```

**Error codes:** 401 (unauthorized), 404 (R2 endpoint not found)

---

### `POST /admin/upstream-r2/bulk-delete`

Bulk delete upstream R2 endpoints.

**Request body:**

| Field           | Type     | Required | Description                            |
| --------------- | -------- | -------- | -------------------------------------- |
| `ids`           | string[] | yes      | Array of R2 endpoint IDs (1-100 items) |
| `confirm_count` | integer  | yes      | Must exactly match `ids.length`        |
| `dry_run`       | boolean  | no       | Default `false`                        |

**Example request:**

```json
{
	"ids": ["upr2_abc123...", "upr2_def456..."],
	"confirm_count": 2,
	"dry_run": false
}
```

**Response `200`:** Same structure as key bulk operations.

**Error codes:** 400 (validation), 401 (unauthorized)

---

## 12. Config

Gateway configuration management. Admin auth required.

### Config keys

| Key                  | Default | Description                                         |
| -------------------- | ------- | --------------------------------------------------- |
| `bulk_rate`          | 50      | Bulk purge token refill rate (tokens/sec)           |
| `bulk_bucket_size`   | 500     | Bulk purge bucket capacity                          |
| `bulk_max_ops`       | 100     | Max bulk operations per request                     |
| `single_rate`        | 3000    | Single-file purge refill rate (tokens/sec)          |
| `single_bucket_size` | 6000    | Single-file bucket capacity                         |
| `single_max_ops`     | 500     | Max single-file URLs per request                    |
| `key_cache_ttl_ms`   | 60000   | In-memory cache TTL for key/credential lookups (ms) |
| `retention_days`     | 30      | D1 analytics retention period (days)                |
| `s3_rps`             | 100     | S3 proxy account-level requests per second          |
| `s3_burst`           | 200     | S3 proxy account-level burst capacity               |

Config resolution order: admin override (highest) > env var > hardcoded default.

---

### `GET /admin/config`

Get the full gateway configuration.

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"config": {
			"bulk_rate": 50,
			"bulk_bucket_size": 500,
			"bulk_max_ops": 100,
			"single_rate": 3000,
			"single_bucket_size": 6000,
			"single_max_ops": 500,
			"key_cache_ttl_ms": 60000,
			"retention_days": 30,
			"s3_rps": 100,
			"s3_burst": 200
		},
		"overrides": [
			{
				"key": "bulk_rate",
				"value": "100",
				"updated_at": 1704067200000,
				"updated_by": "admin@example.com"
			}
		],
		"defaults": {
			"bulk_rate": 50,
			"bulk_bucket_size": 500,
			"bulk_max_ops": 100,
			"single_rate": 3000,
			"single_bucket_size": 6000,
			"single_max_ops": 500,
			"key_cache_ttl_ms": 60000,
			"retention_days": 30,
			"s3_rps": 100,
			"s3_burst": 200
		}
	}
}
```

- `config` -- the fully resolved values (what the gateway is using right now)
- `overrides` -- only the keys explicitly changed, with `updated_at` and `updated_by`
- `defaults` -- the hardcoded fallback values

**Error codes:** 401 (unauthorized)

---

### `PUT /admin/config`

Set one or more config overrides. All values must be positive finite numbers. Unknown keys are rejected.

**Request body:** Flat JSON object of key-value pairs.

```json
{ "bulk_rate": 100, "retention_days": 14 }
```

Changes take effect immediately. The Durable Object rebuilds its rate limit token buckets on every config write.

**Response `200`:**

```json
{
	"success": true,
	"result": {
		"config": {
			"bulk_rate": 100,
			"bulk_bucket_size": 500,
			"bulk_max_ops": 100,
			"single_rate": 3000,
			"single_bucket_size": 6000,
			"single_max_ops": 500,
			"key_cache_ttl_ms": 60000,
			"retention_days": 14,
			"s3_rps": 100,
			"s3_burst": 200
		}
	}
}
```

**Error codes:** 400 (unknown key, non-numeric value, empty body), 401 (unauthorized)

---

### `DELETE /admin/config/:key`

Reset a single config key to the hardcoded default by removing its override.

**Path parameters:**

| Param | Type   | Required | Description                           |
| ----- | ------ | -------- | ------------------------------------- |
| `key` | string | yes      | Config key name (must be a known key) |

**Response `200`:**

```json
{
  "success": true,
  "result": {
    "config": {
      "bulk_rate": 50,
      "bulk_bucket_size": 500,
      "..."
    }
  }
}
```

Returns the newly resolved config after the override is removed.

**Error codes:** 400 (unknown config key), 401 (unauthorized), 404 (no override found for key)

---

## Endpoint Summary

| #   | Method | Path                                   | Tag            | Auth        |
| --- | ------ | -------------------------------------- | -------------- | ----------- |
| 1   | GET    | `/health`                              | System         | None        |
| 2   | POST   | `/v1/zones/:zoneId/purge_cache`        | Purge          | ApiKeyAuth  |
| 3   | POST   | `/v1/zones/:zoneId/dns_records`        | DNS            | ApiKeyAuth  |
| 4   | GET    | `/v1/zones/:zoneId/dns_records`        | DNS            | ApiKeyAuth  |
| 5   | GET    | `/v1/zones/:zoneId/dns_records/export` | DNS            | ApiKeyAuth  |
| 6   | POST   | `/v1/zones/:zoneId/dns_records/batch`  | DNS            | ApiKeyAuth  |
| 7   | POST   | `/v1/zones/:zoneId/dns_records/import` | DNS            | ApiKeyAuth  |
| 8   | GET    | `/v1/zones/:zoneId/dns_records/:id`    | DNS            | ApiKeyAuth  |
| 9   | PATCH  | `/v1/zones/:zoneId/dns_records/:id`    | DNS            | ApiKeyAuth  |
| 10  | PUT    | `/v1/zones/:zoneId/dns_records/:id`    | DNS            | ApiKeyAuth  |
| 11  | DELETE | `/v1/zones/:zoneId/dns_records/:id`    | DNS            | ApiKeyAuth  |
| 12  | POST   | `/admin/keys`                          | Keys           | Admin       |
| 13  | GET    | `/admin/keys`                          | Keys           | Admin       |
| 14  | GET    | `/admin/keys/:id`                      | Keys           | Admin       |
| 15  | DELETE | `/admin/keys/:id`                      | Keys           | Admin       |
| 16  | POST   | `/admin/keys/bulk-revoke`              | Keys           | Admin       |
| 17  | POST   | `/admin/keys/bulk-delete`              | Keys           | Admin       |
| 18  | GET    | `/admin/analytics/events`              | Analytics      | Admin       |
| 19  | GET    | `/admin/analytics/summary`             | Analytics      | Admin       |
| 20  | POST   | `/admin/s3/credentials`                | S3Credentials  | Admin       |
| 21  | GET    | `/admin/s3/credentials`                | S3Credentials  | Admin       |
| 22  | GET    | `/admin/s3/credentials/:id`            | S3Credentials  | Admin       |
| 23  | DELETE | `/admin/s3/credentials/:id`            | S3Credentials  | Admin       |
| 24  | POST   | `/admin/s3/credentials/bulk-revoke`    | S3Credentials  | Admin       |
| 25  | POST   | `/admin/s3/credentials/bulk-delete`    | S3Credentials  | Admin       |
| 26  | GET    | `/admin/s3/analytics/events`           | S3Analytics    | Admin       |
| 27  | GET    | `/admin/s3/analytics/summary`          | S3Analytics    | Admin       |
| 28  | GET    | `/admin/dns/analytics/events`          | DnsAnalytics   | Admin       |
| 29  | GET    | `/admin/dns/analytics/summary`         | DnsAnalytics   | Admin       |
| 30  | GET    | `/s3/*`                                | S3Proxy        | S3SigV4Auth |
| 31  | PUT    | `/s3/*`                                | S3Proxy        | S3SigV4Auth |
| 32  | POST   | `/s3/*`                                | S3Proxy        | S3SigV4Auth |
| 33  | DELETE | `/s3/*`                                | S3Proxy        | S3SigV4Auth |
| 34  | HEAD   | `/s3/*`                                | S3Proxy        | S3SigV4Auth |
| 35  | POST   | `/admin/upstream-tokens`               | UpstreamTokens | Admin       |
| 36  | GET    | `/admin/upstream-tokens`               | UpstreamTokens | Admin       |
| 37  | GET    | `/admin/upstream-tokens/:id`           | UpstreamTokens | Admin       |
| 38  | DELETE | `/admin/upstream-tokens/:id`           | UpstreamTokens | Admin       |
| 39  | POST   | `/admin/upstream-tokens/bulk-delete`   | UpstreamTokens | Admin       |
| 40  | POST   | `/admin/upstream-r2`                   | UpstreamR2     | Admin       |
| 41  | GET    | `/admin/upstream-r2`                   | UpstreamR2     | Admin       |
| 42  | GET    | `/admin/upstream-r2/:id`               | UpstreamR2     | Admin       |
| 43  | DELETE | `/admin/upstream-r2/:id`               | UpstreamR2     | Admin       |
| 44  | POST   | `/admin/upstream-r2/bulk-delete`       | UpstreamR2     | Admin       |
| 45  | GET    | `/admin/config`                        | Config         | Admin       |
| 46  | PUT    | `/admin/config`                        | Config         | Admin       |
| 47  | DELETE | `/admin/config/:key`                   | Config         | Admin       |
