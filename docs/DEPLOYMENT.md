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

A D1 database stores purge and S3 analytics events.

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
| `npm run smoke`            | E2E smoke tests against a live instance              |
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
`npm run cli`):

```
GATEKEEPER_URL=http://localhost:8787
GATEKEEPER_ADMIN_KEY=some-strong-local-secret
GATEKEEPER_ZONE_ID=your-test-zone-id
```
