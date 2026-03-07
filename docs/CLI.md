# Gatekeeper CLI Reference

The `gk` CLI manages the Gatekeeper API gateway. It covers API keys, cache purge,
analytics, S3 credentials, upstream tokens, upstream R2 endpoints, and runtime configuration.

## Installation

```bash
npm run build:cli          # compile TypeScript
node dist/cli/index.js     # run directly
```

Or during development:

```bash
npm run cli -- <command>   # uses tsx + .env
```

## Environment Variables

All connection flags can be set via environment variables to avoid passing them on
every invocation.

| Variable               | Flag          | Description                         |
| ---------------------- | ------------- | ----------------------------------- |
| `GATEKEEPER_URL`       | `--endpoint`  | Base URL of the Gatekeeper instance |
| `GATEKEEPER_ADMIN_KEY` | `--admin-key` | Admin secret for `/admin/*` routes  |
| `GATEKEEPER_API_KEY`   | `--api-key`   | API key (`gw_...`) for purge routes |
| `GATEKEEPER_ZONE_ID`   | `--zone-id`   | Cloudflare zone ID (where required) |

## Global Flags

These flags appear on most commands. They are documented once here and omitted
from individual command sections to reduce repetition.

| Flag          | Alias | Type    | Description                                     |
| ------------- | ----- | ------- | ----------------------------------------------- |
| `--endpoint`  |       | string  | Gateway URL (`$GATEKEEPER_URL`)                 |
| `--admin-key` |       | string  | Admin key (`$GATEKEEPER_ADMIN_KEY`)             |
| `--zone-id`   | `-z`  | string  | Cloudflare zone ID (`$GATEKEEPER_ZONE_ID`)      |
| `--json`      |       | boolean | Output raw JSON (useful for scripting / piping) |

Commands under `purge` use `--api-key` instead of `--admin-key` because purge
requests authenticate with a bearer API key, not the admin secret.

The `--json` flag is available on every command. When set, the CLI prints the
full API response as JSON to stdout (all human-readable output goes to stderr),
making it suitable for `jq` pipelines and scripts.

---

## health

Check if the gateway is reachable.

```
gk health [--endpoint <url>] [--json]
```

| Flag         | Type    | Description                     |
| ------------ | ------- | ------------------------------- |
| `--endpoint` | string  | Gateway URL (`$GATEKEEPER_URL`) |
| `--json`     | boolean | Output raw JSON                 |

The health command does not require `--admin-key`.

```bash
gk health --endpoint https://gate.example.com
```

---

## keys

Manage API keys. All subcommands require `--admin-key` and `--zone-id`.

### keys create

Create a new API key with a policy document.

```
gk keys create --name <name> --policy <json|@file> [--zone-id <id>] [--expires-in-days <n>] [flags]
```

| Flag                | Type   | Required | Description                                   |
| ------------------- | ------ | -------- | --------------------------------------------- |
| `--name`            | string | yes      | Human-readable key name                       |
| `--policy`          | string | yes      | Policy as JSON string or `@path/to/file.json` |
| `--expires-in-days` | string | no       | Auto-expire after N days                      |

```bash
gk keys create \
  --name "staging-purge" \
  --policy '{"purge":{"hosts":["staging.example.com"]}}' \
  --zone-id abc123 \
  --expires-in-days 90
```

### keys list

List all API keys for a zone.

```
gk keys list [--zone-id <id>] [--active-only] [flags]
```

| Flag            | Type    | Required | Description                                 |
| --------------- | ------- | -------- | ------------------------------------------- |
| `--active-only` | boolean | no       | Only show active (non-revoked, non-expired) |

```bash
gk keys list --zone-id abc123 --active-only
```

### keys get

Get details and scopes of an API key.

```
gk keys get --key-id <id> [--zone-id <id>] [flags]
```

| Flag       | Type   | Required | Description               |
| ---------- | ------ | -------- | ------------------------- |
| `--key-id` | string | yes      | The API key ID (`gw_...`) |

```bash
gk keys get --key-id gw_abc123 --zone-id abc123
```

### keys revoke

Revoke or permanently delete an API key.

```
gk keys revoke --key-id <id> [--zone-id <id>] [--permanent] [--force] [flags]
```

| Flag          | Alias | Type    | Required | Description                                         |
| ------------- | ----- | ------- | -------- | --------------------------------------------------- |
| `--key-id`    |       | string  | yes      | The API key ID to revoke (`gw_...`)                 |
| `--permanent` |       | boolean | no       | Permanently delete the row instead of soft-revoking |
| `--force`     | `-f`  | boolean | no       | Skip confirmation prompt                            |

