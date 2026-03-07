# Gatekeeper Cookbook

Complete guide covering every operation, every permutation. All examples show both the CLI (`gk`) and the equivalent `curl` API call.

**Conventions used in this guide:**

- `$ADMIN_KEY` -- your admin secret for `/admin/*` routes.
- `$GATEKEEPER_URL` -- your gateway URL, e.g. `https://gate.example.com`.
- `$ZONE_ID` -- a Cloudflare zone ID (32-char hex).
- `$KEY_ID` -- a purge API key ID (`gw_...`).
- `$ACCESS_KEY_ID` -- an S3 credential access key ID (`GK...`).
- Policy JSON is shown inline for `curl` and via `@file.json` for the CLI where practical.

---

## 1. Getting Started

### Prerequisites

- Node.js >= 18
- A Cloudflare account
- A Cloudflare API token with **Cache Purge** permission (for purge functionality)
- An R2 API token with appropriate bucket access (for S3 proxy functionality)

### Install

```bash
git clone https://github.com/erfianugrah/gatekeeper.git
cd gatekeeper
npm install
cd dashboard && npm install && cd ..
```

### Configure wrangler.jsonc

1. **Custom domain** -- change to your domain or remove the `routes` block for `*.workers.dev`:

   ```jsonc
   "routes": [{ "pattern": "purge.yourdomain.com", "custom_domain": true }]
   ```

2. **D1 database** -- create one and update the binding:

   ```bash
   npx wrangler d1 create gatekeeper-analytics
   # copy the database_id into wrangler.jsonc
   ```

3. **Rate limits** -- defaults target Cloudflare Enterprise purge tier. All tunable settings live in the config registry and can be changed at runtime without redeploying.

### Secrets

Local dev -- create `.dev.vars`:

```
ADMIN_KEY=<a-strong-secret-for-admin-operations>
```

Production:

```bash
npx wrangler secret put ADMIN_KEY
```

Optional (for Cloudflare Access identity on the dashboard):

```bash
npx wrangler secret put CF_ACCESS_TEAM_NAME
npx wrangler secret put CF_ACCESS_AUD
```

### First deploy

```bash
npm run build           # build dashboard + CLI
npx wrangler deploy     # deploy to Cloudflare
```

After deploying, register your upstream credentials (next section) before creating any API keys or S3 credentials.

### CLI setup

The CLI reads configuration from environment variables or flags:

| Env var              | Flag          | Description                |
| -------------------- | ------------- | -------------------------- |
| `GATEKEEPER_URL`     | `--endpoint`  | Gateway URL                |
| `GATEKEEPER_ADMIN`   | `--admin-key` | Admin key for `/admin/*`   |
| `GATEKEEPER_API_KEY` | `--api-key`   | API key for purge requests |
| `GATEKEEPER_ZONE_ID` | `--zone-id`   | Default zone ID            |

Set these in your shell profile or `.env` to avoid passing flags on every command.

---

## 2. Registering Upstream Credentials

Upstream credentials are stored in the Durable Object at runtime -- they are not env vars. This lets you manage multiple upstream tokens, rotate credentials without redeploying, and audit who registered what. Token/secret values are write-only and cannot be retrieved after registration.

### 2.1 Cloudflare API Tokens (for purge)

When a purge request arrives, the gateway resolves the best matching upstream token for the target zone: exact match preferred over wildcard.

#### Single-zone token

**CLI:**

```bash
gk upstream-tokens create \
  --name "prod-purge" \
  --token "$UPSTREAM_CF_TOKEN" \
  --zone-ids "$ZONE_ID"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-tokens" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prod-purge",
    "token": "<your-cloudflare-api-token>",
    "zone_ids": ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"]
  }'
```

#### Multi-zone token

**CLI:**

```bash
gk upstream-tokens create \
  --name "multi-zone-purge" \
  --token "$UPSTREAM_CF_TOKEN" \
  --zone-ids "aaaa1111bbbb2222cccc3333dddd4444,eeee5555ffff6666aaaa7777bbbb8888"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-tokens" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "multi-zone-purge",
    "token": "<your-cloudflare-api-token>",
    "zone_ids": [
      "aaaa1111bbbb2222cccc3333dddd4444",
      "eeee5555ffff6666aaaa7777bbbb8888"
    ]
  }'
```

#### Wildcard token (all zones)

**CLI:**

```bash
gk upstream-tokens create \
  --name "global-purge" \
  --token "$UPSTREAM_CF_TOKEN" \
  --zone-ids "*"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-tokens" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "global-purge",
    "token": "<your-cloudflare-api-token>",
    "zone_ids": ["*"]
  }'
```

#### With validation

Pass `"validate": true` in the API body to have the gateway verify the token against the Cloudflare API before storing it. If the token is invalid, the request fails and nothing is stored.

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-tokens" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prod-purge-validated",
    "token": "<your-cloudflare-api-token>",
    "zone_ids": ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"],
    "validate": true
  }'
```

#### Token from env var

The CLI reads `$UPSTREAM_CF_TOKEN` automatically if `--token` is not provided:

```bash
export UPSTREAM_CF_TOKEN="<your-token>"
gk upstream-tokens create --name "from-env" --zone-ids "*"
```

#### List, get, delete upstream tokens

**CLI:**

```bash
gk upstream-tokens list
gk upstream-tokens get --id upt_abc123
gk upstream-tokens delete --id upt_abc123
gk upstream-tokens delete --id upt_abc123 --force     # skip confirmation
```

**API:**

```bash
# List all
curl -H "X-Admin-Key: $ADMIN_KEY" "$GATEKEEPER_URL/admin/upstream-tokens"

