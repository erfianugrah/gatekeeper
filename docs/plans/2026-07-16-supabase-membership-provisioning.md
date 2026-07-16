# Supabase Membership Provisioning: body-aware authorization, dry-run, audit, lifecycle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Supabase overlay from a transparent per-request proxy into a delegated **organization-membership provisioning gateway**: an IAM operator holds a narrowly-scoped Gatekeeper key that can *only* list / invite / re-role / assign-projects / remove organization members, where every request is authorized against the *contents* of the body (target email domain, requested role, requested projects, batch size), previewable as a dry-run plan, and recorded as a before/after audit entry.

**Non-goal (this plan):** a full SCIM 2.0 server. Section 6 scopes an *optional* provider-specific lifecycle webhook as the pragmatic first step and explicitly defers standardized SCIM to a separate plan, because they are different-sized products (one route vs a spec-conformant identity subsystem).

**Tech Stack:** TypeScript, Cloudflare Workers / Durable Objects, Hono, Vitest + `@cloudflare/vitest-pool-workers`, Playwright (e2e asset-layer gate), React (PolicyBuilder dashboard).

---

## Upstream reality check (verified 2026-07-16). READ BEFORE PLANNING WORK

The membership-write capability this plan gates **does not exist in the public, documented Supabase Management API**. This is the single most important design constraint; getting it wrong means building a classifier + policy surface for endpoints that 404 upstream.

| Capability | Public Management API (`api.supabase.com/v1`) reality | Source |
|---|---|---|
| **List** org members | Yes: `GET /v1/organizations/{slug}/members` (read-only) | `/docs/supabase-api/api/organizations.md:47` |
| **Invite** a member | No v1 endpoint. Done via the internal dashboard API and the UI. | Access Control doc + supabase/supabase PR #32707 (removed `/members/invite`), PR #40513 ("V2 organization roles endpoint") |
| **Change** a member role | No v1 endpoint. Internal "V2 org roles" endpoint only. | supabase/supabase PR #40513 |
| **Assign** projects to a member | No v1 endpoint. Project-scoped role assignment is internal. | Access Control doc |
| **Remove** a member | No v1 endpoint. Add/Remove are dashboard actions. | Access Control doc |

**Role model** (needed for the policy layer regardless of transport): `Owner`, `Administrator`, `Developer`, `Read-Only`. Roles are **org-scoped** or **project-scoped** (project-scoped only on Team/Enterprise). Invite constraint: a project-scoped invite may assign **one** project at invite time; additional projects are assigned after the invitee accepts.

**Consequence - Task 0 is a hard gate.** Before any classifier/route work, a spike MUST confirm the concrete upstream transport (internal `api.supabase.com/platform/...` "V2 org roles" endpoints, exact paths, request/response schemas, auth, stability guarantees) that a stored PAT can actually drive. The rest of the plan is written to be **transport-agnostic**: the classifier, policy, body-authorization, dry-run, and audit layers do not care whether the upstream path is `/v1/...`, an internal `/platform/...`, or a future `/v2/...`. Only the router's `proxyToManagementApi` target and the route glob change with the answer. If Task 0 finds no PAT-drivable write transport exists, Sections 1-3 stop at **List** (read) + the webhook path (Section 6) becomes the only write mechanism.

---

## Design: reuse the multi-context authorize primitive (do NOT build a second evaluator)

The policy engine already does exactly what "authorize every assignment independently, reject the whole request if any is impermissible" requires:

- `evaluatePolicy(policy, contexts: RequestContext[])` (`src/policy-engine.ts:12`) returns true only if **every** context passes (AND). Each context is deny-first then allow.
- `IamManager.authorize(keyId, zoneId, contexts[])` (`src/iam.ts`) already accepts an array and returns a per-item `denied[]` list.

The Supabase router today passes a single `[ctx]` (`src/supabase/router.ts:157`). The core of this plan is: **for a membership mutation, parse the body and expand it into N `RequestContext`s (one per (member, project, role) assignment), each carrying scalar body-derived fields, then hand all N to the existing `authorize(...)`.** All-must-pass semantics gives batch rejection for free. The condition engine operates on scalar `string | boolean` fields (`src/policy-engine.ts:evaluateLeaf`), so arrays (e.g. `project_refs`) MUST be flattened into per-assignment contexts rather than passed as a single field.

