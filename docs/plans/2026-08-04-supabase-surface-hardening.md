# Supabase surface hardening - implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** publish the member-write limitation as a machine-checked pin plus a caller-facing
contract, ship a first-class agent credential profile for the Supabase surface, and record an
optional external `subject` on every key so proxy audit rows attribute to a person or an agent
run rather than only to the credential the key fronts.

**Architecture:** Three independent changes on the existing Supabase overlay. Task 1 adds a
hermetic test over the committed OpenAPI snapshot (`scripts/api-coverage/fixtures/supabase.ops.json`)
so a future upstream member-write endpoint fails the suite instead of being absorbed silently,
and writes the `501` contract into `docs/API.md` §11.2. Task 2 adds one entry to the existing
Supabase template catalog in `dashboard/src/lib/policy-templates.ts`, which is already exercised
from the worker test pool by `test/policy-templates.test.ts`. Task 3 threads a nullable `subject`
column through the DO SQLite `api_keys` table and the D1 `supabase_proxy_events` table, using each
store's existing in-place migration idiom.

**Tech stack:** Cloudflare Workers, Hono, Durable Object SQLite, D1, Zod v4, Vitest with
`@cloudflare/vitest-pool-workers`, Astro/React dashboard, TypeScript strict.

**Standing constraint:** the operator has asked for no commits in this session. Per-task commit
steps are therefore omitted; commit at your own cadence.

**Verified against the repo on 2026-08-04:**

| Fact | Proof |
| --- | --- |
| Sensors are `bun run typecheck`, `bun run lint`, `bun run test`; `bun run test` is `vitest run` over two projects (worker + cli) | `jq -r '.scripts' package.json` |
| `bun run lint` is `prettier --check 'src/**/*.ts' 'cli/**/*.ts' 'test/**/*.ts' 'scripts/**/*.ts'` - it does NOT cover `dashboard/**` | same |
| `bun run check:openapi` regenerates `openapi.json` from the Zod schemas and fails on any diff | `scripts/check-openapi.sh` |
| `bun run check:api-coverage` is `tsx scripts/api-coverage/refresh.ts`, which fetches `https://api.supabase.com/api/v1-json` over the network | `package.json`, `scripts/api-coverage/providers/supabase.ts` `SPEC_URL` |
| The hermetic (offline) coverage check is `test/api-coverage.test.ts`, inside `bun run test` | file header comment: "This NEVER touches the network" |
| The live Supabase OpenAPI spec exposes exactly one member operation: `GET /v1/organizations/{slug}/members` | `jq -r '.[] \| select(.path \| contains("organizations"))' scripts/api-coverage/fixtures/supabase.ops.json` returns 8 rows, no write under `/members` |
| `POST /v1/organizations/{slug}/members` classifies as `supabase:organizations:write` on `org:<slug>`, not as a members action | `src/supabase/classify.ts`, `root === 'organizations'` branch: the members special-case is gated on `method === 'GET' \|\| method === 'HEAD'` |
| `src/supabase/member-router.ts` records outcome `blocked` and returns 501 | `src/supabase/member-router.ts`; already pinned by `test/supabase-members-router.test.ts:59` and `test/supabase-membership-audit.test.ts:165` |
| `docs/API.md` §11.2 documents `/supabase/v1/*`, `/supabase/v0/*` and `/supabase/metrics/:ref` and omits `/supabase/members/*` entirely | `rg -n '^#{1,4} ' docs/API.md \| rg -i supabase` |
| `docs/GUIDE.md` §2.4 already carries the limitation prose at lines 571-578 | `rg -n 'PAT-drivable' docs/GUIDE.md` |
| `dashboard/src/lib/policy-templates.ts` holds `SUPABASE_TEMPLATES` and is imported by `test/policy-templates.test.ts`, which runs `validatePolicy()` on every template inside the worker pool | both files |
| `cli/policy-wizard.ts` has no Supabase mode - it exports only `buildCfPolicy()` and `buildS3Policy()`, both consumed by `cli/commands/keys.ts` and `cli/commands/s3-credentials.ts`, and has no test file | `rg -n 'policy-wizard\|buildCfPolicy\|buildS3Policy' cli/` |
| Supabase rate limiting is account-level only: `consumeSupabaseRateLimit()` takes no key argument | `src/durable-object.ts:616` |
| Per-key buckets are purge-only: `checkPerKeyRateLimit(keyId, rateClass, tokens)` returns `PurgeResult \| null` and reads `bulk_rate` / `single_rate` | `src/durable-object.ts:236-264` |
| The DO SQLite migration idiom is `PRAGMA table_info` then `ALTER TABLE ... ADD COLUMN`, with a `console.log` migration breadcrumb | `src/iam.ts:69-73` (`add_column_upstream_token_id`) |
| The D1 migration idiom is a standalone `ALTER TABLE ... ADD COLUMN` constant run inside `try {} catch {}` in `ensureTables()` | `src/schema.ts:200` + `src/supabase/analytics.ts` `ensureTables()` |
| `IamManager` reads rows with `SELECT *`, so a new column flows into `ApiKey` without touching `getKey` / `listKeys` | `src/iam.ts:276,290` |
| `createKeySchema` and `apiKeySchema` feed the OpenAPI generator | `scripts/generate-openapi.ts:18,61,555,557` |
| `openapi.json` `ApiKey.properties` currently has no `subject` | `jq -r '.components.schemas.ApiKey.properties \| keys \| join(",")' openapi.json` |
| No new HTTP route is introduced by this plan, so no `assets.run_worker_first` entry is needed; `/supabase/members/*` is already listed | `wrangler.jsonc:51-64` |
| `schema.sql` covers only `purge_events`, `s3_events`, `dns_events`, `cf_proxy_events` - `supabase_proxy_events` is not in it, so it is not a migration target here | `grep -n 'CREATE TABLE' schema.sql` |
| Test helper signatures: `createSupabaseKey(policy, upstreamTokenId, name?)`, `registerSupabaseToken(refs?, token?)`, `makePolicy(...statements)`, `allowStmt(actions, resources, conditions?)`, `makeCtx(action, resource, fields?)` | `test/helpers.ts`, `test/policy-helpers.ts` |