# Get one
curl -H "X-Admin-Key: $ADMIN_KEY" "$GATEKEEPER_URL/admin/upstream-tokens/upt_abc123"

# Delete one
curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" "$GATEKEEPER_URL/admin/upstream-tokens/upt_abc123"
```

#### Bulk delete upstream tokens

**CLI (dry run first):**

```bash
gk upstream-tokens bulk-delete --ids "upt_abc123,upt_def456"
```

**CLI (execute):**

```bash
gk upstream-tokens bulk-delete --ids "upt_abc123,upt_def456" --confirm
```

**API (dry run):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-tokens/bulk-delete" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["upt_abc123", "upt_def456"],
    "confirm_count": 2,
    "dry_run": true
  }'
```

**API (execute):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-tokens/bulk-delete" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["upt_abc123", "upt_def456"],
    "confirm_count": 2,
    "dry_run": false
  }'
```

### 2.2 R2 Endpoints (for S3 proxy)

When an S3 request arrives, the gateway resolves the R2 endpoint for the target bucket: exact match preferred over wildcard. For `ListBuckets` (no specific bucket), the first wildcard endpoint is used.

#### Single-bucket endpoint

**CLI:**

```bash
gk upstream-r2 create \
  --name "prod-r2" \
  --access-key-id "<r2-access-key>" \
  --secret-access-key "$UPSTREAM_R2_SECRET_ACCESS_KEY" \
  --r2-endpoint "https://<account_id>.r2.cloudflarestorage.com" \
  --bucket-names "my-bucket"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-r2" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prod-r2",
    "access_key_id": "<r2-access-key-id>",
    "secret_access_key": "<r2-secret-access-key>",
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "bucket_names": ["my-bucket"]
  }'
```

#### Multi-bucket endpoint

**CLI:**

```bash
gk upstream-r2 create \
  --name "multi-r2" \
  --access-key-id "<r2-access-key>" \
  --secret-access-key "$UPSTREAM_R2_SECRET_ACCESS_KEY" \
  --r2-endpoint "https://<account_id>.r2.cloudflarestorage.com" \
  --bucket-names "staging,production,media"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-r2" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "multi-r2",
    "access_key_id": "<r2-access-key-id>",
    "secret_access_key": "<r2-secret-access-key>",
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "bucket_names": ["staging", "production", "media"]
  }'
```

#### Wildcard endpoint (all buckets)

**CLI:**

```bash
gk upstream-r2 create \
  --name "global-r2" \
  --access-key-id "<r2-access-key>" \
  --secret-access-key "$UPSTREAM_R2_SECRET_ACCESS_KEY" \
  --r2-endpoint "https://<account_id>.r2.cloudflarestorage.com" \
  --bucket-names "*"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-r2" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "global-r2",
    "access_key_id": "<r2-access-key-id>",
    "secret_access_key": "<r2-secret-access-key>",
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "bucket_names": ["*"]
  }'
```

#### With validation

Pass `"validate": true` in the API body to verify the R2 credentials before storing them.

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-r2" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prod-r2-validated",
    "access_key_id": "<r2-access-key-id>",
    "secret_access_key": "<r2-secret-access-key>",
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "bucket_names": ["*"],
    "validate": true
  }'
```

#### Secret from env var

The CLI reads `$UPSTREAM_R2_SECRET_ACCESS_KEY` automatically if `--secret-access-key` is not provided:

```bash
export UPSTREAM_R2_SECRET_ACCESS_KEY="<your-secret>"
gk upstream-r2 create \
  --name "from-env" \
  --access-key-id "<r2-access-key>" \
  --r2-endpoint "https://<account_id>.r2.cloudflarestorage.com" \
  --bucket-names "*"
```

#### List, get, delete R2 endpoints

**CLI:**

```bash
gk upstream-r2 list
gk upstream-r2 get --id upr2_abc123
gk upstream-r2 delete --id upr2_abc123
gk upstream-r2 delete --id upr2_abc123 --force     # skip confirmation
```

**API:**

```bash
# List all
curl -H "X-Admin-Key: $ADMIN_KEY" "$GATEKEEPER_URL/admin/upstream-r2"

# Get one
curl -H "X-Admin-Key: $ADMIN_KEY" "$GATEKEEPER_URL/admin/upstream-r2/upr2_abc123"

# Delete one
curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" "$GATEKEEPER_URL/admin/upstream-r2/upr2_abc123"
```

#### Bulk delete R2 endpoints

**CLI (dry run first):**

```bash
gk upstream-r2 bulk-delete --ids "upr2_abc123,upr2_def456"
```

**CLI (execute):**

```bash
gk upstream-r2 bulk-delete --ids "upr2_abc123,upr2_def456" --confirm
```

**API (dry run):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-r2/bulk-delete" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["upr2_abc123", "upr2_def456"],
    "confirm_count": 2,
    "dry_run": true
  }'
```

**API (execute):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/upstream-r2/bulk-delete" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["upr2_abc123", "upr2_def456"],
    "confirm_count": 2,
    "dry_run": false
  }'
```

---

## 3. Creating Purge API Keys

