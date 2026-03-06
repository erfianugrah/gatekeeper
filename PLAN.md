# S3/R2 Proxy — Fine-Grained IAM for Cloudflare R2

## Problem

R2's native API tokens support per-bucket read/write scoping, but nothing finer:

- No object-level or key-prefix control
- No mixed permissions across buckets (e.g., read bucket A + write bucket B)
- No user-level policies — only service-level tokens
- No conditional access (by content type, key pattern, etc.)

Customers coming from AWS have IAM policies like this and need equivalent functionality:

```json
{
	"Effect": "Allow",
	"Action": ["s3:PutObject", "s3:GetObject"],
	"Resource": ["arn:aws:s3:::www*env*cdn/??/??/products/xr/*"]
}
```

R2 bucket-level policies can't handle the volume of rules these customers need. AWS solved this with user-level permission boundaries — Gatekeeper does the same for R2.

## Solution

Gatekeeper sits in front of R2 with a full-admin token and applies AWS IAM-style policies per credential. Clients use standard S3 SDKs (aws-cli, boto3, rclone, etc.) pointed at `gate.erfi.io/s3`.

```
┌──────────────┐     Sig V4      ┌──────────────┐    Re-signed     ┌─────┐
│  S3 Client   │ ──────────────> │  Gatekeeper   │ ─────────────>  │ R2  │
│ (rclone/SDK) │  user creds     │  /s3/*        │  admin creds    │     │
└──────────────┘                 │               │                 └─────┘
                                 │ 1. Verify Sig │
                                 │ 2. Map to IAM │
                                 │ 3. Eval policy│
                                 │ 4. Re-sign    │
                                 │ 5. Forward    │
                                 └──────────────┘
```

## Architecture

### Auth Flow

1. Client signs request with Gatekeeper-issued S3 credentials (access_key_id + secret_access_key)
2. Gatekeeper verifies the AWS Sig V4 signature against the stored secret
3. Extracts the S3 operation, bucket, and key from the HTTP request
4. Builds a `RequestContext` and evaluates the credential's IAM policy
5. If authorized, re-signs the request with the admin R2 token (via `aws4fetch`)
6. Streams the R2 response back to the client

### Routing

Mount the S3 proxy at `/s3/*`. Clients configure their endpoint as `https://gate.erfi.io/s3` with path-style addressing (no virtual-hosted style).

```
GET  /s3/                          → ListBuckets
GET  /s3/{bucket}?list-type=2      → ListObjectsV2
GET  /s3/{bucket}/{key}            → GetObject
PUT  /s3/{bucket}/{key}            → PutObject
DELETE /s3/{bucket}/{key}          → DeleteObject
HEAD /s3/{bucket}/{key}            → HeadObject
POST /s3/{bucket}?delete           → DeleteObjects
PUT  /s3/{bucket}/{key}?uploadId=  → UploadPart
POST /s3/{bucket}/{key}?uploads    → CreateMultipartUpload
POST /s3/{bucket}/{key}?uploadId=  → CompleteMultipartUpload
...
```

Add `/s3/*` to `run_worker_first` in `wrangler.jsonc`.

### S3 Credentials

New table in the DO's SQLite (same DO as purge — single source of truth for IAM):

```sql
CREATE TABLE IF NOT EXISTS s3_credentials (
    access_key_id TEXT PRIMARY KEY,
    secret_access_key TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0,
    policy TEXT NOT NULL,
    created_by TEXT
);
```

Credential format:

- `access_key_id`: `GK` + 18 random uppercase hex chars (20 chars total, e.g., `GK1A2B3C4D5E6F7A8B9C`)
- `secret_access_key`: 64 random hex chars (32 bytes)

Admin API endpoints (under existing `/admin` sub-app, protected by Access + admin key):

```
POST   /admin/s3/credentials              → Create credential with policy
GET    /admin/s3/credentials              → List credentials
GET    /admin/s3/credentials/:id          → Get credential (redacted secret)
DELETE /admin/s3/credentials/:id          → Revoke credential
```

### IAM Actions

Map S3 HTTP requests to IAM actions using AWS-standard names:

