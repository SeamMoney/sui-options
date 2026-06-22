#!/usr/bin/env bash
# Gate that any autonomous agent must pass before committing.
# Refuses cleanly on anything suspicious; never makes it easy to push half-finished work.
#
# v2 hardening (2026-05-23, per Codex catch on commit 655a8d4):
#   The old preflight had two bugs that masked real frontend typecheck failures:
#     1. `npm run --silent typecheck 2>/dev/null` swallowed all stderr, so a
#        non-zero exit from npm produced no visible error.
#     2. A fallback to bare `npx -y tsc --noEmit` (no -b, no workspace context)
#        could pass even when the package's real `npm run typecheck` was failing,
#        because the bare tsc walks tsconfig.json without project references and
#        misses the cross-package errors that show up under `tsc -b`.
#   Fix:
#     a) Build @wick/sdk first — the frontend resolves @wick/sdk through
#        sdk/dist/, so a stale or missing sdk/dist makes the frontend typecheck
#        fail with errors that have nothing to do with the frontend itself.
#     b) Run the package's real `npm run typecheck` and fail hard on its
#        non-zero exit. No silent fallback. Stderr stays visible.

set -euo pipefail

cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '%s\n' "$*"; }

# 1. Branch sanity — never run on the protected branch without explicit override.
# Use symbolic-ref so this works pre-first-commit too.
branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo unknown)"
case "$branch" in
  main|master)
    if [ "${ALLOW_MAIN:-0}" != "1" ]; then
      red "preflight: refusing to run on protected branch '$branch'. set ALLOW_MAIN=1 to override."
      exit 1
    fi
    ;;
esac

# 2. Worktree sanity — agent must know exactly what it changed.
if [ -n "$(git status --porcelain | grep -v '^??' || true)" ]; then
  if [ "${ALLOW_DIRTY:-0}" != "1" ]; then
    red "preflight: working tree has tracked modifications. set ALLOW_DIRTY=1 to override."
    git status --short >&2
    exit 1
  fi
fi

# 3. Move tests — required if move/ has a buildable package.
if [ -f move/Move.toml ]; then
  if ! command -v sui >/dev/null 2>&1; then
    red "preflight: move/Move.toml exists but 'sui' CLI is not installed. install Sui CLI before committing Move changes."
    exit 2
  fi
  note "preflight: running 'sui move test' in move/..."
  (cd move && sui move test) || { red "preflight: move tests failed."; exit 2; }
fi

# 4. Build the workspace packages the frontend resolves through dist BEFORE
#    typechecking it. The frontend imports @wick/sdk AND @sui-options/pro-options
#    + @sui-options/candle-vision(-react) through their published dist layout
#    (file: deps; the only tsconfig path alias is @/* -> ./src). If any of those
#    dist trees is missing or stale, the frontend typecheck either fails with
#    cross-package errors unrelated to frontend code, or — worse — passes against
#    stale types. sdk was covered here originally; the other three were the same
#    gap, left open. Build them all. (check:dist separately guards that the
#    COMMITTED dist matches a fresh build.)
if [ -f package.json ] && grep -q '"build:packages"' package.json; then
  if [ ! -d node_modules ]; then
    red "preflight: root node_modules missing. run 'npm install' at the repo root before committing."
    exit 3
  fi
  note "preflight: building workspace packages the frontend resolves via dist (pro-options, candle-vision*)..."
  npm run --silent build:packages || {
    red "preflight: workspace package build failed. fix it before dependent packages can typecheck cleanly."
    exit 3
  }
fi
if [ -f sdk/package.json ]; then
  if [ ! -d sdk/node_modules ] && [ ! -d node_modules ]; then
    red "preflight: sdk/node_modules and root node_modules are both missing. run 'npm install' at the repo root before committing."
    exit 3
  fi
  note "preflight: building @wick/sdk (frontend resolves it through sdk/dist)..."
  (cd sdk && npm run --silent build) || {
    red "preflight: @wick/sdk build failed. fix the SDK before any dependent package can typecheck cleanly."
    exit 3
  }
fi

# 5. Frontend typecheck — REQUIRED. Uses the package's own 'npm run typecheck'
#    which respects tsconfig project references. No fallback — if the script
#    exists and fails, preflight fails. Stderr is preserved so the agent sees
#    the actual TS error messages.
if [ -f frontend/package.json ]; then
  if [ ! -d frontend/node_modules ] && [ ! -d node_modules ]; then
    red "preflight: frontend/node_modules and root node_modules are both missing. run 'npm install' at the repo root before committing."
    exit 4
  fi
  if ! grep -q '"typecheck"' frontend/package.json; then
    red "preflight: frontend/package.json is missing a 'typecheck' script. add 'tsc -b --noEmit'."
    exit 4
  fi
  note "preflight: typechecking frontend (npm run typecheck)..."
  (cd frontend && npm run typecheck) || {
    red "preflight: frontend typecheck failed."
    exit 4
  }
fi

# 6. Keeper typecheck — same shape as frontend.
if [ -f keeper/package.json ]; then
  if [ ! -d keeper/node_modules ] && [ ! -d node_modules ]; then
    red "preflight: keeper/node_modules and root node_modules are both missing. run 'npm install' at the repo root before committing."
    exit 5
  fi
  if ! grep -q '"typecheck"' keeper/package.json; then
    red "preflight: keeper/package.json is missing a 'typecheck' script."
    exit 5
  fi
  note "preflight: typechecking keeper (npm run typecheck)..."
  (cd keeper && npm run typecheck) || {
    red "preflight: keeper typecheck failed."
    exit 5
  }
fi

# 7. Bots typecheck — same shape.
if [ -f bots/package.json ]; then
  if [ ! -d bots/node_modules ] && [ ! -d node_modules ]; then
    red "preflight: bots/node_modules and root node_modules are both missing. run 'npm install' at the repo root before committing."
    exit 6
  fi
  if ! grep -q '"typecheck"' bots/package.json; then
    red "preflight: bots/package.json is missing a 'typecheck' script."
    exit 6
  fi
  note "preflight: typechecking bots (npm run typecheck)..."
  (cd bots && npm run typecheck) || {
    red "preflight: bots typecheck failed."
    exit 6
  }
fi

# 8. API typecheck — same shape. CI typechecks @wick/api too (ci.yml), and a
#    broken api typecheck (e.g. a .ts import extension like the keeper TS5097 in
#    #615) would otherwise slip the documented gate while CI is billing-down.
if [ -f api/package.json ]; then
  if [ ! -d api/node_modules ] && [ ! -d node_modules ]; then
    red "preflight: api/node_modules and root node_modules are both missing. run 'npm install' at the repo root before committing."
    exit 7
  fi
  if ! grep -q '"typecheck"' api/package.json; then
    red "preflight: api/package.json is missing a 'typecheck' script."
    exit 7
  fi
  note "preflight: typechecking api (npm run typecheck)..."
  (cd api && npm run typecheck) || {
    red "preflight: api typecheck failed."
    exit 7
  }
fi

green "preflight: ok"
