# Smoke Test Plan: Granular Policy Enforcement

The smoke tests currently validate creation-time binding rules and action-level mismatches, but barely test the **runtime policy engine** — the layer that actually restricts what a key can do beyond what the upstream token already allows. The upstream token can already do everything; the entire value prop is the policy narrowing that down. If any policy engine code path regresses, keys silently become more powerful than intended.

This document tracks every test to be added. Check boxes as each is implemented.

---

## 1. Resource-scoped keys used against wrong resources at runtime

**Why it matters:** `matchesResource` in `policy-engine.ts:85-96` is the only thing preventing a key scoped to database A from querying database B. The upstream token has access to both — the policy is the sole gate.

**File:** `cli/smoke/cf-proxy.ts`

### 1a. D1 database-scoped key — wrong database

- [ ] **Create** a key scoped to a specific D1 database via hierarchical resource.

The key already exists (`cf-proxy.ts:180-190`, `tbCorrectHierKeyId`) but is never used. Reuse it or create a new one:

```js
const D1_SCOPED_POLICY = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['d1:query'],
			resources: [`account:${ACCOUNT_ID}/d1/${dbId}`],
		},
	],
};
```

The resource string for a D1 query is built by `d1QueryContext()` in `src/cf/d1/operations.ts:107-120`:

```
resource: `account:${accountId}/d1/${databaseId}`
```

- [ ] **Use the key to query the correct database** → expect **200**.

```js
const scopedOk = await cf(D1_SCOPED_KEY, 'POST', `${CF_BASE}/d1/database/${dbId}/query`, { sql: 'SELECT 1' });
assertStatus('db-scoped key: query correct db -> 200', scopedOk, 200);
```

- [ ] **Use the key to query a different database** → expect **403**.

We need a second database. Create one (like `gk-smoke-scoped-target-${Date.now()}`), use its ID, then clean up:

```js
const scopedDenied = await cf(D1_SCOPED_KEY, 'POST', `${CF_BASE}/d1/database/${otherDbId}/query`, { sql: 'SELECT 1' });
assertStatus('db-scoped key: query wrong db -> 403', scopedDenied, 403);
```

- [ ] **Use the key to list databases (account-level resource)** → expect **403**.