| S3 Operation            | IAM Action                                      | Resource Type                  |
| ----------------------- | ----------------------------------------------- | ------------------------------ |
| ListBuckets             | `s3:ListAllMyBuckets`                           | `account:*`                    |
| HeadBucket              | `s3:HeadBucket`                                 | `bucket:{name}`                |
| CreateBucket            | `s3:CreateBucket`                               | `bucket:{name}`                |
| DeleteBucket            | `s3:DeleteBucket`                               | `bucket:{name}`                |
| GetBucketLocation       | `s3:GetBucketLocation`                          | `bucket:{name}`                |
| GetBucketCors           | `s3:GetBucketCors`                              | `bucket:{name}`                |
| PutBucketCors           | `s3:PutBucketCors`                              | `bucket:{name}`                |
| DeleteBucketCors        | `s3:DeleteBucketCors`                           | `bucket:{name}`                |
| GetBucketLifecycle      | `s3:GetLifecycleConfiguration`                  | `bucket:{name}`                |
| PutBucketLifecycle      | `s3:PutLifecycleConfiguration`                  | `bucket:{name}`                |
| GetBucketEncryption     | `s3:GetEncryptionConfiguration`                 | `bucket:{name}`                |
| ListObjects/V2          | `s3:ListBucket`                                 | `bucket:{name}`                |
| ListMultipartUploads    | `s3:ListBucketMultipartUploads`                 | `bucket:{name}`                |
| GetObject               | `s3:GetObject`                                  | `object:{bucket}/{key}`        |
| HeadObject              | `s3:GetObject`                                  | `object:{bucket}/{key}`        |
| PutObject               | `s3:PutObject`                                  | `object:{bucket}/{key}`        |
| CopyObject              | `s3:PutObject` (dest) + `s3:GetObject` (source) | `object:{bucket}/{key}`        |
| DeleteObject            | `s3:DeleteObject`                               | `object:{bucket}/{key}`        |
| DeleteObjects (batch)   | `s3:DeleteObject`                               | `object:{bucket}/{key}` (each) |
| CreateMultipartUpload   | `s3:PutObject`                                  | `object:{bucket}/{key}`        |
| UploadPart              | `s3:PutObject`                                  | `object:{bucket}/{key}`        |
| UploadPartCopy          | `s3:PutObject` (dest) + `s3:GetObject` (source) | `object:{bucket}/{key}`        |
| CompleteMultipartUpload | `s3:PutObject`                                  | `object:{bucket}/{key}`        |
| AbortMultipartUpload    | `s3:AbortMultipartUpload`                       | `object:{bucket}/{key}`        |
| ListParts               | `s3:ListMultipartUploadParts`                   | `object:{bucket}/{key}`        |
| GetObjectTagging        | `s3:GetObjectTagging`                           | `object:{bucket}/{key}`        |
| PutObjectTagging        | `s3:PutObjectTagging`                           | `object:{bucket}/{key}`        |
| DeleteObjectTagging     | `s3:DeleteObjectTagging`                        | `object:{bucket}/{key}`        |

Wildcards: `s3:*` (all), `s3:Get*` (all reads), `s3:Put*` (all writes), `s3:Delete*` (all deletes).

### IAM Resources

Two resource types, matching existing pattern convention:

- `bucket:{name}` — for bucket-level operations
- `object:{bucket}/{key}` — for object-level operations
- `account:*` — for account-level operations (ListBuckets)

Wildcard matching (already supported by the policy engine):

- `bucket:*` → all buckets
- `object:*` → all objects in all buckets
- `object:my-bucket/*` → all objects in my-bucket
- `object:my-bucket/images/*` → prefix-scoped

### IAM Condition Fields

Available fields for conditions, built from the S3 request:

| Field            | Type   | Description                        | Example                 |
| ---------------- | ------ | ---------------------------------- | ----------------------- |
| `bucket`         | string | Bucket name                        | `"my-assets"`           |
| `key`            | string | Full object key                    | `"images/photo.jpg"`    |
| `key.prefix`     | string | Key up to last `/`                 | `"images/"`             |
| `key.extension`  | string | File extension (without dot)       | `"jpg"`                 |
| `key.filename`   | string | Filename (after last `/`)          | `"photo.jpg"`           |
| `content_type`   | string | Content-Type header (PutObject)    | `"image/jpeg"`          |
| `content_length` | string | Content-Length header (PutObject)  | `"1048576"`             |
| `method`         | string | HTTP method                        | `"GET"`                 |
| `source_bucket`  | string | Source bucket for CopyObject       | `"other-bucket"`        |
| `source_key`     | string | Source key for CopyObject          | `"originals/photo.jpg"` |
| `list_prefix`    | string | prefix query param for ListObjects | `"images/"`             |

