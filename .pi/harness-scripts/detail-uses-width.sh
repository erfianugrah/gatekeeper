#!/usr/bin/env bash
# Sensor: the expanded event-detail row must use horizontal space on desktop.
# Fails if the old max-w-2xl left-third cap survives, or if no responsive
# (lg:) breakpoint layout was introduced to split fields from the JSON panel.
set -euo pipefail

FILE="dashboard/src/components/analytics/EventDetailRow.tsx"

if [[ ! -f "$FILE" ]]; then
	echo "FAIL: $FILE not found"
	exit 1
fi

fail=0

if grep -q 'max-w-2xl' "$FILE"; then
	echo "FAIL: 'max-w-2xl' still present - this cap pins the detail panel to the left third; remove it so the content can use the full row width."
	fail=1
fi

if ! grep -qE 'lg:grid-cols|xl:grid-cols|lg:flex' "$FILE"; then
	echo "FAIL: no responsive desktop breakpoint (lg:/xl: grid or flex) found - add a large-screen layout that spreads content across the horizontal space (e.g. scalar fields in one column, the response_detail JSON panel in a wider column beside them)."
	fail=1
fi

# response_detail must still render (in its own wide panel).
if ! grep -qE "response_detail" "$FILE"; then
	echo "FAIL: response_detail rendering vanished - it must still render (in its own wide panel)."
	fail=1
fi

if [[ "$fail" -eq 0 ]]; then
	echo "OK: detail row uses horizontal space (no max-w-2xl cap, responsive desktop layout present)."
fi
exit "$fail"
