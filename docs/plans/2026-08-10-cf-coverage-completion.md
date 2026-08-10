# Cloudflare proxy: close the coverage allowlist

**Status:** in progress. This document is the binding spec for the loop run that
implements it. It is read-only to the implementing agent; if something here is
wrong, stop and say so rather than editing this file.

## Goal

The CF coverage provider reports `132 in-surface ops, 116 covered, 16
allowlisted` (`bun run check:api-coverage`). Proxy the remaining 16 so the
Cloudflare allowlist is EMPTY and every in-surface op is covered by a real Hono
route with its own IAM action.

"Covered" has one definition and it is mechanical: `providers/cloudflare.ts`
`isCovered(op)` matches the op's method + path tail against the **registered
routes** of the service sub-app. A route that forwards without an IAM action
would satisfy the matcher and is NOT acceptable - see the rules below.

## The 16 ops, with target IAM actions

Verified against `/docs/cloudflare-api/api/{kv,workers,live-tail,queue,dns-records-for-a-zone,hyperdrive}.md`
and `scripts/api-coverage/fixtures/cloudflare.ops.json`.

### KV (1) - reuse the existing action, no new action

| op | action |
|---|---|
| `DELETE /accounts/{a}/storage/kv/namespaces/{ns}/bulk` | `kv:bulk_delete` (existing) |

Legacy bulk-delete shape: same semantics as the `POST /bulk/delete` route we
already proxy (body is a key-name array). Reuse `kv:bulk_delete`; do not invent a
second action for the same operation.

### Workers (5)

| op | action |
|---|---|
| `PATCH /accounts/{a}/workers/scripts/{n}/secrets-bulk` | `workers:update_secrets_bulk` |
| `GET /accounts/{a}/workers/scripts/{n}/usage-model` | `workers:get_usage_model` |
| `PUT /accounts/{a}/workers/scripts/{n}/usage-model` | `workers:update_usage_model` |
| `POST /accounts/{a}/workers/observability/telemetry/live-tail` | `workers:prepare_live_tail` |
| `POST /accounts/{a}/workers/observability/telemetry/live-tail/heartbeat` | `workers:live_tail_heartbeat` |

`usage-model` is deprecated upstream (superseded by script settings) - proxy it
anyway; it exists and clients still call it. Note it as deprecated in the
`operations.ts` header comment.

`live-tail` is NOT a streaming endpoint: the POST prepares a session and returns
`{ result: { wsUrl } }`. It is an ordinary JSON request/response, which is why it
is proxyable at all. The current allowlist reason ("long-lived connection") is
factually wrong and goes away with the entry.

### Queues (5)

| op | action |
|---|---|
| `GET /accounts/{a}/queues/{q}/metrics` | `queues:get_metrics` |
| `POST /accounts/{a}/queues/{q}/messages/preview` | `queues:preview_messages` |
| `POST /accounts/{a}/queues/{q}/messages/preview/ack` | `queues:ack_previewed_messages` |
| `POST /accounts/{a}/queues/{q}/messages/peek` | `queues:peek_messages` |
| `POST /accounts/{a}/queues/{q}/messages/purge` | `queues:purge_peeked_messages` |

`messages/peek` is the renamed `messages/preview` shape (identical body and
semantics); both exist upstream, so both get routes. Distinct actions, because a
policy author granting the new shape should not silently get the old one.

`messages/purge` deletes PEEKED messages by ref. It is NOT the queue-level
`POST /queues/{q}/purge` we already proxy as `queues:purge` - keep the two
actions apart, and make the difference explicit in the `operations.ts` header
comment.

### DNS (4)

| op | action |
|---|---|
| `POST /zones/{z}/dns_records/scan` | `dns:scan` |
| `POST /zones/{z}/dns_records/scan/trigger` | `dns:trigger_scan` |
| `GET /zones/{z}/dns_records/scan/review` | `dns:get_scan_review` |
| `POST /zones/{z}/dns_records/scan/review` | `dns:review_scan` |

Route-ordering hazard: register these BEFORE any single-segment `/:recordId`
route with the same method, or Hono's first-match will send `/scan` into the
record handler.

### Hyperdrive (1)

| op | action |
|---|---|
| `POST /accounts/{a}/hyperdrive/integrationsOperations/{integration}/createDatabaseSignature` | `hyperdrive:create_database_signature` |

