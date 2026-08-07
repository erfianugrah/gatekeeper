# Supabase metrics: derived per-project credentials

**Status:** deferred, deliberately. Written up while the context was fresh; do
not build it until the trigger below fires.

## The gap

`/supabase/metrics/:ref` resolves a `supabase_metrics` upstream token - an HTTP
Basic secret for one project. The Supabase Metrics API is per-project by design,
so a wildcard metrics token cannot work (the credential differs per ref), and
`validateSupabaseMetrics` already concedes this: *"Wildcard metrics token - the
metrics endpoint is per-project, so there is nothing to probe"*
(`src/routes/admin-helpers.ts:322`).

Consequence: N projects means N registered secrets, N rotations, and N chances
to pin a key at the wrong credential. Meanwhile ONE stored PAT can already reach
every project in the account.

## The shape, if built

A key pinned to a `supabase` (PAT) credential hitting `/supabase/metrics/:ref`
derives the project credential instead of failing:

1. `GET https://api.supabase.com/v1/projects/{ref}/api-keys?reveal=true` with the
   stored PAT.
2. Select `type === "secret"` (the `sb_secret_...` form). **Never** select on
   `name === "service_role"` - that picks the legacy JWT, which
   `GET /v1/projects/{ref}/api-keys/legacy` documents as being removed, and which
   can be disabled per project.
3. Optional: if no secret key exists, `POST /v1/projects/{ref}/api-keys` to
   create a dedicated one (e.g. `gatekeeper-metrics`). Same response shape.
   This is the documented recommendation for observability access - see the
   Supabase guide `monitoring-and-debugging/metrics/vendor-agnostic.md`.
4. Use it as the Basic password (username `service_role`) upstream.
5. Cache per ref in the DO. Suggested 15 min: short enough that a dashboard-side
   rotation self-heals inside a scrape interval or two, long enough that a 60s
   scrape does not hammer the Management API. Evict and re-derive ONCE on an
   upstream 401 before surfacing the error.

An explicitly registered `supabase_metrics` credential must keep winning, so the
change stays additive.

Verified against the API schema (`/docs/supabase-api/api/secrets.md`):

```
GET /v1/projects/{ref}/api-keys
  query: reveal (boolean)
  200 -> [{ api_key?: string, id?: string,
            type?: "legacy" | "publishable" | "secret",
            prefix?: string, name: string, ... }]
```

`api_key` is OPTIONAL - without `reveal=true` you get metadata only, no value.

## Why it is deferred

For a handful of projects this loses to three form fills. The feature costs a
few hundred lines, a write-scoped PAT, cache/TTL/eviction semantics, a path that
mutates projects, and a permanent new failure surface in a production gateway.

The scaling argument is also narrower than it first appears: databases reached
by connstring (no PAT, e.g. an audit target outside the account) can never be
covered by a PAT-derived key. Derivation only helps for projects the stored PAT
can already see.

## Trigger to build it

Any of:

- a consumer needs metrics for projects whose secrets we will never hold
  directly, but whose PAT we do hold;
- registered `supabase_metrics` credentials pass roughly a dozen, where manual
  rotation becomes its own failure mode;
- an external consumer (vendor, colleague, hosted Grafana) is fronted, so
  revocation, audit and rate limiting have to live at the gateway rather than in
  the credential itself. This is the case the proxy exists for - a self-hosted
  scraper holding its own narrow key gets little from the extra hop, and gains a
  runtime dependency on this Worker for the telemetry it would use to debug it.

## Prior art in this repo

`src/supabase/member-router.ts` is the same pattern: a Gatekeeper-owned write
surface that runs the full authorization pipeline and provisions upstream. It
sits at 501 only because the membership write transport is undocumented. The
metrics case has no such blocker - the endpoints are public API.

## Related

- v1.11.2 fixed the diagnostic that made a wrong-typed pin look like a missing
  credential. That is what turned this from a mystery into a one-line answer,
  and it ships independently of anything above.
