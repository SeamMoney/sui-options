#!/usr/bin/env bash
#
# Guard against stale committed dist/. Several packages COMMIT their compiled
# dist/ (the frontend imports @wick/sdk and @sui-options/pro-options from dist,
# and they ship to npm from dist) — so a PR that edits src/ but forgets to
# rebuild dist/ silently ships stale compiled code. That's how a fairness or
# pricing fix could land in source yet never reach the running game.
#
# This rebuilds every dist-committing package and fails if the committed dist
# differs from a fresh build. tsc output here is deterministic, so a clean tree
# means dist is in sync; any diff means "rebuild and commit dist/". Mirrors the
# existing `conformance:check` git-diff guard.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build:packages
npm -w @wick/sdk run build

DIST_DIRS=(
  packages/candle-vision/dist
  packages/candle-vision-react/dist
  packages/pro-options/dist
  sdk/dist
)

if ! git diff --quiet -- "${DIST_DIRS[@]}"; then
  echo ""
  echo "✗ committed dist/ is STALE — it does not match a fresh build:"
  git --no-pager diff --stat -- "${DIST_DIRS[@]}"
  echo ""
  echo "Fix: npm run build:packages && npm -w @wick/sdk run build, then commit the dist/ changes."
  exit 1
fi

echo "✓ all committed dist/ matches a fresh build (${#DIST_DIRS[@]} packages)"