Every key requires `name` and `policy`. The policy version must be `"2025-01-01"`. Optional fields: `zone_id` (scope to one zone), `expires_in_days`, `rate_limit` (per-key overrides), `created_by`.

The response includes the key ID (`gw_<hex>`) which is the Bearer token. It is shown once -- save it.

### 3.1 Minimal key -- wildcard policy

Full access to all purge actions on all zones.

**CLI:**

```bash
gk keys create \
  --name "full-access" \
  --zone-id "*" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["purge:*"],
        "resources": ["zone:*"]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "full-access",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["purge:*"],
          "resources": ["zone:*"]
        }
      ]
    }
  }'
```

### 3.2 Zone-scoped key

Full purge access to one specific zone.

**CLI:**

```bash
gk keys create \
  --name "prod-zone-key" \
  --zone-id "aaaa1111bbbb2222cccc3333dddd4444" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["purge:*"],
        "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prod-zone-key",
    "zone_id": "aaaa1111bbbb2222cccc3333dddd4444",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["purge:*"],
          "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
        }
      ]
    }
  }'
```

### 3.3 Key with expiry

Auto-expire after 90 days.

**CLI:**

```bash
gk keys create \
  --name "temp-key" \
  --zone-id "$ZONE_ID" \
  --expires-in-days 90 \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["purge:*"],
        "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "temp-key",
    "zone_id": "aaaa1111bbbb2222cccc3333dddd4444",
    "expires_in_days": 90,
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["purge:*"],
          "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
        }
      ]
    }
  }'
```

### 3.4 Key with per-key rate limits

Override the global rate limits for a single key. Per-key limits cannot exceed the account defaults. Fields: `bulk_rate`, `bulk_bucket`, `single_rate`, `single_bucket`.

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "throttled-ci-key",
    "zone_id": "aaaa1111bbbb2222cccc3333dddd4444",
    "expires_in_days": 30,
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["purge:*"],
          "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
        }
      ]
    },
    "rate_limit": {
      "bulk_rate": 10,
      "bulk_bucket": 20,
      "single_rate": 500,
      "single_bucket": 1000
    }
  }'
```

Note: Per-key rate limits are an API-only feature. The CLI `keys create` command does not currently expose `--rate-limit` flags.

### 3.5 Policy: CI/CD key -- only purge tags matching a release pattern

Regex patterns are validated at key creation time. Max 256 chars, no catastrophic backtracking patterns.

**CLI:**

```bash
gk keys create \
  --name "ci-release-tags" \
  --zone-id "$ZONE_ID" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["purge:tag"],
        "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"],
        "conditions": [
          {
            "field": "tag",
            "operator": "matches",
            "value": "^release-v[0-9]+\\.[0-9]+$"
          }
        ]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ci-release-tags",
    "zone_id": "aaaa1111bbbb2222cccc3333dddd4444",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["purge:tag"],
          "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"],
          "conditions": [
            {
              "field": "tag",
              "operator": "matches",
              "value": "^release-v[0-9]+\\.[0-9]+$"
            }
          ]
        }
      ]
    }
  }'
```

### 3.6 Policy: Host-scoped -- only purge specific hosts

Uses `any` compound condition (OR logic).

**CLI:**

```bash
gk keys create \
  --name "cdn-hosts-only" \
  --zone-id "$ZONE_ID" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["purge:url", "purge:tag"],
        "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"],
        "conditions": [
          {
            "any": [
              {"field": "host", "operator": "eq", "value": "cdn.example.com"},
              {"field": "host", "operator": "eq", "value": "static.example.com"}
            ]
          }
        ]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cdn-hosts-only",
    "zone_id": "aaaa1111bbbb2222cccc3333dddd4444",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["purge:url", "purge:tag"],
          "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"],
          "conditions": [
            {
              "any": [
                {"field": "host", "operator": "eq", "value": "cdn.example.com"},
                {"field": "host", "operator": "eq", "value": "static.example.com"}
              ]
            }
          ]
        }
      ]
    }
  }'
```

### 3.7 Policy: Multi-zone with host restriction

Wildcard zone with host suffix condition. Allows URL and host purge for any zone, but only for `*.example.com` hostnames.

**CLI:**

```bash
gk keys create \
  --name "multi-zone-example" \
  --zone-id "*" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["purge:url", "purge:host"],
        "resources": ["zone:*"],
        "conditions": [
          {"field": "host", "operator": "ends_with", "value": ".example.com"}
        ]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "multi-zone-example",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["purge:url", "purge:host"],
          "resources": ["zone:*"],
          "conditions": [
            {"field": "host", "operator": "ends_with", "value": ".example.com"}
          ]
        }
      ]
    }
  }'
```

### 3.8 Policy: Deny purge-everything while allowing all other purge operations

Deny statements are evaluated first. An explicit deny always wins over allow.

**CLI:**

```bash
gk keys create \
  --name "no-nuke" \
  --zone-id "$ZONE_ID" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "deny",
        "actions": ["purge:everything"],
        "resources": ["*"]
      },
      {
        "effect": "allow",
        "actions": ["purge:*"],
        "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "no-nuke",
    "zone_id": "aaaa1111bbbb2222cccc3333dddd4444",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "deny",
          "actions": ["purge:everything"],
          "resources": ["*"]
        },
        {
          "effect": "allow",
          "actions": ["purge:*"],
          "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
        }
      ]
    }
  }'