---

## File map

### Task 0 - Upstream transport spike (gating, no code merge)
| File | Change |
|---|---|
| `docs/plans/2026-07-16-supabase-membership-provisioning.md` | Fill the "Resolved transport" table below from a live probe against a test org PAT |

### Section 1 - member classification + route glob
| File | Change |
|---|---|
| `src/supabase/constants.ts` | Add `'members'` to `SupabaseCategory` |
| `src/supabase/classify.ts` | New `classifyMemberRequest` (or member branch): map member verbs to `supabase:members:{list,invite,update_role,assign_projects,remove}`. Deny-by-default for everything else on the surface. |
| `wrangler.jsonc` | Add the resolved member route glob (e.g. `/supabase/members/*` or the internal-path glob) to `assets.run_worker_first` - **without this the route returns dashboard HTML (HTTP 200), not a deny; see Known Pitfall** |
| `src/supabase/router.ts` | Mount member handler; distinct actions instead of method-derived read/write |

### Section 2 - member-specific actions + bind-time guard
| File | Change |
|---|---|
| `src/routes/token-binding.ts` | `validateSupabaseResources`: allow `supabase:members:*` actions; keep account-wide (`project:*` / `supabase:account`) behind the wildcard-token requirement |
| `dashboard/src/components/PolicyBuilder.tsx` | New scope-gated `members` action group (5 actions) under `scope === 'supabase'` |
| `dashboard/src/components/KeysPage.tsx` | Thread `members` defaults through `makeDefaultPolicy` / `buildDefaultResources` |

### Section 3 - request-body authorization
| File | Change |
|---|---|
| `src/supabase/member-schema.ts` (new) | Zod schema for the invite/re-role/assign bodies; `parseMemberRequest` to normalized assignment list |
| `src/supabase/member-context.ts` (new) | `buildMemberContexts(assignments, resource)` to `RequestContext[]` with scalar fields: `supabase.target_email`, `supabase.target_domain`, `supabase.requested_role`, `supabase.requested_project`, `supabase.batch_size`, `supabase.contains_production` |
| `src/supabase/router.ts` | Buffer + parse body for member writes; build N contexts; call existing `authorize(...)`; reject whole request on any `denied` |
| `src/policy-types.ts` | Document new `supabase.*` condition fields (no engine change needed) |

### Section 4 - dry-run + idempotent execution
| File | Change |
|---|---|
| `src/supabase/member-plan.ts` (new) | `planMembershipChange`: fetch current members (List) then diff against requested, classify each add/remove/role-change, authorize each, return `{ plan, denied, noops }` without mutating |
| `src/supabase/router.ts` | `?dry_run=true` (or `X-Gatekeeper-Dry-Run`) returns the plan; execution re-validates immediately before applying; idempotency key dedupes retries |
| `src/types.ts` | `MembershipPlanResult` type (mirrors `BulkDryRunResult` shape) |

### Section 5 - before/after audit
| File | Change |
|---|---|
| `src/supabase/analytics.ts` | New `supabase_membership_events` D1 table + `logMembershipEvent`; capture actor (key name + optional IdP identity), target, before-role, requested-role, resulting-role, projects, idempotency key, upstream result, reconcile status |
| `src/routes/admin-supabase-analytics.ts` | `GET /admin/supabase/membership/{events,summary}` (follow the `/events` + `/summary` sibling convention) |
| `src/analytics-timeseries.ts` | Add `supabase_membership_events` to `ALLOWED_TABLES` |
| `src/index.ts` | Cron retention for the new table |

### Section 6 - OPTIONAL provider lifecycle webhook (NOT SCIM)
| File | Change |
|---|---|
| `src/routes/lifecycle-webhook.ts` (new) | `POST /webhooks/idp/lifecycle`: verify signature, map event, List members, Remove match, audit. Config-gated; off by default. |
| `wrangler.jsonc` | `/webhooks/*` in `run_worker_first` |
| `docs/plans/2026-07-XX-scim-server.md` (new stub) | Defer standardized SCIM (`/scim/v2/Users`, `/Groups`, PATCH/filter/pagination, provider quirks) to its own plan |

