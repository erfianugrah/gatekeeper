# Gatekeeper Deployment Guide

Step-by-step instructions for deploying Gatekeeper to Cloudflare Workers.

---

## Prerequisites

- Node.js >= 18
- A Cloudflare account
- A Cloudflare API token with **Cache Purge** permission (for upstream purge)
- Wrangler CLI (installed as a project dev dependency)

```bash
git clone https://github.com/erfianugrah/gatekeeper.git
cd gatekeeper
npm install
cd dashboard && npm install && cd ..
```

---

## Wrangler Configuration

The deployment is defined in `wrangler.jsonc`. Key sections:

### Durable Object

A single Durable Object class (`Gatekeeper`) handles IAM, rate limiting, and
upstream credential storage. It uses SQLite for persistence.

```jsonc
"durable_objects": {
  "bindings": [
    { "class_name": "Gatekeeper", "name": "GATEKEEPER" }
  ]
},
"migrations": [
  { "new_sqlite_classes": ["Gatekeeper"], "tag": "v1" }
]
```

### D1 Database

A D1 database stores purge, S3, DNS, and CF proxy analytics events.

```jsonc
"d1_databases": [
  {
    "binding": "ANALYTICS_DB",
    "database_name": "gatekeeper-analytics",
    "database_id": "<your-database-id>"
  }
]
```

### Static Assets (Dashboard)

The SPA dashboard is served from the `dashboard/dist/` directory. API routes
are handled by the worker first.

```jsonc
"assets": {
  "directory": "./dashboard/dist/",
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/v1/*", "/admin/*", "/health", "/s3", "/s3/*"]
}
```

### Routes (Custom Domain)

```jsonc
"routes": [
  { "pattern": "gate.erfi.io", "custom_domain": true }
]
```

Change `gate.erfi.io` to your domain, or remove the `routes` block entirely to
use the default `*.workers.dev` URL.

### Cron Triggers

A daily cron job runs at 03:00 UTC for maintenance tasks (e.g. expiring keys).

```jsonc
"triggers": {
  "crons": ["0 3 * * *"]
}
```

### Compatibility

```jsonc
"compatibility_date": "2026-03-01",
"compatibility_flags": ["nodejs_compat"],
"observability": { "enabled": true }
```

### Environments