List databases uses `resource: account:${accountId}` (no `/d1/` suffix), so a key scoped to `account:X/d1/Y` should not match `account:X` (child doesn't match parent):

```js
const scopedList = await cf(D1_SCOPED_KEY, 'GET', `${CF_BASE}/d1/database`);
assertStatus('db-scoped key: list databases (account-level) -> 403', scopedList, 403);
```

### 1b. KV namespace-scoped key — wrong namespace

- [ ] **Create** a key scoped to a specific KV namespace.

```js
const KV_SCOPED_POLICY = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['kv:get_value', 'kv:put_value', 'kv:list_keys'],
			resources: [`account:${ACCOUNT_ID}/kv/${nsId}`],
		},
	],
};
```

The resource string for KV operations is built by e.g. `kvListKeysContext()` in `src/cf/kv/operations.ts:96-100`:

```
resource: `account:${accountId}/kv/${namespaceId}`
```

- [ ] **List keys in the correct namespace** → expect **200**.
- [ ] **List keys in a different (nonexistent) namespace** → expect **403**.

```js
const kvScopedBad = await cf(KV_SCOPED_KEY, 'GET', `${CF_BASE}/storage/kv/namespaces/aaaa1111bbbb2222cccc3333dddd4444/keys`);
assertStatus('ns-scoped key: list keys in wrong namespace -> 403', kvScopedBad, 403);
```

- [ ] **List namespaces (account-level)** → expect **403** (resource is `account:X`, not `account:X/kv/...`).

### 1c. S3 bucket-scoped credential — wrong bucket

**File:** `cli/smoke/s3.ts`

The bucket-scoped credential already exists (`s3.ts:211-223`, `correctBucketAk`) but is never used at runtime.

```js
// Already created with:
// resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`]
```

The resource string is built by `buildOp()` in `src/s3/operations.ts:267-280`:

- ListObjectsV2 on bucket X → `resource: bucket:X`
- GetObject on bucket X / key Y → `resource: object:X/Y`

- [ ] **ListObjectsV2 on the correct bucket** → expect **200**.

```js
const scopedClient = s3client(correctBucketAk, correctBucketSk);
const scopedList = await s3req(scopedClient, 'GET', `/${S3_TEST_BUCKET}?list-type=2&max-keys=1`);
assertStatus('bucket-scoped cred: list correct bucket -> 200', scopedList, 200);
```

- [ ] **ListObjectsV2 on a different bucket** → expect **403**.

```js
const scopedWrongBucket = await s3req(scopedClient, 'GET', '/wrong-bucket-name?list-type=2&max-keys=1');
assertStatus('bucket-scoped cred: list wrong bucket -> 403', scopedWrongBucket, 403);
```

- [ ] **GetObject from the correct bucket** → expect **200** (or 404 — not 403).
- [ ] **GetObject from a different bucket** → expect **403**.

### 1d. S3 object-prefix-scoped credential — wrong prefix

**File:** `cli/smoke/s3.ts`

- [ ] **Create** a credential scoped to a specific key prefix.

```js
const PREFIX_S3_POLICY = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
			resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/images/*`],
		},
	],
};
```

Resource for `GetObject` on key `images/photo.jpg` → `object:${bucket}/images/photo.jpg`.
Resource for `GetObject` on key `secrets/key.txt` → `object:${bucket}/secrets/key.txt`.
`object:${bucket}/images/*` matches the first but not the second.

- [ ] **PutObject to `images/smoke-test.jpg`** → expect **200**.
- [ ] **GetObject from `images/smoke-test.jpg`** → expect **200**.
- [ ] **GetObject from `secrets/forbidden.txt`** → expect **403**.
- [ ] **PutObject to `secrets/forbidden.txt`** → expect **403**.
- [ ] **Clean up** the object created in `images/`.

---

## 2. Compound conditions (`not`, `any`, `all`) at runtime

**Why it matters:** Compound conditions are the building blocks for complex policies. `not` inversion bugs let denied values through. `any`/`all` short-circuit bugs silently over-permit or over-deny. Source: `policy-engine.ts:106-116`.

**File:** `cli/smoke/purge.ts`

All tests use the zone-scoped upstream token + `createKey` helper. The `purge:host` action populates `fields.host` via `purgeBodyToContexts()` in `iam.ts:474-478`.

### 2a. `not` — negation

- [ ] **Create** a key that allows purge:host for any host EXCEPT `internal.corp`.

```js
const notPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ not: { field: 'host', operator: 'eq', value: 'internal.corp' } }],
		},
	],
};
const { keyId: NOT_KEY } = await createKey('smoke-not-condition', ZONE, notPolicy);
```

- [ ] **Purge `erfi.io`** → **200** (not `internal.corp`, so `not` evaluates to true).
- [ ] **Purge `internal.corp`** → **403** (`not(host eq internal.corp)` = `not(true)` = false → condition fails → no allow → denied).

### 2b. `any` — OR logic

- [ ] **Create** a key that allows purge:host only for `a.com` OR `b.com`.

```js
const anyPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [
				{
					any: [
						{ field: 'host', operator: 'eq', value: 'a.com' },
						{ field: 'host', operator: 'eq', value: 'b.com' },
					],
				},
			],
		},
	],
};
const { keyId: ANY_KEY } = await createKey('smoke-any-condition', ZONE, anyPolicy);
```

- [ ] **Purge `a.com`** → **200**.
- [ ] **Purge `b.com`** → **200**.
- [ ] **Purge `c.com`** → **403** (neither branch of `any` matches).

### 2c. `all` — AND logic

- [ ] **Create** a key that allows purge:host only when host starts with `cdn` AND ends with `.com`.

```js
const allPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [
				{
					all: [
						{ field: 'host', operator: 'starts_with', value: 'cdn' },
						{ field: 'host', operator: 'ends_with', value: '.com' },
					],
				},
			],
		},
	],
};
const { keyId: ALL_KEY } = await createKey('smoke-all-condition', ZONE, allPolicy);
```

- [ ] **Purge `cdn.example.com`** → **200** (both arms match).
- [ ] **Purge `cdn.example.org`** → **403** (fails `ends_with .com`).
- [ ] **Purge `api.example.com`** → **403** (fails `starts_with cdn`).

### 2d. Nested compound — `not` inside `any`

- [ ] **Create** a key with a nested compound condition: allow purge:host where `any` of: host eq `safe.com`, `not(host starts_with "internal")`.

```js
const nestedPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [
				{
					any: [
						{ field: 'host', operator: 'eq', value: 'safe.com' },
						{ not: { field: 'host', operator: 'starts_with', value: 'internal' } },
					],
				},
			],
		},
	],
};
const { keyId: NESTED_KEY } = await createKey('smoke-nested-compound', ZONE, nestedPolicy);
```

Semantics: allow if host is `safe.com` OR host does NOT start with `internal`.

- [ ] **Purge `safe.com`** → **200** (first branch matches).
- [ ] **Purge `public.com`** → **200** (second branch: `not(starts_with "internal")` = true).
- [ ] **Purge `internal.corp`** → **403** (first branch: not `safe.com`. second branch: `not(starts_with "internal")` = false. no branch matches).

### 2e. Nested compound — `all` inside `not` in deny

- [ ] **Create** a key with a deny statement using `not(all(...))`: allow `purge:*`, deny `purge:host` where `not(all(host starts_with "cdn", host ends_with ".com"))`. This means: deny host purge UNLESS host starts with "cdn" AND ends with ".com".

```js
const denyNestedPolicy = {
	version: '2025-01-01',
	statements: [
		{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] },
		{
			effect: 'deny',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [
				{
					not: {
						all: [
							{ field: 'host', operator: 'starts_with', value: 'cdn' },
							{ field: 'host', operator: 'ends_with', value: '.com' },
						],
					},
				},
			],
		},
	],
};
const { keyId: DENY_NESTED_KEY } = await createKey('smoke-deny-nested', ZONE, denyNestedPolicy);
```

Semantics: deny fires when `not(cdn* AND *.com)` is true — i.e. deny everything that ISN'T a cdn\*.com host.

- [ ] **Purge `cdn.example.com`** → **200** (deny condition = `not(true AND true)` = false → deny doesn't fire → allow matches).
- [ ] **Purge `api.example.com`** → **403** (deny condition = `not(false AND true)` = true → deny fires).
- [ ] **Purge tags `['v1']`** → **200** (deny is on `purge:host` action only, tag purge is unaffected).

### 2f. Multi-statement policy — multiple allow statements with different scopes

- [ ] **Create** a key with two separate allow statements, each covering different hosts.

```js
const multiStmtPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'eq', value: 'cdn.erfi.io' }],
		},
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'eq', value: 'api.erfi.io' }],
		},
	],
};
const { keyId: MULTI_STMT_KEY } = await createKey('smoke-multi-statement', ZONE, multiStmtPolicy);
```

- [ ] **Purge `cdn.erfi.io`** → **200** (first statement matches).
- [ ] **Purge `api.erfi.io`** → **200** (second statement matches).
- [ ] **Purge `evil.com`** → **403** (neither statement matches).

### 2g. Multi-statement policy — allow + narrow deny with conditions on the same action

- [ ] **Create** a key that allows all host purges but denies a specific host via a conditional deny.

```js
const allowDenyPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
		},
		{
			effect: 'deny',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'eq', value: 'protected.erfi.io' }],
		},
	],
};
const { keyId: ALLOW_DENY_KEY } = await createKey('smoke-allow-deny-host', ZONE, allowDenyPolicy);
```

- [ ] **Purge `erfi.io`** → **200** (allow matches, deny condition doesn't fire).
- [ ] **Purge `protected.erfi.io`** → **403** (deny fires because condition matches — deny-first evaluation).
- [ ] **Purge `other.erfi.io`** → **200** (deny condition doesn't match).

---

## 3. Untested condition operators at runtime

**Why it matters:** Every operator is a distinct code path in `evaluateLeaf()` (`policy-engine.ts:121-165`). If any is broken, policies using it fail open or closed. The smoke tests currently only exercise `eq`, `starts_with`, `wildcard`, and `gte` (trivially). All others are untested at runtime.

**File:** `cli/smoke/purge.ts`

Purge:host sets `fields.host`, purge:tag sets `fields.tag`, purge:prefix sets `fields.prefix`. These are the condition fields we can test against.

### 3a. `in`

- [ ] **Create** a key allowing purge:host where host is in a whitelist.

```js
const inPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'in', value: ['a.com', 'b.com', 'c.com'] }],
		},
	],
};
const { keyId: IN_KEY } = await createKey('smoke-op-in', ZONE, inPolicy);
```

- [ ] **Purge `a.com`** → **200**.
- [ ] **Purge `d.com`** → **403**.

### 3b. `not_in`

- [ ] **Create** a key allowing purge:host where host is NOT in a blocklist.

```js
const notInPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'not_in', value: ['blocked.com', 'banned.com'] }],
		},
	],
};
const { keyId: NOT_IN_KEY } = await createKey('smoke-op-not-in', ZONE, notInPolicy);
```

- [ ] **Purge `erfi.io`** → **200** (not in blocklist).
- [ ] **Purge `blocked.com`** → **403** (in blocklist → `not_in` returns false → condition fails).

### 3c. `ne`

- [ ] **Create** a policy using `ne` in a deny statement: allow `purge:*`, deny `purge:host` where `host ne "safe.com"`. Effect: deny everything except `safe.com` host purges.

```js
const nePolicy = {
	version: '2025-01-01',
	statements: [
		{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] },
		{
			effect: 'deny',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'ne', value: 'safe.com' }],
		},
	],
};
const { keyId: NE_KEY } = await createKey('smoke-op-ne', ZONE, nePolicy);
```

- [ ] **Purge `safe.com`** → **200** (deny condition: `host ne safe.com` = false → deny doesn't fire).
- [ ] **Purge `evil.com`** → **403** (deny condition: `host ne safe.com` = true → deny fires).
- [ ] **Purge tags `['v1']`** → **200** (deny is on purge:host only).

### 3d. `contains`

- [ ] **Create** a key allowing purge:host where host contains `"cdn"`.

```js
const containsPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'contains', value: 'cdn' }],
		},
	],
};
const { keyId: CONTAINS_KEY } = await createKey('smoke-op-contains', ZONE, containsPolicy);
```

- [ ] **Purge `cdn.example.com`** → **200** (contains `cdn`).
- [ ] **Purge `api.example.com`** → **403** (does not contain `cdn`).

### 3e. `not_contains`

- [ ] **Create** a key allowing purge:host where host does NOT contain `"internal"`.

```js
const notContainsPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'not_contains', value: 'internal' }],
		},
	],
};
const { keyId: NOT_CONTAINS_KEY } = await createKey('smoke-op-not-contains', ZONE, notContainsPolicy);
```

- [ ] **Purge `public.example.com`** → **200**.
- [ ] **Purge `internal.example.com`** → **403**.

### 3f. `ends_with`

- [ ] **Create** a key allowing purge:host where host ends with `".erfi.io"`.

```js
const endsWithPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'ends_with', value: '.erfi.io' }],
		},
	],
};
const { keyId: ENDS_WITH_KEY } = await createKey('smoke-op-ends-with', ZONE, endsWithPolicy);
```

- [ ] **Purge `cdn.erfi.io`** → **200**.
- [ ] **Purge `cdn.evil.com`** → **403**.

### 3g. `matches` (regex)

- [ ] **Create** a key allowing purge:host where host matches a regex.

```js
const matchesPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'matches', value: '^cdn-\\d+\\.example\\.com$' }],
		},
	],
};
const { keyId: MATCHES_KEY } = await createKey('smoke-op-matches', ZONE, matchesPolicy);
```

- [ ] **Purge `cdn-01.example.com`** → **200** (regex matches).
- [ ] **Purge `cdn-ab.example.com`** → **403** (`\\d+` requires digits, `ab` fails).
- [ ] **Purge `evil.example.com`** → **403** (no `cdn-` prefix).

### 3h. `not_matches` (negated regex)

- [ ] **Create** a key allowing purge:host where host does NOT match an internal pattern.

```js
const notMatchesPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'host', operator: 'not_matches', value: '^internal-.*\\.corp$' }],
		},
	],
};
const { keyId: NOT_MATCHES_KEY } = await createKey('smoke-op-not-matches', ZONE, notMatchesPolicy);
```

- [ ] **Purge `public.example.com`** → **200** (doesn't match internal pattern).
- [ ] **Purge `internal-db.corp`** → **403** (matches the pattern → `not_matches` returns false).

### 3i. `exists` / `not_exists`

- [ ] **Create** a key with a deny that fires when a field exists.

```js
const existsPolicy = {
	version: '2025-01-01',
	statements: [
		{ effect: 'allow', actions: ['purge:host', 'purge:tag'], resources: [`zone:${ZONE}`] },
		{
			effect: 'deny',
			actions: ['purge:tag'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'tag', operator: 'exists' }],
		},
	],
};
const { keyId: EXISTS_KEY } = await createKey('smoke-op-exists', ZONE, existsPolicy);
```

For `purge:host` requests, the `tag` field is NOT populated (`iam.ts:474-478` only sets `host`). For `purge:tag` requests, the `tag` field IS populated (`iam.ts:480-484`).

- [ ] **Purge hosts `['erfi.io']`** → **200** (deny is on `purge:tag` action, doesn't match `purge:host`).
- [ ] **Purge tags `['static-v1']`** → **403** (deny matches: action is `purge:tag`, and `tag` field exists).

Then test `not_exists`:

- [ ] **Create** a key with allow condition `not_exists` on a field that's present for tag purge.

```js
const notExistsPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:host', 'purge:tag'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'tag', operator: 'not_exists' }],
		},
	],
};
const { keyId: NOT_EXISTS_KEY } = await createKey('smoke-op-not-exists', ZONE, notExistsPolicy);
```

- [ ] **Purge hosts `['erfi.io']`** → **200** (`tag` field does not exist → `not_exists` true → allow).
- [ ] **Purge tags `['v1']`** → **403** (`tag` field exists → `not_exists` false → condition fails → no allow).

---

## 4. Conditional deny scoped to a specific sub-resource (CF proxy)

**Why it matters:** Real deployment pattern: "allow all D1 operations on this account, but deny queries on the production database." Tests that deny + hierarchical resource narrowing work together at runtime. The deny's resource (`account:X/d1/<prod-db>`) is narrower than the allow's resource (`account:X`). Source: `matchesResource` parent-match at `policy-engine.ts:93`.

**File:** `cli/smoke/cf-proxy.ts`

### 4a. D1: allow account-wide, deny query on specific database

- [ ] **Create** two D1 databases (db-allow, db-deny).
- [ ] **Create** a key with this policy:

```js
const denySubResourcePolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['d1:*'],
			resources: [`account:${ACCOUNT_ID}`],
		},
		{
			effect: 'deny',
			actions: ['d1:query'],
			resources: [`account:${ACCOUNT_ID}/d1/${denyDbId}`],
		},
	],
};
```

- [ ] **List databases** → **200** (action=`d1:list`, resource=`account:X` — deny's resource `account:X/d1/<id>` doesn't match `account:X`).
- [ ] **Query db-allow** → **200** (action=`d1:query`, resource=`account:X/d1/<allow-id>` — deny's resource is for a different db).
- [ ] **Query db-deny** → **403** (action=`d1:query`, resource=`account:X/d1/<deny-id>` — deny matches exactly).
- [ ] **Get db-deny** → **200** (action=`d1:get`, not `d1:query` — deny only covers `d1:query`).
- [ ] **Clean up** both databases.

---

## 5. Expired key at runtime

**Why it matters:** `iam.ts:320-323` checks `key.expires_at && key.expires_at < Date.now()`. If this regresses, time-limited keys become permanent. The PATCH endpoint (`admin-keys.ts:207-253`) accepts `expires_at: number | null` via `updateKeySchema`.

**File:** `cli/smoke/purge.ts`

### 5a. Purge key expired via PATCH

- [ ] **Create** a key with the wildcard purge policy (no expiry).
- [ ] **Verify it works** — purge `erfi.io` → **200**.
- [ ] **PATCH the key** to set `expires_at` to a past timestamp.

```js
const pastTs = Date.now() - 60_000; // 1 minute ago
const patchRes = await admin('PATCH', `/admin/keys/${EXPIRED_KEY}`, { expires_at: pastTs });
assertStatus('PATCH key expires_at to past -> 200', patchRes, 200);
```

- [ ] **Use the expired key** — purge `erfi.io` → **403**.

```js
const expiredReq = await purge(EXPIRED_KEY, PURGE_URL, { hosts: ['erfi.io'] });
assertStatus('expired key -> 403', expiredReq, 403);
```

- [ ] **Verify error message** mentions expiration.

```js
assertMatch('expired key error message', expiredReq.body?.errors?.[0]?.message ?? '', /expired/i);
```

---

## 6. Numeric condition that actually restricts

**Why it matters:** Current numeric test (`time.hour >= 0`) always matches — it doesn't verify that the numeric path can actually deny. Source: `evalNumeric` at `policy-engine.ts:171-176`. The `time.hour` field is populated by `extractRequestFields()` in `request-fields.ts:26` as `String(now.getUTCHours())`, which is always 0-23.

**File:** `cli/smoke/purge.ts`

### 6a. Always-false numeric condition → denied

- [ ] **Create** a key with `time.hour lt 0` (no UTC hour is negative → condition always false → no allow → implicit deny).

```js
const numDenyPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:*'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'time.hour', operator: 'lt', value: '0' }],
		},
	],
};
const { keyId: NUM_DENY_KEY } = await createKey('smoke-num-always-deny', ZONE, numDenyPolicy);
```

- [ ] **Purge `erfi.io`** → **403**.

### 6b. Always-true numeric condition → allowed (control)

- [ ] **Create** a key with `time.hour gte 0` (always true → allow).

```js
const numAllowPolicy = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['purge:*'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'time.hour', operator: 'gte', value: '0' }],
		},
	],
};
const { keyId: NUM_ALLOW_KEY } = await createKey('smoke-num-always-allow', ZONE, numAllowPolicy);
```

- [ ] **Purge `erfi.io`** → **200**.

### 6c. Numeric deny with `gt` that restricts

- [ ] **Create** a key: allow `purge:*`, deny `purge:everything` where `time.hour gt -1` (always true → deny always fires for purge_everything).

```js
const numDenyGtPolicy = {
	version: '2025-01-01',
	statements: [
		{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] },
		{
			effect: 'deny',
			actions: ['purge:everything'],
			resources: [`zone:${ZONE}`],
			conditions: [{ field: 'time.hour', operator: 'gt', value: '-1' }],
		},
	],
};
const { keyId: NUM_DENY_GT_KEY } = await createKey('smoke-num-deny-gt', ZONE, numDenyGtPolicy);
```

- [ ] **Purge hosts `['erfi.io']`** → **200** (deny is only on `purge:everything`).
- [ ] **Purge everything** → **403** (deny fires because `time.hour > -1` is always true).

---

## 7. S3 resource-scoped deny (broader allow, narrower deny)

**Why it matters:** Real deployment pattern: "allow full access to the bucket, but deny reads from `secrets/`." Tests that resource-pattern matching in deny statements correctly narrows a broader allow. The deny uses `object:<bucket>/secrets/*` which should match `object:<bucket>/secrets/key.txt` via the wildcard suffix check in `matchesResource` (`policy-engine.ts:88-91`).

**File:** `cli/smoke/s3.ts`

### 7a. Allow bucket-wide, deny GetObject on secrets prefix

- [ ] **Create** a credential:

```js
const DENY_PREFIX_POLICY = {
	version: '2025-01-01',
	statements: [
		{
			effect: 'allow',
			actions: ['s3:*'],
			resources: ['account:*', `bucket:${S3_TEST_BUCKET}`, `object:${S3_TEST_BUCKET}/*`],
		},
		{
			effect: 'deny',
			actions: ['s3:GetObject'],
			resources: [`object:${S3_TEST_BUCKET}/secrets/*`],
		},
	],
};
```

- [ ] **PutObject to `public/test.txt`** → **200** (allow matches, deny doesn't cover PutObject).
- [ ] **GetObject from `public/test.txt`** → **200** (deny resource `secrets/*` doesn't match `public/test.txt`).
- [ ] **PutObject to `secrets/key.txt`** → **200** (deny only covers `s3:GetObject`, not `s3:PutObject`).
- [ ] **GetObject from `secrets/key.txt`** → **403** (deny matches: action=`s3:GetObject`, resource=`object:${bucket}/secrets/key.txt` matches pattern `object:${bucket}/secrets/*`).
- [ ] **Clean up** test objects with the full-access client.

---

## 8. Security headers on responses

**Why it matters:** The security header middleware (`index.ts:36-43`) sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and `Content-Security-Policy` on every response. If the middleware is accidentally removed or a refactor breaks it, no test catches it. These prevent clickjacking, MIME-sniffing, and other browser-level attacks on the dashboard.

**File:** `cli/smoke/purge.ts` (has both 200 and 401 responses readily available)

### 8a. Security headers on a 200 response

- [ ] **After a successful purge** (reuse any 200 response from prior tests), assert:

```js
assertJson('X-Content-Type-Options', res.headers.get('x-content-type-options'), 'nosniff');
assertJson('X-Frame-Options', res.headers.get('x-frame-options'), 'DENY');
assertTruthy('Content-Security-Policy present', res.headers.has('content-security-policy'));
assertJson('Referrer-Policy', res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
assertTruthy('Permissions-Policy present', res.headers.has('permissions-policy'));
```

### 8b. Security headers on a 401 response

- [ ] **After a 401 (no auth)** (reuse the `noAuth` response from authentication section), assert the same headers.

### 8c. Security headers on a 403 response

- [ ] **After a 403 (wrong zone / denied)** assert the same headers.

---

## Implementation checklist (summary)

| #   | Section                           | File                    | Tests        | Status      |
| --- | --------------------------------- | ----------------------- | ------------ | ----------- |
| 1a  | D1 database-scoped key            | `cli/smoke/cf-proxy.ts` | 4 assertions | Not started |
| 1b  | KV namespace-scoped key           | `cli/smoke/cf-proxy.ts` | 3 assertions | Not started |
| 1c  | S3 bucket-scoped cred             | `cli/smoke/s3.ts`       | 4 assertions | Not started |
| 1d  | S3 prefix-scoped cred             | `cli/smoke/s3.ts`       | 5 assertions | Not started |
| 2a  | `not` condition                   | `cli/smoke/purge.ts`    | 2 assertions | Not started |
| 2b  | `any` condition                   | `cli/smoke/purge.ts`    | 3 assertions | Not started |
| 2c  | `all` condition                   | `cli/smoke/purge.ts`    | 3 assertions | Not started |
| 2d  | Nested `not` inside `any`         | `cli/smoke/purge.ts`    | 3 assertions | Not started |
| 2e  | Nested `all` inside `not` in deny | `cli/smoke/purge.ts`    | 3 assertions | Not started |
| 2f  | Multi-statement allow             | `cli/smoke/purge.ts`    | 3 assertions | Not started |
| 2g  | Allow + narrow deny               | `cli/smoke/purge.ts`    | 3 assertions | Not started |
| 3a  | `in` operator                     | `cli/smoke/purge.ts`    | 2 assertions | Not started |
| 3b  | `not_in` operator                 | `cli/smoke/purge.ts`    | 2 assertions | Not started |
| 3c  | `ne` operator                     | `cli/smoke/purge.ts`    | 3 assertions | Not started |
| 3d  | `contains` operator               | `cli/smoke/purge.ts`    | 2 assertions | Not started |
| 3e  | `not_contains` operator           | `cli/smoke/purge.ts`    | 2 assertions | Not started |
| 3f  | `ends_with` operator              | `cli/smoke/purge.ts`    | 2 assertions | Not started |
| 3g  | `matches` operator                | `cli/smoke/purge.ts`    | 3 assertions | Not started |
| 3h  | `not_matches` operator            | `cli/smoke/purge.ts`    | 2 assertions | Not started |
| 3i  | `exists` / `not_exists`           | `cli/smoke/purge.ts`    | 4 assertions | Not started |
| 4a  | D1 deny on sub-resource           | `cli/smoke/cf-proxy.ts` | 5 assertions | Not started |
| 5a  | Expired key at runtime            | `cli/smoke/purge.ts`    | 3 assertions | Not started |
| 6a  | Numeric always-deny               | `cli/smoke/purge.ts`    | 1 assertion  | Not started |
| 6b  | Numeric always-allow (control)    | `cli/smoke/purge.ts`    | 1 assertion  | Not started |
| 6c  | Numeric deny with `gt`            | `cli/smoke/purge.ts`    | 2 assertions | Not started |
| 7a  | S3 deny on prefix                 | `cli/smoke/s3.ts`       | 5 assertions | Not started |
| 8a  | Security headers on 200           | `cli/smoke/purge.ts`    | 5 assertions | Not started |
| 8b  | Security headers on 401           | `cli/smoke/purge.ts`    | 5 assertions | Not started |
| 8c  | Security headers on 403           | `cli/smoke/purge.ts`    | 5 assertions | Not started |