```bash
gk keys revoke --key-id gw_abc123 --zone-id abc123 --permanent --force
```

### keys bulk-revoke

Bulk soft-revoke multiple API keys. Runs as a dry run by default.

```
gk keys bulk-revoke --ids <id1,id2,...> [--confirm] [flags]
```

| Flag        | Type    | Required | Description                                                |
| ----------- | ------- | -------- | ---------------------------------------------------------- |
| `--ids`     | string  | yes      | Comma-separated list of key IDs (`gw_...`)                 |
| `--confirm` | boolean | no       | Execute the operation (without this flag, runs in dry-run) |

```bash
# Preview what would happen
gk keys bulk-revoke --ids gw_aaa,gw_bbb --zone-id abc123

# Execute
gk keys bulk-revoke --ids gw_aaa,gw_bbb --zone-id abc123 --confirm
```

### keys bulk-delete

Bulk permanently delete multiple API keys. Runs as a dry run by default.

```
gk keys bulk-delete --ids <id1,id2,...> [--confirm] [flags]
```

| Flag        | Type    | Required | Description                                                |
| ----------- | ------- | -------- | ---------------------------------------------------------- |
| `--ids`     | string  | yes      | Comma-separated list of key IDs (`gw_...`)                 |
| `--confirm` | boolean | no       | Execute the operation (without this flag, runs in dry-run) |

```bash
gk keys bulk-delete --ids gw_aaa,gw_bbb --zone-id abc123 --confirm
```

---

## purge

Purge Cloudflare cache. Purge commands authenticate with `--api-key` (a bearer
API key), not `--admin-key`.

All purge subcommands share these flags:

| Flag         | Alias | Type    | Description                                |
| ------------ | ----- | ------- | ------------------------------------------ |
| `--endpoint` |       | string  | Gateway URL (`$GATEKEEPER_URL`)            |
| `--api-key`  |       | string  | API key `gw_...` (`$GATEKEEPER_API_KEY`)   |
| `--zone-id`  | `-z`  | string  | Cloudflare zone ID (`$GATEKEEPER_ZONE_ID`) |
| `--json`     |       | boolean | Output raw JSON                            |

### purge hosts

Purge by hostname(s).

```
gk purge hosts --host <host1,host2,...> [flags]
```

| Flag     | Type   | Required | Description                                                    |
| -------- | ------ | -------- | -------------------------------------------------------------- |
| `--host` | string | yes      | Comma-separated hostnames (e.g. `example.com,www.example.com`) |

```bash
gk purge hosts --host example.com,www.example.com --zone-id abc123
```

### purge tags

Purge by cache tag(s).

```
gk purge tags --tag <tag1,tag2,...> [flags]
```

| Flag    | Type   | Required | Description                |
| ------- | ------ | -------- | -------------------------- |
| `--tag` | string | yes      | Comma-separated cache tags |

```bash
gk purge tags --tag blog,images --zone-id abc123
```

### purge prefixes

Purge by URL prefix(es).

```
gk purge prefixes --prefix <prefix1,prefix2,...> [flags]
```

| Flag       | Type   | Required | Description                                        |
| ---------- | ------ | -------- | -------------------------------------------------- |
| `--prefix` | string | yes      | Comma-separated prefixes (e.g. `example.com/blog`) |

```bash
gk purge prefixes --prefix example.com/blog,example.com/api --zone-id abc123
```

### purge urls

Purge specific URL(s).

```
gk purge urls --url <url1,url2,...> [flags]
```

| Flag    | Type   | Required | Description               |
| ------- | ------ | -------- | ------------------------- |
| `--url` | string | yes      | Comma-separated full URLs |

```bash
gk purge urls --url "https://example.com/page,https://example.com/other" --zone-id abc123
```

### purge everything

Purge the entire zone cache. Requires confirmation.

```
gk purge everything [--force] [flags]
```

| Flag      | Alias | Type    | Required | Description              |
| --------- | ----- | ------- | -------- | ------------------------ |
| `--force` | `-f`  | boolean | no       | Skip confirmation prompt |

```bash
gk purge everything --zone-id abc123 --force
```

---

## analytics

View purge analytics. Requires `--admin-key` and `--zone-id`.

### analytics events

Query recent purge events.

```
gk analytics events [--zone-id <id>] [--key-id <id>] [--since <time>] [--until <time>] [--limit <n>] [flags]
```

| Flag       | Type   | Required | Description                                  |
| ---------- | ------ | -------- | -------------------------------------------- |
| `--key-id` | string | no       | Filter by API key ID                         |
| `--since`  | string | no       | Start time (ISO 8601 or unix ms)             |
| `--until`  | string | no       | End time (ISO 8601 or unix ms)               |
| `--limit`  | string | no       | Max events to return (default 100, max 1000) |

