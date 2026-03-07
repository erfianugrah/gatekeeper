# Contributing to Gatekeeper

This guide covers development setup, code conventions, testing, and the workflow for adding new features to Gatekeeper -- an API gateway and S3 proxy built on Cloudflare Workers with Durable Objects, D1, and R2.

---

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Style](#code-style)
  - [Formatting](#formatting)
  - [Import Order](#import-order)
  - [Naming Conventions](#naming-conventions)
  - [Types](#types)
  - [Functions](#functions)
  - [Error Handling](#error-handling)
  - [Comments](#comments)
  - [Exports](#exports)
- [Test Architecture](#test-architecture)
  - [Running Tests](#running-tests)
  - [Test Conventions](#test-conventions)
  - [Mocking](#mocking)
- [Commands Reference](#commands-reference)
- [Adding New Endpoints](#adding-new-endpoints)
- [Adding New CLI Commands](#adding-new-cli-commands)

---

## Development Setup

1. **Clone the repository:**

   ```bash
   git clone <repo-url>
   cd gatekeeper
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Create a `.dev.vars` file** in the project root with your local secrets. This file is used by `wrangler dev` and is `.gitignore`d. At minimum you need `ADMIN_KEY`. Refer to `wrangler.jsonc` and `src/env.d.ts` for the full list of bindings and secrets.

4. **Create a `.env` file** for the CLI (also `.gitignore`d). See `.env.example`:

   ```
   GATEKEEPER_URL=https://gate.erfi.io
   GATEKEEPER_ADMIN_KEY=
   GATEKEEPER_API_KEY=
   GATEKEEPER_ZONE_ID=
   ```

5. **Generate TypeScript types** for Cloudflare bindings:

   ```bash
   npx wrangler types
   ```

   Run this again any time you change bindings in `wrangler.jsonc`. The generated file `worker-configuration.d.ts` should not be edited manually.

6. **Start local development:**

   ```bash
   npx wrangler dev
   ```

---

## Project Structure

```
gatekeeper/
  src/               Worker source (Hono routes, Durable Object, policy engine, S3 proxy)
    index.ts           Main entrypoint -- Hono app, security headers, cron handler
    durable-object.ts  Gatekeeper DO class (key/config/credential storage)
    routes/            Hono sub-apps: admin-keys, admin-config, admin-analytics, purge, etc.
    s3/                S3-compatible proxy: routes, SigV4, IAM, XML handling
    schema.ts          D1 table DDL (CREATE TABLE IF NOT EXISTS)
    types.ts           Shared TypeScript types
    policy-engine.ts   IAM policy evaluation engine
    policy-types.ts    Policy document type definitions
    token-bucket.ts    Rate limiter (token bucket algorithm)
    env.d.ts           Extends Cloudflare.Env with secrets not in wrangler.jsonc
  cli/               CLI source (citty commands, Node.js)
    index.ts           CLI entrypoint -- registers all subcommands
    commands/          One file per command (health, keys, purge, config, etc.)
    client.ts          HTTP client helpers (resolveConfig, request, assertOk)
    ui.ts              Terminal output helpers (success, error, label, dim, etc.)
    shared-args.ts     Shared CLI argument definitions
    cli.test.ts        CLI tests (runs in Node.js)
  test/              Worker tests (runs in Cloudflare Workers runtime)
    helpers.ts         Shared test utilities
    *.test.ts          Test files
    env.d.ts           Wires Env into cloudflare:test's ProvidedEnv
  dashboard/         Web dashboard (built separately)
  scripts/           Build/generation scripts
    generate-openapi.ts  Generates openapi.json from Zod schemas
  docs/              Documentation
  wrangler.jsonc     Wrangler configuration (bindings, DO, D1, R2, crons)
  schema.sql         D1 schema source of truth
  openapi.json       Generated OpenAPI spec (do not edit manually)
```

---

## Code Style

### Formatting

The project uses Prettier and EditorConfig. Key rules:

- **Tabs** for indentation (not spaces)
- **Single quotes**
- **Semicolons** required
- **Print width:** 140
- **LF** line endings
- Trailing whitespace trimmed, final newline inserted
- YAML files use spaces for indentation

Run `npm run lint` to check and `npm run lint:fix` to auto-fix.

### Import Order

Imports follow a strict ordering with type-only imports separated:

1. Platform modules (`cloudflare:workers`, `cloudflare:test`)
2. External libraries (`hono`, `citty`, `vitest`, `zod`)
3. Local value imports
4. Local type-only imports (`import type { ... }`)

Additional rules:

- Use **named imports** (not default) for all internal modules.
- **Worker source (`src/`):** No file extensions in import paths (bundled by wrangler).
- **CLI source (`cli/`):** Always use `.js` extensions in import paths (ESM requirement).
- No barrel/index re-export files. Import directly from the source module.

Example:

```typescript
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { getStub } from '../do-stub';
import type { HonoEnv } from '../types';
```

### Naming Conventions

| Category                | Convention                                   | Example                               |
| ----------------------- | -------------------------------------------- | ------------------------------------- |
| Files                   | `kebab-case.ts`                              | `token-bucket.ts`                     |
| Classes                 | `PascalCase`                                 | `Gatekeeper`, `TokenBucket`           |
| Interfaces/Types        | `PascalCase`                                 | `PurgeBody`, `AuthResult`             |
| Functions               | `camelCase`                                  | `classifyPurge`, `resolveZoneId`      |
| Variables               | `camelCase`                                  | `cacheTtlMs`, `singleBucket`          |
| Module constants        | `UPPER_SNAKE_CASE`                           | `DO_NAME`, `CREATE_TABLE_SQL`         |
| Env bindings            | `UPPER_SNAKE_CASE`                           | `ADMIN_KEY`, `ANALYTICS_DB`           |
| DB columns / API fields | `snake_case`                                 | `zone_id`, `scope_type`, `created_at` |
| CLI args                | `kebab-case`                                 | `zone-id`, `admin-key`                |
| Private class fields    | `camelCase` with `private` keyword (not `#`) | `private tokens`                      |
| Test-only exports       | `__testPrefixed` double-underscore           | `__testClearInflightCache()`          |

### Types

- Use `interface` for object/record shapes with multiple fields.
- Use `type` for unions, string literals, and simple aliases (e.g., Hono env wiring).
- Shared worker types go in `src/types.ts`. Domain-specific types live in their own module.
- Explicit return types on public/exported methods. Type inference is fine for short private helpers.
- All env vars are string-typed; cast to numbers at point of use: `Number(env.BULK_RATE) || 50`.

### Functions

- Use `function` declarations for top-level/named helpers.
- Use arrow functions for inline callbacks, Hono route handlers, and middleware.
- Use `async`/`await` exclusively. No raw `.then()` chains (`.finally()` for cleanup is fine).

### Error Handling

There are four error-handling patterns depending on context:

**Worker routes** -- try/catch returning Cloudflare API-style JSON:

```typescript
return c.json({ success: false, errors: [{ code: 400, message: '...' }] }, 400);
```

**Validation helpers** -- throw `new Error(...)` with descriptive messages, caught by the route handler.

**Fire-and-forget** (analytics, etc.) -- try/catch with `console.error(JSON.stringify({...}))`, never propagate.

**CLI** -- call `error(msg)` (from `ui.ts`) then `process.exit(1)` for fatal errors. Use `assertOk()` for HTTP response checks.

Additional conventions:

- Catch clauses: `catch (e: any)` when the error value is used, bare `catch` when unused.
- No generic Result/Either monad. `AuthResult` uses `{ authorized: boolean, error?: string }` pattern.

### Comments

- **Section dividers** in source files use Unicode box-drawing characters:

  ```typescript
  // ─── Admin: Purge Key Management ────────────────────────────────────────────
  ```

- **JSDoc** `/** ... */` for exported functions/methods. No `@param`/`@returns` tags -- rely on TypeScript types.
- **Inline** `//` comments for brief explanations. Use em-dashes in prose.
- **Tests** use `// --- Section ---` with regular dashes.

### Exports

- Named exports for nearly everything.
- `export default app` only for the Hono app (Workers fetch handler requirement).
- CLI command files export `defineCommand(...)` as default (for lazy dynamic import via citty).

---

## Test Architecture

The project has two Vitest projects configured in a workspace (`vitest.config.ts`):

| Project  | Config file               | Runtime                                                    | Files               |
| -------- | ------------------------- | ---------------------------------------------------------- | ------------------- |
| `worker` | `vitest.worker.config.ts` | Cloudflare Workers (via `@cloudflare/vitest-pool-workers`) | `test/**/*.test.ts` |
| `cli`    | `vitest.cli.config.ts`    | Node.js                                                    | `cli/**/*.test.ts`  |

Worker tests run inside the actual Cloudflare Workers runtime using `@cloudflare/vitest-pool-workers`. They can access bindings (D1, R2, Durable Objects) and use `SELF.fetch()` for integration tests.

### Running Tests

```bash
# Run all tests (both worker and CLI)
npm test

# Run worker tests only
npm run test:worker

# Run CLI tests only
npm run test:cli

# Run a single worker test file (no -c flag needed -- default config includes worker project)
npx vitest run test/iam.test.ts

# Run a single CLI test file (MUST specify config)
npx vitest run -c vitest.cli.config.ts cli/cli.test.ts

# Run a single test by name
npx vitest run -t "revoked key -> rejected"

# Run smoke tests against a live instance
npm run smoke
```

Note: when running a single worker test file you do NOT need `-c vitest.worker.config.ts` because the default workspace config includes the worker project. For CLI tests you DO need `-c vitest.cli.config.ts`.

### Test Conventions

- Use `describe()`/`it()` blocks. Test names use natural language with arrow notation:

  ```typescript
  it('revoked key -> rejected', async () => { ... });
  it('valid key + matching zone -> 200', async () => { ... });
  ```

- `beforeAll` for one-time setup (e.g., creating keys, activating mocks).
- `beforeEach`/`afterEach` for per-test state reset.
- Worker integration tests use `SELF.fetch()` from `cloudflare:test` to hit the running worker.
- Durable Object tests obtain stubs via `env.GATEKEEPER.get(id)`.
- Assertions use `expect()` with `.toBe()`, `.toEqual()`, `.toMatch(/regex/)`, etc.
- Parse responses with `res.json<any>()`.

### Mocking

**HTTP mocking** -- use `fetchMock` from `cloudflare:test`:

```typescript
import { fetchMock } from 'cloudflare:test';

beforeAll(() => {
	fetchMock.activate();
});
```

**Time-dependent tests** -- use Vitest fake timers:

```typescript
vi.useFakeTimers();
vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
vi.advanceTimersByTime(60_000);
```

**CLI tests** -- mock `process.exit` via `vi.spyOn()`:

```typescript
vi.spyOn(process, 'exit').mockImplementation(() => {
	throw new Error('process.exit');
});
```

---

## Commands Reference

| Command                | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `npx wrangler dev`     | Start local development server                       |
| `npx wrangler deploy`  | Deploy to Cloudflare                                 |
| `npx wrangler types`   | Regenerate `worker-configuration.d.ts` from bindings |
| `npm test`             | Run all tests (worker + CLI via Vitest workspace)    |
| `npm run test:worker`  | Run worker tests only (Cloudflare Workers runtime)   |
| `npm run test:cli`     | Run CLI tests only (Node.js runtime)                 |
| `npm run typecheck`    | Type-check worker + CLI (no emit)                    |
| `npm run lint`         | Check formatting with Prettier                       |
| `npm run lint:fix`     | Auto-fix formatting with Prettier                    |
| `npm run build`        | Build dashboard + CLI                                |
| `npm run build:cli`    | Build the CLI only                                   |
| `npm run preflight`    | typecheck + lint + test + build (run before PR)      |
| `npm run ship`         | preflight + deploy (full release)                    |
| `npm run openapi`      | Regenerate `openapi.json` from Zod schemas           |
| `npm run smoke`        | E2E smoke tests against a live instance              |
| `npm run cli -- <cmd>` | Run the CLI locally (uses tsx + .env)                |

**Before opening a pull request**, always run:

```bash
npm run preflight
```

This runs typecheck, lint, all tests, and the build in sequence. If any step fails, the command exits immediately.

---

## Adding New Endpoints

Gatekeeper uses Hono for routing, Zod for validation, and Durable Objects for persistent state. Follow this checklist when adding a new admin endpoint:

### 1. Define Zod schemas

Add request/response schemas to `src/routes/admin-schemas.ts`. These schemas serve as the single source of truth for server-side validation, OpenAPI generation, dashboard forms, and TypeScript type inference.

```typescript
export const myFeatureSchema = z.object({
	name: z.string().min(1).max(128),
	enabled: z.boolean().default(true),
});
```

### 2. Create or extend a route file

Add a new file in `src/routes/` (e.g., `admin-my-feature.ts`) or extend an existing one. Follow the established pattern:

```typescript
import { Hono } from 'hono';
import { getStub } from '../do-stub';
import { myFeatureSchema, jsonError, parseJsonBody } from './admin-schemas';
import type { HonoEnv } from '../types';

export const adminMyFeatureApp = new Hono<HonoEnv>();

adminMyFeatureApp.post('/', async (c) => {
	const parsed = await parseJsonBody(c, myFeatureSchema);
	if (parsed instanceof Response) return parsed;

	const stub = getStub(c.env);
	// ... call DO methods ...

	return c.json({
		success: true,
		result: {
			/* ... */
		},
	});
});
```

### 3. Add Durable Object methods (if needed)

If the endpoint needs persistent state, add methods to `src/durable-object.ts` in the `Gatekeeper` class.

### 4. Mount the route

Register the sub-app in `src/routes/admin.ts`:

```typescript
admin.route('/my-feature', adminMyFeatureApp);
```

### 5. Add types (if needed)

Add any new shared interfaces or types to `src/types.ts`.

### 6. Write tests

Create `test/my-feature.test.ts`. Use `SELF.fetch()` for integration tests:

```typescript
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

describe('my-feature', () => {
	it('creates a resource -> 200', async () => {
		const res = await SELF.fetch('https://gatekeeper/admin/my-feature', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Admin-Key': env.ADMIN_KEY,
			},
			body: JSON.stringify({ name: 'test', enabled: true }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
	});
});
```

### 7. Regenerate OpenAPI spec

After adding or modifying schemas:

```bash
npm run openapi
```

This runs `scripts/generate-openapi.ts` and updates `openapi.json`.

### 8. Run preflight

```bash
npm run preflight
```

---

## Adding New CLI Commands

The CLI uses [citty](https://github.com/unjs/citty) for command parsing. Each command is a separate file with a lazy dynamic import.

### 1. Create the command file

Add a new file in `cli/commands/` (e.g., `cli/commands/my-feature.ts`):

```typescript
import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
import { success, error, label, printJson } from '../ui.js';

export default defineCommand({
	meta: { name: 'my-feature', description: 'Manage my feature' },
	args: {
		endpoint: {
			type: 'string',
			description: 'Gateway URL ($GATEKEEPER_URL)',
		},
		'admin-key': {
			type: 'string',
			description: 'Admin key ($GATEKEEPER_ADMIN_KEY)',
		},
		json: {
			type: 'boolean',
			description: 'Output raw JSON',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const { status, data } = await request(config, 'GET', '/admin/my-feature');
		assertOk(status, data);

		if (args.json) {
			printJson(data);
			return;
		}

		success('Feature is working');
		label('Result', data.result);
	},
});
```

Note the `.js` extensions on all local imports -- this is required for ESM compatibility.

### 2. Register in cli/index.ts

Add a lazy import entry in the `subCommands` object:

```typescript
const main = defineCommand({
	// ...
	subCommands: {
		// ... existing commands ...
		'my-feature': () => import('./commands/my-feature.js').then((m) => m.default),
	},
});
```

### 3. Write tests

Add tests in `cli/cli.test.ts` or create a dedicated test file in `cli/`. Remember that CLI tests run in Node.js and require the `-c vitest.cli.config.ts` config flag when run individually:

```bash
npx vitest run -c vitest.cli.config.ts cli/cli.test.ts
```

### 4. Build and verify

```bash
npm run build:cli
npm run preflight
```

### 5. Test locally

```bash
npm run cli -- my-feature --json
```

This uses `tsx` with the `.env` file for local execution.