**Dry-run status:** all three tasks were applied verbatim to a scratch copy at
`/tmp/gatekeeper-check` and the sensors run after each. Baseline: `typecheck` exit 0, `lint`
exit 0, `bun run test` 64 files / 1348 tests passed, `check:openapi` exit 0. After Task 1:
65 files / 1353 tests. After Task 2: 66 files / 1373 tests. After Task 3: `typecheck` exit 0,
`lint` exit 0, `bun run test` 67 files / 1379 tests passed, `check:openapi` exit 0, and
`bun run build:dashboard` exit 0 (12 pages). Eight defects were found and folded back into the
text below; they are listed in the Self-review. Not verified here, because it needs live
infrastructure or a real browser: the
`assets.run_worker_first` behaviour (no route is added, so there is nothing to verify), the
dashboard rendering of the new template (Playwright `e2e/` was deliberately not run - it boots
`wrangler dev`), and whether Supabase ever ships a member-write endpoint (that is exactly what
the Task 1 pin is for).

## File structure

| Path | Responsibility |
| --- | --- |
| `test/supabase-member-write-pin.test.ts` | CREATE - pins the absence of an upstream member-write op in the committed OpenAPI snapshot, and pins how `POST .../members` currently classifies |
| `docs/API.md` | MODIFY - new `POST /supabase/members/:slug/invitations` subsection in §11.2 with the `501` contract |
| `docs/GUIDE.md` | MODIFY - §2.4 bullet points at the new API.md subsection; new `sb-agent` row in the supabase template catalog |
| `dashboard/src/lib/policy-templates.ts` | MODIFY - add the `sb-agent` template to `SUPABASE_TEMPLATES` |
| `test/supabase-agent-profile.test.ts` | CREATE - evaluates the `sb-agent` policy through the real policy engine over an allow/deny table |
| `src/types.ts` | MODIFY - `subject` on `ApiKey`, `CreateKeyRequest`, `AuthResult` |
| `src/iam.ts` | MODIFY - `subject` column migration, INSERT, returned key, rotate inheritance, authorize passthrough |
| `src/routes/admin-schemas.ts` | MODIFY - `subject` on `createKeySchema` and `apiKeySchema` |
| `src/routes/admin-keys.ts` | MODIFY - thread `subject` into `CreateKeyRequest` and the create_key audit detail |
| `src/schema.ts` | MODIFY - `SUPABASE_PROXY_EVENTS_ADD_SUBJECT_SQL` + `subject` in the CREATE TABLE |
| `src/supabase/analytics.ts` | MODIFY - `subject` on `SupabaseProxyEvent`, run the ALTER in `ensureTables`, bind it in the INSERT |
| `src/supabase/router.ts` | MODIFY - stamp `auth.subject` on both proxy event sites |
| `test/helpers.ts` | MODIFY - optional `extra` body fields on `createSupabaseKey` |
| `test/key-subject.test.ts` | CREATE - subject round-trips through create/get/rotate and lands on a proxy audit row |
| `openapi.json` | MODIFY - regenerated by `bun run openapi` |

---

## Why a snapshot pin, and not just another 501 test

`test/supabase-members-router.test.ts:59` and `test/supabase-membership-audit.test.ts:165`
already assert that a non-dry-run invite returns 501 and writes `outcome = 'blocked'`. Those
pin Gatekeeper's own behaviour. They would keep passing forever, including on the day Supabase
ships a member-write endpoint - which is the event worth detecting.

The thing that actually changes on that day is the upstream OpenAPI document. The repo already
captures it: `scripts/api-coverage/refresh.ts` fetches `https://api.supabase.com/api/v1-json`
and rewrites `scripts/api-coverage/fixtures/supabase.ops.json`, and `test/api-coverage.test.ts`
reads that committed snapshot offline. So the pin belongs on the snapshot: assert that the only
operation under an organization member path is `GET`. When someone runs
`bun run api-coverage:write` after Supabase adds `POST /v1/organizations/{slug}/members`, the new
row lands in the fixture and this test fails with the new op named in the diff. The limitation
stops being a comment and becomes a tripwire.

---

### Task 1: pin the member-write limitation and publish the 501 contract

**Files:**
- Create: `test/supabase-member-write-pin.test.ts`
- Modify: `docs/API.md`, `docs/GUIDE.md`

- [ ] **Step 1: Write the pin test.** Create `test/supabase-member-write-pin.test.ts`:

```ts
/**
 * PIN: the Supabase Management API has no member-write operation.
 *
 * `src/supabase/member-router.ts` returns 501 and audits `outcome = 'blocked'` for a
 * non-dry-run invite because invite / re-role / remove live on Supabase's internal
 * dashboard API, which rejects a PAT. The 501 itself is pinned by
 * test/supabase-members-router.test.ts and test/supabase-membership-audit.test.ts.
 *
 * Those tests pin OUR behaviour and would keep passing on the day the limitation lifts.
 * This file pins the UPSTREAM fact instead, against the committed OpenAPI snapshot that
 * `scripts/api-coverage/refresh.ts` regenerates from https://api.supabase.com/api/v1-json.
 * When Supabase ships a member write, the refreshed fixture fails this test by name.
 *
 * Hermetic: reads the committed fixture, never the network (same contract as
 * test/api-coverage.test.ts).
 */

import { describe, expect, it } from 'vitest';

import { supabaseProvider } from '../scripts/api-coverage/providers/supabase';
import { opKey } from '../scripts/api-coverage/types';
import { classifySupabaseRequest } from '../src/supabase/classify';

const MEMBERS_READ = 'GET /v1/organizations/{slug}/members';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const snapshot = supabaseProvider.snapshot;
const memberOps = snapshot.filter((op) => op.path.includes('/members'));

describe('supabase member writes are not PAT-drivable', () => {
	it('the committed spec snapshot is non-empty', () => {
		expect(snapshot.length).toBeGreaterThan(0);
	});

	it('exposes exactly one operation under an organization member path, and it is the list read', () => {
		expect(memberOps.map(opKey)).toEqual([MEMBERS_READ]);
	});

	it('exposes no write operation under any member path', () => {
		const writes = memberOps.filter((op) => WRITE_METHODS.has(op.method.toUpperCase()));
		expect(writes.map(opKey)).toEqual([]);
	});

	it('classifies the list read as supabase:members:list on the org resource', () => {
		expect(classifySupabaseRequest('GET', '/v1/organizations/my-org/members')).toEqual({
			action: 'supabase:members:list',
			category: 'members',
			write: false,
			projectRef: null,
			resource: 'org:my-org',
		});
	});

	it('classifies a POST to the same path as a generic organizations write, not a member action', () => {
		const cls = classifySupabaseRequest('POST', '/v1/organizations/my-org/members');
		expect(cls?.action).toBe('supabase:organizations:write');
		expect(cls?.resource).toBe('org:my-org');
	});
});
```