### Example Policies

**Read-only access to one bucket:**

```json
{
	"version": "2025-01-01",
	"statements": [
		{
			"effect": "allow",
			"actions": ["s3:GetObject", "s3:ListBucket"],
			"resources": ["bucket:my-assets", "object:my-assets/*"]
		}
	]
}
```

**Write to specific prefix, read everything:**

```json
{
	"version": "2025-01-01",
	"statements": [
		{
			"effect": "allow",
			"actions": ["s3:GetObject", "s3:ListBucket"],
			"resources": ["bucket:*", "object:*"]
		},
		{
			"effect": "allow",
			"actions": ["s3:PutObject"],
			"resources": ["object:uploads/*"],
			"conditions": [
				{
					"field": "key",
					"operator": "wildcard",
					"value": "??/??/products/xr/*"
				}
			]
		}
	]
}
```

**Customer use-case equivalent (enterprise-style):**

```json
{
	"version": "2025-01-01",
	"statements": [
		{
			"effect": "allow",
			"actions": ["s3:PutObject", "s3:GetObject"],
			"resources": ["object:*"],
			"conditions": [
				{
					"field": "key",
					"operator": "matches",
					"value": "^(www.*stg.*cdn|www.*pre.*cdn|www.*pub.*cdn|www.*ref.*cdn)/\\d{2}/\\d{2}/products/xr/.*"
				}
			]
		},
		{
			"effect": "allow",
			"actions": ["s3:ListBucket", "s3:GetObject", "s3:GetObjectTagging"],
			"resources": ["bucket:*", "object:*"],
			"conditions": [
				{
					"field": "bucket",
					"operator": "starts_with",
					"value": "www-example-com-"
				}
			]
		}
	]
}
```

## Implementation

### Dependencies

- `aws4fetch` — outbound Sig V4 re-signing to R2 (already Workers-optimized, ~4KB)
- No deps for inbound Sig V4 verification — uses `crypto.subtle` directly

### Secrets

Stored in `.dev.vars` (local) and wrangler secrets (production):

```
R2_ACCESS_KEY_ID=ebd50f0dc5491e61ad0cd72030a8f314
R2_SECRET_ACCESS_KEY=baeace5387c23acf0ad2b582a808a13073e9a09acdf0b54742420229461640f4
R2_ENDPOINT=https://facefacefacefacefacefacefaceface.r2.cloudflarestorage.com
```

### File Structure

```
src/
├── s3/
│   ├── routes.ts          — Hono sub-app for /s3/*, operation dispatch
│   ├── sig-v4-verify.ts   — Inbound Sig V4 verification (crypto.subtle)
│   ├── sig-v4-sign.ts     — Outbound re-signing via aws4fetch
│   ├── operations.ts      — Map HTTP request → S3 operation + IAM action
│   ├── iam.ts             — S3CredentialManager (CRUD, authorize)
│   └── types.ts           — S3-specific types
```

### AWS Sig V4 Verification (Inbound)

Parse the `Authorization` header:

```
AWS4-HMAC-SHA256
  Credential={access_key_id}/{date}/{region}/s3/aws4_request,
  SignedHeaders={signed_headers},
  Signature={signature}
```

Steps:

1. Extract `access_key_id`, `date`, `region`, `signed_headers`, `signature`
2. Look up `secret_access_key` from DO (with cache — same pattern as purge keys)
3. Reconstruct canonical request from the incoming HTTP request
4. Build string-to-sign: `AWS4-HMAC-SHA256\n{datetime}\n{credential_scope}\n{SHA256(canonical_request)}`
5. Derive signing key: `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), "s3"), "aws4_request")`
6. Compute expected signature and compare with `crypto.subtle.timingSafeEqual`

