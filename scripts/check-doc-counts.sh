#!/usr/bin/env bash
#
# Guard against the recurring "docs disagree on the Move test count" drift. The
# count is hard-coded in several judge-facing places (README badge + body,
# move/SAFETY.md, deployments/ADDRESSES.md, the v4.26 runbook). Every time the
# fleet adds tests, some get updated and some lag — it's drifted 553→571→605→641,
# and a judge running `sui move test` sees a number that mismatches a doc.
#
# Cheap check (no `sui move test`): extract every Move-test count stated in the
# Markdown and assert they all agree. Catches the disagreement — the common drift
# — without a slow compile. (To also confirm they match REALITY, run `sui move
# test` and update the docs.)
set -uo pipefail
cd "$(dirname "$0")/.."

# Pull the count from every phrasing used in the docs:
#   "641 / 641 ... tests"  ·  "641 Move tests"  ·  "Total tests: 641"
#   shields badge "move%20tests-641%2F641"
counts=$(grep -rhoE \
  "[0-9]{3} ?/ ?[0-9]{3} (Move )?tests|[0-9]{3} Move tests|Total tests: [0-9]{3}|move%20tests-[0-9]{3}" \
  --include="*.md" . 2>/dev/null \
  | grep -v node_modules \
  | grep -oE "[0-9]{3}" | sort -u)

distinct=$(printf '%s\n' "$counts" | grep -c .)

if [ "$distinct" -le 1 ]; then
  echo "✓ Move test count is consistent across all docs: ${counts:-<none stated>}"
  exit 0
fi

echo "✗ docs disagree on the Move test count — distinct values found:"
printf '%s\n' "$counts" | sed 's/^/    /'
echo ""
echo "  Run 'sui move test' (from move/) for the authoritative number, then make"
echo "  EVERY doc match: README (badge + body), move/SAFETY.md, deployments/ADDRESSES.md,"
echo "  docs/runbooks/v4.26_deploy_runbook.md."
exit 1
