# API coverage framework

Gatekeeper fronts several upstream APIs (Supabase Management, Cloudflare, S3/R2) and classifies
every inbound request to a Gatekeeper action. Anything unclassified is **denied by default** — that
fails safe, but it means an upstream can add or move an endpoint and the proxy silently stops
covering it with no error. This framework makes that drift loud.

## Registered providers

| Provider | Surface source | Coverage predicate | Live ops |
|---|---|---|---|
| `supabase` | live OpenAPI (`api.supabase.com/api/v1-json`) | `classifySupabaseRequest` ≠ null | 165 (all covered) |
| `s3` | runtime enum `S3_OPERATIONS` (`src/s3/operations.ts`) | real `detectOperation` routes the probe back | 66 (all covered) |
| `cloudflare` | live CF OpenAPI (filtered to proxied resources) | a real Hono route in the service sub-app matches | 128 (115 covered, 13 allowlisted) |

Three different *surface sources*, one uniform interface. Each upstream is policed by the model
that fits its shape — see "Coverage models" below.

## Two layers, two concerns

| Layer | File | Network? | Runs in | Catches |
|---|---|---|---|---|
| Hermetic invariant | `test/api-coverage.test.ts` | no | `npm test` (Workers pool) | classifier/routing regressions, stale `covered` flags, allowlist rot — against the **committed** baseline |
| Live drift check | `scripts/api-coverage/refresh.ts` | yes | `npm run check:api-coverage` (tsx) | upstream **schema changes** — new/moved/removed endpoints vs the live spec (supabase, cloudflare) and enum/detection drift (s3) |

The test never touches the network, so it runs offline and on every preflight. The refresh job is
the one that reaches out to the upstream spec — run it on a schedule or before a release.

## Commands

```bash
npm run check:api-coverage     # fetch live specs, fail on drift / uncovered ops (writes nothing)
npm run api-coverage:write     # rewrite the committed snapshots from the live specs, then commit
npm test                       # includes the hermetic invariant (test/api-coverage.test.ts)
```

`check:api-coverage` exits non-zero when:
- a live op is neither covered by the proxy classifier nor in the provider `allowlist` (a real gap), or
- the committed snapshot is stale vs the live spec (an endpoint was added/moved/removed), or
- an allowlist entry is now actually covered, or no longer exists upstream (allowlist rot).

When it flags stale-snapshot drift, run `npm run api-coverage:write` and commit the diff (after
deciding whether each new op needs classifier support or an allowlist entry).

## Adding a provider

One conforming module under `providers/` + one entry in `registry.ts` + one committed snapshot.
A provider implements `CoverageProvider` (see `types.ts`):

```ts
export const fooProvider: CoverageProvider = {
  id: 'foo',
  label: 'Foo API',
  snapshotPath: 'scripts/api-coverage/fixtures/foo.ops.json',
  snapshot: snapshotJson as SnapshotOp[],          // static import of the committed fixture
  async fetchLiveOps() { /* fetch OpenAPI doc -> extractOpenApiOps(spec) */ },
  isCovered(op) { /* run op through the proxy's own classifier; return boolean */ },
  allowlist: { 'GET /v1/thing': 'reason it is intentionally out of scope' },
};
```

Then: `printf '[]\n' > scripts/api-coverage/fixtures/foo.ops.json`, add the import + array entry
in `registry.ts`, run `npm run api-coverage:write`, and commit.

Providers **must not** import `cloudflare:workers` — `refresh.ts` runs in plain tsx. The proxy
classifiers it depends on (`classifySupabaseRequest`, S3 `detectOperation`, the CF per-service
`operations.ts`) are all pure and import only types/constants, so this holds.

## Coverage models

The `CoverageProvider` interface is uniform; the *source* of the authoritative surface and the
coverage predicate differ per upstream because the upstreams differ:

- **Supabase Management API** (`providers/supabase.ts`) — has `https://api.supabase.com/api/v1-json`
  (165 ops) and ships changes frequently. The classifier (`src/supabase/classify.ts`) is a
  table-driven longest-prefix matcher, exactly the thing that lags when an endpoint moves. Coverage
  = `classifySupabaseRequest` returns non-null for the full current surface (no allowlist gap).
- **S3 / R2** (`providers/s3.ts`) — no live AWS spec; the surface is a closed enum exported at
  runtime as `S3_OPERATIONS`. Coverage is exercised through the *real* `detectOperation` routing:
  each op carries a representative request (query/header discriminators) and `isCovered` asserts
  detection routes it back to the same op with a non-empty IAM action. A completeness guard throws
  if the enum gains an op with no probe — so the enum can't grow silently. All 66 ops detect.
- **Cloudflare API proxy** (`providers/cloudflare.ts`) — fetches CF's published OpenAPI, filters it
  to the sub-resource prefixes we actually proxy (KV, D1, Workers, Queues, Vectorize v2, Hyperdrive,
  DNS records), and checks coverage by matching each op against the **real Hono routes** registered
  by each service sub-app (`app.routes`, read without executing handlers). Catches CF adding/moving
  an endpoint under a resource we already proxy. 13 in-surface endpoints we deliberately skip
  (streaming live-tail, legacy/bulk shapes, zone-scan) live in the allowlist with reasons.

The whole rest of the CF API is *out of surface* — never filtered in — so the allowlist stays small
and meaningful instead of swallowing thousands of unproxied endpoints. That filtering is the
difference between drift detection and a tautological 99%-allowlist self-check.
