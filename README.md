# Gatekeeper

API gateway on Cloudflare Workers with an AWS IAM-style authorization engine. Fronts the Cloudflare cache purge API, DNS Records API, Cloudflare R2 (S3-compatible storage), and the broader Cloudflare API (D1, KV, Workers, Queues, Vectorize, Hyperdrive). The IAM layer is service-agnostic — the same policy engine handles all services.

## What it does

1. **IAM policy engine** — fine-grained access control via policy documents. Each API key or S3 credential has an attached policy with actions, resources, and conditions (field/operator/value expressions). Think IAM policies, not flat RBAC.
2. **DNS proxy** — DNS record management scoped to specific FQDNs, record types, and actions. ACME clients, CI/CD pipelines, and internal tooling get least-privilege DNS access without a full-zone CF API token.
3. **S3/R2 proxy** — S3-compatible gateway to Cloudflare R2 with per-credential IAM policies. R2's native tokens only support per-bucket read/write — this adds object-level, key-prefix, cross-bucket, and conditional access control. Standard S3 clients (rclone, boto3, aws-cli) work out of the box.
4. **CF API proxy** — proxies D1, KV, Workers, Queues, Vectorize, and Hyperdrive through the same IAM engine. Account-scoped keys with fine-grained actions (e.g., `d1:query`, `kv:get_value`, `workers:update_script`). Wrangler works out of the box via `CLOUDFLARE_API_BASE_URL`.
5. **Rate limit headers** — the purge endpoint returns `Ratelimit` and `Ratelimit-Policy` (IETF Structured Fields format) so clients know their budget.
6. **Token bucket enforcement** — rejects purge requests client-side before they hit the upstream API. Purge: bulk (50/sec, burst 500) and single-file (3,000/sec, burst 6,000). S3: 100/sec, burst 200. CF proxy: 200/sec, burst 400.
7. **Request collapsing** — identical concurrent purges get deduplicated at both isolate and Durable Object levels.
8. **Analytics** — every purge, DNS, S3, and CF proxy operation is logged to D1. Query events, get summaries, filter by key/credential/zone/account/service/time range. CF proxy events are broken down by individual service (D1, KV, Workers, etc.).
9. **Dashboard** — Astro SPA served from the same Worker via Static Assets. Unified analytics view with dynamic per-source tabs.

## Authentication

Three authentication methods, checked in order:

1. **Cloudflare Access JWT** — SSO via any IdP (Google, Okta, Azure AD, etc.). Roles resolved from IdP groups or built-in user records.
2. **X-Admin-Key header** — shared secret for CLI and automation. Always grants `admin` role. Requires key >= 16 characters.
3. **Built-in email/password** — self-hosted login with no external IdP required. PBKDF2-SHA256 (600k iterations), session cookies, RBAC roles per user.

All three methods coexist. Use whichever fits your deployment:

| Method            | Best for                        | Setup                                                                        |
| ----------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| Cloudflare Access | Teams with existing SSO         | Configure Access app + set `CF_ACCESS_TEAM_NAME` and `CF_ACCESS_AUD` secrets |
| X-Admin-Key       | CLI, automation, CI/CD          | Set `ADMIN_KEY` secret (>= 16 chars)                                         |
| Built-in auth     | Solo operators, no external IdP | Visit `/login` on first deploy to create admin account                       |

### Built-in auth quick start

1. Deploy the worker (no secrets needed for built-in auth)
2. Visit `https://your-domain/login`
3. First visit shows a "Create admin account" form (bootstrap mode)
4. Create your admin user (email + password, min 12 chars)
5. You're logged in — manage additional users at `/admin/users`

When a built-in user has the same email as an Access SSO user, the built-in user's role takes precedence. This lets you manage roles locally even when using SSO for authentication.

### User management API

```
GET    /admin/users              — list all users
POST   /admin/users              — create user { email, password, role }
GET    /admin/users/:id          — get user
PATCH  /admin/users/:id          — update role { role }
DELETE /admin/users/:id          — delete user (revokes all sessions)
POST   /admin/users/:id/password — change password (revokes all sessions)
```

### Auth endpoints (unauthenticated)

```
GET    /login            — login page (HTML)
POST   /auth/login       — { email, password } -> session cookie
POST   /auth/logout      — clear session
GET    /auth/session     — validate current session
POST   /auth/bootstrap   — create first admin (only when 0 users exist)
```

## Quick start

```bash
git clone <repo> && cd gatekeeper
npm install
cp .dev.vars.example .dev.vars   # set ADMIN_KEY
npx wrangler dev                 # local development
```

See [Deployment](docs/DEPLOYMENT.md) for production setup.

## Documentation

| Document                             | Description                                                          |
| ------------------------------------ | -------------------------------------------------------------------- |
| [Guide](docs/GUIDE.md)               | Getting started, creating keys/credentials, every policy permutation |
| [API Reference](docs/API.md)         | All endpoints with request/response examples                         |
| [CLI Reference](docs/CLI.md)         | Every command, flag, and usage example                               |
| [Security](docs/SECURITY.md)         | IAM policy engine, auth tiers, conditions, 11 policy examples        |
| [Architecture](docs/ARCHITECTURE.md) | System design, Durable Object, rate limiting, dashboard              |
| [Deployment](docs/DEPLOYMENT.md)     | Wrangler config, secrets, building, deploying                        |
| [Contributing](docs/CONTRIBUTING.md) | Dev setup, code style, test architecture, adding endpoints           |
| [OpenAPI Spec](openapi.json)         | Auto-generated from Zod schemas (`npm run openapi`)                  |

## Tech stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite) + D1
- **Framework**: Hono
- **Validation**: Zod v4 (single source of truth for validation, OpenAPI, and types)
- **Dashboard**: Astro 5 + React 19 + Tailwind CSS 4 + shadcn/ui
- **CLI**: citty
- **S3 signing**: aws4fetch
- **Tests**: Vitest + @cloudflare/vitest-pool-workers (1,007 unit tests, ~730 e2e smoke assertions)

## Commands

```bash
npm run dev          # local development
npm test             # run all tests (worker + CLI)
npm run typecheck    # type-check worker + CLI
npm run lint         # check formatting
npm run preflight    # typecheck + lint + test + build
npm run openapi      # regenerate openapi.json from Zod schemas
npm run ship         # preflight + deploy
```

## License

MIT — see [LICENSE](LICENSE).
