#!/usr/bin/env bash
# ─── Smoke test suite for gatekeeper ──────────────────────────────────────────
# Requires: curl, jq
# Usage:
#   npm run dev &                    # start wrangler dev
#   ./smoke-test.sh                  # run all tests (local)
#   BASE=https://gate.erfi.io ./smoke-test.sh    # run against live
#   ./smoke-test.sh -v               # verbose (print response bodies)
set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────

BASE="${BASE:-http://localhost:8787}"
VERBOSE="${1:-}"
PASS=0
FAIL=0
ERRORS=()

# Detect remote vs local — remote uses .env, local uses .dev.vars
IS_REMOTE=false
if [[ "$BASE" == https://* ]]; then
	IS_REMOTE=true
fi

# Read ADMIN_KEY — remote from .env (GATEKEEPER_ADMIN_KEY), local from .dev.vars
if [[ "$IS_REMOTE" == true ]]; then
	if [[ -f .env ]]; then
		ADMIN_KEY=$(grep '^GATEKEEPER_ADMIN_KEY=' .env | cut -d= -f2- || true)
	fi
	if [[ -z "${ADMIN_KEY:-}" ]]; then
		echo "ERROR: GATEKEEPER_ADMIN_KEY missing from .env (needed for remote)"
		exit 1
	fi
else
	if [[ ! -f .dev.vars ]]; then
		echo "ERROR: .dev.vars not found. Create it with ADMIN_KEY."
		exit 1
	fi
	ADMIN_KEY=$(grep '^ADMIN_KEY=' .dev.vars | cut -d= -f2-)
	if [[ -z "$ADMIN_KEY" ]]; then
		echo "ERROR: ADMIN_KEY missing from .dev.vars"
		exit 1
	fi
fi

# CF API token — needed to look up zone ID and to register as upstream.
# Reads from CF_API_TOKEN env var, falls back to UPSTREAM_PURGE_KEY in .env.
CF_API_TOKEN="${CF_API_TOKEN:-}"
if [[ -z "$CF_API_TOKEN" && -f .env ]]; then
	CF_API_TOKEN=$(grep '^UPSTREAM_PURGE_KEY=' .env | cut -d= -f2- || true)
fi
if [[ -z "$CF_API_TOKEN" ]]; then
	echo "ERROR: Set CF_API_TOKEN env var or UPSTREAM_PURGE_KEY in .env"
	exit 1
fi

# Track all created keys for cleanup
CREATED_KEYS=()

# ─── Helpers ─────────────────────────────────────────────────────────────────

# request METHOD PATH [BODY] [EXTRA_HEADERS...]
# If arg3 contains ": " it is treated as a header (no body).
# Sets $HTTP_CODE and $BODY after each call.
request() {
	local method="$1" path="$2" ; shift 2
	local body="" headers=()
	for arg in "$@"; do
		if [[ "$arg" == *": "* ]]; then
			headers+=("$arg")
		else
			body="$arg"
		fi
	done
	local args=(-s -w '\n%{http_code}' -X "$method" "${BASE}${path}")
	for hdr in "${headers[@]}"; do args+=(-H "$hdr"); done
	if [[ -n "$body" ]]; then
		args+=(-H "Content-Type: application/json" -d "$body")
	fi
	local raw
	raw=$(curl "${args[@]}")
	HTTP_CODE=$(echo "$raw" | tail -1)
	BODY=$(echo "$raw" | sed '$d')
}

# assert_status TEST_NAME EXPECTED_CODE
assert_status() {
	local name="$1" expected="$2"
	if [[ "$HTTP_CODE" == "$expected" ]]; then
		PASS=$((PASS + 1))
		printf "  \033[32mPASS\033[0m  %s (HTTP %s)\n" "$name" "$HTTP_CODE"
	else
		FAIL=$((FAIL + 1))
		ERRORS+=("$name: expected HTTP $expected, got HTTP $HTTP_CODE")
		printf "  \033[31mFAIL\033[0m  %s (expected %s, got %s)\n" "$name" "$expected" "$HTTP_CODE"
	fi
	if [[ "$VERBOSE" == "-v" ]]; then
		echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
	fi
}

# assert_json TEST_NAME JQ_EXPR EXPECTED_VALUE
assert_json() {
	local name="$1" expr="$2" expected="$3"
	local actual
	actual=$(echo "$BODY" | jq -r "$expr" 2>/dev/null || echo "JQ_ERROR")
	if [[ "$actual" == "$expected" ]]; then
		PASS=$((PASS + 1))
		printf "  \033[32mPASS\033[0m  %s (%s = %s)\n" "$name" "$expr" "$actual"
	else
		FAIL=$((FAIL + 1))
		ERRORS+=("$name: $expr expected '$expected', got '$actual'")
		printf "  \033[31mFAIL\033[0m  %s (%s expected '%s', got '%s')\n" "$name" "$expr" "$expected" "$actual"
	fi
}

# assert_header TEST_NAME KEY_TO_USE HEADER_PATTERN
assert_header() {
	local name="$1" key="$2" pattern="$3"
	local headers
	headers=$(curl -si -X POST "${BASE}${PURGE_URL}" \
		-H "Authorization: Bearer $key" \
		-H "Content-Type: application/json" \
		-d '{"hosts":["erfi.io"]}' 2>&1 | head -30)
	if echo "$headers" | grep -qiE "$pattern"; then
		PASS=$((PASS + 1))
		printf "  \033[32mPASS\033[0m  %s\n" "$name"
	else
		FAIL=$((FAIL + 1))
		ERRORS+=("$name: header pattern '$pattern' not found")
		printf "  \033[31mFAIL\033[0m  %s (header '%s' not found)\n" "$name" "$pattern"
	fi
}

# create_key NAME POLICY -> sets KEY_ID
create_key() {
	local name="$1" policy="$2"
	request POST "/admin/keys" \
		"{\"name\":\"$name\",\"zone_id\":\"$ZONE\",\"policy\":$policy}" \
		"X-Admin-Key: $ADMIN_KEY"
	KEY_ID=$(echo "$BODY" | jq -r '.result.key.id')
	if [[ "$KEY_ID" != "null" && -n "$KEY_ID" ]]; then
		CREATED_KEYS+=("$KEY_ID")
	fi
}

section() {
	echo ""
	printf "\033[1;35m─── %s ───\033[0m\n" "$1"
}

# ─── Discover zone ID ───────────────────────────────────────────────────────

echo ""
printf "\033[1mGatekeeper — Smoke Tests\033[0m\n"
echo "Base: $BASE"
echo "Remote: $IS_REMOTE"

# Check server is up
if ! curl -sf "$BASE/health" >/dev/null 2>&1; then
	echo "ERROR: Server not responding at $BASE/health. Start it with: npm run dev"
	exit 1
fi

# Get erfi.io zone ID from Cloudflare API
ZONE=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=erfi.io" \
	-H "Authorization: Bearer $CF_API_TOKEN" | jq -r '.result[0].id')

if [[ -z "$ZONE" || "$ZONE" == "null" ]]; then
	echo "ERROR: Could not resolve zone ID for erfi.io"
	exit 1
fi
echo "Zone: $ZONE (erfi.io)"

# Register CF API token as upstream token for purge
echo "Registering upstream token..."
UPSTREAM_REG=$(curl -s -X POST "${BASE}/admin/upstream-tokens" \
	-H "X-Admin-Key: $ADMIN_KEY" \
	-H "Content-Type: application/json" \
	-d "{\"name\":\"smoke-test-token\",\"token\":\"$CF_API_TOKEN\",\"zone_ids\":[\"$ZONE\"]}")
UPSTREAM_OK=$(echo "$UPSTREAM_REG" | jq -r '.success')
if [[ "$UPSTREAM_OK" != "true" ]]; then
	echo "ERROR: Failed to register upstream token: $(echo "$UPSTREAM_REG" | jq -r '.errors[0].message // "unknown"')"
	exit 1
fi
UPSTREAM_TOKEN_ID=$(echo "$UPSTREAM_REG" | jq -r '.result.id')
echo "Upstream token: $UPSTREAM_TOKEN_ID"

PURGE_URL="/v1/zones/$ZONE/purge_cache"

WILDCARD_POLICY='{"version":"2025-01-01","statements":[{"effect":"allow","actions":["purge:*"],"resources":["zone:'"$ZONE"'"]}]}'

# ─── 1. Health ───────────────────────────────────────────────────────────────

section "Health"

request GET "/health"
assert_status "GET /health -> 200" 200
assert_json "health body has ok:true" ".ok" "true"

# ─── 2. Admin Authentication ────────────────────────────────────────────────

section "Admin Authentication"

request GET "/admin/keys?zone_id=$ZONE"
assert_status "no admin key -> 401" 401

request GET "/admin/keys?zone_id=$ZONE" "X-Admin-Key: wrong-key-entirely"
assert_status "wrong admin key -> 401" 401

request GET "/admin/keys?zone_id=$ZONE" "X-Admin-Key: $ADMIN_KEY"
assert_status "correct admin key -> 200" 200

# ─── 3. Key Creation — happy path ───────────────────────────────────────────

section "Key Creation"

create_key "smoke-wildcard" "$WILDCARD_POLICY"
assert_status "create wildcard key -> 200" 200
assert_json "key has gw_ prefix" '.result.key.id | startswith("gw_")' "true"
assert_json "key name matches" '.result.key.name' "smoke-wildcard"
assert_json "key zone matches" '.result.key.zone_id' "$ZONE"
assert_json "key not revoked" '.result.key.revoked' "0"
WILDCARD_ID="$KEY_ID"

create_key "smoke-host-scoped" \
	'{"version":"2025-01-01","statements":[{"effect":"allow","actions":["purge:host"],"resources":["zone:'"$ZONE"'"],"conditions":[{"field":"host","operator":"eq","value":"erfi.io"}]}]}'
assert_status "create host-scoped key -> 200" 200
HOST_ID="$KEY_ID"

create_key "smoke-tag-scoped" \
	'{"version":"2025-01-01","statements":[{"effect":"allow","actions":["purge:tag"],"resources":["zone:'"$ZONE"'"],"conditions":[{"field":"tag","operator":"starts_with","value":"static-"}]}]}'
assert_status "create tag-scoped key -> 200" 200
TAG_ID="$KEY_ID"

create_key "smoke-prefix-scoped" \
	'{"version":"2025-01-01","statements":[{"effect":"allow","actions":["purge:prefix"],"resources":["zone:'"$ZONE"'"],"conditions":[{"field":"prefix","operator":"wildcard","value":"erfi.io/assets/*"}]}]}'
assert_status "create prefix-scoped key -> 200" 200
PREFIX_ID="$KEY_ID"

create_key "smoke-url-scoped" \
	'{"version":"2025-01-01","statements":[{"effect":"allow","actions":["purge:url"],"resources":["zone:'"$ZONE"'"],"conditions":[{"field":"host","operator":"eq","value":"erfi.io"}]}]}'
assert_status "create url-scoped key -> 200" 200
URL_ID="$KEY_ID"

create_key "smoke-multi-action" \
	'{"version":"2025-01-01","statements":[{"effect":"allow","actions":["purge:host","purge:tag"],"resources":["zone:'"$ZONE"'"]}]}'
assert_status "create multi-action key -> 200" 200
MULTI_ID="$KEY_ID"

create_key "smoke-revoke-target" "$WILDCARD_POLICY"
assert_status "create key for revoke -> 200" 200
REVOKE_ID="$KEY_ID"

# Second disposable key for zone_id-optional revoke test
create_key "smoke-revoke-target-2" "$WILDCARD_POLICY"
assert_status "create second revoke target -> 200" 200
REVOKE_ID_2="$KEY_ID"

request POST "/admin/keys" \
	"{\"name\":\"smoke-with-ratelimit\",\"zone_id\":\"$ZONE\",\"policy\":$WILDCARD_POLICY,\"rate_limit\":{\"bulk_rate\":10,\"bulk_bucket\":100}}" \
	"X-Admin-Key: $ADMIN_KEY"
assert_status "create key with per-key rate limit -> 200" 200
RATELIMIT_ID=$(echo "$BODY" | jq -r '.result.key.id')
CREATED_KEYS+=("$RATELIMIT_ID")
assert_json "per-key bulk_rate stored" '.result.key.bulk_rate' "10"
assert_json "per-key bulk_bucket stored" '.result.key.bulk_bucket' "100"

# ─── 4. Key Creation — validation errors ────────────────────────────────────

section "Key Creation Validation"

request POST "/admin/keys" '{"zone_id":"'"$ZONE"'","policy":'"$WILDCARD_POLICY"'}' \
	"X-Admin-Key: $ADMIN_KEY"
assert_status "missing name -> 400" 400

# zone_id is optional — missing zone_id should succeed
request POST "/admin/keys" '{"name":"smoke-no-zone","policy":'"$WILDCARD_POLICY"'}' \
	"X-Admin-Key: $ADMIN_KEY"
assert_status "missing zone_id -> 200 (zone_id is optional)" 200
NO_ZONE_KEY=$(echo "$BODY" | jq -r '.result.key.id')
CREATED_KEYS+=("$NO_ZONE_KEY")

request POST "/admin/keys" '{"name":"x","zone_id":"'"$ZONE"'"}' \
	"X-Admin-Key: $ADMIN_KEY"
assert_status "missing policy -> 400" 400

request POST "/admin/keys" '{"name":"x","zone_id":"'"$ZONE"'","policy":{"version":"wrong","statements":[]}}' \
	"X-Admin-Key: $ADMIN_KEY"
assert_status "invalid policy version -> 400" 400

request POST "/admin/keys" '{"name":"x","zone_id":"'"$ZONE"'","policy":{"version":"2025-01-01","statements":[]}}' \
	"X-Admin-Key: $ADMIN_KEY"
assert_status "empty statements -> 400" 400

request POST "/admin/keys" \
	'{"name":"x","zone_id":"'"$ZONE"'","policy":{"version":"2025-01-01","statements":[{"effect":"allow","actions":["purge:*"],"resources":["zone:'"$ZONE"'"],"conditions":[{"field":"x","operator":"matches","value":"(a+)+$"}]}]}}' \
	"X-Admin-Key: $ADMIN_KEY"
assert_status "dangerous regex -> 400" 400
assert_json "error mentions backtracking" '.errors[0].message' "statements[0].conditions[0].value: Regex pattern contains potentially catastrophic backtracking constructs"

request POST "/admin/keys" \
	'{"name":"x","zone_id":"'"$ZONE"'","policy":{"version":"2025-01-01","statements":[{"effect":"deny","actions":["purge:*"],"resources":["zone:'"$ZONE"'"]}]}}' \
	"X-Admin-Key: $ADMIN_KEY"
assert_status "effect=deny -> 400" 400

request POST "/admin/keys" 'not json at all' "X-Admin-Key: $ADMIN_KEY"
assert_status "invalid JSON body -> 400" 400

request POST "/admin/keys" \
	"{\"name\":\"x\",\"zone_id\":\"$ZONE\",\"policy\":$WILDCARD_POLICY,\"rate_limit\":{\"bulk_rate\":99999}}" \
	"X-Admin-Key: $ADMIN_KEY"
assert_status "rate_limit exceeds account default -> 400" 400

# ─── 5. List Keys ───────────────────────────────────────────────────────────

section "List Keys"

request GET "/admin/keys?zone_id=$ZONE" "X-Admin-Key: $ADMIN_KEY"
assert_status "list keys by zone -> 200" 200
KEY_COUNT=$(echo "$BODY" | jq '.result | length')
if [[ "$KEY_COUNT" -ge 8 ]]; then
	PASS=$((PASS + 1))
	printf "  \033[32mPASS\033[0m  key count >= 8 (got %s)\n" "$KEY_COUNT"
else
	FAIL=$((FAIL + 1))
	ERRORS+=("key count expected >= 8, got $KEY_COUNT")
	printf "  \033[31mFAIL\033[0m  key count >= 8 (got %s)\n" "$KEY_COUNT"
fi

request GET "/admin/keys?zone_id=$ZONE&status=active" "X-Admin-Key: $ADMIN_KEY"
assert_status "list active keys -> 200" 200

# zone_id is optional — listing without it returns all keys
request GET "/admin/keys" "X-Admin-Key: $ADMIN_KEY"
assert_status "list without zone_id -> 200 (returns all)" 200

request GET "/admin/keys?zone_id=aaaa1111bbbb2222cccc3333dddd4444" "X-Admin-Key: $ADMIN_KEY"
assert_status "list for unknown zone -> 200 (empty)" 200
assert_json "unknown zone returns empty" '.result | length' "0"

# ─── 6. Get Key ──────────────────────────────────────────────────────────────

section "Get Key"

request GET "/admin/keys/$WILDCARD_ID?zone_id=$ZONE" "X-Admin-Key: $ADMIN_KEY"
assert_status "get existing key -> 200" 200
assert_json "get key returns correct id" '.result.key.id' "$WILDCARD_ID"
assert_json "get key has policy JSON" '.result.key.policy | fromjson | .version' "2025-01-01"

request GET "/admin/keys/gw_00000000000000000000000000000000?zone_id=$ZONE" "X-Admin-Key: $ADMIN_KEY"
assert_status "get nonexistent key -> 404" 404

request GET "/admin/keys/$WILDCARD_ID?zone_id=aaaa1111bbbb2222cccc3333dddd4444" "X-Admin-Key: $ADMIN_KEY"
assert_status "get key with wrong zone -> 404" 404

# zone_id is optional — get without it should succeed
request GET "/admin/keys/$WILDCARD_ID" "X-Admin-Key: $ADMIN_KEY"
assert_status "get key without zone_id -> 200" 200

# ─── 7. Purge Authentication ────────────────────────────────────────────────

section "Purge Authentication"

request POST "$PURGE_URL" '{"hosts":["erfi.io"]}'
assert_status "no auth header -> 401" 401
assert_json "401 message" '.errors[0].message' "Missing Authorization: Bearer <key>"

request POST "$PURGE_URL" '{"hosts":["erfi.io"]}' "Authorization: Bearer gw_00000000000000000000000000000000"
assert_status "nonexistent key -> 401" 401
assert_json "401 invalid key" '.errors[0].message' "Invalid API key"

request POST "$PURGE_URL" '{"hosts":["erfi.io"]}' "Authorization: Bearer $REVOKE_ID"
assert_status "revoked key (not yet revoked) -> 200" 200

# Wrong zone — no upstream token registered for fake zone -> 502
request POST "/v1/zones/aaaa1111bbbb2222cccc3333dddd4444/purge_cache" \
	'{"hosts":["erfi.io"]}' "Authorization: Bearer $WILDCARD_ID"
assert_status "wrong zone (no upstream token) -> 502" 502

# ─── 8. Purge Validation ────────────────────────────────────────────────────

section "Purge Validation"

request POST "/v1/zones/not-a-hex-zone/purge_cache" '{"hosts":["erfi.io"]}' \
	"Authorization: Bearer $WILDCARD_ID"
assert_status "invalid zone ID format -> 400" 400

request POST "$PURGE_URL" 'broken json {{' "Authorization: Bearer $WILDCARD_ID"
assert_status "invalid JSON -> 400" 400

request POST "$PURGE_URL" '{}' "Authorization: Bearer $WILDCARD_ID"
assert_status "empty body -> 400" 400
assert_json "empty body message" '.errors[0].message' "Request body must contain one of: files, hosts, tags, prefixes, or purge_everything"

request POST "$PURGE_URL" '{"purge_everything":false}' "Authorization: Bearer $WILDCARD_ID"
assert_status "purge_everything=false -> 400" 400

# Generate 501-item files array
FILES_501=$(python3 -c "import json; print(json.dumps({'files':['https://erfi.io/'+str(i) for i in range(501)]}))")
request POST "$PURGE_URL" "$FILES_501" "Authorization: Bearer $WILDCARD_ID"
assert_status "oversized files array (501) -> 400" 400

# ─── 9. Purge Happy Path — all 5 types ──────────────────────────────────────

section "Purge Happy Path (wildcard key)"

request POST "$PURGE_URL" '{"hosts":["erfi.io"]}' "Authorization: Bearer $WILDCARD_ID"
assert_status "host purge -> 200" 200
assert_json "host purge success" '.success' "true"

request POST "$PURGE_URL" '{"tags":["static-v1"]}' "Authorization: Bearer $WILDCARD_ID"
assert_status "tag purge -> 200" 200

request POST "$PURGE_URL" '{"prefixes":["erfi.io/css/"]}' "Authorization: Bearer $WILDCARD_ID"
assert_status "prefix purge -> 200" 200

request POST "$PURGE_URL" '{"files":["https://erfi.io/smoke-test.txt"]}' "Authorization: Bearer $WILDCARD_ID"
assert_status "single-file purge -> 200" 200

request POST "$PURGE_URL" '{"purge_everything":true}' "Authorization: Bearer $WILDCARD_ID"
assert_status "purge_everything -> 200" 200

# Multiple files in one request
request POST "$PURGE_URL" '{"files":["https://erfi.io/a.js","https://erfi.io/b.js","https://erfi.io/c.css"]}' \
	"Authorization: Bearer $WILDCARD_ID"
assert_status "multi-file purge -> 200" 200

# Multiple hosts
request POST "$PURGE_URL" '{"hosts":["erfi.io","www.erfi.io"]}' "Authorization: Bearer $WILDCARD_ID"
assert_status "multi-host purge -> 200" 200

# Multiple tags
request POST "$PURGE_URL" '{"tags":["v1","v2","v3"]}' "Authorization: Bearer $WILDCARD_ID"
assert_status "multi-tag purge -> 200" 200

# ─── 10. Rate Limit Headers ─────────────────────────────────────────────────

section "Rate Limit Headers"

assert_header "Ratelimit header present" "$WILDCARD_ID" "^Ratelimit:"
assert_header "Ratelimit-Policy header present" "$WILDCARD_ID" "^Ratelimit-Policy:"
assert_header "Content-Type is JSON" "$WILDCARD_ID" "^Content-Type:.*application/json"

# ─── 11. Scoped Key Authorization ───────────────────────────────────────────

section "Scoped Key Authorization"

# Host-scoped: erfi.io allowed, other denied
request POST "$PURGE_URL" '{"hosts":["erfi.io"]}' "Authorization: Bearer $HOST_ID"
assert_status "host key: allowed host -> 200" 200

request POST "$PURGE_URL" '{"hosts":["evil.com"]}' "Authorization: Bearer $HOST_ID"
assert_status "host key: disallowed host -> 403" 403
assert_json "denied list present" '.denied[0]' "host:evil.com"

# Host key can't do tags
request POST "$PURGE_URL" '{"tags":["foo"]}' "Authorization: Bearer $HOST_ID"
assert_status "host key: tag purge (wrong action) -> 403" 403

# Host key can't do purge_everything
request POST "$PURGE_URL" '{"purge_everything":true}' "Authorization: Bearer $HOST_ID"
assert_status "host key: purge_everything (wrong action) -> 403" 403

# Tag-scoped: starts_with "static-"
request POST "$PURGE_URL" '{"tags":["static-v2"]}' "Authorization: Bearer $TAG_ID"
assert_status "tag key: matching tag -> 200" 200

request POST "$PURGE_URL" '{"tags":["dynamic-v1"]}' "Authorization: Bearer $TAG_ID"
assert_status "tag key: non-matching tag -> 403" 403

request POST "$PURGE_URL" '{"hosts":["erfi.io"]}' "Authorization: Bearer $TAG_ID"
assert_status "tag key: host purge (wrong action) -> 403" 403

# Prefix-scoped: wildcard "erfi.io/assets/*"
request POST "$PURGE_URL" '{"prefixes":["erfi.io/assets/css/"]}' "Authorization: Bearer $PREFIX_ID"
assert_status "prefix key: matching prefix -> 200" 200

request POST "$PURGE_URL" '{"prefixes":["erfi.io/api/"]}' "Authorization: Bearer $PREFIX_ID"
assert_status "prefix key: non-matching prefix -> 403" 403

# URL-scoped: host=erfi.io condition on purge:url action
request POST "$PURGE_URL" '{"files":["https://erfi.io/page.html"]}' "Authorization: Bearer $URL_ID"
assert_status "url key: matching file host -> 200" 200

request POST "$PURGE_URL" '{"files":["https://evil.com/page.html"]}' "Authorization: Bearer $URL_ID"
assert_status "url key: non-matching file host -> 403" 403

# Multi-action key: purge:host + purge:tag allowed, purge:prefix denied
request POST "$PURGE_URL" '{"hosts":["erfi.io"]}' "Authorization: Bearer $MULTI_ID"
assert_status "multi-action key: host purge -> 200" 200

request POST "$PURGE_URL" '{"tags":["any-tag"]}' "Authorization: Bearer $MULTI_ID"
assert_status "multi-action key: tag purge -> 200" 200

request POST "$PURGE_URL" '{"prefixes":["erfi.io/"]}' "Authorization: Bearer $MULTI_ID"
assert_status "multi-action key: prefix (not in actions) -> 403" 403

request POST "$PURGE_URL" '{"purge_everything":true}' "Authorization: Bearer $MULTI_ID"
assert_status "multi-action key: purge_everything (not in actions) -> 403" 403

# Partial match: one host allowed, one denied -> entire request denied
request POST "$PURGE_URL" '{"hosts":["erfi.io","evil.com"]}' "Authorization: Bearer $HOST_ID"
assert_status "host key: partial match (1 ok, 1 denied) -> 403" 403
assert_json "denied list has evil.com" '.denied[0]' "host:evil.com"

# ─── 12. Revoke Key (after purge tests to avoid breaking wildcard key) ──────

section "Revoke Key"

request DELETE "/admin/keys/$REVOKE_ID" "X-Admin-Key: $ADMIN_KEY"
assert_status "revoke key -> 200" 200
assert_json "revoke result" '.result.revoked' "true"

request DELETE "/admin/keys/$REVOKE_ID" "X-Admin-Key: $ADMIN_KEY"
assert_status "revoke already-revoked -> 404" 404

request GET "/admin/keys?zone_id=$ZONE&status=revoked" "X-Admin-Key: $ADMIN_KEY"
assert_status "list revoked keys -> 200" 200
REVOKED_COUNT=$(echo "$BODY" | jq '[.result[] | select(.id == "'"$REVOKE_ID"'")] | length')
if [[ "$REVOKED_COUNT" == "1" ]]; then
	PASS=$((PASS + 1))
	printf "  \033[32mPASS\033[0m  revoked key appears in revoked filter\n"
else
	FAIL=$((FAIL + 1))
	ERRORS+=("revoked key not in filtered list")
	printf "  \033[31mFAIL\033[0m  revoked key not in revoked filter\n"
fi

request DELETE "/admin/keys/gw_00000000000000000000000000000000" "X-Admin-Key: $ADMIN_KEY"
assert_status "revoke nonexistent key -> 404" 404

# Revoke without zone_id — zone_id is optional, so this should succeed
request DELETE "/admin/keys/$REVOKE_ID_2" "X-Admin-Key: $ADMIN_KEY"
assert_status "revoke without zone_id -> 200" 200

# Use revoked key for purge -> 403
request POST "$PURGE_URL" '{"hosts":["erfi.io"]}' "Authorization: Bearer $REVOKE_ID"
assert_status "purge with revoked key -> 403" 403
assert_json "403 revoked msg" '.errors[0].message' "API key has been revoked"

# ─── 13. Analytics ───────────────────────────────────────────────────────────

section "Analytics"

# Small delay to let fire-and-forget D1 writes complete
sleep 1

request GET "/admin/analytics/events?zone_id=$ZONE" "X-Admin-Key: $ADMIN_KEY"
assert_status "events -> 200" 200
EVENT_COUNT=$(echo "$BODY" | jq '.result | length')
if [[ "$EVENT_COUNT" -gt 0 ]]; then
	PASS=$((PASS + 1))
	printf "  \033[32mPASS\033[0m  events count > 0 (got %s)\n" "$EVENT_COUNT"
else
	FAIL=$((FAIL + 1))
	ERRORS+=("events count should be > 0")
	printf "  \033[31mFAIL\033[0m  events count > 0 (got %s)\n" "$EVENT_COUNT"
fi

# Event shape — including new fields
assert_json "event has key_id" '.result[0].key_id | startswith("gw_")' "true"
assert_json "event has zone_id" '.result[0].zone_id' "$ZONE"
assert_json "event has purge_type" '.result[0].purge_type | length > 0' "true"
assert_json "event has status" '.result[0].status | . > 0' "true"
assert_json "event has created_by" '.result[0].created_by | startswith("gw_")' "true"

# Find a 200-status event to verify response_detail
DETAIL_EVENT=$(echo "$BODY" | jq -r '[.result[] | select(.status == 200)][0].response_detail // ""')
if [[ -n "$DETAIL_EVENT" && "$DETAIL_EVENT" != "null" ]]; then
	PASS=$((PASS + 1))
	printf "  \033[32mPASS\033[0m  200-status event has response_detail\n"
else
	FAIL=$((FAIL + 1))
	ERRORS+=("200-status event missing response_detail")
	printf "  \033[31mFAIL\033[0m  200-status event missing response_detail\n"
fi

request GET "/admin/analytics/events?zone_id=$ZONE&limit=2" "X-Admin-Key: $ADMIN_KEY"
assert_status "events with limit -> 200" 200
LIMITED=$(echo "$BODY" | jq '.result | length')
if [[ "$LIMITED" -le 2 ]]; then
	PASS=$((PASS + 1))
	printf "  \033[32mPASS\033[0m  limit=2 respected (got %s)\n" "$LIMITED"
else
	FAIL=$((FAIL + 1))
	ERRORS+=("limit=2 not respected, got $LIMITED")
	printf "  \033[31mFAIL\033[0m  limit=2 not respected (got %s)\n" "$LIMITED"
fi

request GET "/admin/analytics/events?zone_id=$ZONE&key_id=$WILDCARD_ID" "X-Admin-Key: $ADMIN_KEY"
assert_status "events filtered by key_id -> 200" 200

request GET "/admin/analytics/summary?zone_id=$ZONE" "X-Admin-Key: $ADMIN_KEY"
assert_status "summary -> 200" 200
assert_json "summary has total_requests" '.result.total_requests | . > 0' "true"
assert_json "summary has by_status" '.result.by_status | keys | length > 0' "true"
assert_json "summary has by_purge_type" '.result.by_purge_type | keys | length > 0' "true"

# zone_id is optional for analytics too
request GET "/admin/analytics/events" "X-Admin-Key: $ADMIN_KEY"
assert_status "events without zone_id -> 200 (returns all)" 200

request GET "/admin/analytics/summary" "X-Admin-Key: $ADMIN_KEY"
assert_status "summary without zone_id -> 200 (returns all)" 200

# ─── 14. Dashboard Static Assets ────────────────────────────────────────────

# Skip dashboard tests for remote — CF Access intercepts with 302 redirect to SSO
if [[ "$IS_REMOTE" == true ]]; then
	section "Dashboard Static Assets (skipped — CF Access SSO redirect)"
	printf "  \033[33mSKIP\033[0m  Dashboard tests skipped on remote (CF Access 302)\n"
else
	section "Dashboard Static Assets"

	request GET "/dashboard/"
	assert_status "GET /dashboard/ -> 200" 200
	if echo "$BODY" | grep -q 'gatekeeper'; then
		PASS=$((PASS + 1))
		printf "  \033[32mPASS\033[0m  dashboard HTML contains 'gatekeeper'\n"
	else
		FAIL=$((FAIL + 1))
		ERRORS+=("dashboard HTML missing 'gatekeeper'")
		printf "  \033[31mFAIL\033[0m  dashboard HTML missing 'gatekeeper'\n"
	fi

	request GET "/dashboard/keys/"
	assert_status "GET /dashboard/keys/ -> 200" 200

	request GET "/dashboard/analytics/"
	assert_status "GET /dashboard/analytics/ -> 200" 200

	request GET "/dashboard/purge/"
	assert_status "GET /dashboard/purge/ -> 200" 200

	request GET "/dashboard/favicon.svg"
	assert_status "GET /dashboard/favicon.svg -> 200" 200

	# SPA fallback — unknown dashboard sub-route still serves index
	request GET "/dashboard/nonexistent/deep/route"
	assert_status "SPA fallback for unknown route -> 200" 200

	# Static JS assets
	JS_FILE=$(curl -s "$BASE/dashboard/" | grep -oP '/_astro/[^"]+\.js' | head -1)
	if [[ -n "$JS_FILE" ]]; then
		request GET "$JS_FILE"
		assert_status "JS asset ($JS_FILE) -> 200" 200
	else
		FAIL=$((FAIL + 1))
		ERRORS+=("No JS asset found in dashboard HTML")
		printf "  \033[31mFAIL\033[0m  No JS asset found in dashboard HTML\n"
	fi
fi

# Root redirect
request GET "/"
assert_status "GET / -> 200 (root index)" 200

# ─── 15. API Route 404s ─────────────────────────────────────────────────────

section "API 404s"

request GET "/v1/unknown"
assert_status "unknown /v1/ route -> 404" 404

request POST "/v1/zones/$ZONE/unknown"
assert_status "unknown zone sub-route -> 404" 404

request GET "/admin/nonexistent" "X-Admin-Key: $ADMIN_KEY"
assert_status "unknown /admin/ route -> 404" 404

# ─── Cleanup ─────────────────────────────────────────────────────────────────

section "Cleanup"

# Revoke all created smoke-test keys
for kid in "${CREATED_KEYS[@]}"; do
	curl -s -X DELETE "${BASE}/admin/keys/${kid}" \
		-H "X-Admin-Key: $ADMIN_KEY" >/dev/null 2>&1 || true
done
printf "  Revoked %d smoke-test keys\n" "${#CREATED_KEYS[@]}"

# Revoke the upstream token registered at the start
curl -s -X DELETE "${BASE}/admin/upstream-tokens/${UPSTREAM_TOKEN_ID}" \
	-H "X-Admin-Key: $ADMIN_KEY" >/dev/null 2>&1
printf "  Revoked upstream token %s\n" "$UPSTREAM_TOKEN_ID"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
printf "\033[1m═══════════════════════════════════════\033[0m\n"
TOTAL=$((PASS + FAIL))
if [[ $FAIL -eq 0 ]]; then
	printf "\033[1;32m  ALL %d TESTS PASSED\033[0m\n" "$TOTAL"
else
	printf "\033[1;31m  %d/%d FAILED\033[0m\n" "$FAIL" "$TOTAL"
	echo ""
	for err in "${ERRORS[@]}"; do
		printf "  \033[31m•\033[0m %s\n" "$err"
	done
fi
printf "\033[1m═══════════════════════════════════════\033[0m\n"

exit $FAIL