Region is always `auto` (R2's region). Accept `auto`, `us-east-1`, and empty string as aliases.

### Outbound Re-signing (aws4fetch)

```typescript
import { AwsClient } from 'aws4fetch';

const r2 = new AwsClient({
	accessKeyId: env.R2_ACCESS_KEY_ID,
	secretAccessKey: env.R2_SECRET_ACCESS_KEY,
	service: 's3',
	region: 'auto',
});

// Rewrite path: /s3/{bucket}/{key} → /{bucket}/{key}
const r2Url = `${env.R2_ENDPOINT}/${bucket}/${key}`;
const signed = await r2.sign(r2Url, {
	method: request.method,
	headers: forwardHeaders,
	body: request.body,
});
return fetch(signed);
```

### Request Streaming

Bodies are streamed through without buffering:

- `PutObject` / `UploadPart`: Stream request body to R2
- `GetObject`: Stream response body from R2 to client
- Use `UNSIGNED-PAYLOAD` for `x-amz-content-sha256` (R2 supports it)

For inbound Sig V4 verification when the client sends `UNSIGNED-PAYLOAD` (most S3 clients do for streaming), we skip body hash verification and only verify the header signature.

### Analytics

Log S3 operations to the same D1 analytics database. Add new columns or a new table:

```sql
CREATE TABLE IF NOT EXISTS s3_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    access_key_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    bucket TEXT,
    key TEXT,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    bytes_in INTEGER,
    bytes_out INTEGER,
    error TEXT
);
```

### Phases

**Phase 1 — Core plumbing:**

- [ ] Store R2 admin credentials as secrets
- [ ] S3 credential CRUD in DO + admin API endpoints
- [ ] Sig V4 verification (inbound)
- [ ] Sig V4 re-signing (outbound, aws4fetch)
- [ ] S3 route skeleton with operation detection
- [ ] Basic forwarding for GetObject, PutObject, DeleteObject, HeadObject
- [ ] IAM evaluation for each operation
- [ ] Tests: credential CRUD, Sig V4 verify, basic operations

**Phase 2 — Full S3 surface:**

- [ ] ListBuckets, ListObjectsV2, ListObjects
- [ ] DeleteObjects (batch — parse XML body, authorize each key)
- [ ] CopyObject (dual authorization: source + dest)
- [ ] Multipart upload (CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload, ListParts, ListMultipartUploads)
- [ ] Bucket operations (CreateBucket, DeleteBucket, HeadBucket, GetBucketLocation)
- [ ] CORS operations (GetBucketCors, PutBucketCors, DeleteBucketCors)
- [ ] Lifecycle operations (GetBucketLifecycle, PutBucketLifecycle)
- [ ] Tagging operations (GetObjectTagging, PutObjectTagging, DeleteObjectTagging)

**Phase 3 — Polish:**

- [ ] S3 analytics (D1)
- [ ] CLI commands for S3 credential management
- [ ] Dashboard S3 credential UI
- [ ] Presigned URL support
- [ ] Error response formatting (S3 XML errors)
- [ ] README + OpenAPI update
- [ ] rclone end-to-end test against live proxy

### S3 XML Error Responses

S3 returns XML errors, not JSON. Gatekeeper must return S3-compatible XML for auth failures:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>AccessDenied</Code>
    <Message>Access Denied</Message>
    <RequestId>...</RequestId>
</Error>
```

Error codes: `AccessDenied`, `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `ExpiredToken`, `InvalidRequest`.

### S3 Operation Detection

Detect the operation from HTTP method + path + query parameters:

```
Method  Path pattern        Query params          Operation
──────  ──────────────────  ──────────────────    ─────────────────────────
GET     /                   (none)                ListBuckets
GET     /{bucket}           list-type=2           ListObjectsV2
GET     /{bucket}           (none)                ListObjects
GET     /{bucket}           uploads               ListMultipartUploads
GET     /{bucket}/{key+}    uploadId              ListParts
GET     /{bucket}/{key+}    tagging               GetObjectTagging
GET     /{bucket}/{key+}    (none)                GetObject
HEAD    /{bucket}           (none)                HeadBucket
HEAD    /{bucket}/{key+}    (none)                HeadObject
PUT     /{bucket}           (none)                CreateBucket
PUT     /{bucket}/{key+}    uploadId              UploadPart
PUT     /{bucket}/{key+}    x-amz-copy-source     CopyObject / UploadPartCopy
PUT     /{bucket}/{key+}    tagging               PutObjectTagging
PUT     /{bucket}/{key+}    (none)                PutObject
DELETE  /{bucket}           (none)                DeleteBucket
DELETE  /{bucket}/{key+}    uploadId              AbortMultipartUpload
DELETE  /{bucket}/{key+}    tagging               DeleteObjectTagging
DELETE  /{bucket}/{key+}    (none)                DeleteObject
POST    /{bucket}           delete                DeleteObjects
POST    /{bucket}/{key+}    uploads               CreateMultipartUpload
POST    /{bucket}/{key+}    uploadId              CompleteMultipartUpload
GET     /{bucket}           cors                  GetBucketCors
PUT     /{bucket}           cors                  PutBucketCors
DELETE  /{bucket}           cors                  DeleteBucketCors
GET     /{bucket}           lifecycle             GetBucketLifecycle
PUT     /{bucket}           lifecycle             PutBucketLifecycle
GET     /{bucket}           location              GetBucketLocation
GET     /{bucket}           encryption            GetBucketEncryption
```

### Client Configuration

**rclone:**

```ini
[gatekeeper]
type = s3
provider = Other
access_key_id = GK1A2B3C4D5E6F7A8B9C
secret_access_key = abcdef1234567890...
endpoint = https://gate.erfi.io/s3
force_path_style = true
```

**AWS CLI:**

```bash
aws s3 ls --endpoint-url https://gate.erfi.io/s3
```

**boto3:**

```python
s3 = boto3.client('s3',
    endpoint_url='https://gate.erfi.io/s3',
    aws_access_key_id='GK1A2B3C4D5E6F7A8B9C',
    aws_secret_access_key='abcdef1234567890...',
)
```

**aws-sdk-js-v3:**

```typescript
const client = new S3Client({
	endpoint: 'https://gate.erfi.io/s3',
	region: 'auto',
	credentials: {
		accessKeyId: 'GK1A2B3C4D5E6F7A8B9C',
		secretAccessKey: 'abcdef1234567890...',
	},
	forcePathStyle: true,
});
```

---

# IAM v2 — Policy Engine Enhancements

## Overview

Extend the policy engine with numeric comparisons, IP/geo conditions, deny statements, and request context fields. All changes are backward-compatible — existing policies continue to work unchanged.

## Features

### 1. Numeric comparison operators

**New operators**: `lt`, `gt`, `lte`, `gte`

Coerce both the field value and the condition value to numbers at eval time. If either side is not a valid number, the condition fails (returns false).

**Files to change**:

- `src/policy-types.ts` — add to `LeafOperator` union
- `src/policy-engine.ts` — add cases to `evaluateLeaf()`
- `test/policy-engine.test.ts` — add tests for each operator, NaN edge cases
- `dashboard/src/components/ConditionEditor.tsx` — add to operator dropdown

**Use cases**:

```jsonc
// S3: block uploads over 50MB
{ "field": "content_length", "operator": "gt", "value": "52428800" }
// S3: restrict list results
{ "field": "max_keys", "operator": "lte", "value": "100" }
```

**Edge cases to test**:

- Non-numeric field value → condition fails (safe default: deny)
- Non-numeric condition value → condition fails
- Negative numbers, zero, floats
- Missing field (field not in context) → condition fails

### 2. IP/geo condition fields

**New fields**: `client_ip`, `client_country`, `client_asn`

These are populated from Cloudflare headers at request time — no policy schema change needed.

**Files to change**:

- `src/routes/purge.ts` — extract headers into `fields` when building `RequestContext`
- `src/s3/operations.ts` (`buildConditionFields`) — add client headers
- `src/s3/routes.ts` — pass request headers to `buildConditionFields`
- `test/policy-engine.test.ts` — test IP/geo conditions
- `test/purge.test.ts` — test purge with IP condition
- `dashboard/src/components/ConditionEditor.tsx` — add to field dropdown

**Headers to extract**:
| Field | Header | Example |
|-------|--------|---------|
| `client_ip` | `CF-Connecting-IP` | `203.0.113.42` |
| `client_country` | `CF-IPCountry` | `US` |
| `client_asn` | `CF-IPAsn` (via `cf` object: `request.cf?.asn`) | `13335` |

**Use cases**:

```jsonc
// Only allow purge from US/EU
{ "field": "client_country", "operator": "in", "value": ["US", "DE", "FR", "GB", "NL"] }
// Block specific IP
{ "not": { "field": "client_ip", "operator": "eq", "value": "203.0.113.42" } }
// S3: restrict uploads to known ASN
{ "field": "client_asn", "operator": "eq", "value": "13335" }
```

**Note**: `request.cf?.asn` returns a number — convert to string for condition eval. IP is always a string. Country is a 2-letter ISO code.

### 3. Deny statements

**Change**: Allow `effect: "deny"` in policy statements.

**Evaluation order** (standard IAM precedence):

1. Check all statements. If any `deny` matches → **denied**.
2. If any `allow` matches → **allowed**.
3. If nothing matches → **denied** (implicit deny).

This is a one-line change to validation (remove the `effect !== 'allow'` check) and a small refactor to the evaluation loop.

**Files to change**:

- `src/policy-types.ts` — change `effect` type from `'allow'` to `'allow' | 'deny'`
- `src/policy-engine.ts` — refactor `evaluatePolicy()` and `evaluatePolicyForContext()` to check deny-first
- `src/iam.ts` — update validation in `validatePolicy()` (remove deny rejection)
- `src/s3/iam.ts` — same validation update
- `test/policy-engine.test.ts` — add deny tests (deny overrides allow, explicit deny + allow, deny-only policy)
- `dashboard/src/components/PolicyBuilder.tsx` — add effect toggle
- `dashboard/src/components/S3PolicyBuilder.tsx` — add effect toggle

**Use cases**:

```jsonc
{
	"version": "2025-01-01",
	"statements": [
		{ "effect": "allow", "actions": ["s3:*"], "resources": ["*"] },
		{
			"effect": "deny",
			"actions": ["s3:DeleteObject"],
			"resources": ["*"],
			"conditions": [{ "field": "bucket", "operator": "eq", "value": "vault" }],
		},
	],
}
// → Full access everywhere, but cannot delete from vault
```

**Edge cases to test**:

- Deny with no conditions (blanket deny on specific action)
- Deny + allow on same action — deny wins
- Multiple deny statements — any match = denied
- Deny-only policy (no allow) — everything denied
- Existing policies with only `allow` — unchanged behavior

### 4. Time-based condition fields

**New fields**: `time.hour` (0-23), `time.day_of_week` (0=Sun, 6=Sat), `time.iso`

Populated at request time from `Date.now()`.

**Files to change**:

- `src/routes/purge.ts` — add time fields
- `src/s3/operations.ts` — add time fields
- `test/policy-engine.test.ts` — test with fake timers

**Use cases**:

```jsonc
// Only allow during business hours (UTC)
{
    "all": [
        { "field": "time.hour", "operator": "gte", "value": "9" },
        { "field": "time.hour", "operator": "lt", "value": "17" }
    ]
}
// Block weekend operations
{ "field": "time.day_of_week", "operator": "in", "value": ["0", "6"] }
```

**Note**: Requires numeric operators (feature 1) to be useful. These are string fields that work with numeric comparison after coercion.

## Implementation order

1. **Numeric operators** (`lt`, `gt`, `lte`, `gte`) — foundation for time-based conditions
2. **IP/geo fields** (`client_ip`, `client_country`, `client_asn`) — no engine changes needed
3. **Deny statements** — policy engine refactor
4. **Time-based fields** — depends on numeric operators
5. **Dashboard updates** — operator/field dropdowns, effect toggle
6. **Smoke tests** — add cases for each new feature
7. **Run preflight** — typecheck + lint + test + build

## Testing strategy

Each feature gets unit tests in `test/policy-engine.test.ts`. Integration tests where the condition fields are populated (purge.test.ts, s3-e2e-iam.test.ts). Smoke test additions for live verification.

**Test matrix for numeric operators**:

- `lt`: 5 < 10 → true, 10 < 10 → false, 15 < 10 → false
- `gt`: 15 > 10 → true, 10 > 10 → false, 5 > 10 → false
- `lte`: 5 <= 10 → true, 10 <= 10 → true, 15 <= 10 → false
- `gte`: 15 >= 10 → true, 10 >= 10 → true, 5 >= 10 → false
- NaN handling: "abc" < 10 → false, 10 < "abc" → false

**Test matrix for deny**:

- allow s3:\* + deny s3:DeleteObject → GetObject allowed, DeleteObject denied
- deny purge:everything + allow purge:\* → host/tag/url allowed, everything denied
- deny-only policy → everything denied
- no matching statements → denied (implicit deny, unchanged behavior)

---

# Bulk Revoke & Hard-Delete

## Overview

Add bulk revoke and bulk hard-delete endpoints for both purge keys and S3 credentials. All bulk operations require a fat-finger guard (`confirm_count`) and support a dry-run preview mode.

## Endpoints

| Method | Path                                | Purpose                     |
| ------ | ----------------------------------- | --------------------------- |
| POST   | `/admin/keys/bulk-revoke`           | Bulk soft-revoke purge keys |
| POST   | `/admin/keys/bulk-delete`           | Bulk hard-delete purge keys |
| POST   | `/admin/s3/credentials/bulk-revoke` | Bulk soft-revoke S3 creds   |
| POST   | `/admin/s3/credentials/bulk-delete` | Bulk hard-delete S3 creds   |

## Request Body

**Keys:**

```json
{
	"ids": ["gw_abc123...", "gw_def456..."],
	"confirm_count": 2,
	"dry_run": false
}
```

**S3 credentials:**

```json
{
	"access_key_ids": ["GK1A2B3C...", "GK4D5E6F..."],
	"confirm_count": 2,
	"dry_run": false
}
```

## Fat-Finger Guards

1. **`confirm_count` (required)**: Must exactly match the length of the `ids` / `access_key_ids` array. Returns 400 if mismatched.
2. **`dry_run` (optional, default false)**: When `true`, returns a preview of what would happen without executing. Shows each item's current state.
3. **Array constraints**: Must be non-empty, max 100 items. Returns 400 if violated.

## Response — Normal Execution

```json
{
	"success": true,
	"result": {
		"processed": 2,
		"results": [
			{ "id": "gw_abc123", "status": "revoked" },
			{ "id": "gw_def456", "status": "not_found" }
		]
	}
}
```

Possible per-item statuses:

- `revoked` — successfully soft-revoked (was active)
- `deleted` — successfully hard-deleted
- `already_revoked` — was already revoked (for bulk-revoke)
- `not_found` — ID does not exist

## Response — Dry Run

```json
{
	"success": true,
	"result": {
		"dry_run": true,
		"would_process": 2,
		"items": [
			{ "id": "gw_abc123", "current_status": "active", "would_become": "revoked" },
			{ "id": "gw_def456", "current_status": "not_found", "would_become": "not_found" }
		]
	}
}
```

## Implementation

### IAM layer (`src/iam.ts`, `src/s3/iam.ts`)

Add `bulkRevoke(ids)` and `bulkDelete(ids)` methods that iterate and return per-item results. Each method clears the cache for affected items.

For dry-run, add `bulkInspect(ids)` that returns current status for each item without modifying anything.

### Durable Object (`src/durable-object.ts`)

New RPC methods:

- `bulkRevokeKeys(ids)` / `bulkDeleteKeys(ids)`
- `bulkRevokeS3Credentials(accessKeyIds)` / `bulkDeleteS3Credentials(accessKeyIds)`
- `bulkInspectKeys(ids)` / `bulkInspectS3Credentials(accessKeyIds)`

Also clears `keyBuckets` for affected key IDs (purge keys only).

### Routes (`src/routes/admin-keys.ts`, `src/routes/admin-s3.ts`)

New Hono POST routes. Validation:

1. Parse body, validate `ids`/`access_key_ids` is a non-empty string array, max 100
2. Validate `confirm_count` is present and matches array length
3. If `dry_run`, call inspect method and return preview
4. Otherwise, call bulk revoke/delete and return results

### CLI (`cli/commands/keys.ts`, `cli/commands/s3-credentials.ts`)

New subcommands:

- `keys bulk-revoke --ids gw_a,gw_b --confirm`
- `keys bulk-delete --ids gw_a,gw_b --confirm`
- `s3-credentials bulk-revoke --ids GKa,GKb --confirm`
- `s3-credentials bulk-delete --ids GKa,GKb --confirm`

The `--confirm` flag is required (acts as the CLI-level fat-finger guard). Without it, the command runs in dry-run mode and shows the preview, prompting the user to re-run with `--confirm`.

### Dashboard

Add multi-select checkboxes to KeysPage and S3CredentialsPage. Selected items enable "Bulk Revoke" / "Bulk Delete" buttons. Before executing, show a confirmation dialog with the count and list of items.

### Tests

Unit tests: bulk revoke (mix of active, already-revoked, not-found), bulk delete (mix of states), confirm_count mismatch, empty array, over-100 array, dry-run preview.

Smoke tests: create N keys, bulk-revoke them, verify all revoked. Create N keys, bulk-delete, verify all gone. Test confirm_count mismatch returns 400. Test dry-run returns preview without side effects.
