# Gatekeeper Code Review — Findings & Fix Tracker

Comprehensive code review findings for the Gatekeeper codebase. Each item includes
the file, line(s), severity, a description of the problem, the verification source
(RFC, docs, or code trace), and a suggested fix. Items are grouped by category.

Status legend: `[ ]` = open, `[x]` = done, `[-]` = won't fix / by design.

---

## Table of Contents

1. [Security — Access Control & RBAC](#1-security--access-control--rbac)
2. [Security — SigV4 / S3 Auth](#2-security--sigv4--s3-auth)
3. [Security — JWT Validation](#3-security--jwt-validation)
4. [Security — Policy Engine](#4-security--policy-engine)
5. [Security — Rate Limiting](#5-security--rate-limiting)
6. [Upstream Token/Key Resolution](#6-upstream-tokenkey-resolution)
7. [Error Handling Gaps](#7-error-handling-gaps)
8. [Data Safety](#8-data-safety)
9. [Performance](#9-performance)
10. [CLI Issues](#10-cli-issues)
11. [Code Quality / DRY](#11-code-quality--dry)
12. [Test Coverage Gaps](#12-test-coverage-gaps)

---

## 1. Security — Access Control & RBAC

### 1.1 `[HIGH]` No role-based access control on admin routes

- **File**: `src/auth-admin.ts:19-37`, `src/routes/admin.ts:16`
- **Problem**: Any valid Cloudflare Access user gets **full admin access** (create/delete
  keys, tokens, credentials, change config). The `AccessIdentity.type` field (`"app"` vs
  `"service-token"`) is extracted but never checked. IDP group memberships and custom
  claims in the JWT payload are completely ignored. A junior team member with CF Access
  can delete all upstream tokens, bulk-delete all API keys, or reconfigure rate limits.
- **Verification**: Cloudflare Access docs confirm JWTs can carry `groups` (via OIDC
  `groups` scope) and custom claims per IdP (Entra ID, Okta, generic OIDC all support
  this). The code's `JWTPayload` interface (`src/auth-access.ts:26-34`) only extracts
  `sub`, `email`, `iss`, `aud`, `exp`, `iat`, `type` — groups/roles are silently dropped.
- **Fix**: Extract `groups` (and optionally custom claims) from the JWT payload. Add a
  role mapping layer (e.g. `admin`, `operator`, `viewer`) resolved from groups. Add
  per-route authorization middleware that checks the required role. Example tiers:
  - `viewer`: GET on `/admin/keys`, `/admin/analytics`, `/admin/config`
  - `operator`: POST/DELETE on `/admin/keys`, `/admin/s3/credentials`, purge keys
  - `admin`: everything including `/admin/config`, `/admin/upstream-*`
- **Status**: `[ ]`

### 1.2 `[LOW]` `created_by` is self-reported for non-SSO users

- **File**: `src/routes/admin-keys.ts:113`, `src/routes/admin-s3.ts:77`
- **Problem**: When auth is via `X-Admin-Key` (no Access JWT), the `created_by` field
  falls back to `raw.created_by` from the request body. A CLI user can claim any email.
- **Verification**: Code trace — `identity?.email ?? (typeof raw.created_by === 'string' ? raw.created_by : undefined)`.
- **Fix**: Document that `created_by` is unverified for non-SSO users. Optionally prefix
  with `unverified:` when not from a JWT.
- **Status**: `[ ]`

---

## 2. Security — SigV4 / S3 Auth

### 2.1 `[LOW]` SigV4 credential scope does not validate `service === 's3'`

- **File**: `src/s3/sig-v4-verify.ts:233`, `src/s3/sig-v4-verify.ts:271`
- **Problem**: When parsing the credential scope (`accessKeyId/date/region/service/aws4_request`),
  `region` is validated against `VALID_REGIONS` and `requestType` against `aws4_request`,
  but `service` is never checked to be `s3`.
- **Verification**: Per AWS docs
  (https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-auth-using-authorization-header.html),
  the Credential field format is `<access-key-id>/<date>/<aws-region>/<aws-service>/aws4_request`
  where `<aws-service>` is `s3`. The signing key derivation (`deriveSigningKey` at line 375)
  feeds `service` into the HMAC chain, so a credential signed with `service=iam` produces
  a different HMAC and the signature **will not match**. This makes the check
  defense-in-depth, not a vulnerability fix.
- **Fix**: Add `if (parsed.service !== 's3') return { valid: false, error: 'Invalid service in credential scope' };`
  after the region validation (lines 45 and 129). Simple one-liner, no risk.
- **Status**: `[ ]`

### 2.2 `[MEDIUM]` Silent DeleteObjects body parse failure bypasses per-key auth

- **File**: `src/s3/routes.ts:198-200`
- **Problem**: If `parseDeleteObjectKeys` throws on malformed XML, the catch block
  silently falls through. `contexts` still contains only the bucket-level `DeleteObjects`
  context (set at line 140-146). This means a crafted invalid XML body skips per-key
  authorization and falls back to bucket-level `s3:DeleteObject` auth.
- **Verification**: AWS S3 API docs for DeleteObjects specify the `<Delete>` XML schema
  and return `MalformedXML` error code for invalid XML
  (https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html). The
  expected behavior is to reject malformed input, not to silently fall back to broader
  authorization.
- **Fix**: Replace the empty `catch {}` with returning `s3XmlError('MalformedXML', ...)`.
  ```typescript
  } catch {
      return s3XmlError('MalformedXML', 'The XML you provided was not well-formed', 400);
  }
  ```
- **Status**: `[ ]`

### 2.3 `[LOW]` No body size limit on DeleteObjects XML

- **File**: `src/s3/routes.ts:164-165`
- **Problem**: `c.req.text()` reads the entire body. A client could send a very large XML
  body to exhaust Worker memory. AWS limits DeleteObjects to 1,000 keys.
- **Verification**: AWS docs: "The request can contain a list of up to 1,000 keys."
  Cloudflare Workers have a 128 MB memory limit per request.
- **Fix**: Check `Content-Length` header before reading. Reject bodies >1 MB (generous for
  1000 keys). Or cap parsed keys at 1000 and reject the rest.
- **Status**: `[ ]`

### 2.4 `[MEDIUM]` Unknown HTTP methods fall through to read operations

- **File**: `src/s3/operations.ts:195-198`, `src/s3/operations.ts:257-260`
- **Problem**: `OPTIONS`, `PATCH`, or unknown methods are classified as `GetObject` (for
  object-level) or `ListObjects` (for bucket-level). This allows policy evaluation and
  forwarding to R2 of methods that should be rejected early.
- **Fix**: Return a `405 MethodNotAllowed` for unrecognized HTTP methods instead of
  falling through to a default operation.
- **Status**: `[ ]`

### 2.5 `[LOW]` `isR2Supported()` defined but never called

- **File**: `src/s3/operations.ts:111`
- **Problem**: The function exists to gate unsupported S3 operations, but no code path
  calls it. Unsupported operations (tagging, versioning, ACL, etc.) are forwarded to R2
  which returns a 501, wasting IAM evaluation, re-signing, and a round-trip.
- **Fix**: Add `if (!isR2Supported(op.name)) return s3XmlError('NotImplemented', ...)` in
  `src/s3/routes.ts` before the auth check, or after auth but before forwarding.
- **Status**: `[ ]`

### 2.6 `[LOW]` No TTL on S3 re-signing `AwsClient` cache

- **File**: `src/s3/sig-v4-sign.ts:9-19`
- **Problem**: Module-level `clientCache` has FIFO size eviction (64 entries) but no TTL.
  If upstream R2 credentials are rotated, the cached `AwsClient` uses the old secret until
  isolate death.
- **Fix**: Add a `cachedAt` timestamp and check TTL (e.g. 5 minutes) on lookup.
- **Status**: `[ ]`

---

## 3. Security — JWT Validation

### 3.1 `[LOW]` No `iat` (issued-at) future-check in CF Access JWT validation

- **File**: `src/auth-access.ts:172-174`
- **Problem**: The code checks `exp` but not that `iat` is in the past. A JWT with a
  future `iat` would be accepted.
- **Verification**: Cloudflare Access JWTs include `iat` (confirmed by the `JWTPayload`
  type at line 32). RFC 7519 Section 4.1.6 defines `iat` as "the time at which the JWT
  was issued." While RFC 7519 doesn't mandate rejecting future `iat`, it's a common
  defense-in-depth check.
- **Note**: `nbf` (not-before) is **not** a standard CF Access JWT claim, so no check is
  needed for it.
- **Fix**: Add after line 174: `if (jwt.payload.iat > now + 60) return null;` (60s skew
  tolerance).
- **Status**: `[ ]`

---

## 4. Security — Policy Engine

### 4.1 `[MEDIUM]` No recursion depth limit on compound conditions

- **File**: `src/policy-engine.ts:95-101`
- **Problem**: `evaluateCondition` recurses through `any`/`all`/`not` without a depth
  limit. A deeply nested policy (e.g. 1000 levels of `{ not: { not: { not: ... } } }`)
  could cause stack overflow at evaluation time. `validateCondition` also doesn't enforce
  max depth.
- **Fix**: Add a `depth` parameter to both `evaluateCondition` and `validateCondition`.
  Reject policies with nesting >20 levels at validation time.
- **Status**: `[ ]`

### 4.2 `[MEDIUM]` ReDoS protection is basic — no runtime execution timeout

- **File**: `src/policy-engine.ts:166-176`, `src/policy-engine.ts:295-296`
- **Problem**: `DANGEROUS_REGEX` catches some catastrophic patterns and `MAX_REGEX_LENGTH`
  caps at 256, but the runtime `new RegExp(pattern).test(value)` has no execution timeout.
  A crafted regex that passes the basic check could still hang the Worker.
- **Verification**: Cloudflare Workers have a 30-second CPU time limit (paid plan) and
  10ms on free. A ReDoS would hit this limit and terminate the request, but it's a
  denial-of-service vector for the Worker.
- **Fix**: Consider using a regex engine with backtracking limits, or run `evalRegex` in a
  try/catch with a more aggressive pattern validator. Alternatively, document that
  `matches`/`not_matches` operators are advanced and should be used carefully.
- **Status**: `[ ]`

### 4.3 `[LOW]` Resource/action matching only supports suffix wildcards

- **File**: `src/policy-engine.ts:59-68`, `src/policy-engine.ts:79-88`
- **Problem**: Only `*` suffix is supported. `"object:*/key.txt"` does not work. Cannot
  write cross-bucket deny rules for specific key names.
- **Note**: This is a design decision, not a bug. Matches AWS IAM's resource ARN pattern
  behavior. Document in API docs.
- **Status**: `[-]` (by design)

### 4.4 `[LOW]` Wildcard condition matching is case-insensitive

- **File**: `src/policy-engine.ts:183-191`
- **Problem**: `evalWildcard` uses the `'i'` flag. `*.Example.com` matches `cdn.example.com`.
  This is documented in a comment but could surprise users.
- **Fix**: Document in the API/policy docs that wildcard conditions are case-insensitive.
- **Status**: `[ ]`

---

## 5. Security — Rate Limiting

### 5.1 `[HIGH]` S3 path has no rate limiting

- **File**: `src/s3/routes.ts` (entire file), `src/durable-object.ts`
- **Problem**: The purge path has both account-level and per-key token-bucket rate
  limiting. The S3 path has **zero rate limiting** — neither account-level nor
  per-credential. A compromised S3 credential can issue unlimited operations against R2.
- **Fix**: Add S3 rate limiting, either:
  - Account-level: token bucket in the DO for S3 ops (like purge has `bulkBucket`/`singleBucket`)
  - Per-credential: configurable per-credential rate limits (like purge per-key limits)
  - At minimum: a global S3 requests-per-second guard
- **Status**: `[ ]`

### 5.2 `[MEDIUM]` `consume(count <= 0)` allows rate-limit bypass via RPC

- **File**: `src/token-bucket.ts:23-25`, `src/durable-object.ts:303-306`
- **Problem**: `TokenBucket.consume()` returns `allowed: true` without consuming tokens
  when `count <= 0`. The DO's `purge()` method guards this (line 130: `if (tokens <= 0) tokens = 1`),
  but the public `consume()` RPC method (line 303) passes `count` directly with no
  validation.
- **Fix**: Add `if (count <= 0) count = 1;` at the top of `consume()` in `token-bucket.ts`,
  or validate in the DO's `consume` RPC method.
- **Status**: `[ ]`

### 5.3 `[MEDIUM]` `rebuildBuckets()` refills all rate-limit buckets on config change

- **File**: `src/durable-object.ts:104-111`
- **Problem**: Any config update (even unrelated to rate limiting, e.g. changing
  `retention_days`) recreates all `TokenBucket` instances at full capacity. Exploit:
  exhaust tokens → trigger config change → all buckets refill.
- **Fix**: Only rebuild buckets when rate-limit config values actually changed. Or preserve
  remaining tokens proportionally: `newBucket.setRemaining(oldBucket.getRemaining() * newSize / oldSize)`.
- **Status**: `[ ]`

---

## 6. Upstream Token/Key Resolution

### 6.1 `[MEDIUM]` Upstream tokens/R2 credentials are never validated at registration

- **File**: `src/routes/admin-upstream-tokens.ts:48-53`, `src/routes/admin-upstream-r2.ts:73-80`
- **Problem**: When an admin registers an upstream CF API token or R2 credential, Gatekeeper
  stores it without testing that it works. An invalid/revoked token causes every purge or
  S3 request for affected zones/buckets to fail with upstream errors. Misconfigurations are
  only discovered at request time.
- **Fix**: Add an optional `validate: true` body parameter. When set:
  - For CF tokens: `GET https://api.cloudflare.com/client/v4/user/tokens/verify` with the token.
  - For R2 creds: `GET /{endpoint}/` (ListBuckets) with the provided credentials.
    Return a warning (not error) if validation fails, so the admin can still force-register.
- **Status**: `[ ]`

### 6.2 `[LOW]` No binding between API key and upstream token

- **File**: `src/routes/purge.ts:94-102`
- **Problem**: Upstream token selection is purely by zone ID, completely decoupled from the
  API key. A key with `zone_id: null` (any-zone) can purge any zone that has an upstream
  token, limited only by the policy engine. This is by design but underdocumented.
- **Note**: This is actually the correct architecture — admin registers upstream tokens
  per-zone, keys control _what_ via policies. But the mental model should be documented.
- **Status**: `[-]` (by design, document it)

### 6.3 `[LOW]` Wildcard upstream tokens can match zones they don't cover

- **File**: `src/upstream-tokens.ts:187-196`
- **Problem**: A wildcard token (`zone_ids: "*"`) catches all zones without explicit tokens.
  If the wildcard token's actual CF account doesn't own all zones, requests fail silently.
- **Fix**: Document that wildcard tokens should only be used when the account owns all
  zones. Consider an optional scope validation at registration.
- **Status**: `[ ]`

### 6.4 `[LOW]` Upstream token zone_id format not validated at registration

- **File**: `src/routes/admin-upstream-tokens.ts:37-43`
- **Problem**: `zone_ids` is validated as `string[]` but format isn't checked. You can
  register `zone_ids: ["not-a-zone"]`. The purge route validates the incoming zoneId
  (`/^[a-f0-9]{32}$/`), so invalid zone IDs in tokens are never matched — but the data is
  polluted.
- **Fix**: Validate each zone_id matches `/^[a-f0-9]{32}$/` or is `"*"`.
- **Status**: `[ ]`

---

## 7. Error Handling Gaps

### 7.1 `[HIGH]` No top-level try/catch on purge route handler

- **File**: `src/routes/purge.ts:25`
- **Problem**: If `stub.getConfig()`, `stub.authorizeFromBody()`, or
  `isolateCollapser.collapseOrCreate()` throws an unhandled error, Hono returns an
  unstructured 500 instead of the CF API-style JSON envelope
  `{ success: false, errors: [...] }`. This violates the project's own error-handling
  convention (AGENTS.md: "Worker routes: try/catch returning Cloudflare API-style JSON").
- **Fix**: Wrap the entire handler body in try/catch:
  ```typescript
  purgeRoute.post('/v1/zones/:zoneId/purge_cache', async (c) => {
  	try {
  		// ... existing code ...
  	} catch (e: any) {
  		console.error(JSON.stringify({ route: 'purge', error: e.message, ts: new Date().toISOString() }));
  		return c.json({ success: false, errors: [{ code: 500, message: 'Internal server error' }] }, 500);
  	}
  });
  ```
- **Status**: `[ ]`

### 7.2 `[HIGH]` No top-level try/catch on admin route handlers

- **File**: All files in `src/routes/admin-*.ts`
- **Problem**: Same as 7.1 — if the DO stub throws (e.g. DO overloaded, RPC timeout), the
  error propagates as an unstructured 500.
- **Fix**: Either add try/catch to each handler, or add a Hono `onError` handler on the
  `adminApp` that catches all errors and returns structured JSON.
- **Status**: `[ ]`

### 7.3 `[MEDIUM]` Header case mismatch in 429 detection

- **File**: `src/routes/purge.ts:151`
- **Problem**: `result.headers['Ratelimit']` checks with capital-R. The DO's
  `buildRateLimitResult` (line 42) sets `Ratelimit` with capital-R, so this works for
  gateway-originated 429s. But if headers are normalized to lowercase somewhere in the
  chain, the check fails and all 429s would be logged as `upstream_rate_limited`.
- **Verification**: `PurgeResult.headers` is `Record<string, string>` — the DO sets the
  exact key `Ratelimit` at `durable-object.ts:42`. JavaScript object property access is
  case-sensitive, so `result.headers['Ratelimit']` will find the DO-set key. This is
  actually correct for the current implementation, but fragile if header naming changes.
- **Fix**: Use a consistent lowercase key throughout, or check with a case-insensitive
  helper.
- **Status**: `[ ]`

### 7.4 `[LOW]` `responseDetail` captured but never included in console log for S3

- **File**: `src/s3/routes.ts:240-250`
- **Problem**: The R2 error body is captured in `responseDetail` and passed to D1 analytics,
  but it's not in the `console.log(JSON.stringify(log))` structured log. Operators using
  `wrangler tail` miss it.
- **Fix**: Add `log.responseDetail = responseDetail;` before the console.log call.
- **Status**: `[ ]`

---

## 8. Data Safety

### 8.1 `[HIGH]` Destructive schema migrations drop entire tables

- **File**: `src/iam.ts:50-69`, `src/upstream-tokens.ts:61-76`, `src/s3/upstream-r2.ts:73-90`
- **Problem**: If old schema is detected (e.g. `zone_id` has `NOT NULL`, or `revoked` column
  exists), the code does `DROP TABLE` + `CREATE TABLE`, deleting all existing data.
- **Fix**: These are one-time migrations from an old schema. Options:
  1. Replace with `ALTER TABLE` migrations (SQLite supports limited ALTER TABLE).
  2. Add a migration version flag (e.g. a `schema_version` table) so the migration only
     runs once and is explicit.
  3. At minimum, add a `console.warn` log so operators know data was dropped.
- **Status**: `[ ]`

---

## 9. Performance

### 9.1 `[MEDIUM]` `ensureTables()` runs DDL on every analytics write

- **File**: `src/analytics.ts:31-33`, `src/s3/analytics.ts:24-26`
- **Problem**: Every `logPurgeEvent`, `logS3Event`, `queryEvents`, `querySummary`,
  `deleteOldEvents` call runs 3+ `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
  D1 statements. On the purge hot path, this is unnecessary overhead.
- **Fix**: Use a module-level `Set<D1Database>` to track initialized databases. Only call
  `ensureTables` once per database per isolate lifetime.
  ```typescript
  const initialized = new WeakSet<D1Database>();
  async function ensureTablesOnce(db: D1Database) {
  	if (initialized.has(db)) return;
  	await ensureTables(db);
  	initialized.add(db);
  }
  ```
- **Status**: `[ ]`

### 9.2 `[LOW]` `resolveForBucket` queries all rows every cache miss

- **File**: `src/s3/upstream-r2.ts:198`
- **Problem**: `SELECT * FROM upstream_r2 ORDER BY created_at DESC` on every cache miss
  reads all endpoints including secrets. For a small number of endpoints this is fine.
- **Fix**: Fine for now. Consider a targeted query if endpoint count grows past ~50.
- **Status**: `[-]` (acceptable at current scale)

### 9.3 `[LOW]` Double DO RPC calls in admin routes

- **File**: `src/routes/admin-keys.ts:98+121`, `src/routes/admin-config.ts:95+98`
- **Problem**: `getConfig()` + `createKey()` and `setConfig()` + `getConfig()` are
  sequential round-trips. Could be optimized by having `createKey` validate internally or
  `setConfig` return the new config.
- **Fix**: Low priority — only affects admin latency, not hot path.
- **Status**: `[ ]`

---

## 10. CLI Issues

### 10.1 `[HIGH]` `config set` accepts `Infinity` as valid value

- **File**: `cli/commands/config.ts:104`
- **Problem**: `Number("Infinity")` passes the `isNaN(value) || value <= 0` check.
  `Number.isFinite(Infinity)` returns `false`.
- **Fix**: Change check to `!Number.isFinite(value) || value <= 0`.
- **Status**: `[ ]`

### 10.2 `[HIGH]` No timeout on CLI HTTP requests

- **File**: `cli/client.ts:68`
- **Problem**: `fetch()` has no `AbortSignal` or timeout. A hung server causes the CLI to
  hang indefinitely.
- **Fix**: Add `signal: AbortSignal.timeout(30_000)` to the fetch options.
- **Status**: `[ ]`

### 10.3 `[MEDIUM]` Non-JSON error responses silently swallowed

- **File**: `cli/client.ts:75`
- **Problem**: `res.json().catch(() => null)` discards HTML error pages (e.g. Cloudflare
  error page). The user gets a generic error with no diagnostic info.
- **Fix**: On JSON parse failure, fall back to `res.text()` and include the raw body
  (truncated) in the error message.
- **Status**: `[ ]`

### 10.4 `[LOW]` Unused imports in CLI commands

- **File**: `cli/commands/config.ts` (imports `warn`), others import unused `symbols`/`gray`
- **Fix**: Remove unused imports.
- **Status**: `[ ]`

---

## 11. Code Quality / DRY

### 11.1 `[MEDIUM]` `parseBulkBody` duplicated across 4 admin route files

- **Files**: `src/routes/admin-keys.ts:281`, `src/routes/admin-s3.ts:236`,
  `src/routes/admin-upstream-tokens.ts:149`, `src/routes/admin-upstream-r2.ts:176`
- **Problem**: Nearly identical bulk-body parsing. `admin-keys.ts` already parameterizes
  with `idField` — the others should reuse it.
- **Fix**: Extract `parseBulkBody` to a shared module (e.g. `src/routes/helpers.ts`).
- **Status**: `[ ]`

### 11.2 `[LOW]` `MAX_BULK_ITEMS = 100` defined independently in 4 files

- **Files**: Same as 11.1.
- **Fix**: Export from shared module.
- **Status**: `[ ]`

### 11.3 `[MEDIUM]` CLI: `globalArgs` duplicated in every command file

- **Files**: All `cli/commands/*.ts` files.
- **Problem**: `endpoint`, `admin-key`, `json` args are identical in every command.
- **Fix**: Extract to `cli/shared-args.ts`.
- **Status**: `[ ]`

### 11.4 `[MEDIUM]` CLI: Confirmation prompt copy-pasted 5 times

- **Files**: `cli/commands/keys.ts:242-252`, `cli/commands/purge.ts:210-220`,
  `cli/commands/s3-credentials.ts:235-245`, `cli/commands/upstream-r2.ts:200-210`,
  `cli/commands/upstream-tokens.ts:188-198`
- **Fix**: Extract to `confirm()` utility in `cli/ui.ts`.
- **Status**: `[ ]`

### 11.5 `[LOW]` `queryAll` lives in `crypto.ts`

- **File**: `src/crypto.ts:28`
- **Problem**: A SQL utility in a module named `crypto` is misleading.
- **Fix**: Move to `src/db-utils.ts` or `src/sql.ts`.
- **Status**: `[ ]`

### 11.6 `[LOW]` Purge body `classifyPurge` vs `purgeBodyToContexts` scope mismatch

- **File**: `src/routes/purge.ts:208`, `src/iam.ts:327-388`
- **Problem**: `classifyPurge` picks `files` first and ignores `hosts`/`tags`/`prefixes` if
  files exist. But `purgeBodyToContexts` generates contexts for **all** present fields.
  So IAM authorizes a broader scope than what is actually sent upstream. Not exploitable
  (authorized scope > execution scope), but wastes policy evaluation.
- **Fix**: Either reject mixed bodies (like CF API does) or align the two functions.
- **Status**: `[ ]`

### 11.7 `[LOW]` Global regex `g` flag on `DELETE_KEY_RE`

- **File**: `src/s3/xml.ts:36-46`
- **Problem**: Module-scoped regex with `g` flag has `lastIndex` state. Manual reset
  handles it, but if an exception occurs between the while loop and reset, `lastIndex`
  stays non-zero. A function-scoped regex would be inherently safe.
- **Fix**: Move the regex inside the function, or remove the `g` flag and use `matchAll`.
- **Status**: `[ ]`

---

## 12. Test Coverage Gaps

### 12.1 `[HIGH]` CLI commands have zero test coverage

- **Files**: All `cli/commands/*.ts` files.
- **Problem**: The actual command `run()` functions with subcommand branching, formatting,
  and error handling are completely untested. Only `parsePolicy`, `formatDuration`,
  `resolveConfig`, `resolveZoneId` from `ui.ts` are tested in `cli/cli.test.ts`.
- **Status**: `[ ]`

### 12.2 `[MEDIUM]` `cli/client.ts` is untested

- **Problem**: `request()`, `assertOk()`, spinner behavior, error formatting — no tests.
- **Status**: `[ ]`

### 12.3 `[MEDIUM]` Multiple `ui.ts` functions untested

- **Problem**: `formatRateLimit`, `formatKey`, `formatPolicy`, `formatApiError`, `table`,
  `spinner`, `renderBar`, `printJson` — none tested.
- **Status**: `[ ]`

### 12.4 `[LOW]` No multi-file token cost test

- **File**: `test/purge.test.ts`
- **Problem**: Tests single-file purge but doesn't verify that a 30-URL purge consumes 30
  tokens from the single bucket.
- **Status**: `[ ]`

### 12.5 `[LOW]` IAM test re-declares helpers from `test/helpers.ts`

- **File**: `test/iam.test.ts`
- **Problem**: Locally defines `wildcardPolicy()`, `hostPolicy()`, etc. that duplicate
  `test/helpers.ts`.
- **Fix**: Import from `test/helpers.ts`.
- **Status**: `[ ]`

---

## Priority Ordering for Implementation

### Must-fix (security/correctness)

1. 7.1 + 7.2 — Add try/catch to purge and admin route handlers
2. 1.1 — Add RBAC to admin routes (extract groups from JWT, add role middleware)
3. 5.1 — Add S3 rate limiting
4. 2.2 — Return MalformedXML on DeleteObjects parse failure
5. 5.2 — Validate `count > 0` in token bucket
6. 8.1 — Replace destructive migrations with safe ALTER TABLE

### Should-fix (robustness)

7. 5.3 — Only rebuild buckets when rate-limit config changes
8. 10.1 — Fix `Infinity` acceptance in CLI config set
9. 10.2 — Add timeout to CLI HTTP requests
10. 2.4 — Reject unknown HTTP methods in S3 operations
11. 4.1 — Add recursion depth limit to policy conditions
12. 6.1 — Add optional upstream token/credential validation

### Nice-to-have (quality/DRY)

13. 11.1-11.4 — Extract shared code (parseBulkBody, globalArgs, confirm)
14. 9.1 — Deduplicate ensureTables calls
15. 12.1-12.3 — CLI test coverage
16. 2.1 — Validate service in SigV4
17. 2.5 — Call isR2Supported before forwarding

---

_Last updated: 2026-03-07_
