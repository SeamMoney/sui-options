#!/usr/bin/env bash
# Best-effort top-up from the Sui testnet faucet.
#
# What this CAN do:
#   - Loop over the v1/v2 HTTP faucet endpoints with backoff
#   - Honor the "Wait for Ns" hint in 429 responses
#   - Fund any address (defaults to active sui CLI address)
#   - Stop after a target balance is reached or after a deadline
#
# What this CANNOT do:
#   - Get you "lots" of SUI. The public faucet drips ~1 SUI per success,
#     and IP-level rate limiting caps real throughput at ~1 success per few
#     minutes per IP. Realistic ceiling is ~10–50 SUI per day.
#   - Bypass captcha. The web UI at https://faucet.sui.io has captcha; the
#     HTTP API doesn't but is more aggressively rate-limited.
#
# For bottomless dev funds: run a local network with `sui start`.
#
# Usage:
#   ./scripts/faucet.sh                        # use active CLI address, target 5 SUI
#   ./scripts/faucet.sh <address>              # specific address
#   TARGET_SUI=10 ./scripts/faucet.sh          # different target
#   DEADLINE_SECONDS=600 ./scripts/faucet.sh   # cap total wait

set -euo pipefail

ADDR="${1:-$(sui client active-address 2>/dev/null || true)}"
if [ -z "$ADDR" ]; then
  echo "faucet: no address. pass one as the first arg or set an active sui CLI address." >&2
  exit 1
fi

TARGET_SUI="${TARGET_SUI:-5}"
TARGET_MIST=$(awk "BEGIN { printf \"%d\", $TARGET_SUI * 1000000000 }")
DEADLINE_SECONDS="${DEADLINE_SECONDS:-1800}" # 30 min default

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '%s\n' "$*"; }

current_balance_mist() {
  sui client gas --json 2>/dev/null \
    | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(0); sys.exit(0)
print(sum(int(c["mistBalance"]) for c in data) if data else 0)
' 2>/dev/null || echo 0
}

request_drip() {
  local endpoint="$1"
  curl -sS -m 10 -X POST \
    "https://faucet.testnet.sui.io/${endpoint}/gas" \
    -H "Content-Type: application/json" \
    -d "{\"FixedAmountRequest\":{\"recipient\":\"${ADDR}\"}}"
}

note "faucet: address=$ADDR  target=${TARGET_SUI} SUI  deadline=${DEADLINE_SECONDS}s"

start=$SECONDS
attempt=0
while :; do
  bal=$(current_balance_mist)
  if [ "$bal" -ge "$TARGET_MIST" ]; then
    green "faucet: target reached. balance=$bal MIST"
    exit 0
  fi

  elapsed=$((SECONDS - start))
  if [ "$elapsed" -ge "$DEADLINE_SECONDS" ]; then
    red "faucet: deadline reached (${elapsed}s). balance=$bal MIST. giving up."
    exit 2
  fi

  attempt=$((attempt + 1))
  for ep in v2 v1; do
    note "[attempt $attempt][$ep] balance=$bal MIST  elapsed=${elapsed}s  requesting drip..."
    resp=$(request_drip "$ep" || true)
    note "  -> $resp"
    # Parse "Wait for Ns" hint
    wait_hint=$(printf '%s' "$resp" | grep -oE 'Wait for [0-9]+s' | head -1 | grep -oE '[0-9]+' || true)
    if [ -n "$wait_hint" ]; then
      sleep_for=$((wait_hint + 1))
    else
      sleep_for=8
    fi
    sleep "$sleep_for"
  done

  # Cooldown between full attempt cycles to avoid amplifying rate limits.
  sleep 30
done