```bash
gk analytics events --zone-id abc123 --since 2025-01-01T00:00:00Z --limit 50
```

### analytics summary

Get aggregated analytics summary for a zone.

```
gk analytics summary [--zone-id <id>] [--key-id <id>] [--since <time>] [--until <time>] [flags]
```

| Flag       | Type   | Required | Description                      |
| ---------- | ------ | -------- | -------------------------------- |
| `--key-id` | string | no       | Filter by API key ID             |
| `--since`  | string | no       | Start time (ISO 8601 or unix ms) |
| `--until`  | string | no       | End time (ISO 8601 or unix ms)   |

```bash
gk analytics summary --zone-id abc123 --since 2025-01-01T00:00:00Z
```

---

## s3-credentials

Manage S3 proxy credentials. Requires `--admin-key`. These commands are not
zone-scoped (no `--zone-id`).

### s3-credentials create

Create a new S3 credential with a policy document.

```
gk s3-credentials create --name <name> --policy <json|@file> [--expires-in-days <n>] [flags]
```

| Flag                | Type   | Required | Description                                   |
| ------------------- | ------ | -------- | --------------------------------------------- |
| `--name`            | string | yes      | Human-readable credential name                |
| `--policy`          | string | yes      | Policy as JSON string or `@path/to/file.json` |
| `--expires-in-days` | string | no       | Auto-expire after N days                      |

The response includes the `access_key_id` and `secret_access_key`. The secret
is shown only once and cannot be retrieved later.

```bash
gk s3-credentials create \
  --name "app-uploads" \
  --policy '{"s3":{"buckets":["my-bucket"],"operations":["GetObject","PutObject"]}}'
```

### s3-credentials list

List all S3 credentials.

```
gk s3-credentials list [--active-only] [flags]
```

| Flag            | Type    | Required | Description                          |
| --------------- | ------- | -------- | ------------------------------------ |
| `--active-only` | boolean | no       | Only show active (non-revoked) creds |

```bash
gk s3-credentials list --active-only
```

### s3-credentials get

Get details of an S3 credential.

```
gk s3-credentials get --access-key-id <id> [flags]
```

| Flag              | Type   | Required | Description                 |
| ----------------- | ------ | -------- | --------------------------- |
| `--access-key-id` | string | yes      | The access key ID (`GK...`) |

```bash
gk s3-credentials get --access-key-id GKabc123
```

### s3-credentials revoke

Revoke or permanently delete an S3 credential.

```
gk s3-credentials revoke --access-key-id <id> [--permanent] [--force] [flags]
```

| Flag              | Alias | Type    | Required | Description                                 |
| ----------------- | ----- | ------- | -------- | ------------------------------------------- |
| `--access-key-id` |       | string  | yes      | The access key ID to revoke (`GK...`)       |
| `--permanent`     |       | boolean | no       | Permanently delete instead of soft-revoking |
| `--force`         | `-f`  | boolean | no       | Skip confirmation prompt                    |

```bash
gk s3-credentials revoke --access-key-id GKabc123 --permanent --force
```

### s3-credentials bulk-revoke

Bulk soft-revoke multiple S3 credentials. Runs as a dry run by default.

```
gk s3-credentials bulk-revoke --ids <id1,id2,...> [--confirm] [flags]
```

| Flag        | Type    | Required | Description                                                |
| ----------- | ------- | -------- | ---------------------------------------------------------- |
| `--ids`     | string  | yes      | Comma-separated list of access key IDs (`GK...`)           |
| `--confirm` | boolean | no       | Execute the operation (without this flag, runs in dry-run) |

```bash
gk s3-credentials bulk-revoke --ids GKaaa,GKbbb --confirm
```

### s3-credentials bulk-delete

Bulk permanently delete multiple S3 credentials. Runs as a dry run by default.

```
gk s3-credentials bulk-delete --ids <id1,id2,...> [--confirm] [flags]
```

| Flag        | Type    | Required | Description                                                |
| ----------- | ------- | -------- | ---------------------------------------------------------- |
| `--ids`     | string  | yes      | Comma-separated list of access key IDs (`GK...`)           |
| `--confirm` | boolean | no       | Execute the operation (without this flag, runs in dry-run) |

```bash
gk s3-credentials bulk-delete --ids GKaaa,GKbbb --confirm
```

---

## s3-analytics

View S3 proxy analytics. Requires `--admin-key`. Not zone-scoped.

