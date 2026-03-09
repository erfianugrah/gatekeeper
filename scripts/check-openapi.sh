#!/usr/bin/env bash
# Check that openapi.json is up to date with the Zod schemas.
# Exits non-zero if the file would change after regeneration.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENAPI="$REPO_ROOT/openapi.json"

# Save current content
cp "$OPENAPI" "$OPENAPI.bak"

# Regenerate
npx tsx "$REPO_ROOT/scripts/generate-openapi.ts" > /dev/null 2>&1

# Compare
if ! diff -q "$OPENAPI" "$OPENAPI.bak" > /dev/null 2>&1; then
	# Restore original (don't leave dirty working tree)
	mv "$OPENAPI.bak" "$OPENAPI"
	echo "ERROR: openapi.json is out of date. Run 'npm run openapi' and commit the result."
	exit 1
fi

rm "$OPENAPI.bak"
echo "openapi.json is up to date."