Two Workers are deployed from one codebase via wrangler [environments](https://developers.cloudflare.com/workers/wrangler/environments/):

| Env | Worker name | Route | D1 (`ANALYTICS_DB`) |
| --- | --- | --- | --- |
| **production** (top-level config) | `gatekeeper` | custom domain | `gatekeeper-analytics` |
| **staging** (`env.staging`) | `gatekeeper-staging` | `*.workers.dev` | `gatekeeper-analytics-staging` |

- **The top-level config IS production.** A bare `wrangler deploy` (and `npm run deploy` / `ship`) deploys prod. The `@cloudflare/vitest-pool-workers` test pool also reads the top-level config, so those bindings must stay intact.
- **`env.staging` re-declares the bindings on purpose.** `durable_objects` and `d1_databases` are [non-inheritable](https://developers.cloudflare.com/workers/wrangler/configuration/#non-inheritable-keys) — once any one is overridden in an env, all must be redeclared there. `routes` is inheritable, so staging overrides it to `[]` + `workers_dev: true` to avoid claiming the production domain. Staging gets its own isolated DO namespace automatically (separate Worker script).
- `account_id` is pinned in `wrangler.jsonc` so wrangler doesn't error on account ambiguity.
- Deploy staging manually with `npm run deploy:staging` (or `ship:staging` to gate on preflight first).

---

## D1 Database Creation

Create the D1 database and copy its ID into `wrangler.jsonc`:

```bash
npx wrangler d1 create gatekeeper-analytics
```

The command outputs a `database_id`. Paste it into the `d1_databases` binding in
`wrangler.jsonc`.

---

## Secrets

### Required

| Secret      | Description                                          |
| ----------- | ---------------------------------------------------- |
| `ADMIN_KEY` | Authenticates CLI and API calls to `/admin/*` routes |

Set for production:

```bash
npx wrangler secret put ADMIN_KEY
```

### Optional

| Secret                 | Description                                                                   |
| ---------------------- | ----------------------------------------------------------------------------- |
| `CF_ACCESS_TEAM_NAME`  | Cloudflare Access team name (e.g. `myteam` for `myteam.cloudflareaccess.com`) |
| `CF_ACCESS_AUD`        | Cloudflare Access Application Audience (AUD) tag                              |
| `RBAC_ADMIN_GROUPS`    | Comma-separated IDP group names mapped to the admin role                      |
| `RBAC_OPERATOR_GROUPS` | Comma-separated IDP group names mapped to the operator role                   |
| `RBAC_VIEWER_GROUPS`   | Comma-separated IDP group names mapped to the viewer role                     |

```bash
npx wrangler secret put CF_ACCESS_TEAM_NAME
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put RBAC_ADMIN_GROUPS
npx wrangler secret put RBAC_OPERATOR_GROUPS
npx wrangler secret put RBAC_VIEWER_GROUPS
```

The RBAC group secrets are optional. They enable role-based access control
through Cloudflare Access identity headers on the dashboard.

### Upstream Credentials

Upstream Cloudflare API tokens and R2 endpoint credentials are **not** set as
env vars or secrets. They are registered at runtime via the admin API and stored
in the Durable Object's SQLite database. This allows managing multiple upstream
tokens with different zone/bucket scopes, rotating credentials without
redeploying, and auditing who registered what.

Account-scoped upstream tokens (`--scope-type account`) are needed for CF proxy
services (D1, KV, Workers, Queues, Vectorize, Hyperdrive). For smoke tests, the
CF proxy token (`CF_PROXY_TOKEN` or `UPSTREAM_CF_TOKEN`) must be present in
`.env` so the test orchestrator can register it at runtime.

See the [CLI reference](CLI.md) for `upstream-tokens create` and
`upstream-r2 create`.

---

## Local Development

Create a `.dev.vars` file in the project root with your secrets:

```
ADMIN_KEY=some-strong-local-secret
```

Then start the local dev server:

```bash
npm run dev
```

This runs `wrangler dev`, which starts a local worker with the Durable Object
and D1 bindings available locally.

After changing bindings in `wrangler.jsonc`, regenerate TypeScript types:

```bash
npx wrangler types
```

---

## Building

The project has two build targets: the dashboard (Vite SPA) and the CLI.

```bash
# Build both
npm run build

# Build individually
npm run build:dashboard    # Vite build -> dashboard/dist/
npm run build:cli          # TypeScript compile -> dist/cli/
```

Run the full pre-deploy check (typecheck, lint, test, build):

```bash
npm run preflight
```

---

## Deploying

Deploy builds the dashboard and runs `wrangler deploy`:

```bash
npm run deploy
```

Or run the full preflight pipeline then deploy:

```bash
npm run ship
```

On first deploy, Wrangler automatically:

1. Creates the Durable Object namespace.
2. Runs the SQLite migration (tag `v1`).

No manual migration steps are required.

### Continuous Deployment

CD lives in `.github/workflows/ci.yml` (the `deploy` job, `needs: [preflight, e2e]` so a red suite or a failed Playwright e2e run never ships):

- **push to `main`** → deploy **staging**, then run the `live-smoke` job against it
- **push tag `v*`** → deploy **production**
- **`workflow_dispatch`** → deploy the chosen env

Auth is the scoped `CLOUDFLARE_API_TOKEN` repo secret (Workers Scripts + D1 on the account, Workers Routes + Zone Read on the zone) — **never** the global API key. The e2e job is a deploy gate because it catches the `run_worker_first` asset-layer class of bug that the worker test pool is blind to (vitest calls `app.fetch` directly).

**`live-smoke`** (`needs: deploy`, push-to-`main` only) runs `cli/smoke-supabase.ts` against the freshly deployed staging worker — API-first checks with a synthetic tier always, plus a real PAT-swap live tier when the `SUPABASE_SMOKE_PAT` repo secret is set. Optional live metrics checks run when both `SUPABASE_SMOKE_METRICS_SECRET` and `SUPABASE_SMOKE_METRICS_REF` are set. CI also enables a non-destructive write-classified probe with `SUPABASE_SMOKE_ENABLE_WRITE_PROBE=1`. Missing optional vars emit notices and self-skip only those subtiers. It targets staging via the `STAGING_ADMIN_KEY` repo secret and self-skips when that is unset (so it never blocks a deploy before secrets exist). It is intentionally **not** run on `workflow_dispatch` (which can target prod) because it mints real resources via the admin key. The full multi-surface `npm run smoke` is deliberately **not** in CI — it needs the complete upstream credential set (CF API token, R2/DNS creds) and is run manually.

A separate scheduled workflow (`.github/workflows/supabase-live-smoke-scheduled.yml`) runs weekly against staging for regression detection between deploys. It requires `STAGING_ADMIN_KEY` and `SUPABASE_SMOKE_PAT`; metrics secrets stay optional and self-skip when unset.

Secrets are per-environment: `wrangler secret put <NAME> --env staging`. Staging has its own `ADMIN_KEY`; the other secrets (`CF_ACCESS_*`, `RBAC_*`) are unset on staging until needed.

---

## Custom Domain Setup

1. Edit the `routes` array in `wrangler.jsonc`:

   ```jsonc
   "routes": [
     { "pattern": "purge.yourdomain.com", "custom_domain": true }
   ]
   ```

2. The domain must be on your Cloudflare account (proxied through Cloudflare).
   Wrangler handles the DNS record creation when using `custom_domain: true`.

3. Deploy:

   ```bash
   npm run deploy
   ```

To use the default `*.workers.dev` URL instead, remove the `routes` block
entirely from `wrangler.jsonc`.

---

## Commands Reference

| Command                    | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `npm run dev`              | Start local development server (`wrangler dev`)      |
| `npm run build`            | Build dashboard + CLI                                |
| `npm run build:dashboard`  | Build dashboard only (Vite)                          |
| `npm run build:cli`        | Build CLI only (TypeScript)                          |
| `npm run deploy`           | Build dashboard, then `wrangler deploy`              |
| `npm run ship`             | Preflight (typecheck + lint + test + build) + deploy |
| `npm test`                 | Run all tests (worker + CLI)                         |
| `npm run test:worker`      | Run worker tests only (Cloudflare Workers runtime)   |
| `npm run test:cli`         | Run CLI tests only (Node.js runtime)                 |
| `npm run typecheck`        | Type-check worker + CLI (no emit)                    |
| `npm run lint`             | Check formatting (Prettier)                          |
| `npm run lint:fix`         | Auto-fix formatting                                  |
| `npm run preflight`        | typecheck + lint + test + build                      |
| `npx wrangler types`       | Regenerate types after changing `wrangler.jsonc`     |
| `npm run cli -- <command>` | Run the CLI locally (uses tsx + `.env`)              |
| `npm run deploy:staging`   | Build dashboard, then `wrangler deploy --env staging`|
| `npm run ship:staging`     | Preflight + deploy staging                           |
| `npm run test:e2e`         | Playwright E2E tests (auto-starts `wrangler dev`)    |
| `npm run smoke`            | Full multi-surface E2E smoke against a live instance |
| `npm run smoke:supabase`   | Supabase-only smoke (API-first synthetic + opt-in live PAT/metrics tiers) |
| `bun run env:decrypt`      | Decrypt `.env.sops` → `.env` (needs the SOPS age key)|
| `npm run check:api-coverage` | Live upstream-drift check (not in preflight)       |
| `npm run api-coverage:write` | Refresh + write api-coverage snapshots             |
| `npm run openapi`          | Generate OpenAPI specification                       |

---

## CLI Environment Variables

When using the `gk` CLI against a deployed instance, set these environment
variables (or pass the equivalent flags):

| Variable               | Description                         |
| ---------------------- | ----------------------------------- |
| `GATEKEEPER_URL`       | Base URL of the Gatekeeper instance |
| `GATEKEEPER_ADMIN_KEY` | Admin secret for `/admin/*` routes  |
| `GATEKEEPER_API_KEY`   | API key (`gw_...`) for purge routes |
| `GATEKEEPER_ZONE_ID`   | Default Cloudflare zone ID          |

Example:

```bash
export GATEKEEPER_URL=https://gate.example.com
export GATEKEEPER_ADMIN_KEY=my-admin-secret
gk health
gk keys list --zone-id abc123
```

For local development with the CLI, use the `.env` file (loaded automatically by
`npm run cli`). If you have the SOPS age key, the shared credential set is
committed encrypted as `.env.sops` — run `bun run env:decrypt` to produce the
plaintext `.env` (and `bun run env:edit` to change a value):

```
GATEKEEPER_URL=http://localhost:8787
GATEKEEPER_ADMIN_KEY=some-strong-local-secret
GATEKEEPER_ZONE_ID=your-test-zone-id
```
