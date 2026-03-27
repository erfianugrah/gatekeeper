# Gatekeeper Gateway Roadmap

> **Status**: Working document. Will be subsumed into proper docs once features land.
> **Last updated**: 2026-03-27

This document details the plan to evolve Gatekeeper from a Cloudflare API governance layer into a full API gateway that surpasses CF API Shield and encroaches on Kong Gateway territory — all running on Cloudflare Workers with zero external infrastructure.

---

## Table of Contents

1. [Platform Constraints & Budget](#1-platform-constraints--budget)
2. [Cloudflare Request Lifecycle (What Runs Before/After Workers)](#2-cloudflare-request-lifecycle)
3. [Storage Architecture](#3-storage-architecture)
4. [Phase 1 — Beat API Shield](#4-phase-1--beat-api-shield)
5. [Phase 2 — Enter Kong Territory](#5-phase-2--enter-kong-territory)
6. [Phase 3 — Platform Play](#6-phase-3--platform-play)
7. [Binding Changes](#7-binding-changes)
8. [Pipeline Execution Order](#8-pipeline-execution-order)
9. [Migration Strategy](#9-migration-strategy)
10. [Appendix A — Full Platform Inventory](#appendix-a-every-nook-and-cranny--full-platform-inventory)
11. [Appendix B — Competitive Positioning](#appendix-b-competitive-positioning)

---

## 1. Platform Constraints & Budget

Every design decision must respect these hard limits. No exceptions.

### Workers Limits (Paid Plan)

| Resource                          | Limit                       | Implication                                                                                                                 |
| --------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| CPU time per invocation           | 5 min                       | Schema validation + JWT verification + policy eval + proxy must fit. Budget ~50ms for gateway overhead on the hot path.     |
| Memory per isolate                | 128 MB                      | Shared across concurrent requests in the same isolate. OpenAPI schemas, JWKS caches, and compiled regexes compete for this. |
| Worker bundle size                | 10 MB                       | No large schema validation libraries. Hand-roll or use minimal deps.                                                        |
| Subrequests per invocation        | 10,000 (default, up to 10M) | Generous. JWKS fetch + upstream fetch + analytics write = ~3 per request.                                                   |
| Simultaneous outgoing connections | 6 per request               | Constrains fan-out patterns. Health checks must be serial or use alarms.                                                    |
| Request body size                 | 100 MB (Pro), 500 MB (Ent)  | Limits file upload proxy size. Must stream, not buffer.                                                                     |
| Startup time                      | 1 second                    | All global-scope init (schema compilation, etc.) must be fast.                                                              |
| Environment variables             | 128 per Worker, 5 KB each   | OpenAPI schemas cannot live in env vars. Use DO SQLite or KV.                                                               |

### Durable Object Limits (SQLite-backed)

| Resource                | Limit                        | Implication                                                                                                                                           |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage per DO instance | 10 GB                        | All IAM keys, credentials, upstream tokens, users, sessions, config, route definitions, schemas, circuit breaker state share this. Monitor carefully. |
| CPU per request         | 30s default, 5 min max       | Complex policy evaluation is fine. Batch schema compilation during admin writes, not on the hot path.                                                 |
| Single-threaded         | Queries execute sequentially | Keep DO calls fast. Isolate-level caching is critical.                                                                                                |
| WebSocket hibernation   | Supported                    | Enables real-time log streaming to dashboard without burning duration charges.                                                                        |

### D1 Limits

| Resource      | Limit                                    | Implication                                                                                       |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Database size | **10 GB hard cap, cannot be increased**  | Currently used for analytics only. At high volume, 10 GB fills in weeks. Must plan overflow.      |
| Concurrency   | Single-threaded per DB                   | ~1,000 QPS with 1ms queries. Analytics writes are fire-and-forget, but reads (dashboard) contend. |
| Throughput    | Inversely proportional to query duration | Index everything. Keep writes to simple INSERTs.                                                  |

### KV Limits

| Resource                  | Limit                 | Implication                                                                                       |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| Value size                | 25 MB                 | Large enough for OpenAPI schemas, route configs, cached JWKS responses.                           |
| Write rate                | 1 write/sec per key   | Not suitable for per-request counters. Fine for config/schema storage (write-rarely, read-often). |
| Read latency              | ~10ms globally cached | Excellent for hot-path reads like JWKS, schemas, route tables.                                    |
| Storage per namespace     | Unlimited (paid)      | No cap concerns.                                                                                  |
| Operations per invocation | 1,000                 | More than enough.                                                                                 |

### R2 Limits

| Resource            | Limit     | Implication                                         |
| ------------------- | --------- | --------------------------------------------------- |
| Object size         | 5 TB      | Log archives, request body captures, large schemas. |
| Storage per bucket  | Unlimited | Long-term analytics overflow destination.           |
| Write rate per key  | 1/sec     | Fine for log batches (write to unique keys).        |
| Buckets per account | 1,000,000 | No concern.                                         |

### Analytics Engine

| Resource          | Limit                        | Implication                                             |
| ----------------- | ---------------------------- | ------------------------------------------------------- |
| Blob fields total | 16 KB per data point         | Enough for request metadata, not full bodies.           |
| Retention         | 90 days                      | Built-in, no management overhead.                       |
| Query             | SQL API (external)           | Cannot query from Workers directly. Dashboard/CLI only. |
| Write             | Fire-and-forget from Workers | Zero latency impact. Perfect for request logs.          |

---

## 2. Cloudflare Request Lifecycle

Understanding what executes **before** and **after** Workers is critical. We cannot control phases outside our Worker, but we must design around them.

### Request Phases (in execution order)

```
Client Request
  │
  ├─ 1. DNS Resolution
  ├─ 2. DDoS L7 Protection          ← CF automatic, before Workers
  ├─ 3. Single Redirects            ← Ruleset Engine
  ├─ 4. URL Normalization           ← Ruleset Engine
  ├─ 5. URL Rewrite Rules           ← Ruleset Engine
  ├─ 6. Waiting Room Rules          ← Internal phase
  ├─ 7. API Shield (early)          ← http_request_api_gateway_early
  ├─ 8. Configuration Rules         ← Ruleset Engine
  ├─ 9. Origin Rules                ← Ruleset Engine
  ├─ 10. DDoS L7 (detailed)        ← Ruleset Engine
  ├─ 11. WAF Custom Rules           ← http_request_firewall_custom
  ├─ 12. WAF Rate Limiting          ← http_ratelimit
  ├─ 13. API Shield (late)          ← http_request_api_gateway_late
  ├─ 14. WAF Managed Rules          ← http_request_firewall_managed
  ├─ 15. Super Bot Fight Mode       ← http_request_sbfm
  ├─ 16. Cloudflare Access          ← Internal phase (JWT validation)
  ├─ 17. Bulk Redirects             ← Ruleset Engine
  ├─ 18. Managed Transforms         ← Internal phase
  ├─ 19. Request Header Transforms  ← http_request_late_transform
  ├─ 20. Cache Rules                ← http_request_cache_settings
  ├─ 21. Snippets                   ← http_request_snippets (5ms, 2MB)
  ├─ 22. Cloud Connector            ← http_request_cloud_connector
  │
  ├─ 23. ████ WORKER EXECUTES ████  ← THIS IS US
  │
  ├─ 24. Cache (on miss → origin)
  │
  └─ Response Phases:
       ├─ 25. Custom Errors
       ├─ 26. Managed Transforms (response)
       ├─ 27. Response Header Transforms
       ├─ 28. WAF Rate Limiting (response-based)
       └─ 29. Compression Rules
```

### Design Implications

| Fact                                                                 | Implication                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **DDoS + WAF run before us**                                         | We get DDoS protection for free. We don't need to implement L3/L4 protection.                                                                                                  |
| **CF Access runs before us**                                         | CF Access JWT validation happens before our Worker. Our admin auth (`auth-admin.ts`) can trust the `Cf-Access-Jwt-Assertion` header for SSO users.                             |
| **API Shield runs before us**                                        | If a customer _also_ uses CF API Shield, its schema validation runs before our Worker. Our schema validation is complementary / for self-hosted use without API Shield.        |
| **We cannot modify the request before WAF**                          | If we want to inject headers (e.g., `X-Request-ID`) for WAF rules to see, we can't. WAF sees the original request. Our transforms only affect what goes upstream.              |
| **Cache sits after us**                                              | We can use the Cache API (`caches.default`) to cache our own upstream responses. This is where response caching lives.                                                         |
| **Response transforms run after us**                                 | CF-level response header transforms can overwrite our headers. Document this for operators.                                                                                    |
| **mTLS client cert info is available on `request.cf.tlsClientAuth`** | CF terminates TLS and populates `tlsClientAuth` with cert details. We don't terminate TLS ourselves — we read what CF gives us. This is how mTLS enforcement works in Workers. |

### The Key Insight: We Can Rebuild the Entire Ruleset Engine in Workers

The Cloudflare Ruleset Engine is, at its core, a sequence of "match expression → action" evaluations across phases. Every phase listed above follows the same pattern:

```
for each rule in phase:
  if rule.expression matches request:
    execute rule.action (block, challenge, rewrite, log, skip, ...)
    if action is terminating: stop
```

**We already have this.** The existing policy engine (`src/policy-engine.ts`) is a superset:

- 16 leaf operators (vs wirefilter's ~10)
- Compound conditions (`any`/`all`/`not` with arbitrary nesting)
- Effect-aware evaluation (allow/deny with vacuous truth for missing fields)
- Regex with ReDoS protection
- Resource + action wildcards

The gap is not the evaluation engine — it's the **breadth of what it inspects and what actions it can take**. Here's the mapping:

| CF Ruleset Engine Phase                                     | Workers Equivalent                                                                                              | Storage                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **WAF Custom Rules** (firewall expressions)                 | Policy engine conditions on request fields (IP, country, ASN, URI, headers, body patterns)                      | Rulesets in DO SQLite                |
| **WAF Rate Limiting**                                       | Workers Rate Limiting binding (pre-auth) + DO token bucket (post-auth)                                          | Binding config + DO in-memory        |
| **WAF Managed Rules** (OWASP CRS)                           | Pattern sets stored in KV, loaded at isolate startup, evaluated by policy engine                                | KV (`ruleset:{id}`)                  |
| **Transform Rules** (request/response headers, URL rewrite) | Transform definitions on routes, evaluated in pipeline steps 9 + 12                                             | DO SQLite (routes table)             |
| **Cache Rules**                                             | `fetch()` with `cf` options for same-zone/non-CF upstreams, Cache API for cross-zone, KV for global consistency | Per-route config in DO SQLite        |
| **Origin Rules** (host header override, SNI override)       | Upstream definition (base_url, host rewrite, TLS config)                                                        | DO SQLite (upstreams table)          |
| **Redirect Rules** (single + bulk)                          | Route matching + redirect action type                                                                           | DO SQLite (routes table)             |
| **API Shield schema validation**                            | Zod-compiled OpenAPI schemas                                                                                    | KV + isolate cache                   |
| **API Shield JWT validation**                               | Web Crypto JWKS verification, claims as condition fields                                                        | KV (JWKS cache) + DO SQLite (config) |
| **Bot Fight Mode / SBFM**                                   | Not replicated (CF does this before us for free)                                                                | N/A                                  |
| **DDoS L7**                                                 | Not replicated (CF does this before us for free)                                                                | N/A                                  |

#### WAF Managed Rules (OWASP CRS) on KV

The OWASP Core Rule Set is ~4,000 regex patterns organized into categories (SQLi, XSS, RCE, LFI, etc.). Each pattern is small. The entire CRS as a JSON blob is ~2 MB — well within KV's 25 MB value limit.

```
Admin uploads/enables ruleset → POST /admin/rulesets
  → Store in KV: "ruleset:{id}" = JSON array of { id, pattern, category, severity, action }
  → Store ruleset index in DO SQLite: enabled rulesets, per-route overrides, exclusions
  → On isolate cold start: load enabled rulesets from KV, compile regexes, cache in memory

Request arrives → after auth, before proxy:
  → For each enabled ruleset:
      → Test request (URI, headers, body) against compiled patterns
      → On match: check action (block, log, challenge-equivalent)
      → Exclusions checked per-rule (path-based, IP-based, etc.)
  → Performance budget: ~5-10ms for full CRS scan (regexes are fast on V8)
```

**Caveats**:

- Body scanning requires reading the body, which consumes the stream. Use `request.clone()` or `body.tee()` to preserve the stream for upstream forwarding.
- The 128 MB isolate memory limit constrains how many compiled regexes we can hold. The full OWASP CRS compiled is ~20-30 MB in V8 — safe, but monitor this.

#### Proof-of-Work Challenge Action (Replaces Managed Challenges)

CF's Managed Challenges (CAPTCHAs, Turnstile) are proprietary and cannot be issued from Workers. But we can build something **better** — an Anubis-style PoW interstitial with client-side telemetry that provides bot detection without third-party dependencies.

This is a proven architecture — already implemented in the caddy-policy-engine (`caddy-compose/PLAN.md`, v2.66.0) with 5-layer bot scoring, 81 e2e tests, and 11 Playwright browser tests. The Workers implementation adapts the same design.

**How it works:**

```
Request → policy engine → challenge rule matches?
  │                              │
  │ NO: continue                 │ YES: check cookie
  │                              │
  │                    ┌─────────┴─────────┐
  │                    │                   │
  │                 Valid cookie         No cookie
  │                    │                   │
  │                Continue             Serve interstitial
  │                                    ┌──────────────────────────────┐
  │                                    │ "Verifying your connection"  │
  │                                    │ SHA-256 PoW (WebCrypto API)  │
  │                                    │ + Client telemetry probes    │
  │                                    └──────────┬───────────────────┘
  │                                               │
  │                                    POST /.well-known/gk-challenge/verify
  │                                               │
  │                                    PoW valid + bot score < 70?
  │                                         │            │
  │                                        YES          NO → 403
  │                                         │
  │                                    Set HMAC-signed cookie
  │                                    302 → original URL
```

**PoW protocol (SHA-256 hashcash):**

1. Server generates random 32-byte nonce + HMAC signature
2. Client iterates `SHA-256(nonce + counter)` until hash has N leading zero bits
3. Difficulty configurable per-rule: 4 bits (~0.5s), 8 bits (~5s), 16 bits (punishment tier)
4. Web Workers for multi-threaded solving, pure-JS fallback
5. Server verifies HMAC (prevents nonce tampering), recomputes hash, issues HMAC-signed cookie

**5-layer bot signal scoring (collected during PoW interstitial):**

| Layer                     | Signals                                                                                                                                                                                    | What It Catches                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **JS environment probes** | `navigator.webdriver`, plugin count, WebGL renderer (SwiftShader = headless), canvas fingerprint, speech voices, `chrome.runtime`, language count, audio fingerprint (OfflineAudioContext) | Raw headless Chrome, Puppeteer, Playwright                                     |
| **Behavioral signals**    | Mouse movement, keyboard events, scroll events, focus/blur, Web Worker timing variance                                                                                                     | Headless browsers that patch webdriver flags but don't simulate human behavior |
| **JA4 TLS fingerprint**   | ALPN, TLS version, cipher/extension order (from `request.cf.botManagement.ja4` on Enterprise, or parsed from `cf-ja4` header if available)                                                 | Mismatched TLS stacks (Python requests claiming to be Chrome)                  |
| **HTTP header analysis**  | `Sec-Fetch-*` headers, `Sec-CH-UA-*` Client Hints, `Accept-Language` structure, header order                                                                                               | Bots that spoof UA but miss modern browser header conventions                  |
| **Spatial inconsistency** | Mobile UA + desktop WebGL signals, Chrome UA + non-browser JA4, geo mismatch between TLS and IP                                                                                            | Sophisticated bots with partial fingerprint spoofing                           |

Score >= 70 → reject even with valid PoW. This means even if a bot can solve the math, the telemetry detects it's not a real browser.

**Cookie design:**

```
Name:     __gk_challenge_{sha256(route_id)[:8]}
Value:    base64url(payload) + "." + base64url(HMAC-SHA256(key, payload))
Payload:  { sub: client_ip, exp: timestamp, dif: difficulty, jti: random_id, bot_score: N }
HttpOnly: true, Secure: true, SameSite: Lax
```

IP-bound by default (prevents cookie replay). Configurable TTL (default 24h, max 7d).

**Implementation in Workers:**

| Component               | Workers Approach                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Interstitial HTML       | Embedded in Worker bundle as static string (~5KB gzipped). No external deps.                                                                 |
| PoW verification        | Web Crypto `crypto.subtle.digest('SHA-256', ...)` — same API client and server.                                                              |
| HMAC cookie signing     | `crypto.subtle.sign('HMAC', ...)` with key from Secrets Store or env.                                                                        |
| Verification endpoint   | `POST /.well-known/gk-challenge/verify` — handled by the Worker before route matching.                                                       |
| Bot score storage       | Analytics Engine data point per challenge event (score, signals, JTI).                                                                       |
| Nonce replay prevention | Short-lived nonces (5 min expiry checked server-side). For distributed replay prevention, store used nonces in KV with `expirationTtl: 300`. |

**Why this is better than CF Managed Challenge / Turnstile:**

1. **No third-party dependency** — no Turnstile iframe, no Google reCAPTCHA, no external JS
2. **Policy-driven** — challenge rules use the same condition engine as everything else (IP, geo, path, UA, time, JWT claims)
3. **Configurable difficulty** — punish known AI crawlers with difficulty 16, gentle challenge for normal traffic at 4
4. **Client telemetry** — 17+ JS probes + behavioral signals give better bot detection than a simple checkbox
5. **Transparent to APIs** — API consumers (curl, SDKs) are never challenged; challenge rules target browser-like traffic via conditions
6. **Open, auditable** — no proprietary black box; operators see exactly what's being checked

#### Building It Incrementally

We don't need to implement every Ruleset Engine phase at once. The policy engine is already the foundation. Each phase is an incremental expansion:

1. **Already done**: IP/country/ASN conditions, time conditions, action/resource authorization
2. **Phase 1 adds**: Schema validation, JWT validation, mTLS conditions, adaptive rate limiting
3. **Phase 2 adds**: Request inspection (URI/header/body patterns via managed rulesets), transforms, caching, routing
4. **Phase 3 adds**: Bot scoring (via Workers AI?), custom challenge pages, log-only mode for gradual rollout

The pipeline execution order in Section 8 shows exactly where each "phase" runs in our Worker.

---

## 3. Storage Architecture

### Current State

```
┌─────────────────────────────────────────────────────────────────┐
│                    Durable Object (SQLite)                       │
│  ┌──────────┬──────────┬─────────────┬────────────────────────┐ │
│  │ API Keys │ S3 Creds │  Upstream   │ Users / Sessions /     │ │
│  │          │          │  Tokens/R2  │ Config                 │ │
│  └──────────┴──────────┴─────────────┴────────────────────────┘ │
│  10 GB max — currently uses ~MB, grows with key count           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         D1 Database                              │
│  ┌──────────────┬───────────┬───────────┬─────────────────────┐ │
│  │ purge_events │ s3_events │ dns_events│ cf_proxy / audit     │ │
│  └──────────────┴───────────┴───────────┴─────────────────────┘ │
│  10 GB hard cap — retention cron keeps it in check              │
└─────────────────────────────────────────────────────────────────┘
```

### Target State

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     Durable Object (SQLite) — "Hot State"                 │
│  ┌──────────┬──────────┬──────────┬────────┬──────────┬────────────────┐ │
│  │ API Keys │ S3 Creds │ Upstream │ Users  │ Routes   │ Circuit        │ │
│  │          │          │ Tokens   │Sessions│ Upstream │ Breaker        │ │
│  │          │          │ R2       │ Config │ Defs     │ State          │ │
│  └──────────┴──────────┴──────────┴────────┴──────────┴────────────────┘ │
│  Rate limiters, request collapsing, JWT claim cache (in-memory)          │
│  10 GB max — route table + schemas stored as references to KV            │
└───────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│                           KV Namespace — "Config Store"                    │
│  ┌──────────────────┬───────────────────┬───────────────────────────────┐ │
│  │ OpenAPI Schemas   │ JWKS Cached Keys  │ Route Table Snapshots         │ │
│  │ (per-upstream)    │ (auto-rotated)    │ (serialized, versioned)       │ │
│  └──────────────────┴───────────────────┴───────────────────────────────┘ │
│  Write-rarely, read-often. 25 MB max value. Global edge cache ~10ms.     │
│  Key pattern: schema:{upstream_id}, jwks:{issuer_hash}, routes:v{N}      │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│                    D1 Database — "Analytics" (10 GB cap)                   │
│  Keep existing tables. Add: gateway_events (generic proxy analytics).     │
│  Aggressive retention (7-30 days). Overflow → R2 archive.                 │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│              Analytics Engine — "High-Volume Telemetry" (new)              │
│  Fire-and-forget. 90-day retention. No storage cap concern.               │
│  Use for: per-request latency, status codes, route hit counts,            │
│  rate limit events, circuit breaker trips, JWT validation failures.       │
│  Query via SQL API from dashboard/CLI — not from Workers.                 │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│                   R2 Bucket — "Archive & Blobs" (new)                     │
│  ┌──────────────────┬──────────────────┬────────────────────────────────┐ │
│  │ D1 Overflow Logs │ Request Body     │ OpenAPI Schema Archive         │ │
│  │ (NDJSON by day)  │ Captures (opt-in)│ (version history)              │ │
│  └──────────────────┴──────────────────┴────────────────────────────────┘ │
│  Unlimited storage. $0.015/GB/mo. No egress fees.                        │
│  Queryable via R2 SQL (Iceberg) for historical analytics.                │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│              Hyperdrive + External Postgres — "Escape Hatch" (optional)    │
│  For deployments that outgrow DO SQLite + D1. Connect to Neon/Supabase/   │
│  self-hosted Postgres via Hyperdrive connection pooling.                   │
│  Only relevant at extreme scale. Not in initial phases.                   │
└────────────────────────────────────────────────────────────────────────────┘
```

### D1 Overflow Strategy

D1's 10 GB cap is real and cannot be increased. Strategy:

1. **Aggressive retention**: Default 7 days for high-volume tables, 30 days for audit. Configurable via `retention_days`.
2. **Analytics Engine for new telemetry**: All new per-request metrics go to Analytics Engine (fire-and-forget, 90-day retention, unlimited cardinality). D1 is only for structured queries the dashboard needs today.
3. **R2 archive cron**: Before deleting old D1 rows, the cron job serializes them as NDJSON and writes to R2. Key pattern: `analytics/{table}/{YYYY-MM-DD}.ndjson.gz`. Queryable later via R2 SQL (Iceberg tables).
4. **Monitor D1 size**: The cron job checks `pragma_page_count * pragma_page_size` and emits a breadcrumb warning at 7 GB, a structured alert at 9 GB.

---

## 4. Phase 1 — Beat API Shield

### 4.1 OpenAPI Schema Validation

**Goal**: Validate inbound requests against an OpenAPI 3.x spec before proxying. Block or log violations.

**Approach — Zod 4**: Zod is already a dependency (`src/routes/admin-schemas.ts`). Zod 4 has native `z.toJSONSchema()` for generation but does NOT have a built-in `fromJSONSchema()`. However, the ecosystem library `zod-from-json-schema` (1M+ weekly downloads) converts arbitrary JSON Schema → Zod validators at runtime. This is the right approach:

1. **No new dependency category** — Zod is already in the bundle. `zod-from-json-schema` is ~15KB, not 500KB+.
2. **ReDoS protection** — We already have `isUnsafeRegex` in the policy engine. Wire it into the schema compilation step to reject schemas with pathological `pattern` values.
3. **Type inference** — Zod gives us TypeScript types from schemas for free, useful in the dashboard/CLI.
4. **Battle-tested** — Zod's validation is mature. Hand-rolling a JSON Schema validator is reinventing what Zod already does.

The one concern is compile-time cost: converting a large OpenAPI spec's JSON Schema fragments to Zod validators is CPU work. This must happen at **admin upload time** (not on the hot path), with the compiled validators serialized and cached.

#### Design

```
Admin uploads schema → POST /admin/schemas/:upstream_id
  → Validate it's parseable OpenAPI 3.x (JSON or YAML→JSON)
  → Extract and pre-compile:
      - Path templates → trie of regex matchers
      - Per-operation: method, required params, param schemas, request body content-type + JSON schema
      - JSON Schema fragments → Zod validators via zod-from-json-schema
      - ReDoS check on all `pattern` fields (reuse existing isUnsafeRegex)
  → Store raw schema in KV: key "schema:{upstream_id}", value = raw JSON
  → Store compiled index in DO SQLite: schema_index table (upstream_id, version, path_count, compiled_at)
  → The compiled form is cached in-memory (isolate-level) with TTL from config
  → On isolate cold start, re-compile from KV (fast — Zod compilation is <10ms for typical schemas)

Request arrives → route matched to upstream → upstream has schema?
  → Load compiled schema from isolate cache (or KV → compile → cache)
  → Match request path against path trie
  → Validate: method allowed? required query params present? Content-Type matches? Body matches Zod schema?
  → On violation:
      - mode = "block" → 400 with CF API-style error body listing violations (Zod error formatting)
      - mode = "log"   → proxy anyway, log violations to Analytics Engine
      - mode = "off"   → skip (default for backward compat)
```

#### What Zod Covers vs What We Still Hand-Roll

| Component                        | Approach                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| JSON Schema body validation      | Zod via `zod-from-json-schema`                                                                      |
| Path parameter extraction/typing | Zod (coerce string params to numbers where schema says `integer`)                                   |
| Query parameter validation       | Zod (build schema from OpenAPI `parameters` where `in: "query"`)                                    |
| Header validation                | Zod (build schema from OpenAPI `parameters` where `in: "header"`)                                   |
| Path template → regex matching   | Hand-roll (trie of compiled path patterns, same pattern as route matching)                          |
| OpenAPI spec parsing             | Hand-roll (walk the spec's `paths` object, extract operations — this is structural, not validation) |
| `pattern` ReDoS screening        | Existing `isUnsafeRegex` from policy engine                                                         |

#### New Bindings

```jsonc
// wrangler.jsonc additions
"kv_namespaces": [
  {
    "binding": "CONFIG_KV",
    "id": "<kv-namespace-id>"
  }
]
```

#### New DO Tables

```sql
CREATE TABLE IF NOT EXISTS schema_index (
  upstream_id TEXT PRIMARY KEY,
  version     INTEGER NOT NULL DEFAULT 1,
  mode        TEXT NOT NULL DEFAULT 'off',  -- 'off' | 'log' | 'block'
  path_count  INTEGER NOT NULL DEFAULT 0,
  compiled_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
```

#### Isolate-Level Schema Cache

```typescript
// src/schema-cache.ts
interface CachedSchema {
  compiled: CompiledOpenApiSchema;
  cachedAt: number;
}

const SCHEMA_CACHE = new Map<string, CachedSchema>();
const SCHEMA_CACHE_TTL_MS = 60_000; // same TTL as key cache

function getCachedSchema(upstreamId: string): CompiledOpenApiSchema | null { ... }
function setCachedSchema(upstreamId: string, compiled: CompiledOpenApiSchema): void { ... }
```

### 4.2 JWT Validation for Proxied Traffic

**Goal**: Validate consumer JWTs on proxied API requests (not just admin auth). Extract claims as policy condition fields.

**Distinction from CF Access JWT validation**: CF Access validates its own JWTs in phase 16 (before Workers). This feature validates _consumer_ JWTs — tokens issued by the customer's own IdP — for API-key-free authentication or as an additional layer on top of API keys.

#### Design

```
Admin creates JWT config → POST /admin/jwt-configs
  {
    "name": "my-idp",
    "issuer": "https://auth.example.com",
    "jwks_uri": "https://auth.example.com/.well-known/jwks.json",
    "audiences": ["https://api.example.com"],
    "algorithms": ["RS256", "ES256"],
    "header_name": "Authorization",      // default
    "header_scheme": "Bearer",           // default
    "claim_mappings": {                  // claims → policy condition fields
      "sub": "jwt.sub",
      "scope": "jwt.scope",
      "email": "jwt.email",
      "groups": "jwt.groups",
      "tenant_id": "jwt.tenant_id"
    },
    "required_claims": {                 // hard requirements (fail-fast, before policy eval)
      "iss": "https://auth.example.com"
    },
    "max_token_age_seconds": 300,        // reject tokens older than this (clock skew tolerance: 30s)
    "cache_ttl_seconds": 3600            // JWKS cache TTL
  }
```

#### JWKS Handling (Hand-Rolled)

No external JWT library. Use Web Crypto API directly:

1. **Fetch JWKS**: `fetch(jwks_uri)` → parse JSON → extract keys by `kid` + `alg`.
2. **Cache in KV**: Key `jwks:{sha256(jwks_uri)}`, value = serialized JWKS. TTL from config (default 1h). KV's global edge cache means subsequent reads in the same region are ~10ms.
3. **Import keys**: `crypto.subtle.importKey("jwk", ...)` → cache `CryptoKey` objects in isolate memory (Map keyed by `kid`). These survive across requests in the same isolate.
4. **Verify signature**: Split JWT, decode header for `kid` + `alg`, `crypto.subtle.verify()`.
5. **Validate claims**: `exp`, `nbf`, `iss`, `aud` — standard checks. `iat` + `max_token_age_seconds` for freshness.
6. **Extract claims**: Map to policy condition fields per `claim_mappings`.

Workers Web Crypto supports: `RSASSA-PKCS1-v1_5` (RS256/384/512), `ECDSA` (ES256/384/512), `HMAC` (HS256/384/512 — requires shared secret, stored encrypted in DO). This covers all standard JWT algorithms.

#### New DO Tables

```sql
CREATE TABLE IF NOT EXISTS jwt_configs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  issuer          TEXT NOT NULL,
  jwks_uri        TEXT,
  audiences       TEXT NOT NULL,            -- JSON array
  algorithms      TEXT NOT NULL,            -- JSON array
  header_name     TEXT NOT NULL DEFAULT 'Authorization',
  header_scheme   TEXT NOT NULL DEFAULT 'Bearer',
  claim_mappings  TEXT NOT NULL DEFAULT '{}', -- JSON object
  required_claims TEXT NOT NULL DEFAULT '{}', -- JSON object
  max_token_age   INTEGER DEFAULT 300,
  cache_ttl       INTEGER DEFAULT 3600,
  hmac_secret     TEXT,                      -- encrypted, for HS* algorithms only
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
```

#### Policy Integration

JWT claims become first-class condition fields:

```json
{
	"version": "2024-01-01",
	"statements": [
		{
			"effect": "allow",
			"actions": ["proxy:*"],
			"resources": ["upstream:my-api"],
			"conditions": [
				{ "field": "jwt.scope", "operator": "contains", "value": "read:data" },
				{ "field": "jwt.tenant_id", "operator": "eq", "value": "tenant-123" }
			]
		}
	]
}
```

### 4.3 mTLS Client Certificate Enforcement

**Goal**: Optionally require/validate client certificates on API requests.

**How mTLS works in Workers**: Cloudflare terminates TLS at the edge. When mTLS is enabled on the zone (via CF dashboard / API Shield), CF requests a client certificate during the TLS handshake. The certificate details are available on `request.cf.tlsClientAuth`:

```typescript
interface TlsClientAuth {
	certIssuerDNLegacy: string;
	certIssuerDN: string;
	certIssuerDNRFC2253: string;
	certSubjectDNLegacy: string;
	certSubjectDN: string;
	certSubjectDNRFC2253: string;
	certNotBefore: string;
	certNotAfter: string;
	certSerial: string;
	certFingerprintSHA1: string;
	certFingerprintSHA256: string;
	certPresented: '0' | '1';
	certVerified: 'SUCCESS' | 'FAILED:reason' | 'NONE';
	certRevoked: '0' | '1';
	certIssuerSerial: string;
	certIssuerSKI: string;
	certSKI: string;
}
```

**Key insight**: We do **not** terminate TLS. We cannot validate certificates ourselves. CF does that. Our job is to:

1. **Enforce that a cert was presented and verified** (`certPresented === "1"` and `certVerified === "SUCCESS"`)
2. **Make cert fields available as policy condition fields** (fingerprint, subject DN, issuer DN, serial)
3. **Optionally pin API keys to specific certificate fingerprints**

#### Design

```sql
-- Add to api_keys table (migration)
ALTER TABLE keys ADD COLUMN cert_fingerprint TEXT;
-- When set, requests using this key MUST present a client cert with this SHA-256 fingerprint
```

New policy condition fields:

- `cert.presented` — "0" or "1"
- `cert.verified` — "SUCCESS" or failure reason
- `cert.fingerprint_sha256` — hex fingerprint
- `cert.subject_dn` — subject distinguished name
- `cert.issuer_dn` — issuer distinguished name
- `cert.serial` — certificate serial number

These are extracted in `request-fields.ts` alongside existing `client_ip`, `client_country`, etc.

#### Prerequisite

mTLS must be enabled on the zone via Cloudflare dashboard or API. This is outside Gatekeeper's control — it's a zone-level setting. Document this clearly. Without it, `tlsClientAuth` will always show `certPresented: "0"`.

### 4.4 Adaptive Rate Limiting

**Goal**: Move beyond static token buckets. Per-endpoint rate limits. Sliding windows. Anomaly detection.

#### Workers Rate Limiting Binding vs Hand-Rolled Token Bucket

Workers has a native Rate Limiting binding (GA since Sept 2025). Compare:

| Factor                  | Workers `ratelimits` Binding                                             | Hand-Rolled Token Bucket (current)          |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| Latency                 | ~0ms (in-isolate cached counter, async background sync)                  | ~1-5ms (DO RPC call)                        |
| Consistency             | Eventually consistent, per-colo                                          | Strongly consistent (single DO)             |
| Configuration           | Static in wrangler.jsonc (`limit` + `period`, period must be 10s or 60s) | Fully dynamic (DO SQLite + config registry) |
| Window type             | Fixed window (10s or 60s)                                                | Token bucket (continuous refill)            |
| Per-key limits          | Yes (pass any string key)                                                | Yes (per-key bucket Map in DO)              |
| Dynamic reconfiguration | No (redeploy to change limits)                                           | Yes (admin API, runtime config registry)    |
| Upstream 429 drain      | Not built-in                                                             | Built-in (drain bucket on upstream 429)     |
| Cost                    | Free (included in Workers)                                               | DO duration charges                         |
| Shared across Workers   | Yes (same `namespace_id`)                                                | No (single DO instance)                     |

**Decision**: Use **both**. The Workers binding is ideal for coarse, high-volume, pre-auth rate limiting (IP-based, DDoS-adjacent). The hand-rolled token bucket remains for post-auth per-key limits with dynamic reconfiguration and upstream 429 awareness. They serve different purposes:

- **Workers binding** → Step 4 in the pipeline (pre-auth, IP-based, cheap)
- **Token bucket in DO** → Step 6 in the pipeline (post-auth, per-key, policy-aware)

```jsonc
// wrangler.jsonc additions
"ratelimits": [
  {
    "name": "GLOBAL_RATE_LIMITER",
    "namespace_id": "1001",
    "simple": { "limit": 1000, "period": 60 }
  },
  {
    "name": "UNAUTHENTICATED_RATE_LIMITER",
    "namespace_id": "1002",
    "simple": { "limit": 100, "period": 60 }
  }
]
```

#### Per-Upstream and Per-Route Rate Limits

Currently rate limits are global (bulk/single/s3/cf-proxy). Add:

```sql
-- New table in DO SQLite
CREATE TABLE IF NOT EXISTS route_rate_limits (
  route_pattern TEXT NOT NULL,          -- e.g. "POST /api/v1/orders"
  upstream_id   TEXT NOT NULL,
  rate          INTEGER NOT NULL,       -- requests per second
  burst         INTEGER NOT NULL,       -- bucket size
  window_type   TEXT NOT NULL DEFAULT 'token_bucket', -- 'token_bucket' | 'sliding_window'
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (route_pattern, upstream_id)
);
```

#### Sliding Window Rate Limiter

The existing `TokenBucket` is great for smoothing. Add a `SlidingWindowCounter` for cases where "N requests in M seconds" semantics are needed (matches what most API consumers expect):

```typescript
// src/sliding-window.ts — hand-rolled, zero deps
// Uses two fixed windows and interpolates. O(1) memory per key.
// Classic sliding window log is O(N) — too expensive at high volume.
//
// Algorithm:
//   previous_window_count * overlap_fraction + current_window_count
//   If this exceeds the limit, reject.
//
// Storage: per key, store (current_count, previous_count, window_start_ms)
// Fits in DO SQLite for persistent state, or in-memory Map for ephemeral.
```

#### Anomaly Detection (Lightweight)

Not ML. Simple statistical approach:

1. Track per-endpoint p50/p99 request rates in a circular buffer (in-memory, per isolate).
2. When current rate exceeds 3x the p99 over the last hour, flag as anomalous.
3. Anomaly can trigger: log (default), rate-limit override, or block.
4. Statistics are periodically flushed to Analytics Engine for dashboard display.

This is strictly better than CF API Shield's "volumetric abuse detection" because it's policy-driven — operators write conditions like `where request_rate gt 3x_baseline`.

---

## 5. Phase 2 — Enter Kong Territory

### 5.1 Generic HTTP Reverse Proxy

**Gap is narrower than it appears.** Gatekeeper is already a full reverse proxy — `proxyToCfApi()` in `src/cf/proxy-helpers.ts` does body forwarding, header manipulation, response building, and rate-limit header passthrough. `forwardToR2()` in `src/s3/sig-v4-sign.ts` does streaming body forwarding with header stripping and re-signing. The `buildProxyResponse()` helper already copies upstream headers selectively.

What's missing is not the proxy mechanics — it's that every upstream is hardcoded:

- `proxyToCfApi()` always builds URLs from `CF_API_BASE` (`https://api.cloudflare.com/client/v4`)
- `forwardToR2()` always targets R2 endpoints
- Auth is always swapped to a stored upstream token (Bearer for CF API, Sig V4 for R2)

The actual work is: **make the upstream URL, auth injection, and header policy configurable per-route** instead of hardcoded. The existing `handleCfServiceRequest()` pattern (auth → rate limit → resolve upstream → proxy → analytics) is exactly the pipeline we need — it just needs to be parameterized.

#### Upstream Definition

```sql
CREATE TABLE IF NOT EXISTS upstreams (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  base_url        TEXT NOT NULL,          -- e.g. "https://api.internal.example.com"
  timeout_ms      INTEGER DEFAULT 30000,
  retries         INTEGER DEFAULT 0,      -- 0 = no retry
  retry_on        TEXT DEFAULT '502,503,504', -- status codes to retry on
  strip_prefix    TEXT,                    -- strip this prefix from path before forwarding
  add_prefix      TEXT,                    -- add this prefix to path before forwarding
  tls_verify      INTEGER DEFAULT 1,      -- verify upstream TLS (1=yes, 0=no)
  mtls_cert_id    TEXT,                    -- mTLS cert binding to present TO upstream
  health_check    TEXT,                    -- JSON: { path, interval_sec, threshold }
  circuit_breaker TEXT,                    -- JSON: { error_threshold_pct, window_sec, cooldown_sec }
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  created_by      TEXT
);
```

#### Route Definition

```sql
CREATE TABLE IF NOT EXISTS routes (
  id              TEXT PRIMARY KEY,
  upstream_id     TEXT NOT NULL REFERENCES upstreams(id),
  priority        INTEGER NOT NULL DEFAULT 0,  -- higher = matched first
  methods         TEXT,                         -- JSON array: ["GET","POST"] or null = all
  path_pattern    TEXT NOT NULL,                -- "/api/v1/*", "/exact/path", regex: "~^/users/\\d+"
  hosts           TEXT,                         -- JSON array: ["api.example.com"] or null = all
  headers         TEXT,                         -- JSON: { "X-Version": "2" } match requirements
  schema_id       TEXT,                         -- optional OpenAPI schema for validation
  jwt_config_id   TEXT,                         -- optional JWT validation config
  rate_limit_id   TEXT,                         -- optional per-route rate limit
  auth_mode       TEXT DEFAULT 'api_key',       -- 'api_key' | 'jwt' | 'api_key_or_jwt' | 'none' | 'passthrough'
  transform       TEXT,                         -- JSON: request/response transforms (see 5.2)
  enabled         INTEGER DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  created_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(priority DESC);
CREATE INDEX IF NOT EXISTS idx_routes_upstream ON routes(upstream_id);
```

#### Route Matching

```
Request: GET /api/v1/users/123 Host: api.example.com

1. Load route table (isolate-cached, TTL from config, invalidated on admin write)
2. Filter by host (if route has hosts constraint)
3. Filter by method (if route has methods constraint)
4. Filter by header match (if route has headers constraint)
5. Match path:
   - Exact: "/api/v1/users/123" === route.path_pattern
   - Prefix: "/api/v1/*" — route.path_pattern ends with "*"
   - Regex: "~^/api/v1/users/\\d+$" — prefix "~" = regex
6. Among matches, highest priority wins. Ties broken by specificity (exact > prefix > regex).
7. No match → 404 (or fall through to existing CF API proxy routes for backward compat)
```

Route table is stored in DO SQLite but **snapshotted to KV** on every admin mutation. Workers read from KV on cache miss (global edge, ~10ms). The isolate-level `Map` cache is the hot path (<1ms).

#### Proxy Execution

```typescript
// src/proxy/handler.ts — the core proxy loop
async function proxyRequest(request: Request, route: Route, upstream: Upstream, env: Env, ctx: ExecutionContext): Promise<Response> {
	// 1. Circuit breaker check (in-memory state in DO, queried via RPC)
	// 2. Rate limit check (per-route or per-upstream bucket)
	// 3. Request transforms (headers, path rewrite)
	// 4. Build upstream URL
	// 5. Forward request (streaming body — do NOT buffer)
	// 6. Response transforms (headers)
	// 7. Record analytics (waitUntil)
	// 8. Update circuit breaker state (waitUntil)
	// 9. Return response
}
```

**Body streaming**: Use `request.body` (ReadableStream) directly. Never buffer the full body in memory. This respects the 128 MB isolate memory limit and supports large uploads.

#### mTLS to Upstream

Workers support mTLS certificate bindings for outbound requests. When an upstream requires client auth:

```jsonc
// wrangler.jsonc
"mtls_certificates": [
  {
    "binding": "UPSTREAM_CERT_1",
    "certificate_id": "<cert-id-from-wrangler-mtls-certificate-upload>"
  }
]
```

The upstream definition references a cert binding name. At proxy time:

```typescript
// Instead of global fetch():
const response = await env.UPSTREAM_CERT_1.fetch(upstreamUrl, { ...options });
```

**Limitation**: mTLS cert bindings are static in wrangler config. They cannot be dynamically loaded per-request. If you need N different client certs for N upstreams, you need N bindings declared in wrangler.jsonc. This is manageable for <50 upstreams. At scale, use a single client cert trusted by all upstreams, or terminate mTLS at a shared origin gateway.

### 5.2 Request/Response Transformation

**Goal**: Header injection, header stripping, body rewriting, path rewriting, correlation IDs.

#### Transform Definition (JSON)

```json
{
	"request": {
		"headers": {
			"add": {
				"X-Request-ID": "${request_id}",
				"X-Forwarded-For": "${client_ip}",
				"X-Gateway-Version": "gatekeeper/1.0"
			},
			"remove": ["X-Internal-Only", "Cookie"],
			"rename": { "Authorization": "X-Original-Auth" }
		},
		"path": {
			"strip_prefix": "/api/v1",
			"add_prefix": "/internal"
		}
	},
	"response": {
		"headers": {
			"add": {
				"X-Request-ID": "${request_id}",
				"X-Response-Time": "${upstream_latency_ms}ms",
				"X-Powered-By": "Gatekeeper"
			},
			"remove": ["Server", "X-Powered-By-Origin"],
			"rename": {}
		}
	}
}
```

#### Template Variables

Available in transform expressions:

| Variable                 | Source                          | Example                                |
| ------------------------ | ------------------------------- | -------------------------------------- |
| `${request_id}`          | Generated per-request (UUID v4) | `550e8400-e29b-41d4-a716-446655440000` |
| `${client_ip}`           | `cf-connecting-ip` header       | `203.0.113.50`                         |
| `${client_country}`      | `cf-ipcountry` header           | `US`                                   |
| `${client_asn}`          | `request.cf.asn`                | `13335`                                |
| `${upstream_latency_ms}` | Measured (response only)        | `42`                                   |
| `${timestamp_iso}`       | Current time                    | `2026-03-27T12:00:00Z`                 |
| `${jwt.CLAIM}`           | JWT claim (if JWT auth)         | `${jwt.sub}` → `user-123`              |
| `${key.name}`            | API key name (if key auth)      | `prod-readonly`                        |
| `${key.id}`              | API key ID (if key auth)        | `gk_abc123`                            |
| `${route.id}`            | Matched route ID                | `route_xyz`                            |

#### Implementation

Transforms are simple string operations — no eval, no template engines. Variables are resolved via a `Map<string, string>` lookup. This is <0.1ms overhead.

### 5.3 Circuit Breaker

**Goal**: Detect upstream failures and short-circuit requests to failing backends.

#### State Machine

```
CLOSED ──(error_rate > threshold)──→ OPEN
  ↑                                    │
  │                              (cooldown expires)
  │                                    ↓
  └───(success)───── HALF_OPEN ←───────┘
                      │
                (failure) → OPEN
```

#### Storage

Circuit breaker state is **in-memory in the DO** (not SQLite). It's ephemeral — if the DO is evicted, the circuit resets to CLOSED. This is the correct behavior: if the DO was idle long enough to be evicted, the upstream has likely recovered.

```typescript
// src/circuit-breaker.ts
interface CircuitState {
  status: 'closed' | 'open' | 'half_open';
  failure_count: number;
  success_count: number;
  last_failure_at: number;
  opened_at: number;
  window_start: number;
  total_in_window: number;
  failures_in_window: number;
}

// Per-upstream circuit state, keyed by upstream_id
private circuits = new Map<string, CircuitState>();
```

#### Config (per-upstream)

```json
{
	"error_threshold_pct": 50,
	"window_sec": 60,
	"cooldown_sec": 30,
	"min_requests": 10
}
```

`min_requests` prevents the circuit from tripping on the first error when traffic is low.

### 5.4 Developer Self-Service Portal

**Goal**: Let API consumers sign up, browse APIs, request keys, view their usage. Kong charges $35k+/yr for this.

#### Architecture

New Astro pages under `/portal/*`. Separate from the admin dashboard (`/dashboard/*`).

```
/portal/                    → API catalog (list of published upstreams/routes)
/portal/docs/:upstream_id   → Auto-generated API docs from OpenAPI schema
/portal/signup              → Self-service registration
/portal/login               → Consumer login (separate from admin login)
/portal/keys                → My API keys (request, view, regenerate)
/portal/usage               → My usage analytics
```

#### Consumer vs Admin

|                | Admin                            | Consumer                                              |
| -------------- | -------------------------------- | ----------------------------------------------------- |
| Auth           | Access JWT / Admin Key / Session | Email+password / OAuth (separate user pool)           |
| Key management | Full CRUD on all keys            | Request keys (require admin approval or auto-approve) |
| Analytics      | All keys, all upstreams          | Only own keys                                         |
| Config         | Full gateway config              | None                                                  |
| Routes         | Full CRUD                        | Read-only catalog                                     |

#### New DO Tables

```sql
CREATE TABLE IF NOT EXISTS consumers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  name            TEXT,
  organization    TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended' | 'pending_approval'
  tier            TEXT NOT NULL DEFAULT 'free',     -- links to consumer_groups
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS consumer_groups (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,             -- 'free', 'pro', 'enterprise'
  rate_limit      TEXT,                             -- JSON: rate limit overrides for this tier
  max_keys        INTEGER DEFAULT 5,
  allowed_upstreams TEXT,                           -- JSON array of upstream IDs, null = all
  auto_approve    INTEGER DEFAULT 0,                -- 1 = keys are auto-approved
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Link consumers to their API keys via created_by field on existing keys table
-- Add: consumer_id column to keys table
```

### 5.5 Health Checks

**Goal**: Periodically probe upstreams and take unhealthy ones out of rotation.

#### Implementation via DO Alarms

Workers cannot run background loops. Use Durable Object alarms:

```typescript
// In the Gatekeeper DO:
async alarm(): Promise<void> {
  const upstreams = this.loadUpstreamsWithHealthChecks();
  for (const upstream of upstreams) {
    try {
      const res = await fetch(upstream.base_url + upstream.health_check.path, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      this.updateHealthStatus(upstream.id, res.ok);
    } catch {
      this.updateHealthStatus(upstream.id, false);
    }
  }
  // Re-schedule alarm for next interval
  const minInterval = Math.min(...upstreams.map(u => u.health_check.interval_sec));
  await this.ctx.storage.setAlarm(Date.now() + minInterval * 1000);
}
```

**Limitation**: 6 simultaneous outgoing connections per request/alarm invocation. If you have 20 upstreams, health checks run in batches of 6. This adds latency to the alarm but is fine since health checks are not on the hot path.

**Health state**: Stored in-memory on the DO (same as circuit breaker). Exposed via RPC for the Worker to check before proxying. Unhealthy upstreams return 503 immediately.

---

## 6. Phase 3 — Platform Play

### 6.1 Plugin / Middleware System

**Goal**: Let operators extend the gateway pipeline with custom logic without forking.

#### Approach: Stored JS Functions

Plugins are JavaScript/TypeScript functions stored in KV and evaluated at request time. Not full Workers — they run inside the existing Worker isolate via `new Function()` (not `eval` — `Function` constructor is allowed in Workers with the `unsafe-eval` compatibility flag).

**Alternative (safer, no `unsafe-eval`)**: Plugins are defined as a sequence of built-in transforms and conditions. A declarative plugin DSL rather than arbitrary code:

```json
{
	"name": "add-api-version-header",
	"phase": "on_request",
	"conditions": [{ "field": "request.path", "operator": "starts_with", "value": "/api/" }],
	"actions": [
		{ "type": "set_header", "name": "X-API-Version", "value": "2024-01-01" },
		{ "type": "set_header", "name": "X-Client-Tier", "value": "${consumer.tier}" }
	]
}
```

This is less powerful than arbitrary code but avoids the security nightmare of executing user-provided JS. It covers 90% of real-world plugin use cases (header manipulation, conditional routing, request tagging).

**Escape hatch for full programmability**: Service bindings. Deploy a separate Worker with custom logic, bind it as a service binding, and call it from a plugin step. This keeps the security boundary clean.

### 6.2 WebSocket Proxying

Workers + Durable Objects support WebSocket hibernation. Adding WebSocket pass-through:

```typescript
// Route config: { "protocol": "websocket" }
// On matching route:
//   1. Accept WebSocket upgrade from client
//   2. Open WebSocket to upstream
//   3. Pipe messages bidirectionally via DO (for connection tracking)
//   4. Hibernate when idle (zero cost)
```

**Constraint**: WebSocket connections must be accepted by a Durable Object (for hibernation). The Worker `fetch` handler upgrades the connection and hands it to the DO. The DO manages the upstream WebSocket connection.

### 6.3 Log Shipping / Webhooks

**Goal**: Export events to external systems.

#### Approach 1: Queues + Consumer Worker

```jsonc
// wrangler.jsonc
"queues": {
  "producers": [
    { "binding": "LOG_QUEUE", "queue": "gatekeeper-logs" }
  ]
}
```

The gateway enqueues log events. A separate consumer Worker (or the same Worker with a `queue` handler) batches and ships to external destinations:

- **Webhook**: POST JSON batches to a configurable URL
- **R2**: Write NDJSON batches (already planned for D1 overflow)
- **Datadog/Splunk**: Format as the vendor's expected JSON shape and POST

Queue limits: 5,000 messages/sec per queue, 128 KB per message, 25 GB backlog. More than sufficient.

#### Approach 2: Tail Worker

Deploy a Tail Worker that receives all `console.log` output from the main Worker. Since we already emit structured breadcrumb logs, the Tail Worker can parse and forward them. Zero changes to the main Worker.

### 6.4 Traffic Splitting / Canary

**Goal**: Route X% of traffic to upstream A, Y% to upstream B.

#### Implementation

```sql
-- Add to routes table
ALTER TABLE routes ADD COLUMN traffic_split TEXT;
-- JSON: [{ "upstream_id": "a", "weight": 90 }, { "upstream_id": "b", "weight": 10 }]
```

Weighted random selection using `crypto.getRandomValues()`. Sticky sessions optional (hash `client_ip` or a cookie value to ensure the same client hits the same upstream).

### 6.5 Consumer Groups

**Goal**: Group API keys into tiers with shared rate limits and policies.

Already sketched in 5.4 (`consumer_groups` table). The consumer group's rate limit overrides apply to all keys in the group. If a key has its own override, key-level takes precedence (same 3-layer resolution pattern as config registry).

### 6.6 Response Caching

**Goal**: Cache upstream responses to reduce latency and upstream load.

Three layers available (see Appendix A → Caching Strategy for the full decision tree):

#### Layer 1: `fetch()` with `cf` options (preferred for non-CF upstreams)

For upstreams that are not orange-clouded on another CF zone (i.e., most generic proxy targets), this is the best option. It uses the CDN cache natively, supports Tiered Cache and Cache Reserve, and costs nothing.

```typescript
const response = await fetch(upstreamUrl, {
	method: request.method,
	headers: upstreamHeaders,
	body: request.body,
	cf: {
		cacheTtl: route.cache_config.ttl_sec,
		cacheEverything: true,
		cacheKey: buildCacheKey(request, route), // include route + vary headers + JWT claims
		cacheTtlByStatus: {
			'200-299': route.cache_config.ttl_sec,
			'404': route.cache_config.not_found_ttl ?? 60,
			'500-599': 0,
		},
	},
});
```

**Requires** `compatibility_date >= "2025-04-02"` (or `cache_api_compat_flags` + `cache_api_request_cf_overrides_cache_rules` flags) so Worker cache settings override zone Cache Rules. We already have `compatibility_date: "2026-03-01"`.

#### Layer 2: Cache API (for cross-zone or custom cache key needs)

When the upstream is on another CF zone (orange-clouded), `cf` options are silently ignored. Use `cache.put()` with `body.tee()` to stream the response to client and cache simultaneously:

```typescript
const cache = caches.default;
const cacheKey = new Request(buildCacheKey(request, route), request);

const cached = await cache.match(cacheKey);
if (cached) return cached;

const upstream = await fetch(upstreamUrl, { ... });
if (!upstream.ok || !upstream.body) return upstream;

// tee() avoids buffering the entire body (respects 128 MB memory limit)
const [streamForClient, streamForCache] = upstream.body.tee();

const headers = new Headers(upstream.headers);
headers.delete('Set-Cookie'); // Cache API rejects Set-Cookie
headers.set('Cache-Control', `public, max-age=${route.cache_config.ttl_sec}`);

const responseForCache = new Response(streamForCache, { status: upstream.status, headers });
ctx.waitUntil(cache.put(cacheKey, responseForCache));

return new Response(streamForClient, { status: upstream.status, headers });
```

Per-colo only. No Tiered Cache. `cache.delete()` is per-colo. For most API gateway use cases this is acceptable.

#### Layer 3: KV (for global consistency)

Rarely needed for response caching. Use for: config, schemas, JWKS — not upstream responses. See Appendix A.

#### Cache Configuration (per-route)

```json
{
	"cache_config": {
		"enabled": true,
		"ttl_sec": 3600,
		"not_found_ttl": 60,
		"vary_by": ["Authorization", "Accept-Language"],
		"include_query_params": true,
		"include_jwt_claims": ["tenant_id"],
		"bypass_on_cookie": "session_id",
		"stale_while_revalidate": 60
	}
}
```

Cache keys are built from: `route_id + method + path + sorted(vary_by headers) + sorted(query params if enabled) + JWT claims`. This ensures different tenants/users get separate cache entries when needed.

---

## 7. Binding Changes

### Current wrangler.jsonc Bindings

```jsonc
{
  "durable_objects": { "bindings": [{ "class_name": "Gatekeeper", "name": "GATEKEEPER" }] },
  "d1_databases": [{ "binding": "ANALYTICS_DB", ... }],
  "assets": { "binding": "ASSETS", ... }
}
```

### Phase 1 Additions

```jsonc
{
	"kv_namespaces": [
		{
			"binding": "CONFIG_KV",
			"id": "<id>",
			// Stores: OpenAPI schemas, JWKS cached keys, route table snapshots,
			// WAF managed rulesets (OWASP CRS), IP reputation lists
		},
	],
	"ratelimits": [
		{
			"name": "GLOBAL_RATE_LIMITER",
			"namespace_id": "1001",
			"simple": { "limit": 1000, "period": 60 },
			// Pre-auth IP rate limiting. Zero latency (in-isolate cached counter).
		},
		{
			"name": "UNAUTHENTICATED_RATE_LIMITER",
			"namespace_id": "1002",
			"simple": { "limit": 100, "period": 60 },
			// Stricter limit for unauthenticated traffic.
		},
	],
}
```

### Phase 2 Additions

```jsonc
{
	"analytics_engine_datasets": [
		{
			"binding": "GATEWAY_AE",
			"dataset": "gatekeeper_events",
			// High-volume per-request telemetry. 90-day retention. SQL API queryable.
		},
	],
	"r2_buckets": [
		{
			"binding": "ARCHIVE_BUCKET",
			"bucket_name": "gatekeeper-archive",
			// D1 overflow, request body captures, schema version history
		},
	],
	"mtls_certificates": [
		{
			"binding": "UPSTREAM_CERT_DEFAULT",
			"certificate_id": "<cert-id>",
			// Client cert for mTLS to upstreams. Add more as needed.
		},
	],
}
```

### Phase 3 Additions

```jsonc
{
	"queues": {
		"producers": [
			{
				"binding": "LOG_QUEUE",
				"queue": "gatekeeper-logs",
				// Log shipping. Consumer can be same Worker or separate.
			},
		],
	},
	// Optional:
	// "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id>" }]
	// Only if operator needs external Postgres for analytics at extreme scale.
}
```

### Updated `assets.run_worker_first`

```jsonc
"run_worker_first": [
  "/v1/*", "/admin/*", "/auth/*", "/health", "/logout",
  "/s3", "/s3/*", "/cf/*",
  "/proxy/*",     // new: generic proxy routes
  "/portal/api/*" // new: portal API endpoints (not static pages)
]
```

---

## 8. Pipeline Execution Order

This is the internal execution order within the Worker for a proxied request. This is our equivalent of Kong's plugin execution phases.

```
Request arrives at Worker
│
├─ 0. CHALLENGE VERIFICATION (before all other steps)
│     POST /.well-known/gk-challenge/verify → verify PoW, issue cookie, 302 redirect
│     This path is exempt from all other pipeline steps.
│
├─ 1. SECURITY HEADERS middleware (existing)
│     Add X-Content-Type-Options, X-Frame-Options, etc.
│
├─ 2. ROUTE MATCHING
│     Match request to route table (isolate cache → KV fallback)
│     If no route match → fall through to existing CF API / purge / S3 routes
│
├─ 3. EARLY REJECT
│     Circuit breaker check (is upstream OPEN?)
│     Health check status (is upstream healthy?)
│     If either fails → 503 Service Unavailable (skip all downstream phases)
│
├─ 4. RATE LIMITING (pre-auth, zero latency)
│     Workers Rate Limiting binding: env.GLOBAL_RATE_LIMITER.limit({ key: client_ip })
│     env.UNAUTHENTICATED_RATE_LIMITER.limit({ key: client_ip + route })
│     If exceeded → 429 Too Many Requests
│
├─ 5. PoW CHALLENGE (browser traffic only)
│     If route has challenge rule and request matches conditions:
│       Check for valid HMAC-signed challenge cookie
│       Cookie present + valid → continue (sub-microsecond HMAC check)
│       Cookie absent/expired → serve interstitial HTML with PoW puzzle
│       (terminates pipeline — client must solve and retry)
│
├─ 6. WAF INSPECTION (managed rulesets)
│     If route/upstream has WAF rulesets enabled:
│       Load compiled OWASP CRS patterns from isolate cache (KV fallback)
│       Scan URI, headers, body (tee() body to preserve stream)
│       Anomaly scoring: sum matched rule severities
│       If score > threshold → block (403) or log
│       ~5-10ms for full CRS scan
│
├─ 7. AUTHENTICATION
│     Based on route.auth_mode:
│       'api_key'       → Extract Bearer token, DO lookup, policy resolution
│       'jwt'           → Extract JWT, JWKS fetch/cache (KV), verify (Web Crypto), extract claims
│       'api_key_or_jwt'→ Try JWT first (no DO call), fall back to API key
│       'none'          → Skip auth (public route)
│       'passthrough'   → Forward auth headers to upstream, don't validate
│     mTLS cert check: request.cf.tlsClientAuth.certPresented + certFingerprintSHA256
│
├─ 8. RATE LIMITING (post-auth)
│     Per-key rate limit: DO token bucket (existing)
│     Per-consumer-group rate limit
│     If exceeded → 429
│
├─ 9. AUTHORIZATION (Policy Engine)
│     Build RequestContext with all fields:
│       route fields, JWT claims (jwt.sub, jwt.scope, jwt.tenant_id),
│       cert fields (cert.fingerprint_sha256, cert.subject_dn),
│       request fields (client_ip, client_country, client_asn, time.*),
│       request.cf fields (tls.version, tls.ja4, bot.score, bot.verified,
│         geo.city, geo.region, geo.continent, geo.is_eu, http.protocol),
│       key fields (key.name, key.id)
│     Evaluate policy document (existing engine, no changes needed)
│     If denied → 403 Forbidden
│
├─ 10. SCHEMA VALIDATION
│      If route has schema_id and mode != 'off':
│        Load Zod-compiled schema (isolate cache → KV)
│        Validate path, method, query params, headers, body
│        If mode='block' and violations → 400 Bad Request (Zod error formatting)
│        If mode='log' → continue, record violations to Analytics Engine
│
├─ 11. REQUEST TRANSFORMS
│      Apply route.transform.request:
│        Header add/remove/rename (template variable resolution)
│        Path rewrite (strip_prefix, add_prefix)
│        Inject X-Request-ID (crypto.randomUUID())
│
├─ 12. REQUEST COLLAPSING (optional, for GET/HEAD)
│      If route.collapse_identical_requests:
│        Isolate-level → DO-level dedup (existing RequestCollapser)
│
├─ 13. PROXY + RESPONSE CACHING
│      Build upstream Request:
│        URL = upstream.base_url + transformed path
│        Headers = transformed headers
│        Body = streaming passthrough (never buffered)
│        Timeout = upstream.timeout_ms via AbortSignal.timeout()
│      If upstream.mtls_cert_id → use env[cert_binding].fetch()
│      If route.cache_config:
│        Non-CF upstream → fetch() with cf: { cacheTtl, cacheEverything, cacheKey }
│          (natively uses CDN cache, Tiered Cache, Cache Reserve — zero extra code)
│        Cross-zone upstream → Cache API with body.tee()
│      Else → global fetch()
│
├─ 14. RESPONSE TRANSFORMS
│      Apply route.transform.response:
│        Header add/remove/rename
│        Inject X-Request-ID, X-Response-Time (${Date.now() - start}ms)
│
├─ 15. ANALYTICS (fire-and-forget)
│      ctx.waitUntil():
│        D1: structured event row (existing pattern)
│        Analytics Engine: per-request telemetry (latency, status, route, cache hit/miss,
│          WAF score, bot score, rate limit remaining, challenge state)
│        Queue: log event (if log shipping enabled)
│        Circuit breaker state update (success/failure in DO)
│
└─ 16. RETURN RESPONSE
       Stream response body to client
```

### Comparison to Kong's Plugin Phases

| Kong Phase      | Gatekeeper Equivalent                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `certificate`   | N/A (CF handles TLS termination; cert fields available as policy inputs) |
| `rewrite`       | Step 2 (route matching) + Step 11 (request transforms)                   |
| `access`        | Steps 4-10 (RL, challenge, WAF, auth, authz, schema)                     |
| `header_filter` | Step 14 (response transforms)                                            |
| `body_filter`   | Not implemented (streaming, no modification — use service binding)       |
| `log`           | Step 15 (D1 + Analytics Engine + Queues, fire-and-forget)                |

### Comparison to CF Ruleset Engine Phases

| CF Phase                          | Gatekeeper Step               | Notes                                                       |
| --------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `ddos_l7`                         | N/A                           | CF handles this before us (free)                            |
| `http_request_firewall_custom`    | Step 9 (policy engine)        | Our 16-operator engine is more expressive than wirefilter   |
| `http_ratelimit`                  | Steps 4 + 8                   | Workers RL binding (pre-auth) + DO token bucket (post-auth) |
| `http_request_api_gateway_early`  | Step 10 (schema validation)   | Zod-compiled OpenAPI validation                             |
| `http_request_firewall_managed`   | Step 6 (WAF inspection)       | OWASP CRS from KV, anomaly scoring                          |
| `http_request_sbfm`               | Step 5 (PoW challenge)        | Better: 5-layer telemetry vs checkbox                       |
| Cloudflare Access                 | Step 7 (authentication)       | JWT + API key + mTLS + OAuth                                |
| `http_request_late_transform`     | Step 11 (request transforms)  | Template variables, path rewrite                            |
| `http_request_cache_settings`     | Step 13 (proxy + caching)     | `cf` options or Cache API                                   |
| `http_response_headers_transform` | Step 14 (response transforms) | Header add/remove/rename                                    |

---

## 9. Migration Strategy

### Backward Compatibility

All existing routes remain unchanged:

- `POST /v1/zones/:zoneId/purge_cache` — purge proxy
- `/cf/*` — CF API proxy
- `/s3/*` — S3/R2 proxy
- `/admin/*` — admin API
- `/auth/*` — auth endpoints
- `/dashboard/*` — admin dashboard

New generic proxy routes live under `/proxy/*` (or the gateway can be configured to match on host headers for a cleaner UX where `api.example.com/users` goes through the gateway without a prefix).

### Phase Ordering

```
Phase 1 (4-6 weeks) — Beat API Shield:
  1.1  KV binding + schema storage infrastructure
  1.2  Workers Rate Limiting binding (pre-auth IP rate limiting)
  1.3  Expand request-fields.ts: all request.cf properties → policy condition fields
         (tls.version, tls.ja4, bot.score, bot.verified, geo.city, geo.region,
          geo.continent, geo.is_eu, http.protocol, as.organization, cert.*)
  1.4  OpenAPI schema compilation (Zod 4 + zod-from-json-schema)
  1.5  Schema validation middleware (log mode first, then block)
  1.6  JWT validation (JWKS fetch → KV cache, Web Crypto verify, claim extraction)
  1.7  JWT claims as policy condition fields (jwt.sub, jwt.scope, jwt.email, etc.)
  1.8  mTLS cert fields from request.cf.tlsClientAuth → policy conditions
  1.9  Cert fingerprint pinning on API keys
  1.10 Sliding window rate limiter
  1.11 Per-route rate limits (DO SQLite + config)

Phase 2 (8-12 weeks) — Enter Kong Territory:
  2.1  Upstream + route tables in DO SQLite
  2.2  Route table KV snapshot + isolate cache
  2.3  Route matching engine (exact, prefix, regex)
  2.4  Generic proxy handler (parameterize existing proxyToCfApi for any upstream)
         Streaming body, AbortSignal.timeout(), retries, mTLS cert bindings
  2.5  Response caching: fetch() with cf options for non-CF, Cache API + tee() for cross-zone
  2.6  Request/response transforms (template variables, path rewrite)
  2.7  Circuit breaker (in-memory state machine in DO)
  2.8  Health checks via DO alarms (batched, 6-connection limit per alarm)
  2.9  WAF managed rulesets: OWASP CRS patterns on KV, anomaly scoring in pipeline
  2.10 Analytics Engine binding for per-request telemetry
  2.11 R2 binding for D1 overflow archive
  2.12 Developer portal (consumer tables, self-service pages)
  2.13 mTLS to upstream (mtls_certificates binding)

Phase 3 (ongoing) — Platform Play:
  3.1  PoW challenge interstitial (SHA-256 hashcash + 5-layer bot telemetry)
  3.2  Declarative plugin DSL (condition + action, no eval)
  3.3  WebSocket proxying via DO hibernation
  3.4  Queue binding for log shipping (+ Tail Worker alternative)
  3.5  Traffic splitting / canary deployments
  3.6  Consumer groups with tiered rate limits
  3.7  Workflows binding for durable admin operations (key rotation, schema rollout)
  3.8  Workers AI binding for optional ML-based anomaly detection
  3.9  Secrets Store binding for account-level credential management
  3.10 Hyperdrive integration (optional external Postgres escape hatch)
```

### What NOT to Build

- **Service mesh / sidecar**: Workers run at the edge, not alongside services. Service-to-service auth is better solved by mTLS + API keys through the gateway.
- **GraphQL-specific features**: GraphQL introspection, per-query cost analysis, and depth limiting are niche. If needed later, they're a plugin — not core.
- **gRPC proxying**: Workers cannot proxy raw HTTP/2 frames with gRPC trailers. gRPC-Web (over HTTP/1.1) works, but native gRPC does not. Don't promise it.
- **Response body transformation**: Buffering and rewriting response bodies breaks streaming and risks OOM at 128 MB. Header transforms only. If someone needs body rewriting, they should do it in the upstream or a service-bound Worker.
- **Full JSON Schema Draft 2020-12**: Zod via `zod-from-json-schema` covers the standard subset. Edge cases (`if/then/else`, `patternProperties`, `unevaluatedProperties`) can be added incrementally if real schemas need them.
- **CAPTCHAs / Turnstile**: PoW challenge with client telemetry is strictly better for API gateways. CAPTCHAs are UX-hostile and useless for API traffic.

---

## Appendix A: Every Nook and Cranny — Full Platform Inventory

Every Workers binding and runtime API, mapped to how Gatekeeper can exploit it. Nothing left on the table.

### Bindings We Already Use

| Binding                                                       | Current Use                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Durable Objects** (`GATEKEEPER`)                            | IAM, rate limiting, request collapsing, config, users, sessions, upstream tokens, upstream R2 |
| **D1** (`ANALYTICS_DB`)                                       | Analytics, audit log                                                                          |
| **Static Assets** (`ASSETS`)                                  | Dashboard (Astro)                                                                             |
| **Secrets** (`ADMIN_KEY`, `CF_ACCESS_*`, `OAUTH_*`, `RBAC_*`) | Auth configuration                                                                            |

### Bindings to Add (Phased)

| Binding                                                                   | Type                        | Use Case                                                                                                                                                                                                                                  | Phase  |
| ------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **KV** (`CONFIG_KV`)                                                      | `kv_namespaces`             | OpenAPI schemas, JWKS cache, route table snapshots, WAF managed rulesets, IP reputation lists                                                                                                                                             | 1      |
| **Rate Limiting** (`GLOBAL_RATE_LIMITER`, `UNAUTHENTICATED_RATE_LIMITER`) | `ratelimits`                | Pre-auth IP rate limiting with zero latency. Complement DO token buckets.                                                                                                                                                                 | 1      |
| **Analytics Engine** (`GATEWAY_AE`)                                       | `analytics_engine_datasets` | Per-request telemetry (latency, status, route, rate limit events, JWT failures, WAF matches). 90-day retention, SQL API queryable, zero storage cap. Replaces D1 for high-volume events.                                                  | 2      |
| **R2** (`ARCHIVE_BUCKET`)                                                 | `r2_buckets`                | D1 overflow archive (NDJSON by day), request body captures, schema version history. Unlimited storage, $0.015/GB/mo, queryable via R2 SQL.                                                                                                | 2      |
| **mTLS Certificates** (`UPSTREAM_CERT_*`)                                 | `mtls_certificates`         | Client cert for outbound mTLS to upstreams. `env.UPSTREAM_CERT_1.fetch()` presents cert on TLS handshake. Static per-binding (one wrangler entry per cert).                                                                               | 2      |
| **Queues** (`LOG_QUEUE`)                                                  | `queues.producers`          | Log shipping. Batch events and ship to external destinations (webhook, Datadog, Splunk, R2). 5,000 msg/sec, 128 KB/msg, 25 GB backlog.                                                                                                    | 3      |
| **Workflows** (`ONBOARDING_WORKFLOW`)                                     | `workflows`                 | Consumer onboarding (multi-step: create key → send welcome email → provision tier). API key rotation with approval. Long-running admin operations. Durable, automatic retries, sleeps.                                                    | 3      |
| **Workers AI** (`AI`)                                                     | `ai`                        | Bot scoring (text classification on request patterns), content moderation (scan request/response bodies), anomaly detection (embedding-based similarity on request sequences). Optional — only if the operator wants AI-powered security. | 3      |
| **Service Bindings**                                                      | `services`                  | Plugin escape hatch — operators deploy a separate Worker with custom logic, bind it, call from a plugin step. Clean security boundary. Also: Tail Worker for log shipping.                                                                | 3      |
| **Secrets Store** (`secrets_store_secrets`)                               | `secrets_store_secrets`     | Account-level secrets for upstream API keys, webhook signing keys. Better than per-Worker secrets for multi-Worker setups. Independent rotation.                                                                                          | 3      |
| **Hyperdrive** (`HYPERDRIVE`)                                             | `hyperdrive`                | Optional escape hatch to external Postgres for analytics at extreme scale. Connection pooling across CF edge.                                                                                                                             | 3      |
| **Vectorize**                                                             | `vectorize`                 | Experimental: store request embeddings for sequence anomaly detection. Compare incoming request sequences against known-good patterns.                                                                                                    | Future |

### Runtime APIs (No Binding Needed)

| API                                             | Use Case                                                                                                                                                                                          | Phase  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **`request.cf` properties**                     | Rich request metadata available for free. See full inventory below.                                                                                                                               | 1      |
| **Cache API** (`caches.default`)                | Response caching for upstream responses. Per-colo, `CF-Cache-Status` auto-added. Use `body.tee()` to stream to client + cache simultaneously without buffering.                                   | 2      |
| **`fetch()` with `cf` options**                 | `cacheTtl`, `cacheEverything`, `cacheTtlByStatus`, `cacheKey` — for same-zone/non-CF upstreams, the CDN cache layer works natively. Richer than Cache API (supports Tiered Cache, Cache Reserve). | 2      |
| **Web Crypto API**                              | JWT signature verification (RS256, ES256, HS256+), HMAC, SHA-256 digests, random bytes. Already used for passwords + Sig V4.                                                                      | 1      |
| **`AbortSignal.timeout()`**                     | Upstream request timeouts. Per-route configurable.                                                                                                                                                | 2      |
| **`HTMLRewriter`**                              | Could rewrite error pages, inject portal UI into upstream responses. Low priority but free.                                                                                                       | Future |
| **`navigator.sendBeacon()`**                    | Fire-and-forget analytics to external endpoints. Alternative to Queues for simple webhook delivery.                                                                                               | 3      |
| **`CompressionStream` / `DecompressionStream`** | Compress/decompress request/response bodies on the fly. Useful for WAF body inspection of gzip'd payloads.                                                                                        | 2      |
| **`crypto.subtle.timingSafeEqual()`**           | Already used (password verification, API key comparison). Foundation for all auth.                                                                                                                | Done   |
| **`waitUntil()`**                               | Already used everywhere. Critical for non-blocking analytics, cache writes, circuit breaker updates.                                                                                              | Done   |
| **TCP Sockets** (`connect()`)                   | Direct TCP to external databases without Hyperdrive. Fallback if Hyperdrive not available.                                                                                                        | Future |

### Full `request.cf` Property Inventory

Every field CF gives us for free on every request. Each one is a potential policy condition field:

| Property                       | Type       | Use Case in Gatekeeper                                                                                                                                                                    |
| ------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tlsVersion`                   | `string`   | Enforce minimum TLS version (`policy: deny where tls.version lt TLSv1.2`)                                                                                                                 |
| `tlsCipher`                    | `string`   | Block weak ciphers                                                                                                                                                                        |
| `tlsClientAuth`                | `object`   | **mTLS enforcement** — `certPresented`, `certVerified`, `certFingerprintSHA256`, `certSubjectDN`, `certIssuerDN`, `certSerial`, `certNotBefore`, `certNotAfter`, `certSKI`, `certRevoked` |
| `asn`                          | `number`   | Already used. ASN-based policies.                                                                                                                                                         |
| `asOrganization`               | `string`   | Block/allow by ISP name (e.g., `deny where asOrganization contains "hosting"`)                                                                                                            |
| `country`                      | `string`   | Already used via `cf-ipcountry` header.                                                                                                                                                   |
| `region`                       | `string`   | Sub-country region (ISO-3166-2). Finer than country.                                                                                                                                      |
| `regionCode`                   | `string`   | ISO region code.                                                                                                                                                                          |
| `city`                         | `string`   | City-level geofencing.                                                                                                                                                                    |
| `postalCode`                   | `string`   | Zip-code-level policies (rare but possible).                                                                                                                                              |
| `latitude` / `longitude`       | `string`   | Geo-radius policies (compute distance from expected location).                                                                                                                            |
| `timezone`                     | `string`   | Time-zone-aware business-hours policies.                                                                                                                                                  |
| `isEUCountry`                  | `string`   | GDPR compliance — route EU traffic differently.                                                                                                                                           |
| `continent`                    | `string`   | Continent-level routing/policies.                                                                                                                                                         |
| `httpProtocol`                 | `string`   | `HTTP/1.1` vs `HTTP/2` vs `HTTP/3`. Can enforce HTTP/2+ for API traffic.                                                                                                                  |
| `requestPriority`              | `string`   | HTTP/2 priority hints from client.                                                                                                                                                        |
| `botManagement.score`          | `number`   | **Bot scoring** (Enterprise + Bot Management). 1-99, <30 = likely bot. Expose as `bot.score` condition field.                                                                             |
| `botManagement.verifiedBot`    | `boolean`  | Known-good bots (Google, Bing). Expose as `bot.verified`.                                                                                                                                 |
| `botManagement.staticResource` | `boolean`  | Whether CF thinks this is a static asset.                                                                                                                                                 |
| `botManagement.ja3Hash`        | `string`   | TLS fingerprint. Expose as `tls.ja3` for fingerprint-based policies.                                                                                                                      |
| `botManagement.ja4`            | `string`   | JA4 fingerprint (newer, more accurate). Expose as `tls.ja4`.                                                                                                                              |
| `botManagement.detectionIds`   | `number[]` | Which heuristic detections fired.                                                                                                                                                         |
| `clientTcpRtt`                 | `number`   | TCP round-trip time in ms. Can detect proxied/VPN traffic (unusually high RTT).                                                                                                           |
| `clientAcceptEncoding`         | `string`   | Encoding negotiation.                                                                                                                                                                     |
| `edgeRequestKeepAliveStatus`   | `number`   | Connection reuse status.                                                                                                                                                                  |
| `colo`                         | `string`   | CF colo (e.g., `SJC`). Useful for debugging, not policies.                                                                                                                                |

**Key insight**: `botManagement` fields are only populated for Enterprise zones with Bot Management enabled. For non-Enterprise zones, we provide our own lightweight bot scoring via request pattern analysis (UA parsing, header order fingerprinting, request rate). This is where Workers AI text classification could optionally help.

### Caching Strategy (Detailed)

Three distinct caching layers, used for different purposes:

| Layer                            | Mechanism                                 | When to Use                                                                                          | Limitations                                                                                                                   |
| -------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **`fetch()` with `cf` options**  | `cacheTtl`, `cacheEverything`, `cacheKey` | Upstream is non-CF or same-zone. Best option — supports Tiered Cache, Cache Reserve, standard purge. | Ignored for cross-zone orange-clouded origins. `cacheKey` only works within your zone.                                        |
| **Cache API** (`caches.default`) | `cache.match()` / `cache.put()`           | Cross-zone upstreams, or when you need custom cache keys (include JWT claims, API key tier, etc.).   | Per-colo (not globally replicated). No Tiered Cache. `cache.delete()` is per-colo only. Must `tee()` body to avoid buffering. |
| **KV**                           | `KV.get()` / `KV.put()` with `cacheTtl`   | Need global consistency. Rarely-changing data (config, schemas).                                     | 25 MB value limit. 1 write/sec/key. Must build your own TTL/invalidation. Eventually consistent (~60s propagation).           |

**For generic proxy response caching**, the decision tree:

```
Is the upstream non-CF or same-zone?
  YES → Use fetch() with cf options. Set cacheKey to include route + relevant vary headers.
         This is the cheapest, fastest, most integrated option.
  NO (cross-zone orange-clouded) →
    Is per-colo caching acceptable?
      YES → Use Cache API with body.tee().
      NO  → Use KV (build cache layer, handle invalidation).
```

For most Gatekeeper use cases (proxying to arbitrary non-CF backends), `fetch()` with `cf` options works natively. The upstream is not on Cloudflare, so there's no cross-zone issue.

### Observability Stack

| Layer                                            | Mechanism                          | What It Captures                                                              | Queryable From                                 |
| ------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| **Workers Logs** (`observability.enabled: true`) | Built-in, already enabled          | All `console.log`, exceptions, request metadata                               | Dashboard, wrangler tail                       |
| **Analytics Engine** (`GATEWAY_AE`)              | Fire-and-forget `writeDataPoint()` | Per-request metrics: latency, status, route, cache hit/miss, rate limit state | SQL API (external) → dashboard/CLI             |
| **D1** (`ANALYTICS_DB`)                          | Existing fire-and-forget INSERTs   | Structured event tables (purge, S3, DNS, CF proxy, audit)                     | Direct SQL from Workers → dashboard            |
| **Tail Workers**                                 | Separate Worker, `tail()` handler  | All `console.log` + exceptions from producer                                  | Custom: forward to Datadog, Splunk, etc.       |
| **Workers Logpush**                              | Account-level config (no binding)  | Trace events: scriptName, outcome, CPU time, subrequest count                 | Push to R2, S3, Datadog, Splunk, Elastic, etc. |
| **R2 SQL**                                       | Query archived NDJSON via Iceberg  | Historical analytics beyond D1 retention                                      | R2 SQL API (external)                          |

**Tail Worker vs Queue for log shipping**: Tail Workers are simpler (zero changes to producer, captures all `console.log` automatically, runs after response). Queues are more flexible (custom payloads, batching, retries, dead-letter). Use Tail Worker for "export all logs to X" and Queues for "export specific events with guaranteed delivery".

### Workflows for Long-Running Admin Operations

Workflows are durable multi-step execution engines. Perfect for:

| Operation                     | Steps                                                                                                        | Why Workflows?                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **API key rotation**          | Create new key → test with probe request → swap upstream bindings → revoke old key → notify consumer         | Each step persists. If step 3 fails, retry from step 3, not step 1.                           |
| **Consumer onboarding**       | Create consumer → generate API key → apply tier rate limits → send welcome email → create portal account     | Multi-system coordination with retries.                                                       |
| **Bulk upstream migration**   | For each route: update upstream → health check → rollback if fails → proceed to next                         | Fan-out with individual step retries. `step.sleep("cooldown", "30 seconds")` between batches. |
| **Schema validation rollout** | Upload schema in log mode → wait 24h → analyze violations → if clean, switch to block mode                   | `step.sleepUntil()` for time-delayed operations.                                              |
| **Certificate rotation**      | Generate new cert → upload via wrangler API → update upstream config → verify connectivity → remove old cert | Safety: each step verified before proceeding.                                                 |

```jsonc
// wrangler.jsonc
"workflows": [
  {
    "name": "gatekeeper-admin-workflow",
    "binding": "ADMIN_WORKFLOW",
    "class_name": "AdminWorkflow"
  }
]
```

---

## Appendix B: Competitive Positioning

| Feature                     | CF API Shield                  | Kong Gateway Enterprise        | Gatekeeper (Target)                                                                                                                            |
| --------------------------- | ------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI schema validation   | Yes                            | Yes (plugin)                   | Yes (Zod 4 + `zod-from-json-schema`)                                                                                                           |
| JWT validation              | Yes                            | Yes (plugin)                   | Yes (Web Crypto, JWKS in KV)                                                                                                                   |
| mTLS client auth            | Yes (zone-level)               | Yes (plugin)                   | Yes (CF `tlsClientAuth` + policy conditions + cert pinning)                                                                                    |
| Adaptive rate limiting      | ML-based                       | Sliding window plugin          | Workers RL binding (pre-auth) + DO token bucket (post-auth) + sliding window + anomaly detection                                               |
| Policy engine               | Wirefilter expressions         | ACL plugin (basic)             | IAM-style (16 operators, compound conditions, effect-aware skip)                                                                               |
| WAF / managed rulesets      | Yes (OWASP CRS, managed rules) | ModSecurity plugin             | OWASP CRS on KV + policy engine evaluation                                                                                                     |
| Bot detection               | Bot Management ($$$)           | Plugin                         | `request.cf.botManagement` (Enterprise) + 5-layer PoW challenge telemetry (17 JS probes, behavioral, JA4, HTTP headers, spatial inconsistency) |
| Challenge / CAPTCHA         | Managed Challenge / Turnstile  | None                           | PoW interstitial with SHA-256 hashcash + client telemetry (no third-party deps, policy-driven, configurable difficulty)                        |
| Request/response transforms | Via Transform Rules            | Yes (plugin)                   | Yes (built-in, template variables)                                                                                                             |
| Generic reverse proxy       | No (CF services only)          | Yes (core)                     | Yes (existing proxy infra parameterized for any HTTP upstream)                                                                                 |
| Circuit breaker             | No                             | Yes (plugin)                   | Yes (in-memory state machine in DO)                                                                                                            |
| Health checks               | No                             | Yes (active + passive)         | Yes (active via DO alarms, passive via circuit breaker)                                                                                        |
| Developer portal            | No                             | Yes ($35k+/yr)                 | Yes (built-in, self-service consumer signup)                                                                                                   |
| WebSocket proxy             | No                             | Yes                            | Yes (DO hibernation, zero cost when idle)                                                                                                      |
| Response caching            | CDN (for proxied zones)        | Yes (plugin)                   | Three layers: `fetch()` cf options + Cache API + KV (global)                                                                                   |
| Log shipping                | Logpush (CF logs only)         | Yes (30+ plugins)              | Queues + Tail Workers + Logpush + Analytics Engine                                                                                             |
| Traffic splitting           | No                             | Yes                            | Yes (weighted random, sticky sessions)                                                                                                         |
| Durable workflows           | No                             | No                             | Yes (Workflows binding — key rotation, onboarding, schema rollout)                                                                             |
| Geo-fencing                 | WAF custom rules               | Plugin                         | 12+ geo fields from `request.cf` (country, region, city, postal, lat/lng, continent, EU flag, timezone)                                        |
| TLS fingerprinting          | JA3/JA4 (Enterprise)           | No                             | JA3/JA4 from `request.cf.botManagement` + policy conditions                                                                                    |
| Anomaly detection (AI)      | No                             | No                             | Optional Workers AI binding for request classification                                                                                         |
| Self-hosted                 | N/A (SaaS only)                | Yes (K8s, VMs)                 | Yes (one `wrangler deploy`, zero infra)                                                                                                        |
| Infrastructure required     | None (SaaS)                    | K8s cluster + Postgres + Redis | None (Cloudflare Workers)                                                                                                                      |
| Pricing                     | Enterprise plan ($$$)          | $35k-$150k/yr                  | Workers pricing (~$5-50/mo typical)                                                                                                            |
