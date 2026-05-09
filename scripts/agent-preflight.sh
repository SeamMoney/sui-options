#!/usr/bin/env bash
# Gate that any autonomous agent must pass before committing.
# Refuses cleanly on anything suspicious; never makes it easy to push half-finished work.

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

# 4. Frontend typecheck — required if frontend/ has package.json.
if [ -f frontend/package.json ]; then
  note "preflight: typechecking frontend..."
  if (cd frontend && npm run --silent typecheck) 2>/dev/null; then
    :
  elif (cd frontend && npx -y tsc --noEmit); then
    :
  else
    red "preflight: frontend typecheck failed."
    exit 3
  fi
fi

# 5. Keeper typecheck — same idea.
if [ -f keeper/package.json ]; then
  note "preflight: typechecking keeper..."
  if (cd keeper && npm run --silent typecheck) 2>/dev/null; then
    :
  elif (cd keeper && npx -y tsc --noEmit); then
    :
  else
    red "preflight: keeper typecheck failed."
    exit 4
  fi
fi

green "preflight: ok"