- [ ] **Step 2: Run it and confirm it passes against the current fixture.**

```bash
cd /home/erfi/gatekeeper && bunx vitest run -c vitest.worker.config.ts test/supabase-member-write-pin.test.ts
```

Expect `Tests  5 passed (5)`. This test is green from the start by design - it is a
regression tripwire, not a red-green cycle. Prove it can fail before trusting it, in step 3.

- [ ] **Step 3: Prove the tripwire fires.** Temporarily append a fake write op to the fixture,
      re-run, confirm the failure names it, then restore:

```bash
cd /home/erfi/gatekeeper
cp scripts/api-coverage/fixtures/supabase.ops.json /tmp/sb-ops.bak
jq '. + [{"method":"POST","path":"/v1/organizations/{slug}/members","summary":"fake","covered":true}]' \
  /tmp/sb-ops.bak > scripts/api-coverage/fixtures/supabase.ops.json
bunx vitest run -c vitest.worker.config.ts test/supabase-member-write-pin.test.ts
cp /tmp/sb-ops.bak scripts/api-coverage/fixtures/supabase.ops.json
```

Expect two failures naming `POST /v1/organizations/{slug}/members` - one from the
"exactly one operation" assertion, one from the "no write operation" assertion. The restore
`cp` runs unconditionally on the next line; confirm `git status --short` is clean for the
fixture afterwards.

- [ ] **Step 4: Add the endpoint contract to `docs/API.md`.** §11.2 currently documents
      `/supabase/v1/*`, `/supabase/v0/*` and `/supabase/metrics/:ref` and omits the
      Gatekeeper-owned member surface entirely. Insert this immediately before the `---` that
      precedes `## 11.3 Supabase Analytics`:

```markdown
### `POST /supabase/members/:slug/invitations`

Gatekeeper-owned org-membership surface. Body: `{ users: [ { email, role, project_refs? } ] }`.

**Auth:** ApiKeyAuth (policy must allow `supabase:members:invite` on `org:<slug>`)

**Behaviour:** a coarse action/resource gate runs first, then the body is parsed and **every
assignment is authorized individually** - one out-of-policy item rejects the whole batch. With
`?dry_run=true` the route fetches current membership via the supported
`GET /v1/organizations/{slug}/members` read, diffs it, and returns
`{ plan: { changes, noops }, denied }`. Every decision is written to the D1
`supabase_membership_events` table.

**Upstream limitation.** The Supabase Management API has **no member-write operation**. Its
OpenAPI document exposes exactly one member path, `GET /v1/organizations/{slug}/members`;
invite, re-role and remove are served by Supabase's internal dashboard API, which rejects a
Personal Access Token. Gatekeeper therefore authorizes, plans and audits the change but cannot
execute it. The absence of an upstream write op is pinned by
`test/supabase-member-write-pin.test.ts` against the committed OpenAPI snapshot, so if Supabase
ever ships one the test suite fails rather than silently continuing to return 501.

**Error codes:** 401 (no/invalid Gatekeeper key), 403 (policy denies the coarse gate or any
individual assignment), 400 (malformed body, e.g. unknown role), 501 (request was fully
authorized and audited, but no upstream write transport exists)

**How to handle a 501.** Treat it as "accepted and recorded, not applied" - not as a transient
error:

- Do **not** retry. A retry re-runs authorization and writes another `blocked` audit row; it
  will never succeed.
- Read the plan first. Send the same body with `?dry_run=true` to get the exact
  add / update_role / noop set the request would have produced, and the `denied` list.
- Apply the change out of band (Supabase dashboard or the org owner), then re-run the dry run
  to confirm the diff is empty.
- For provisioning pipelines, gate on the dry run: a `501` on the execute call means the plan
  is valid and policy-approved, so surface it as "manual step required" rather than a failure.
```

- [ ] **Step 5: Point the guide at the contract.** In `docs/GUIDE.md` §2.4, replace the bullet

```markdown
- A non-dry-run POST currently returns **501** after full authorization (no upstream write transport exists).
```

with

```markdown
- A non-dry-run POST currently returns **501** after full authorization (no upstream write transport exists). The absence of an upstream member-write operation is pinned against the committed OpenAPI snapshot by `test/supabase-member-write-pin.test.ts`; see API.md §11.2 (`POST /supabase/members/:slug/invitations`) for how a caller should handle the 501.
```

- [ ] **Step 6: Run the sensors.**

```bash
cd /home/erfi/gatekeeper && bun run typecheck && bun run lint && bun run test
```