### s3-analytics events

Query recent S3 proxy events.

```
gk s3-analytics events [--credential-id <id>] [--bucket <name>] [--operation <op>] [--since <time>] [--until <time>] [--limit <n>] [flags]
```

| Flag              | Type   | Required | Description                                  |
| ----------------- | ------ | -------- | -------------------------------------------- |
| `--credential-id` | string | no       | Filter by S3 credential (access_key_id)      |
| `--bucket`        | string | no       | Filter by bucket name                        |
| `--operation`     | string | no       | Filter by S3 operation (e.g. GetObject)      |
| `--since`         | string | no       | Start time (ISO 8601 or unix ms)             |
| `--until`         | string | no       | End time (ISO 8601 or unix ms)               |
| `--limit`         | string | no       | Max events to return (default 100, max 1000) |

```bash
gk s3-analytics events --bucket my-bucket --operation GetObject --limit 50
```

### s3-analytics summary

Get aggregated S3 proxy analytics summary.

```
gk s3-analytics summary [--credential-id <id>] [--bucket <name>] [--operation <op>] [--since <time>] [--until <time>] [flags]
```

| Flag              | Type   | Required | Description                             |
| ----------------- | ------ | -------- | --------------------------------------- |
| `--credential-id` | string | no       | Filter by S3 credential (access_key_id) |
| `--bucket`        | string | no       | Filter by bucket name                   |
| `--operation`     | string | no       | Filter by S3 operation                  |
| `--since`         | string | no       | Start time (ISO 8601 or unix ms)        |
| `--until`         | string | no       | End time (ISO 8601 or unix ms)          |

```bash
gk s3-analytics summary --since 2025-01-01T00:00:00Z
```

---

## upstream-tokens

Manage upstream Cloudflare API tokens for purge. Requires `--admin-key`. Not
zone-scoped.

### upstream-tokens create

Register a Cloudflare API token for upstream purge requests.

```
gk upstream-tokens create --name <name> --zone-ids <ids> [--token <token>] [flags]
```

| Flag         | Type   | Required | Description                                                |
| ------------ | ------ | -------- | ---------------------------------------------------------- |
| `--name`     | string | yes      | Human-readable name for this token                         |
| `--token`    | string | no       | Cloudflare API token value (`$UPSTREAM_CF_TOKEN`)          |
| `--zone-ids` | string | yes      | Comma-separated zone IDs this token covers, or `*` for all |

If `--token` is omitted, the CLI reads from `$UPSTREAM_CF_TOKEN`.

```bash
gk upstream-tokens create \
  --name "prod-purge" \
  --token "cf-api-token-value" \
  --zone-ids "zone1,zone2"
```

### upstream-tokens list

List all registered upstream tokens.

```
gk upstream-tokens list [flags]
```

No additional flags beyond the global set.

```bash
gk upstream-tokens list
```

### upstream-tokens get

Get details of an upstream token.

```
gk upstream-tokens get --id <id> [flags]
```

| Flag   | Type   | Required | Description                       |
| ------ | ------ | -------- | --------------------------------- |
| `--id` | string | yes      | The upstream token ID (`upt_...`) |

```bash
gk upstream-tokens get --id upt_abc123
```

### upstream-tokens delete

Delete an upstream token. This is permanent and irreversible.

```
gk upstream-tokens delete --id <id> [--force] [flags]
```

| Flag      | Alias | Type    | Required | Description              |
| --------- | ----- | ------- | -------- | ------------------------ |
| `--id`    |       | string  | yes      | Token ID (`upt_...`)     |
| `--force` | `-f`  | boolean | no       | Skip confirmation prompt |

```bash
gk upstream-tokens delete --id upt_abc123 --force
```

### upstream-tokens bulk-delete

Bulk permanently delete multiple upstream tokens. Runs as a dry run by default.

```
gk upstream-tokens bulk-delete --ids <id1,id2,...> [--confirm] [flags]
```

| Flag        | Type    | Required | Description                                                |
| ----------- | ------- | -------- | ---------------------------------------------------------- |
| `--ids`     | string  | yes      | Comma-separated list of token IDs (`upt_...`)              |
| `--confirm` | boolean | no       | Execute the operation (without this flag, runs in dry-run) |

```bash
gk upstream-tokens bulk-delete --ids upt_aaa,upt_bbb --confirm
```

---

## upstream-r2

Manage upstream R2 endpoints for the S3 proxy. Requires `--admin-key`. Not
zone-scoped.

### upstream-r2 create

Register an R2 endpoint with credentials for S3 proxy forwarding.