```

### 3.9 Policy: IP/country restriction

Only allow purge from specific countries.

**CLI:**

```bash
gk keys create \
  --name "geo-restricted" \
  --zone-id "*" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["purge:*"],
        "resources": ["zone:*"],
        "conditions": [
          {"field": "client_country", "operator": "in", "value": ["US", "DE", "GB", "NL"]}
        ]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "geo-restricted",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["purge:*"],
          "resources": ["zone:*"],
          "conditions": [
            {"field": "client_country", "operator": "in", "value": ["US", "DE", "GB", "NL"]}
          ]
        }
      ]
    }
  }'
```

### 3.10 Policy from a file

Save the policy as a JSON file and reference it with `@`:

```bash
# Save policy to file
cat > /tmp/policy.json << 'EOF'
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow",
      "actions": ["purge:*"],
      "resources": ["zone:aaaa1111bbbb2222cccc3333dddd4444"]
    }
  ]
}
EOF

# Reference it
gk keys create \
  --name "from-file" \
  --zone-id "$ZONE_ID" \
  --policy @/tmp/policy.json
```

---

## 4. Creating S3 Credentials

Every credential requires `name` and `policy`. Optional fields: `expires_in_days`, `created_by`. The response includes both `access_key_id` (GK prefix, 20 chars) and `secret_access_key` (64 hex chars) -- the secret is shown once only.

S3 credentials are not zone-scoped. They are account-level.

### 4.1 Minimal credential -- wildcard policy

Full S3 access to all buckets and objects.

**CLI:**

```bash
gk s3-credentials create \
  --name "full-s3-access" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["s3:*"],
        "resources": ["*"]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "full-s3-access",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["s3:*"],
          "resources": ["*"]
        }
      ]
    }
  }'
```

### 4.2 Read-only bucket access

Only `GetObject` and `ListBucket` on a specific bucket.

**CLI:**

```bash
gk s3-credentials create \
  --name "cdn-reader" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["s3:GetObject", "s3:ListBucket"],
        "resources": ["bucket:my-assets", "object:my-assets/*"]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cdn-reader",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["s3:GetObject", "s3:ListBucket"],
          "resources": ["bucket:my-assets", "object:my-assets/*"]
        }
      ]
    }
  }'
```

### 4.3 Prefix-scoped access

Read-only access restricted to a specific key prefix within a bucket.

**CLI:**

```bash
gk s3-credentials create \
  --name "public-reader" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["s3:GetObject", "s3:ListBucket"],
        "resources": ["object:my-assets/public/*", "bucket:my-assets"],
        "conditions": [
          {"field": "key.prefix", "operator": "starts_with", "value": "public/"}
        ]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "public-reader",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["s3:GetObject", "s3:ListBucket"],
          "resources": ["object:my-assets/public/*", "bucket:my-assets"],
          "conditions": [
            {"field": "key.prefix", "operator": "starts_with", "value": "public/"}
          ]
        }
      ]
    }
  }'
```

### 4.4 Multi-bucket mixed access

Full access to staging, read-only to production.

**CLI:**

```bash
gk s3-credentials create \
  --name "staging-writer" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["s3:*"],
        "resources": ["bucket:staging", "object:staging/*"]
      },
      {
        "effect": "allow",
        "actions": ["s3:GetObject", "s3:ListBucket"],
        "resources": ["bucket:production", "object:production/*"]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "staging-writer",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["s3:*"],
          "resources": ["bucket:staging", "object:staging/*"]
        },
        {
          "effect": "allow",
          "actions": ["s3:GetObject", "s3:ListBucket"],
          "resources": ["bucket:production", "object:production/*"]
        }
      ]
    }
  }'
```

### 4.5 Content-type restrictions

Only allow image uploads with specific extensions and content types.

**CLI:**

```bash
gk s3-credentials create \
  --name "image-uploader" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["s3:PutObject"],
        "resources": ["object:media/*"],
        "conditions": [
          {"field": "key.extension", "operator": "in", "value": ["jpg", "png", "webp"]},
          {"field": "content_type", "operator": "starts_with", "value": "image/"}
        ]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "image-uploader",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["s3:PutObject"],
          "resources": ["object:media/*"],
          "conditions": [
            {"field": "key.extension", "operator": "in", "value": ["jpg", "png", "webp"]},
            {"field": "content_type", "operator": "starts_with", "value": "image/"}
          ]
        }
      ]
    }
  }'
```

### 4.6 Deny patterns -- protect vault bucket from deletion

Full access everywhere, but explicit deny on delete operations for the vault bucket.

**CLI:**

```bash
gk s3-credentials create \
  --name "safe-admin" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {"effect": "allow", "actions": ["s3:*"], "resources": ["*"]},
      {
        "effect": "deny",
        "actions": ["s3:DeleteObject", "s3:DeleteBucket"],
        "resources": ["bucket:vault", "object:vault/*"]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "safe-admin",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {"effect": "allow", "actions": ["s3:*"], "resources": ["*"]},
        {
          "effect": "deny",
          "actions": ["s3:DeleteObject", "s3:DeleteBucket"],
          "resources": ["bucket:vault", "object:vault/*"]
        }
      ]
    }
  }'
