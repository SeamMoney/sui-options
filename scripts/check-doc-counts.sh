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

# Every phrasing the docs use to state the count. ONE source of truth, reused by
# both the count extraction and the per-file breakdown below, so they can't drift:
#   "641 / 641 ... tests"  ·  "641/641 passing"  ·  "641 Move tests"
#   "Total tests: 641"  ·  shields badge "move%20tests-641%2F641"
# (the "passing" form is move/SAFETY.md's — it was silently MISSED before, a
#  false-pass risk if it were ever the lone laggard.)
PAT='[0-9]{3} ?/ ?[0-9]{3} (Move )?(tests|passing)|[0-9]{3} Move tests|Total tests: [0-9]{3}|move%20tests-[0-9]{3}'
counts=$(grep -rhoE "$PAT" --include="*.md" . 2>/dev/null \
  | grep -v node_modules \
  | grep -oE "[0-9]{3}" | sort -u)

distinct=$(printf '%s\n' "$counts" | grep -c .)

if [ "$distinct" -le 1 ]; then
  # The docs agree with EACH OTHER. Now also check they match REALITY — the
  # number of #[test] functions in the Move source. This catches the other half
  # of the drift: when a test is added/removed and EVERY doc lags together (so the
  # consistency check above still passes), a judge running `sui move test` sees a
  # number no doc states. The #[test] count is an exact proxy for the `sui move
  # test` total — #[test_only] helpers are excluded by the literal `]`, and there
  # are no commented-out tests (verified: the proxy == the suite total). Cheap:
  # a grep, no compile.
  actual=$(grep -rhoE '#\[test\]' move/sources move/tests 2>/dev/null | wc -l | tr -d ' ')
  if [ -n "$counts" ] && [ "$counts" != "$actual" ]; then
    echo "✗ every doc agrees on ${counts} Move tests, but move/ source has ${actual} #[test] functions."
    echo ""
    echo "  The docs are STALE vs the source — a test was added/removed without a doc sync"
    echo "  (the agree-with-each-other check can't catch this; that's why this reality check exists)."
    echo "  Confirm with 'sui move test' (from move/), then make EVERY doc match ${actual}:"
    echo "  README (badge + body), move/SAFETY.md, deployments/ADDRESSES.md, docs/runbooks/v4.26_deploy_runbook.md."
    exit 1
  fi
  echo "✓ Move test count is consistent across all docs AND matches move/ source: ${counts:-<none stated>}${counts:+ (= ${actual} #[test] functions)}"
  exit 0
fi

echo "✗ docs disagree on the Move test count — distinct values found: $(printf '%s ' $counts)"
echo ""
# Per-file breakdown so a PARTIAL sync stops missing the same stragglers — the
# recurring failure mode is README getting synced while deployments/ADDRESSES.md
# and the runbook lag a release behind. Name every file + its stated count so
# they can ALL be reconciled in one pass:
echo "  per-file (sync every laggard to the authoritative count below):"
grep -rnoE "$PAT" --include="*.md" . 2>/dev/null | grep -v node_modules | sed 's/^/    /'
echo ""
actual=$(grep -rhoE '#\[test\]' move/sources move/tests 2>/dev/null | wc -l | tr -d ' ')
echo "  Authoritative count (move/ #[test] functions == 'sui move test' total): ${actual}."
echo "  Make every file above state ${actual}."
exit 1