```
gk upstream-r2 create --name <name> --access-key-id <key> --r2-endpoint <url> --bucket-names <names> [--secret-access-key <secret>] [flags]
```

| Flag                  | Type   | Required | Description                                                         |
| --------------------- | ------ | -------- | ------------------------------------------------------------------- |
| `--name`              | string | yes      | Human-readable name for this R2 endpoint                            |
| `--access-key-id`     | string | yes      | R2 access key ID                                                    |
| `--secret-access-key` | string | no       | R2 secret access key (`$UPSTREAM_R2_SECRET_ACCESS_KEY`)             |
| `--r2-endpoint`       | string | yes      | R2 endpoint URL (e.g. `https://<account>.r2.cloudflarestorage.com`) |
| `--bucket-names`      | string | yes      | Comma-separated bucket names, or `*` for all                        |

If `--secret-access-key` is omitted, the CLI reads from `$UPSTREAM_R2_SECRET_ACCESS_KEY`.

```bash
gk upstream-r2 create \
  --name "prod-r2" \
  --access-key-id "r2-key-id" \
  --secret-access-key "r2-secret" \
  --r2-endpoint "https://acct.r2.cloudflarestorage.com" \
  --bucket-names "assets,uploads"
```

### upstream-r2 list

List all registered R2 endpoints.

```
gk upstream-r2 list [flags]
```

No additional flags beyond the global set.

```bash
gk upstream-r2 list
```

### upstream-r2 get

Get details of an R2 endpoint.

```
gk upstream-r2 get --id <id> [flags]
```

| Flag   | Type   | Required | Description                     |
| ------ | ------ | -------- | ------------------------------- |
| `--id` | string | yes      | The R2 endpoint ID (`upr2_...`) |

```bash
gk upstream-r2 get --id upr2_abc123
```

### upstream-r2 delete

Delete an R2 endpoint registration. This is permanent and irreversible.

```
gk upstream-r2 delete --id <id> [--force] [flags]
```

| Flag      | Alias | Type    | Required | Description              |
| --------- | ----- | ------- | -------- | ------------------------ |
| `--id`    |       | string  | yes      | Endpoint ID (`upr2_...`) |
| `--force` | `-f`  | boolean | no       | Skip confirmation prompt |

```bash
gk upstream-r2 delete --id upr2_abc123 --force
```

### upstream-r2 bulk-delete

Bulk permanently delete multiple R2 endpoints. Runs as a dry run by default.

```
gk upstream-r2 bulk-delete --ids <id1,id2,...> [--confirm] [flags]
```

| Flag        | Type    | Required | Description                                                |
| ----------- | ------- | -------- | ---------------------------------------------------------- |
| `--ids`     | string  | yes      | Comma-separated list of endpoint IDs (`upr2_...`)          |
| `--confirm` | boolean | no       | Execute the operation (without this flag, runs in dry-run) |

```bash
gk upstream-r2 bulk-delete --ids upr2_aaa,upr2_bbb --confirm
```

---

## config

Manage gateway configuration (rate limits, cache TTLs, etc.). Requires
`--admin-key`. Not zone-scoped.

### config get

Show the full resolved config with overrides, env values, and defaults.

```
gk config get [flags]
```

No additional flags beyond the global set. The output table shows each key, its
current value, the source (registry override, env, or default), and the default
value.

```bash
gk config get
```

### config set

Set one or more config values using positional `key=value` pairs.

```
gk config set <key=value> [<key=value> ...] [flags]
```

| Positional | Required | Description                                     |
| ---------- | -------- | ----------------------------------------------- |
| key=value  | yes      | One or more config pairs (e.g. `bulk_rate=100`) |

Values must be positive numbers.

```bash
gk config set bulk_rate=100 single_rate=5000
```

### config reset

Reset a config key to its env/default value (removes the registry override).

```
gk config reset --key <key> [flags]
```

| Flag    | Type   | Required | Description             |
| ------- | ------ | -------- | ----------------------- |
| `--key` | string | yes      | The config key to reset |

```bash
gk config reset --key bulk_rate
```

---

## Scripting with --json

Every command supports `--json`. When set:

- Human-readable output (tables, labels, success messages) is suppressed.
- The full API response JSON is printed to stdout.
- Errors still cause a non-zero exit code.

This makes it straightforward to integrate with `jq`, scripts, or CI pipelines:

```bash
# Get all active key IDs as a list
gk keys list --zone-id abc123 --active-only --json | jq -r '.result[].id'

# Check health in CI
gk health --json && echo "OK" || echo "FAIL"

# Pipe analytics to a file
gk analytics events --zone-id abc123 --json > events.json
```