```

### 4.7 Time-based -- restrict S3 writes to business hours (UTC)

Read access is unrestricted. Write/delete operations are only allowed Monday through Friday, 09:00--17:00 UTC.

**CLI:**

```bash
gk s3-credentials create \
  --name "business-hours-writer" \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["s3:GetObject", "s3:ListBucket"],
        "resources": ["*"]
      },
      {
        "effect": "allow",
        "actions": ["s3:PutObject", "s3:DeleteObject"],
        "resources": ["*"],
        "conditions": [
          {"field": "time.hour", "operator": "gte", "value": "9"},
          {"field": "time.hour", "operator": "lt", "value": "17"},
          {"not": {"field": "time.day_of_week", "operator": "in", "value": ["0", "6"]}}
        ]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "business-hours-writer",
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["s3:GetObject", "s3:ListBucket"],
          "resources": ["*"]
        },
        {
          "effect": "allow",
          "actions": ["s3:PutObject", "s3:DeleteObject"],
          "resources": ["*"],
          "conditions": [
            {"field": "time.hour", "operator": "gte", "value": "9"},
            {"field": "time.hour", "operator": "lt", "value": "17"},
            {"not": {"field": "time.day_of_week", "operator": "in", "value": ["0", "6"]}}
          ]
        }
      ]
    }
  }'
```

### 4.8 Credential with expiry

**CLI:**

```bash
gk s3-credentials create \
  --name "temp-reader" \
  --expires-in-days 30 \
  --policy '{
    "version": "2025-01-01",
    "statements": [
      {
        "effect": "allow",
        "actions": ["s3:GetObject", "s3:ListBucket"],
        "resources": ["*"]
      }
    ]
  }'
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "temp-reader",
    "expires_in_days": 30,
    "policy": {
      "version": "2025-01-01",
      "statements": [
        {
          "effect": "allow",
          "actions": ["s3:GetObject", "s3:ListBucket"],
          "resources": ["*"]
        }
      ]
    }
  }'
```

---

## 5. Purging Cache

Purge requests go to `POST /v1/zones/:zoneId/purge_cache` and require `Authorization: Bearer gw_<key_id>`.

### 5.1 Purge by hosts

**CLI:**

```bash
gk purge hosts --host "example.com,www.example.com"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/v1/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $KEY_ID" \
  -H "Content-Type: application/json" \
  -d '{"hosts": ["example.com", "www.example.com"]}'
```

### 5.2 Purge by tags

**CLI:**

```bash
gk purge tags --tag "product-page,header,footer"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/v1/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $KEY_ID" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["product-page", "header", "footer"]}'
```

### 5.3 Purge by prefixes

**CLI:**

```bash
gk purge prefixes --prefix "example.com/blog/,example.com/docs/"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/v1/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $KEY_ID" \
  -H "Content-Type: application/json" \
  -d '{"prefixes": ["example.com/blog/", "example.com/docs/"]}'
```

### 5.4 Purge by URLs

**CLI:**

```bash
gk purge urls --url "https://example.com/page.html,https://example.com/style.css"
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/v1/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $KEY_ID" \
  -H "Content-Type: application/json" \
  -d '{"files": ["https://example.com/page.html", "https://example.com/style.css"]}'
```

### 5.5 Purge URLs with cache key headers

For custom cache keys (e.g. device-type variants), pass objects with headers:

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/v1/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $KEY_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      {
        "url": "https://example.com/",
        "headers": {
          "CF-Device-Type": "mobile",
          "CF-IPCountry": "ES"
        }
      }
    ]
  }'
```

### 5.6 Purge everything

**CLI:**

```bash
gk purge everything              # prompts for confirmation
gk purge everything --force      # skip confirmation
```

**API:**

```bash
curl -X POST "$GATEKEEPER_URL/v1/zones/$ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $KEY_ID" \
  -H "Content-Type: application/json" \
  -d '{"purge_everything": true}'
```

### 5.7 Using rclone / S3 clients to test S3 proxy

Configure rclone:

```ini
[gatekeeper]
type = s3
provider = Other
endpoint = https://gate.example.com/s3
access_key_id = GK1A2B3C4D5E6F7890AB
secret_access_key = <your-secret-key>
```

Common operations:

```bash
# List buckets
rclone lsd gatekeeper:

# List objects in a bucket
rclone ls gatekeeper:my-bucket/

# List with prefix
rclone ls gatekeeper:my-bucket/public/

# Upload a file
rclone copy ./local-file.txt gatekeeper:my-bucket/path/

# Download a file
rclone copy gatekeeper:my-bucket/path/file.txt ./local/

# Delete a file
rclone deletefile gatekeeper:my-bucket/path/file.txt

# Sync a directory
rclone sync ./local-dir gatekeeper:my-bucket/prefix/
```

Using AWS CLI:

```bash
aws s3 ls --endpoint-url https://gate.example.com/s3 s3://my-bucket/
aws s3 cp ./file.txt --endpoint-url https://gate.example.com/s3 s3://my-bucket/path/
```

Using boto3 (Python):

```python
import boto3

s3 = boto3.client(
    's3',
    endpoint_url='https://gate.example.com/s3',
    aws_access_key_id='GK1A2B3C4D5E6F7890AB',
    aws_secret_access_key='<your-secret-key>',
)

# List buckets
response = s3.list_buckets()

# Get object
response = s3.get_object(Bucket='my-bucket', Key='public/file.txt')
```

---

## 6. Managing Keys and Credentials

### 6.1 Purge API Keys

#### List keys

**CLI:**