Expect `typecheck` and `lint` silent-clean, and the suite at 65 files / 1353 tests passed
(baseline 64 / 1348, plus this file's 5). Measured in the dry run: exactly that.

---

## Where the agent profile belongs, and what it cannot carry

The brief offered three homes: the CLI policy wizard, a dashboard `makeDefaultPolicy` variant,
or both. The source decides it.

`cli/policy-wizard.ts` exports exactly two entry points, `buildCfPolicy()` and `buildS3Policy()`
(lines 517 and 522), consumed by `cli/commands/keys.ts:68` and `cli/commands/s3-credentials.ts:63`.
There is no Supabase mode. Adding an agent preset there means first building a whole Supabase
wizard branch, and the wizard is interactive prompt code with no test file - `rg -n policy-wizard
cli/*.test.ts` returns nothing. That is the larger, less testable half.

`dashboard/src/lib/policy-templates.ts` already has a `SUPABASE_TEMPLATES` catalog with nine
entries, and `test/policy-templates.test.ts` imports it **from the worker test pool** and runs
every generated policy through the worker's own `validatePolicy()`. One new entry gets structural
validation for free and can be evaluated through the real `evaluatePolicy()` in the same pool.

So: the dashboard catalog, option (b). A CLI Supabase wizard mode is a separate piece of work and
is listed as a follow-up below.

**What the profile does not carry: a shorter rate-limit budget.** That is not expressible today.
`consumeSupabaseRateLimit()` (`src/durable-object.ts:616`) takes no key argument - it drains one
account-level `TokenBucket` built from `supabase_rps` / `supabase_burst` (defaults 200 / 400,
`src/config-registry.ts:22-24`). The per-key buckets that do exist are purge-only:
`checkPerKeyRateLimit(keyId, rateClass, tokens)` returns `PurgeResult | null` and reads
`bulk_rate` / `single_rate` (`src/durable-object.ts:236-264`). Giving an agent key its own
Supabase budget means adding per-key Supabase rate-limit columns, a keyed bucket map, and a
config validation path - a change on the order of the other two tasks combined. It is a
follow-up, not a line in a policy template.

---

### Task 2: agent-scoped Supabase credential profile

**Files:**
- Modify: `dashboard/src/lib/policy-templates.ts`
- Create: `test/supabase-agent-profile.test.ts`
- Modify: `docs/GUIDE.md`

- [ ] **Step 1: Write the failing test.** Create `test/supabase-agent-profile.test.ts`:

```ts
/**
 * The `sb-agent` credential profile: what an automated agent driving the Supabase
 * Management API through Gatekeeper is allowed to do.
 *
 * Shape: read anything on the bound project, write nothing except preview branches,
 * and never touch secrets. Every case below is evaluated through the worker's real
 * policy engine, with the same field set src/supabase/router.ts builds per request.
 */

import { describe, expect, it } from 'vitest';

import { POLICY_TEMPLATES, applyTemplate } from '../dashboard/src/lib/policy-templates';
import { evaluatePolicy, validatePolicy } from '../src/policy-engine';
import type { RequestContext } from '../src/policy-types';

const REF = 'dewddkcmwrzbpynylyhg';
const PROJECT = `project:${REF}`;
const OTHER_PROJECT = 'project:aabbccddee1122334455';

const template = POLICY_TEMPLATES.supabase.find((t) => t.id === 'sb-agent');
if (!template) throw new Error('sb-agent template is missing from POLICY_TEMPLATES.supabase');
const policy = applyTemplate(template, { resources: [PROJECT] });

/** Mirrors the ctx src/supabase/router.ts builds for a classified management request. */
function ctx(action: string, resource: string, write: boolean): RequestContext {
	return {
		action,
		resource,
		fields: {
			'supabase.project_ref': REF,
			'supabase.method': write ? 'POST' : 'GET',
			'supabase.write': write,
		},
	};
}

const ALLOWED: Array<[string, string, boolean]> = [
	['supabase:database:read', PROJECT, false],
	['supabase:auth:read', PROJECT, false],
	['supabase:projects:read', PROJECT, false],
	['supabase:metrics:read', PROJECT, false],
	['supabase:edge_functions:read', PROJECT, false],
	// The single allowlisted write: create / run a preview branch.
	['supabase:environment:write', PROJECT, true],
];

const DENIED: Array<[string, string, boolean]> = [
	['supabase:database:write', PROJECT, true],
	['supabase:edge_functions:write', PROJECT, true],
	['supabase:auth:write', PROJECT, true],
	['supabase:storage:write', PROJECT, true],
	// Secrets are denied in BOTH directions - the read-wildcard would otherwise expose
	// /v1/projects/{ref}/api-keys, which classify.ts maps to the `secrets` category.
	['supabase:secrets:read', PROJECT, false],
	['supabase:secrets:write', PROJECT, true],
	// Bound to one project ref.
	['supabase:database:read', OTHER_PROJECT, false],
	['supabase:environment:write', OTHER_PROJECT, true],
];

describe('sb-agent policy template', () => {
	it('is structurally valid', () => {
		expect(validatePolicy(policy)).toEqual([]);
	});

	it('carries three statements: reads, the write allowlist, the secrets deny', () => {
		expect(policy.statements.map((s) => s.effect)).toEqual(['allow', 'allow', 'deny']);
	});

	for (const [action, resource, write] of ALLOWED) {
		it(`allows ${action} on ${resource}`, () => {
			expect(evaluatePolicy(policy, [ctx(action, resource, write)])).toBe(true);
		});
	}

	for (const [action, resource, write] of DENIED) {
		it(`denies ${action} on ${resource}`, () => {
			expect(evaluatePolicy(policy, [ctx(action, resource, write)])).toBe(false);
		});
	}

	it('does not reach branch-id-scoped routes', () => {
		// src/supabase/classify.ts maps /v1/branches/{id} to resource `branch:<id>`, not
		// `project:<ref>`, so a project-bound agent key cannot mutate an existing branch by id.
		// Branch CREATION (/v1/projects/{ref}/branches) is project-scoped and IS allowed above.
		expect(evaluatePolicy(policy, [ctx('supabase:environment:write', 'branch:br_abc123', true)])).toBe(false);
	});

	it('does not reach account-level routes', () => {
		// GET /v1/projects and GET /v1/organizations classify to resource `supabase:account`.
		expect(evaluatePolicy(policy, [ctx('supabase:projects:read', 'supabase:account', false)])).toBe(false);
	});

	it('placeholder build (no bound token yet) is still valid', () => {
		const placeholder = applyTemplate(template, { resources: [] });
		expect(validatePolicy(placeholder)).toEqual([]);
		expect(placeholder.statements.every((s) => s.resources.includes('project:<ref>'))).toBe(true);
	});
});
```

- [ ] **Step 2: Run it and verify it fails for the right reason.**

```bash
cd /home/erfi/gatekeeper && bunx vitest run -c vitest.worker.config.ts test/supabase-agent-profile.test.ts
```

Expect the whole file to error before any test runs, with
`Error: sb-agent template is missing from POLICY_TEMPLATES.supabase`.

- [ ] **Step 3: Add the template.** In `dashboard/src/lib/policy-templates.ts`, insert this
      entry into `SUPABASE_TEMPLATES` immediately after the `sb-readonly` entry and before
      `sb-no-secrets`:

```ts
	{
		id: 'sb-agent',
		group: 'General',
		label: 'Agent - reads plus preview branches',
		description: 'For an automated agent on one project: read everything except secrets, and create preview branches.',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['supabase:*'],
				resources: res(c, 'project:<ref>'),
				conditions: [{ field: 'supabase.write', operator: 'eq', value: false }],
			},
			{ effect: 'allow', actions: ['supabase:environment:write'], resources: res(c, 'project:<ref>') },
			{ effect: 'deny', actions: ['supabase:secrets:read', 'supabase:secrets:write'], resources: res(c, 'project:<ref>') },
		],
	},
```

Each element traces to `src/supabase/classify.ts`: the read wildcard relies on
`supabase.write` being set from the HTTP method on every classified request;
`environment` is the category for the `branches` and `actions` tails under
`/v1/projects/{ref}/`; `secrets` is the category for the `secrets`, `api-keys` and
`pgsodium` tails, which is why it needs an explicit deny rather than relying on the
read/write split.

- [ ] **Step 4: Run the template tests.**

```bash
cd /home/erfi/gatekeeper && bunx vitest run -c vitest.worker.config.ts test/supabase-agent-profile.test.ts test/policy-templates.test.ts
```

Expect both files green. `test/policy-templates.test.ts` picks the new entry up automatically:
it iterates `POLICY_TEMPLATES` and asserts unique ids, non-empty statements, `validatePolicy`
clean, action shape, and known action prefix.

- [ ] **Step 5: Add the catalog row to `docs/GUIDE.md`.** In the `#### supabase` table under
      "Policy templates (dashboard)", insert this row immediately after the **Read-only** row:

```markdown
| **Agent - reads plus preview branches**<br><span>For an automated agent on one project: read everything except secrets, and create preview branches.</span> | General | **allow** `supabase:*` on `project:<ref>` where supabase.write eq false<br>**allow** `supabase:environment:write` on `project:<ref>`<br>**deny** `supabase:secrets:read, supabase:secrets:write` on `project:<ref>` |
```

- [ ] **Step 6: Run the sensors.**

```bash
cd /home/erfi/gatekeeper && bun run typecheck && bun run lint && bun run test && bun run build:dashboard
```

Expect 66 files / 1373 tests passed: 65 / 1353 after Task 1, plus this file's 19, plus **one**
in `test/policy-templates.test.ts`, which emits one `it()` per catalog entry and therefore grows
with the catalog (54 -> 55). Measured in the dry run: exactly that.

`bun run build:dashboard` is in the list because `bun run lint` does **not** cover
`dashboard/**` and `bun run typecheck` excludes it (`tsconfig.json` `exclude`), so the Astro
build is the only sensor that compiles the edited file. Match the file's existing style by hand:
tabs, single quotes, under 140 columns.

---

## How the schema evolves here, and why two migrations

`subject` has to land in two different stores, and each already has an idiom. Do not invent a
third.

**Durable Object SQLite** (`api_keys`): `IamManager.initTables()` reads
`PRAGMA table_info('api_keys')` into `cols`, then `ALTER TABLE ... ADD COLUMN` when the column
is absent, logging a `{ migration, action, ts }` breadcrumb. That is exactly how
`upstream_token_id` was added (`src/iam.ts:69-73`). `initTables()` runs inside
`ctx.blockConcurrencyWhile()` at DO construction, so the column exists before any request is
served. Reads use `SELECT *` (`src/iam.ts:276,290`), so `getKey` / `listKeys` need no change.

**D1** (`supabase_proxy_events`): the column goes into `SUPABASE_PROXY_EVENTS_TABLE_SQL` (for
fresh databases) *and* gets a standalone `ALTER TABLE` constant run inside `try {} catch {}` in
`ensureTables()` (for existing ones). That is exactly how `key_fingerprint` was added
(`src/schema.ts:200`, `src/supabase/analytics.ts` `ensureTables()`). Do not add a
`tablesInitialized` module flag while you are in that function - AGENTS.md "Known Pitfalls"
records why it breaks the test pool.

This is attribution, not authentication. Gatekeeper still authenticates the key itself; `subject`
is a caller-supplied label recorded at creation and replayed onto audit rows. Nothing reads it to
make an authorization decision.

---

### Task 3: bind keys to an external identity

**Files:**
- Modify: `src/types.ts`, `src/iam.ts`, `src/routes/admin-schemas.ts`, `src/routes/admin-keys.ts`,
  `src/schema.ts`, `src/supabase/analytics.ts`, `src/supabase/router.ts`, `test/helpers.ts`,
  `openapi.json`
- Create: `test/key-subject.test.ts`

- [ ] **Step 1: Give the test helper a way to pass extra create-key fields.** In
      `test/helpers.ts`, replace `createSupabaseKey` with:

```ts
/** Create a Gatekeeper key bound to a Supabase upstream token, with the given policy. Returns the key id (= bearer token). */
export async function createSupabaseKey(
	policy: PolicyDocument,
	upstreamTokenId: string,
	name = 'sb-key',
	extra?: Record<string, unknown>,
): Promise<string> {
	const res = await SELF.fetch('http://localhost/admin/keys', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({ name, policy, upstream_token_id: upstreamTokenId, ...extra }),
	});
	const data = await res.json<any>();
	if (!data.success) throw new Error(`createSupabaseKey failed: ${JSON.stringify(data.errors)}`);
	createdKeyIds.push(data.result.key.id);
	return data.result.key.id;
}
```

The fourth parameter is optional and defaulted, so the existing call sites are unaffected -
50 of them across seven files (`rg -c 'createSupabaseKey\(' test/*.ts`).

- [ ] **Step 2: Write the failing test.** Create `test/key-subject.test.ts`:

```ts
/**
 * `subject`: an optional external identity recorded on a key and stamped onto every
 * Supabase proxy audit row.
 *
 * ATTRIBUTION, NOT AUTHENTICATION. Gatekeeper still authenticates the key itself; subject is
 * a caller-supplied label (IdP user, service name, agent run id) so an audit row points at
 * WHO the key was issued to, not only at which upstream credential it fronts. No
 * authorization decision reads it.
 */

import { SELF, fetchMock } from 'cloudflare:test';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { adminHeaders, cleanupCreatedResources, createSupabaseKey, registerSupabaseToken, waitForAnalytics } from './helpers';
import { makePreview } from '../src/crypto';
import type { PolicyDocument } from '../src/policy-types';

// A ref distinct from every other supabase test file, to avoid cross-file analytics pollution.
const REF = 'ffeeddccbb9988776655';
const SB_API = 'https://api.supabase.com';
const SUBJECT = 'agent:planner/run-7f3a';
const V = '2025-01-01' as const;

function dbReadPolicy(): PolicyDocument {
	return { version: V, statements: [{ effect: 'allow', actions: ['supabase:database:read'], resources: [`project:${REF}`] }] };
}

let tid: string;

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	tid = await registerSupabaseToken([REF], 'sbp_subject_pat');
});
afterAll(() => cleanupCreatedResources());

describe('key subject - admin surface', () => {
	it('records the subject at creation and returns it on the created key', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'subject-create', policy: dbReadPolicy(), upstream_token_id: tid, subject: SUBJECT }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.key.subject).toBe(SUBJECT);

		const getRes = await SELF.fetch(`http://localhost/admin/keys/${data.result.key.id}`, { headers: adminHeaders() });
		const got = await getRes.json<any>();
		expect(got.result.key.subject).toBe(SUBJECT);

		await SELF.fetch(`http://localhost/admin/keys/${data.result.key.id}`, { method: 'DELETE', headers: adminHeaders() });
	});

	it('defaults to null when no subject is supplied', async () => {
		const keyId = await createSupabaseKey(dbReadPolicy(), tid, 'subject-absent');
		const getRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, { headers: adminHeaders() });
		const got = await getRes.json<any>();
		expect(got.result.key.subject).toBeNull();
	});

	it('rejects an empty-string subject', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'subject-empty', policy: dbReadPolicy(), upstream_token_id: tid, subject: '' }),
		});
		expect(res.status).toBe(400);
	});

	it('carries the subject across a rotation', async () => {
		const keyId = await createSupabaseKey(dbReadPolicy(), tid, 'subject-rotate', { subject: SUBJECT });
		// The rotate route runs parseJsonBody(c, rotateKeySchema), so a body is required even
		// when nothing is overridden - `{}` is the idiom in test/key-rotation.test.ts.
		const rotRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(rotRes.status).toBe(200);
		const rot = await rotRes.json<any>();
		expect(rot.result.new_key.subject).toBe(SUBJECT);

		await SELF.fetch(`http://localhost/admin/keys/${rot.result.new_key.id}`, { method: 'DELETE', headers: adminHeaders() });
	});
});