---

## Resolved transport (fill in Task 0)

| Member verb | Gatekeeper action | Upstream method + path | Auth | Body schema | Stability |
|---|---|---|---|---|---|
| list | `supabase:members:list` | `GET /v1/organizations/{slug}/members` | Bearer PAT | - | public/stable |
| invite | `supabase:members:invite` | _TBD_ | _TBD_ | _TBD_ | _internal?_ |
| update_role | `supabase:members:update_role` | _TBD_ | _TBD_ | _TBD_ | _internal?_ |
| assign_projects | `supabase:members:assign_projects` | _TBD_ | _TBD_ | _TBD_ | _internal?_ |
| remove | `supabase:members:remove` | _TBD_ | _TBD_ | _TBD_ | _internal?_ |

---

## Task 0: Upstream transport spike (GATE)

**Files:** docs only (record findings in the table above).

- [ ] Probe a throwaway test org with a real PAT: attempt member list (confirmed works), then observe the dashboard's network calls for invite / re-role / assign / remove. Record exact method, path, host (`api.supabase.com/platform/...` vs other), request body schema, and response.
- [ ] Confirm whether a **stored PAT** (not a browser session cookie) can drive each write. If a write requires a session cookie / CSRF token that a PAT cannot supply, mark that verb **not-proxyable** and route it exclusively through Section 6 (webhook) or defer it.
- [ ] Decision checkpoint: if zero writes are PAT-proxyable, cut Sections 1-4 down to **list-only** + Section 5 (audit of reads) + Section 6 (webhook remove). Do not build classifier rows for endpoints that cannot be reached.

**Rationale:** deny-by-default fails safe but silently - building a `supabase:members:invite` action for a non-existent proxyable endpoint yields a policy surface that always 404s at upstream. Verify the endpoint exists and is reachable with the credential we hold before writing the classifier.

---

## Task 1: Member classifier (TDD)

**Files:** Modify `src/supabase/constants.ts`, `src/supabase/classify.ts`; create `test/supabase-members.test.ts`.

- [ ] **Step 1: Write the failing test.** Assert each member verb resolves to its distinct action (not method-derived `organizations:read|write`), the resource is `org:<slug>`, and any non-member path on the surface returns `null` (deny). Include a test that the route glob is present in `run_worker_first` (parse `wrangler.jsonc`).
- [ ] **Step 2: Implement.** Add `'members'` to `SupabaseCategory`; add the member branch to `classifySupabaseRequest` keyed off the resolved transport from Task 0. Keep verbs explicit (a `PUT .../roles/{id}` must map to a *named* action, not inherit `write`).
- [ ] **Step 3: Verify.** `bunx vitest run test/supabase-members.test.ts` green; add member ops to the api-coverage snapshot (`bun run api-coverage:write`) and confirm `test/api-coverage.test.ts` still passes.

## Task 2: Bind-time guard + PolicyBuilder group (TDD)

- [ ] Test: a `members`-only key bound to a ref-scoped token is accepted; a `members` action bound with `project:*` / `supabase:account` resource requires a wildcard token (reuse the existing account-wide guard in `validateSupabaseResources`).
- [ ] Implement the `members` action group in `PolicyBuilder.tsx` (scope-gated to `supabase`), thread defaults through `KeysPage.tsx`.
- [ ] e2e (`e2e/supabase-ui.spec.ts`): the `members` group appears only when a `supabase` upstream token is selected.

## Task 3: Body-authorization (TDD, the core)

- [ ] Test the deny paths explicitly: invite `Owner` denied when policy allows only `Developer`/`Read-Only`; invite to an unlisted project denied; batch over configured max denied; non-corporate target domain denied; **one bad item in a batch rejects the whole request** (assert via the multi-context `authorize` returning `denied[]`).
- [ ] Test the allow path: a well-formed invite of an allowed role to an in-scope project reaches upstream.
- [ ] Implement `member-schema.ts` (zod, at the boundary) + `member-context.ts` (flatten to per-assignment `RequestContext[]`) + router wiring. No policy-engine change - only new field names in `ctx.fields`.
- [ ] Document the new condition fields in `policy-types.ts` and `docs/SECURITY.md`.