```bash
gk keys list --zone-id "$ZONE_ID"
gk keys list --zone-id "$ZONE_ID" --active-only     # exclude revoked/expired
gk keys list --zone-id "$ZONE_ID" --json             # raw JSON output
```

**API:**

```bash
# All keys for a zone
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/keys?zone_id=$ZONE_ID"

# Active only
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/keys?zone_id=$ZONE_ID&status=active"
```

#### Get key details

**CLI:**

```bash
gk keys get --zone-id "$ZONE_ID" --key-id "gw_abc123..."
```

**API:**

```bash
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/keys/gw_abc123...?zone_id=$ZONE_ID"
```

#### Revoke a key (soft)

Soft revoke: sets `revoked = 1`. The key is immediately rejected on subsequent purge requests (up to 60s cache TTL). The key row is preserved for audit.

**CLI:**

```bash
gk keys revoke --zone-id "$ZONE_ID" --key-id "gw_abc123..."
gk keys revoke --zone-id "$ZONE_ID" --key-id "gw_abc123..." --force   # skip confirmation
```

**API:**

```bash
curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/keys/gw_abc123...?zone_id=$ZONE_ID"
```

#### Permanently delete a key

Hard delete: removes the key row entirely. D1 analytics rows are preserved.

**CLI:**

```bash
gk keys revoke --zone-id "$ZONE_ID" --key-id "gw_abc123..." --permanent
gk keys revoke --zone-id "$ZONE_ID" --key-id "gw_abc123..." --permanent --force
```

**API:**

```bash
curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/keys/gw_abc123...?zone_id=$ZONE_ID&permanent=true"
```

#### Bulk revoke keys

Always do a dry run first to preview the impact.

**CLI (dry run):**

```bash
gk keys bulk-revoke --ids "gw_abc123,gw_def456,gw_ghi789"
```

**CLI (execute):**

```bash
gk keys bulk-revoke --ids "gw_abc123,gw_def456,gw_ghi789" --confirm
```

**API (dry run):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys/bulk-revoke" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["gw_abc123", "gw_def456", "gw_ghi789"],
    "confirm_count": 3,
    "dry_run": true
  }'
```

**API (execute):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys/bulk-revoke" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["gw_abc123", "gw_def456", "gw_ghi789"],
    "confirm_count": 3,
    "dry_run": false
  }'
```

Fat-finger guards: `confirm_count` must match the array length, max 100 items per request.

#### Bulk delete keys

**CLI (dry run):**

```bash
gk keys bulk-delete --ids "gw_abc123,gw_def456"
```

**CLI (execute):**

```bash
gk keys bulk-delete --ids "gw_abc123,gw_def456" --confirm
```

**API (dry run):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys/bulk-delete" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["gw_abc123", "gw_def456"],
    "confirm_count": 2,
    "dry_run": true
  }'
```

**API (execute):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/keys/bulk-delete" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["gw_abc123", "gw_def456"],
    "confirm_count": 2,
    "dry_run": false
  }'
```

### 6.2 S3 Credentials

#### List credentials

**CLI:**

```bash
gk s3-credentials list
gk s3-credentials list --active-only
gk s3-credentials list --json
```

**API:**

```bash
# All credentials
curl -H "X-Admin-Key: $ADMIN_KEY" "$GATEKEEPER_URL/admin/s3/credentials"

# Active only
curl -H "X-Admin-Key: $ADMIN_KEY" "$GATEKEEPER_URL/admin/s3/credentials?status=active"
```

#### Get credential details

**CLI:**

```bash
gk s3-credentials get --access-key-id "GK1A2B3C4D5E6F7890AB"
```

**API:**

```bash
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/s3/credentials/GK1A2B3C4D5E6F7890AB"
```

#### Revoke a credential (soft)

**CLI:**

```bash
gk s3-credentials revoke --access-key-id "GK1A2B3C4D5E6F7890AB"
gk s3-credentials revoke --access-key-id "GK1A2B3C4D5E6F7890AB" --force
```

**API:**

```bash
curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/s3/credentials/GK1A2B3C4D5E6F7890AB"
```

#### Permanently delete a credential

**CLI:**

```bash
gk s3-credentials revoke --access-key-id "GK1A2B3C4D5E6F7890AB" --permanent
gk s3-credentials revoke --access-key-id "GK1A2B3C4D5E6F7890AB" --permanent --force
```

**API:**

```bash
curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/s3/credentials/GK1A2B3C4D5E6F7890AB?permanent=true"
```

#### Bulk revoke S3 credentials

**CLI (dry run):**

```bash
gk s3-credentials bulk-revoke --ids "GK1A2B3C4D5E6F7890AB,GK9Z8Y7X6W5V4U3T2S1R"
```

**CLI (execute):**

```bash
gk s3-credentials bulk-revoke --ids "GK1A2B3C4D5E6F7890AB,GK9Z8Y7X6W5V4U3T2S1R" --confirm
```

**API (dry run):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials/bulk-revoke" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "access_key_ids": ["GK1A2B3C4D5E6F7890AB", "GK9Z8Y7X6W5V4U3T2S1R"],
    "confirm_count": 2,
    "dry_run": true
  }'
```

**API (execute):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials/bulk-revoke" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "access_key_ids": ["GK1A2B3C4D5E6F7890AB", "GK9Z8Y7X6W5V4U3T2S1R"],
    "confirm_count": 2,
    "dry_run": false
  }'
```