describe('key subject - audit attribution', () => {
	it('stamps the subject onto the Supabase proxy audit row', async () => {
		const keyId = await createSupabaseKey(dbReadPolicy(), tid, 'subject-audit', { subject: SUBJECT });

		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, '{}', { headers: { 'Content-Type': 'application/json' } });

		const proxyRes = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(proxyRes.status).toBe(200);
		await waitForAnalytics();

		const res = await SELF.fetch(`https://gk/admin/supabase/analytics/events?project_ref=${REF}`, { headers: adminHeaders() });
		const data = await res.json<any>();
		const row = (data.result as any[]).find((r) => r.key_id === makePreview(keyId));
		expect(row).toBeDefined();
		expect(row.subject).toBe(SUBJECT);
		// created_by still names the key; subject is the additional external identity.
		expect(row.created_by).toBe('key:subject-audit');
	});

	it('leaves subject null on an audit row for a key with no subject', async () => {
		const keyId = await createSupabaseKey(dbReadPolicy(), tid, 'subject-audit-absent');

		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, '{}', { headers: { 'Content-Type': 'application/json' } });

		await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${keyId}` },
		});
		await waitForAnalytics();

		const res = await SELF.fetch(`https://gk/admin/supabase/analytics/events?project_ref=${REF}`, { headers: adminHeaders() });
		const data = await res.json<any>();
		const row = (data.result as any[]).find((r) => r.key_id === makePreview(keyId));
		expect(row).toBeDefined();
		expect(row.subject).toBeNull();
	});
});
```

- [ ] **Step 3: Run it and verify it fails for the right reason.**

```bash
cd /home/erfi/gatekeeper && bunx vitest run -c vitest.worker.config.ts test/key-subject.test.ts
```

Expect all 6 to fail: `expected undefined to be 'agent:planner/run-7f3a'` on the create,
rotate and audit assertions; `expected undefined to be null` on the two absent-subject
assertions; and `expected 200 to be 400` on the empty-string case, because `createKeySchema`
is a non-strict Zod object today and silently drops the unknown `subject` field rather than
rejecting it.

- [ ] **Step 4: Add `subject` to the three types.** In `src/types.ts`, add to `ApiKey`
      immediately after `upstream_token_id`:

```ts
	/**
	 * Optional external identity this key is attributed to - an IdP user, a named service,
	 * an agent run id. ATTRIBUTION ONLY: Gatekeeper authenticates the key, never the subject.
	 */
	subject: string | null;
