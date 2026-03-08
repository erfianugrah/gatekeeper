# Gatekeeper

API gateway on Cloudflare Workers with an AWS IAM-style authorization engine. Fronts the Cloudflare cache purge API, DNS Records API, and Cloudflare R2 (S3-compatible storage). The IAM layer is service-agnostic — the same policy engine handles all three services.

## What it does

1. **IAM policy engine** — fine-grained access control via policy documents. Each API key or S3 credential has an attached policy with actions, resources, and conditions (field/operator/value expressions). Think IAM policies, not flat RBAC.
2. **DNS proxy** — DNS record management scoped to specific FQDNs, record types, and actions. ACME clients, CI/CD pipelines, and internal tooling get least-privilege DNS access without a full-zone CF API token.
3. **S3/R2 proxy** — S3-compatible gateway to Cloudflare R2 with per-credential IAM policies. R2's native tokens only support per-bucket read/write — this adds object-level, key-prefix, cross-bucket, and conditional access control. Standard S3 clients (rclone, boto3, aws-cli) work out of the box.
4. **Rate limit headers** — the purge endpoint returns `Ratelimit` and `Ratelimit-Policy` (IETF Structured Fields format) so clients know their budget.
5. **Token bucket enforcement** — rejects purge requests client-side before they hit the upstream API. Two buckets: bulk (50/sec, burst 500) and single-file (3,000 URLs/sec, burst 6,000).
6. **Request collapsing** — identical concurrent purges get deduplicated at both isolate and Durable Object levels.
7. **Analytics** — every purge, DNS, and S3 operation is logged to D1. Query events, get summaries, filter by key/credential/zone/bucket/time range.
8. **Dashboard** — Astro SPA served from the same Worker via Static Assets.

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
| [API Reference](docs/API.md)         | All 32 endpoints with request/response examples                      |
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
- **Tests**: Vitest + @cloudflare/vitest-pool-workers (691 tests)

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