Note: S3 bulk operations use `access_key_ids` (not `ids`) as the field name.

#### Bulk delete S3 credentials

**CLI (dry run):**

```bash
gk s3-credentials bulk-delete --ids "GK1A2B3C4D5E6F7890AB,GK9Z8Y7X6W5V4U3T2S1R"
```

**CLI (execute):**

```bash
gk s3-credentials bulk-delete --ids "GK1A2B3C4D5E6F7890AB,GK9Z8Y7X6W5V4U3T2S1R" --confirm
```

**API (dry run):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials/bulk-delete" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "access_key_ids": ["GK1A2B3C4D5E6F7890AB", "GK9Z8Y7X6W5V4U3T2S1R"],
    "confirm_count": 2,
    "dry_run": true
  }'
```

**API (execute):**

```bash
curl -X POST "$GATEKEEPER_URL/admin/s3/credentials/bulk-delete" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "access_key_ids": ["GK1A2B3C4D5E6F7890AB", "GK9Z8Y7X6W5V4U3T2S1R"],
    "confirm_count": 2,
    "dry_run": false
  }'
```

---

## 7. Analytics

### 7.1 Purge Analytics

#### Events

Returns individual purge events from D1.

**CLI:**

```bash
# Recent events (default limit 100)
gk analytics events

# Filter by key
gk analytics events --key-id "gw_abc123..."

# Filter by time range (ISO 8601 or unix ms)
gk analytics events --since "2025-01-01T00:00:00Z" --until "2025-01-31T23:59:59Z"

# Limit results
gk analytics events --limit 50

# All filters combined
gk analytics events \
  --key-id "gw_abc123..." \
  --since "2025-01-01T00:00:00Z" \
  --until "2025-01-31T23:59:59Z" \
  --limit 500

# JSON output
gk analytics events --json
```

**API:**

```bash
# Recent events
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/analytics/events?zone_id=$ZONE_ID"

# With filters
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/analytics/events?zone_id=$ZONE_ID&key_id=gw_abc123&since=1704067200000&until=1706745599000&limit=500"
```

#### Summary

Aggregate statistics: total requests, URLs purged, breakdown by status and purge type, collapsed count, average duration.

**CLI:**

```bash
# Full summary
gk analytics summary

# Filtered summary
gk analytics summary --key-id "gw_abc123..." --since "2025-01-01T00:00:00Z"

# JSON output
gk analytics summary --json
```

**API:**

```bash
# Full summary
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/analytics/summary?zone_id=$ZONE_ID"

# Filtered
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/analytics/summary?zone_id=$ZONE_ID&key_id=gw_abc123&since=1704067200000"
```

### 7.2 S3 Analytics

S3 analytics are account-level (not zone-scoped). Additional filters: `credential_id`, `bucket`, `operation`.

#### Events

**CLI:**

```bash
# Recent S3 events
gk s3-analytics events

# Filter by credential
gk s3-analytics events --credential-id "GK1A2B3C4D5E6F7890AB"

# Filter by bucket
gk s3-analytics events --bucket "my-bucket"

# Filter by operation
gk s3-analytics events --operation "GetObject"

# Filter by time range
gk s3-analytics events --since "2025-01-01T00:00:00Z" --until "2025-01-31T23:59:59Z"

# Limit results
gk s3-analytics events --limit 200

# All filters combined
gk s3-analytics events \
  --credential-id "GK1A2B3C4D5E6F7890AB" \
  --bucket "my-bucket" \
  --operation "PutObject" \
  --since "2025-01-01T00:00:00Z" \
  --limit 100

# JSON output
gk s3-analytics events --json
```

**API:**

```bash
# Recent events
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/s3/analytics/events"

# With filters
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/s3/analytics/events?credential_id=GK1A2B3C4D5E6F7890AB&bucket=my-bucket&operation=PutObject&limit=100"
```

#### Summary

Aggregate statistics: total requests, breakdown by status/operation/bucket, average duration.

**CLI:**

```bash
# Full summary
gk s3-analytics summary

# Filtered
gk s3-analytics summary --bucket "my-bucket" --since "2025-01-01T00:00:00Z"

# JSON output
gk s3-analytics summary --json
```

**API:**

```bash
# Full summary
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/s3/analytics/summary"

# Filtered
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/s3/analytics/summary?bucket=my-bucket&since=1704067200000"
```

---

## 8. Configuration

All gateway settings live in the config registry -- a SQLite table inside the Durable Object. No env vars, no redeployment needed. Changes take effect immediately.

### Config keys

| Key                  | Default | What it does                                                    |
| -------------------- | ------- | --------------------------------------------------------------- |
| `bulk_rate`          | `50`    | Bulk purge token refill rate (tokens/sec)                       |
| `bulk_bucket_size`   | `500`   | Bulk purge burst capacity                                       |
| `bulk_max_ops`       | `100`   | Max items in a single bulk purge request                        |
| `single_rate`        | `3000`  | Single-file purge token refill rate (URLs/sec)                  |
| `single_bucket_size` | `6000`  | Single-file purge burst capacity                                |
| `single_max_ops`     | `500`   | Max URLs in a single purge-by-URL request                       |
| `key_cache_ttl_ms`   | `60000` | How long the DO caches key/credential lookups (ms)              |
| `retention_days`     | `30`    | D1 analytics retention (cron at 03:00 UTC deletes older events) |
| `s3_rps`             | --      | S3 proxy requests per second                                    |
| `s3_burst`           | --      | S3 proxy burst capacity                                         |

### 8.1 Viewing config

**CLI:**

```bash
gk config get
gk config get --json
```

**API:**

```bash
curl -H "X-Admin-Key: $ADMIN_KEY" "$GATEKEEPER_URL/admin/config"
```

The response includes three objects:

- `config` -- fully resolved values (what the gateway is using right now)
- `overrides` -- keys you have explicitly changed, with `updated_at` and `updated_by`
- `defaults` -- hardcoded fallback values

### 8.2 Changing config values

Set one or more values at once.

**CLI:**

```bash
# Single value
gk config set bulk_rate=100

