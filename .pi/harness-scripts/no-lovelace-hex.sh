#!/usr/bin/env bash
# Structural sensor: fails if any pre-migration "Lovelace" neon hex literal
# (from the pre-McMaster theme) still appears anywhere under dashboard/src.
# These are distinct from the McMaster palette hexes defined in globals.css.
set -euo pipefail
cd "$(dirname "$0")/../.."
PATTERN='#5adecd|#f37e96|#f1a171|#8796f4|#ff4870|#c574dd|#79e6f3|#ffd866|#282a36|#414457|#fcfcfc|#bdbdc1'
if rg -n --glob 'dashboard/src/**' -e "$PATTERN" dashboard/src; then
  echo "FAIL: leftover Lovelace-theme neon hex literals found (see above). Remap to the McMaster status-* tokens in globals.css." >&2
  exit 1
fi
echo "OK: no leftover Lovelace neon hex literals in dashboard/src"