## Task 4: Dry-run + idempotency (TDD)

- [ ] Test: `?dry_run=true` returns `{ plan, denied, noops }` and performs **no** upstream mutation (assert with a `fetchMock` that records zero write calls); a no-op (member already has requested role) is detected; a conflicting item is flagged.
- [ ] Test: idempotency key replays the same result without a second upstream mutation.
- [ ] Implement `member-plan.ts` (List, diff, authorize each, plan) and the execute path (re-validate, apply, reconcile).

## Task 5: Before/after audit (TDD)

- [ ] Test: a successful re-role writes a `supabase_membership_events` row with before-role, requested-role, resulting-role, actor, target, idempotency key, reconcile status.
- [ ] Implement the D1 table (`CREATE TABLE IF NOT EXISTS` - **do NOT add a module-level init flag**, see Known Pitfalls), `logMembershipEvent` (fire-and-forget via `waitUntil`), the admin read endpoints, timeseries allowlist entry, and cron retention.
- [ ] Note the actor limitation: the recorded actor is the **key**, not a person, unless keys are 1:1 with people or an IdP identity is threaded in. Capture whatever identity the auth layer already has (`auth.keyName`).

## Task 6 (OPTIONAL): Provider lifecycle webhook (TDD)

- [ ] Test: a signed `user.deactivated` event with a valid signature triggers a member-remove through the Section 4 execute path; an invalid signature is rejected; the "deprovision semantics" are config-driven (which of remove-membership / revoke-sessions / remove-projects fire).
- [ ] Implement `lifecycle-webhook.ts`, add `/webhooks/*` to `run_worker_first`, config-gate it off by default.
- [ ] Write the SCIM deferral stub plan. Do not implement `/scim/v2/*` here.

---

## Deprovision semantics are undefined until confirmed

"Remove a member" is ambiguous and must be pinned before Section 6 executes anything destructive. Candidate actions, which are NOT equivalent:

1. Prevent the next SSO login.
2. Revoke existing platform sessions.
3. Remove project assignments only.
4. Remove organization membership.
5. Delete / disable the underlying identity.
6. Preserve the account + history for audit.

Section 6 config MUST make the chosen combination explicit and default to the least-destructive interpretation (remove org membership, preserve history) until an operator opts into more.

---

## Cross-cutting gotchas (from repo AGENTS.md - do not rediscover these)

- **`run_worker_first` or it fails OPEN.** Any new route prefix NOT in `assets.run_worker_first` (`wrangler.jsonc`) is served the dashboard SPA `index.html` (HTTP 200) by Cloudflare's asset layer *before the worker runs*. This is invisible to `vitest` (which calls `app.fetch` directly) and only surfaces at deploy - hence the e2e gate. Add `/supabase/members/*` (or resolved glob) and `/webhooks/*`.
- **No module-level `ensureTables()` cache flag** in the new analytics module - it breaks the per-file D1 isolation in `@cloudflare/vitest-pool-workers`. `CREATE TABLE IF NOT EXISTS` is a microsecond no-op; leave it unguarded.
- **Breadcrumbs on every decision branch** in the router (`supabase-members-authz-denied`, `supabase-members-unmapped`, `supabase-members-dry-run`, `supabase-members-idempotent-replay`) per the Breadcrumb Logging convention - kebab-case, no bare `error:` fields.
- **`bun run test`, never `bun test`.** Run `bun run preflight` before any PR.
- **api-coverage drift:** member ops must land in the committed `supabase.ops.json` snapshot so the hermetic `test/api-coverage.test.ts` stays honest.

---

## Sequencing

Task 0 (gate), then Task 1, Task 2, Task 3 (core value), Task 4, Task 5. Task 6 is optional and independent of 1-5 except it reuses Task 4's execute path. Ship 1-3 as the first mergeable increment (delegated, body-authorized member management with deny-by-default); 4-5 as the second (dry-run + audit); 6 as a separate opt-in.