# Multiple values
gk config set bulk_rate=100 single_rate=5000 retention_days=14
```

**API:**

```bash
# Single value
curl -X PUT "$GATEKEEPER_URL/admin/config" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"bulk_rate": 100}'

# Multiple values
curl -X PUT "$GATEKEEPER_URL/admin/config" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"bulk_rate": 100, "single_rate": 5000, "retention_days": 14}'
```

All values must be positive numbers. Unknown keys are rejected. The DO rebuilds its token buckets on every config write.

### 8.3 Resetting to defaults

Revert a single key back to its hardcoded default.

**CLI:**

```bash
gk config reset --key bulk_rate
```

**API:**

```bash
curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" \
  "$GATEKEEPER_URL/admin/config/bulk_rate"
```

---

## Appendix A: Policy Reference

### Policy version

The current and only supported policy version is `"2025-01-01"`.

### Policy structure

```json
{
  "version": "2025-01-01",
  "statements": [
    {
      "effect": "allow" | "deny",
      "actions": ["purge:url", "s3:GetObject", ...],
      "resources": ["zone:<id>", "bucket:<name>", ...],
      "conditions": [ ... ]
    }
  ]
}
```

### Evaluation order

1. If **any** deny statement matches --> **denied** (explicit deny always wins)
2. If **any** allow statement matches --> **allowed**
3. If nothing matches --> **denied** (implicit deny)

### Purge actions

`purge:url`, `purge:host`, `purge:tag`, `purge:prefix`, `purge:everything`, `purge:*`

### S3 actions

`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:ListAllMyBuckets`, `s3:CreateBucket`, `s3:DeleteBucket`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts`, `s3:*`

### Resource patterns

| Pattern                    | Matches                     |
| -------------------------- | --------------------------- |
| `zone:<id>`                | Specific zone               |
| `zone:*`                   | All zones                   |
| `bucket:<name>`            | Specific bucket             |
| `bucket:staging-*`         | Buckets matching prefix     |
| `object:<bucket>/<key>`    | Specific object             |
| `object:<bucket>/*`        | All objects in a bucket     |
| `object:<bucket>/public/*` | Objects under a key prefix  |
| `account:*`                | Account-level (ListBuckets) |
| `*`                        | Everything                  |

### Condition operators

| Operator       | Description                     |
| -------------- | ------------------------------- |
| `eq`           | Exact equality                  |
| `ne`           | Not equal                       |
| `contains`     | Substring match                 |
| `not_contains` | Substring exclusion             |
| `starts_with`  | Prefix match                    |
| `ends_with`    | Suffix match                    |
| `matches`      | Regex match (max 256 chars)     |
| `not_matches`  | Regex exclusion                 |
| `in`           | Value in a set                  |
| `not_in`       | Value not in set                |
| `wildcard`     | Glob-style matching             |
| `lt`           | Less than (numeric)             |
| `gt`           | Greater than (numeric)          |
| `lte`          | Less than or equal (numeric)    |
| `gte`          | Greater than or equal (numeric) |
| `exists`       | Field is present                |
| `not_exists`   | Field is absent                 |

### Compound conditions

- Top-level conditions: AND (all must match)
- `any: [...]`: OR (any child must match)
- `all: [...]`: explicit AND
- `not: {...}`: negation

### Condition fields -- purge

`host`, `tag`, `prefix`, `url`, `url.path`, `url.query`, `url.query.<param>`, `header.<name>`, `purge_everything`

### Condition fields -- S3

`bucket`, `key`, `key.prefix`, `key.filename`, `key.extension`, `method`, `content_type`, `content_length`, `source_bucket`, `source_key`, `list_prefix`

### Condition fields -- request-level (both services)

`client_ip`, `client_country`, `client_asn`, `time.hour`, `time.day_of_week`, `time.iso`

## Appendix B: Bulk Operation Safety

All bulk operations (`bulk-revoke`, `bulk-delete`) across all resource types share the same safety guards:

1. **`confirm_count`** (required) -- must exactly match the array length. Returns 400 if mismatched.
2. **`dry_run`** (optional, default `false`) -- when `true`, returns a preview without executing.
3. **Max 100 items** per request.
4. **Per-item statuses** in the response: `revoked`, `deleted`, `already_revoked`, `not_found`.

Always run with `dry_run: true` first (CLI: omit `--confirm`; API: set `"dry_run": true`) to preview the impact before executing.

## Appendix C: ID Prefixes

| Prefix  | Resource type         |
| ------- | --------------------- |
| `gw_`   | Purge API key         |
| `GK`    | S3 credential         |
| `upt_`  | Upstream CF API token |
| `upr2_` | Upstream R2 endpoint  |
