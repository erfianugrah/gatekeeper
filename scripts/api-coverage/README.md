# API coverage framework

Gatekeeper fronts several upstream APIs (Supabase Management, Cloudflare, S3/R2) and classifies
every inbound request to a Gatekeeper action. Anything unclassified is **denied by default** — that
fails safe, but it means an upstream can add or move an endpoint and the proxy silently stops
covering it with no error. This framework makes that drift loud.

## Two layers, two concerns

| Layer | File | Network? | Runs in | Catches |
|---|---|---|---|---|
| Hermetic invariant | `test/api-coverage.test.ts` | no | `npm test` (Workers pool) | classifier regressions, stale `covered` flags, allowlist rot — against the **committed** baseline |
| Live drift check | `scripts/api-coverage/refresh.ts` | yes | `npm run check:api-coverage` (tsx) | upstream **schema changes** — new/moved/removed endpoints vs the live OpenAPI spec |

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

## Why only Supabase today

Only an upstream with a live, machine-readable spec **and** a real risk of silent endpoint drift
earns a provider:

- **Supabase Management API** — has `https://api.supabase.com/api/v1-json` (164+ ops) and ships
  changes frequently. The classifier (`src/supabase/classify.ts`) is a table-driven longest-prefix
  matcher, exactly the thing that lags when an endpoint moves. Real payoff. (This framework already
  caught `GET /v1/oauth/authorize/project-claim` having changed method, and surfaced `/v1/snippets`
  as an account-level gap a date-stamped manual review had missed.)
- **S3 / R2** — the surface is a closed enum, `Record<S3OperationName, string>` in
  `src/s3/operations.ts`. TypeScript already enforces totality at compile time; there is no live
  spec to drift against. A provider here would be a tautological self-check.
- **Cloudflare** — the proxy covers a deliberate per-service subset (KV, D1, DNS, Workers, Queues,
  Vectorize, Hyperdrive); the rest of the enormous CF API is intentionally out of scope, so a
  provider would be ~99% allowlist. No drift-detection value.

Forcing those in would be the "snowflake add-on" this framework exists to avoid. The extension
point is real and uniform — when the next spec-backed upstream arrives, it is a conforming module,
not a bolt-on.