```

to `CreateKeyRequest` immediately after `upstream_token_id`:

```ts
	/** Optional external identity to attribute this key to (see ApiKey.subject). */
	subject?: string;
```

and to `AuthResult` immediately after `upstreamTokenId`:

```ts
	/** The key's external subject, if one was recorded at creation. Stamped onto audit rows. */
	subject?: string;
```

- [ ] **Step 5: Migrate and populate the DO SQLite column.** In `src/iam.ts`:

  a. In `initTables()`, immediately after the `upstream_token_id` migration block, add:

```ts
		// Migration: add subject column for external-identity attribution (IdP user, service, agent run id).
		if (!cols.some((c) => c.name === 'subject')) {
			console.log(JSON.stringify({ migration: 'api_keys', action: 'add_column_subject', ts: new Date().toISOString() }));
			this.sql.exec(`ALTER TABLE api_keys ADD COLUMN subject TEXT`);
		}
```

  `cols` was read before the `upstream_token_id` ALTER, which never adds `subject`, so reusing
  it is correct.

  b. In `createKey()`, extend the INSERT column list, placeholders and bindings:

```ts
		this.sql.exec(
			`INSERT INTO api_keys (id, name, zone_id, created_at, expires_at, revoked, bulk_rate, bulk_bucket, single_rate, single_bucket, policy, created_by, upstream_token_id, subject)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			req.name,
			req.zone_id ?? null,
			now,
			expiresAt,
			rl?.bulk_rate ?? null,
			rl?.bulk_bucket ?? null,
			rl?.single_rate ?? null,
			rl?.single_bucket ?? null,
			policyJson,
			req.created_by ?? null,
			upstreamTokenId,
			req.subject ?? null,
		);
```

  c. In the `const key: ApiKey = { ... }` literal in `createKey()`, add after
     `upstream_token_id: upstreamTokenId,`:

```ts
			subject: req.subject ?? null,
```

  d. In `rotateKey()`, add to the `const req: CreateKeyRequest = { ... }` literal, after
     `upstream_token_id: oldKey.upstream_token_id ?? null!,`:

```ts
			subject: oldKey.subject ?? undefined,
```

  e. In `authorize()`, replace the success return:

```ts
		return {
			authorized: true,
			keyName: key.name,
			upstreamTokenId: key.upstream_token_id ?? undefined,
			subject: key.subject ?? undefined,
		};
```

- [ ] **Step 6: Accept and expose `subject` on the admin API.** In
      `src/routes/admin-schemas.ts`, add to `createKeySchema` after the `upstream_token_id`
      line:

```ts
	subject: z.string().min(1, 'subject must be a non-empty string').max(256).optional(),
```

and to `apiKeySchema` after its `upstream_token_id` line:

```ts
		subject: z.string().nullable(),
```

In `src/routes/admin-keys.ts`, add to the `const req: CreateKeyRequest = { ... }` literal after
`upstream_token_id: parsed.upstream_token_id,`:

```ts
		subject: parsed.subject,
```

and extend the create_key audit detail. Write it pre-wrapped - the one-line form is 143
columns and `prettier --check` (printWidth 140) fails on it:

```ts
		detail: JSON.stringify({
			name: req.name,
			zone_id: req.zone_id,
			upstream_token_id: req.upstream_token_id,
			subject: req.subject ?? null,
		}),
```

- [ ] **Step 7: Migrate the D1 audit table.** In `src/schema.ts`, add `subject TEXT,`
      immediately after the `created_by TEXT,` line inside `SUPABASE_PROXY_EVENTS_TABLE_SQL`,
      and add a new constant immediately after `SUPABASE_PROXY_EVENTS_ADD_KEY_FINGERPRINT_SQL`:

```ts
export const SUPABASE_PROXY_EVENTS_ADD_SUBJECT_SQL = `ALTER TABLE supabase_proxy_events ADD COLUMN subject TEXT`;
```

- [ ] **Step 8: Write the column.** In `src/supabase/analytics.ts`:

  a. Add `SUPABASE_PROXY_EVENTS_ADD_SUBJECT_SQL` to the existing import from `'../schema'`
     (keep the list alphabetical: it sorts after `SUPABASE_PROXY_EVENTS_ADD_KEY_FINGERPRINT_SQL`).

  b. Add to the `SupabaseProxyEvent` interface, after `created_by`:

```ts
	/** External identity the calling key is attributed to, if one was recorded. */
	subject: string | null;
```

  c. In `ensureTables()`, immediately after the `key_fingerprint` try/catch, add:

```ts
	try {
		await db.prepare(SUPABASE_PROXY_EVENTS_ADD_SUBJECT_SQL).run();
	} catch {
		// Column already exists - expected after first migration run.
	}
```

  d. In `logSupabaseProxyEvent()`, add `subject` to the INSERT column list and one more `?`
     placeholder, then bind `event.subject` immediately after `event.created_by`:

```ts
				`INSERT INTO supabase_proxy_events (key_id, key_fingerprint, project_ref, category, action, status, upstream_status, duration_ms, upstream_latency_ms, response_size, response_detail, created_by, subject, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```

- [ ] **Step 9: Stamp it at both proxy event sites.** In `src/supabase/router.ts`, both
      `const event: SupabaseProxyEvent = { ... }` literals (the metrics handler and the
      management handler) get one line after their `created_by:` line:

```ts
			subject: auth.subject ?? null,
```

`auth` is the `AuthResult` returned by `stub.authorize(...)` in each handler, so this is the
subject of the key that made the call.

- [ ] **Step 10: Regenerate the OpenAPI document.** `createKeySchema` and `apiKeySchema` feed
      `scripts/generate-openapi.ts`, and `bun run check:openapi` fails on any diff:

```bash
cd /home/erfi/gatekeeper && bun run openapi && bun run check:openapi
```

Expect `openapi.json is up to date.` and a `git diff --stat` showing only `openapi.json`.
Confirm the field landed. Note that only the **response** schema is a named component
(`ApiKey`); the create-key request body is inlined under the path, so there is no
`components.schemas.CreateKeyRequest` to query:

```bash
cd /home/erfi/gatekeeper
jq -r '.components.schemas.ApiKey.properties.subject.anyOf | map(.type) | join("|")' openapi.json
jq -c '.paths["/admin/keys"].post.requestBody.content["application/json"].schema.properties.subject' openapi.json
```

Expect `string|null` and `{"type":"string","minLength":1,"maxLength":256}`.

- [ ] **Step 11: Run the sensors.**

```bash
cd /home/erfi/gatekeeper && bun run typecheck && bun run lint && bun run test && bun run check:openapi
```

Expect 67 files / 1379 tests passed (66 / 1373 after Task 2, plus this file's 6), and every
other sensor exit 0. Measured in the dry run: exactly that.

---

## Follow-ups (deliberately not in this plan)

Each of these is a real gap found while reading the source. None is padding for the three tasks
above; they are named here so the boundary is explicit rather than silently dropped.

1. **Per-key Supabase rate-limit budget.** The agent profile cannot carry a tighter budget than a
   human key today - `consumeSupabaseRateLimit()` drains one account-level bucket and takes no key
   argument (`src/durable-object.ts:616`). Doing it properly means new per-key columns, a keyed
   bucket map alongside `keyBuckets`, config validation against the account ceiling (mirroring
   `validateRateLimits`), and admin-schema plumbing. Comparable in size to Task 3.
2. **A Supabase mode in the CLI policy wizard.** `cli/policy-wizard.ts` covers `cf` and `s3` only.
   A Supabase branch would need a category picker, the read/write split, project-ref prompting,
   and a preset list - and the wizard currently has no test file, so it needs a testable seam first.
3. **`subject` on the other three proxy audit tables.** This plan stamps it on
   `supabase_proxy_events` only. `purge_events`, `dns_events`, `cf_proxy_events` and `s3_events`
   have the same `created_by` shape and would take the same two-line migration each, plus their
   event sites and `schema.sql` (which does contain those four tables, unlike
   `supabase_proxy_events`).
4. **Filtering analytics by `subject`.** `SupabaseProxyAnalyticsQuery` gains nothing here. A
   `subject` filter means a `buildWhere` clause, a query-schema field, and a dashboard control.
5. **The `#### supabase` catalog table in `docs/GUIDE.md` has already drifted from its source.**
   The guide's metrics row reads "Metrics - read" / "Management /v0 + /v1"; the template in
   `dashboard/src/lib/policy-templates.ts` reads `Metrics - read (v0)` / "Management /v0". The
   table claims to be "generated from" the source but nothing generates or checks it. Either
   generate it or drop the claim.

## Defects the dry run found

Read in order: the first three are harness defects that produced false sensor readings before a
single line of the plan had been tested, and are worth more than the rest.

1. **A false green from the scratch copy.** The tar-pipe excluded `dist`, which deleted
   `dashboard/dist` - the path `wrangler.jsonc` names in `assets.directory`. Every worker test
   file failed to collect and vitest reported `Tests  no tests`. Fix: symlink
   `<repo>/dashboard/dist` into the scratch copy.
2. **A second false green from the same copy.** `dashboard/node_modules` was not symlinked, so
   `dashboard/tsconfig.json`'s `extends: astro/tsconfigs/strict` could not resolve and the two
   test files that import dashboard source - `test/policy-templates.test.ts` and
   `test/aws-policy-converter.test.ts` - failed to load. Those are exactly the files Task 2
   depends on. Fix: symlink `<repo>/dashboard/node_modules` too.
3. **The sensor script reported exit 0 on a failing run.** `bun run test 2>&1 | tail -40; echo
   "TEST_EXIT=$?"` captures `tail`'s status, not the command's. The first baseline printed
   `TEST_EXIT=0` under a visibly broken run. Fix: run each sensor unpiped into a log file and
   read `$?` directly. This is the "shell guard that never fires" class, in the verification
   harness itself.
4. **Task 2 test-count arithmetic was wrong** (predicted 1372, actual 1373).
   `test/policy-templates.test.ts` emits one `it()` per catalog entry, so adding a template adds
   a test there as well as in the new file. Corrected in Step 6.
5. **The rotate route requires a request body.** `POST /admin/keys/:id/rotate` runs
   `parseJsonBody(c, rotateKeySchema)`, so calling it without a body returns 400, not 200. The
   plan's test omitted it and failed with `expected 400 to be 200` for a reason unrelated to
   `subject`. `test/key-rotation.test.ts` passes `JSON.stringify({})`; the test now does too.
6. **The expected-failure text for Task 3 Step 3 was wrong** - 6 failures, not 5, and the
   empty-string case fails because `createKeySchema` is non-strict and drops unknown fields,
   not because of anything to do with rejection logic. Corrected with the real reason.
7. **The OpenAPI verification command queried a schema that does not exist.**
   `components.schemas.CreateKeyRequest` returns `null` - only the response type is a named
   component; the create-key body is inlined under `paths["/admin/keys"].post`. The command now
   queries the real path and states the expected output.
8. **The create_key audit-detail line broke lint.** As a one-liner it is 143 columns and
   `prettier --check` (printWidth 140) rejected it; `typecheck` and `test` were both green at
   the time, so only `lint` caught it. Step 6 now gives the pre-wrapped form.

Also corrected before the run, from reading rather than execution: a hand-written GitHub anchor
link in Task 1 Step 5 that did not resolve, replaced with a plain-text section reference.

## Self-review

**Coverage.** Every file in the file-structure table is written or modified by a numbered step,
and every symbol referenced in a step is defined in the same step or quoted from the existing
source with a line reference. The three tasks are independent: Task 1 touches only a new test and
two docs, Task 2 only the dashboard catalog plus a new test and one docs row, Task 3 only the key
plumbing. They can be implemented and reviewed in any order.

**Placeholders.** None. The one place the plan cannot pin an answer - whether Supabase ever ships
a member-write endpoint - is written as a mechanism (a fixture pin that fails on the day it
happens), not as a TODO.

**Type consistency.** `subject` is `string | null` on the stored `ApiKey` (SQLite gives back
`null`, not `undefined`), `string | undefined` on `CreateKeyRequest` and `AuthResult` (optional
input, absent rather than null), and `string | null` on `SupabaseProxyEvent` (a D1 column). The
`?? null` / `?? undefined` conversions at each boundary are written out in Steps 5, 6 and 9.

**Known weaknesses, honestly.**

- Task 1's pin is only as good as the fixture refresh cadence. Nothing in `bun run test` fetches
  the live spec - `bun run check:api-coverage` does, and it is not wired into `preflight`. If
  nobody runs it, the pin never fires. Step 3 proves the tripwire works; it cannot make anyone
  pull the trigger. `scripts/api-coverage/README.md` already frames this as a scheduled job.
- `bun run typecheck` compiles `src/**` and `scripts/**` only (`tsconfig.json` `include`), and
  `cli/tsconfig.json`. Test files are transpiled by esbuild without type checking, so a type
  error in the three new test files will not fail a sensor. They were still written to compile.
- `bun run lint` does not cover `dashboard/**`, so the Task 2 template edit is unformatted by CI.
  It was written to match the file's existing style (tabs, single quotes, under 140 columns).
- The agent profile allows exactly one write action. That is defensible - `environment` is the
  only category that is both project-resource-scoped and safe to hand an agent - but it is a
  judgement call, and `supabase:database:write` (the category that carries
  `POST /v1/projects/{ref}/database/query`) is the one an agent will ask for first. If that
  becomes the requirement, it belongs in a second template with the trade-off named, not bolted
  onto this one.
- Task 3 adds `subject` to the Supabase audit path only. A key created with a subject and used
  against the purge, DNS, CF or S3 proxies produces audit rows without it. That asymmetry is
  visible to an operator reading the dashboard and is follow-up 3 above.
- `docs/API.md` §11.2's new subsection is the first documentation of `/supabase/members/*` in
  that file. The `?dry_run=true` response shape is described in prose rather than as a JSON
  example, because the exact serialization lives in `src/supabase/member-router.ts` and was not
  quoted into this plan. If a reader needs the literal shape, read that file and add the example.