The path segment is literally `integrationsOperations` (camelCase, upstream's
spelling). `{integration}` is an enum with one member today (`planetScale`);
proxy it as a path param, do not hardcode the value.

## Two ops hand out an off-gateway channel - say so in the docs

Both of these return something the caller then uses OUTSIDE the proxy, so the
audit trail stops at the grant:

- `workers:prepare_live_tail` returns a `wsUrl` the client connects to directly.
  Log lines never transit Gatekeeper.
- `hyperdrive:create_database_signature` returns a signed authorization a partner
  CLI redeems directly, creating a database billed to the account.

Both are deny-by-default like every other action, so this is a documentation
duty, not a code one: add a short subsection to `docs/SECURITY.md` naming both
actions and the fact that granting them yields an unproxied, unaudited
capability. Do not soften it and do not add a code-level guard - policy is the
guard.

## Per-op checklist (all of it, for every op)

1. **`src/cf/<svc>/operations.ts`** - add the action to the `<Svc>Action` union
   and to the header-comment route table (the table is the human-readable index;
   an action missing from it is an incomplete change). Reuse an existing context
   builder when the resource shape matches; add one only if the resource string
   genuinely differs.
2. **`src/cf/<svc>/routes.ts`** - add the route. Copy the shape of the nearest
   sibling handler exactly: `jsonServiceRoute(c, SVC, '<action>', [ctx], '<upstream path>', '<METHOD>', <resourceId?>)`
   wrapped in try/catch with the `console.error(JSON.stringify({ route, error, ts }))`
   failure log. No new abstraction, no helper extraction.
3. **`dashboard/src/components/PolicyBuilder.tsx`** - add the action to its
   service group with a human label + description (and the existing `category`
   where that group uses one). Every CF action is currently listed there; that
   parity is a gate.
4. **`docs/GUIDE.md`** - add the action to the service's action list. Same
   parity gate.
5. **Tests** - extend the existing file for that service (`test/cf-kv.test.ts`,
   `test/cf-workers.test.ts`, `test/cf-queues-vectorize-hyperdrive.test.ts`,
   `test/dns.test.ts`). Follow the file's existing idiom. Each new op needs BOTH
   directions: a key whose policy allows the action reaches the upstream
   (fetchMock), and a key without it gets 403. A route with only a happy-path
   test is not done.
6. **`scripts/api-coverage/providers/cloudflare.ts`** - delete the allowlist
   entry for the op. When all 16 are done the `allowlist` object is `{}`.
7. **Snapshot** - `bun run api-coverage:write`, then confirm
   `bun run check:api-coverage` says `gaps: 0` and `allowlisted: 0`.
8. **Counts in prose** - `AGENTS.md` and `scripts/api-coverage/README.md` state
   the covered/allowlisted numbers. Update every occurrence; a stale count is a
   doc that contradicts the code.

## Hard rules

- No stubs. A route that returns 501 or forwards without an IAM action is a
  failed iteration, not progress.
- Do not weaken, skip, or delete tests. The suite is at 1351 passing; it only
  goes up.
- Do not touch `test/api-coverage.test.ts` - it is the invariant that judges
  this work.
- Do not hand-edit the `covered` flags in
  `scripts/api-coverage/fixtures/cloudflare.ops.json`. Regenerate it with
  `bun run api-coverage:write`; the invariant test recomputes every flag from the
  real routes and will catch a hand-edit.
- Do not touch `.pi/harness*` or `docs/plans/2026-08-10-cf-coverage-completion.md`.
- `/cf/*` is already in `assets.run_worker_first` (`wrangler.jsonc`), so no
  wrangler change is needed for any of these routes. Do not add one.
- Prettier config: tabs, single quotes, width 140. Run `bun run lint:fix` before
  declaring done.

## Golden references

- Route + action + context, JSON service: `src/cf/queues/routes.ts` (`queues:purge_status`)
  with `src/cf/queues/operations.ts` (`queuesQueueContext`).
- Sub-resource path with two params: `src/cf/queues/routes.ts` consumers routes.
- Zone-scoped service: `src/cf/dns/routes.ts` + `src/cf/dns/operations.ts`.
- Allow-and-deny test pair: `test/cf-queues-vectorize-hyperdrive.test.ts`.
