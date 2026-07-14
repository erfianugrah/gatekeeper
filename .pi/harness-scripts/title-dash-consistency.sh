#!/usr/bin/env bash
# Structural sensor: every dashboard/*.astro page's <DashboardLayout title="gatekeeper ? ...">
# must use the em-dash separator (U+2014), matching the majority convention (8 of 10 pages).
# A plain ASCII hyphen is a stray inconsistency predating the McMaster pass.
set -euo pipefail
cd "$(dirname "$0")/../.."
EMDASH=$'\xe2\x80\x94'
if rg -n "title=\"gatekeeper - " dashboard/src/pages/dashboard; then
  echo "FAIL: found a page title using a plain hyphen instead of the em-dash separator (U+2014) used by every other dashboard page." >&2
  exit 1
fi
COUNT=$(rg -c "title=\"gatekeeper ${EMDASH} " dashboard/src/pages/dashboard 2>/dev/null | wc -l)
if [ "$COUNT" -lt 10 ]; then
  echo "FAIL: expected all 10 dashboard page titles to use the em-dash separator, only found $COUNT." >&2
  exit 1
fi
echo "OK: all dashboard page titles use the em-dash separator consistently"
