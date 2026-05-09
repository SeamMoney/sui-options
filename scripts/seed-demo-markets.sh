#!/usr/bin/env bash
# Seed a small set of fresh markets so the public testnet demo always has
# live content. Designed to be re-runnable — every invocation creates new
# markets with rolling expiries (1m, 5m, 30m). The keeper bot will settle
# them automatically when conditions are met.
#
# Run from repo root:
#   ./scripts/seed-demo-markets.sh
#
# Optional env vars:
#   SEED_MIST=200000      collateral per market (mist)
#   FEE_BPS=30            CPMM fee in basis points

set -euo pipefail

cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

SEED_MIST="${SEED_MIST:-200000}"
FEE_BPS="${FEE_BPS:-30}"
PKG=$(python3 -c 'import json; print(json.load(open("deployments/testnet.json"))["package_id"])')
SENDER=$(sui client active-address)

note "package: $PKG"
note "sender:  $SENDER"
note "seed:    $SEED_MIST mist per market"

strip_to_json() { awk '/^{/ {flag=1} flag {print}' "$1" > "$2"; }
created_with_type() {
  python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
needle = sys.argv[2]
for c in d.get('objectChanges', []):
    if c.get('type') == 'created' and needle in c.get('objectType', ''):
        print(c.get('objectId',''))
        break
" "$1" "$2"
}

run_tx() {
  local label="$1"; shift
  local raw="/tmp/wick-seed-${label}-raw.txt"
  local out="/tmp/wick-seed-${label}.json"
  if ! "$@" >"$raw" 2>&1; then
    red "tx '$label' failed:"; cat "$raw" >&2; exit 2
  fi
  strip_to_json "$raw" "$out"
}

# Markets to seed. Each row: ASSET INITIAL_PRICE BARRIER DIRECTION_CODE EXPIRY_OFFSET_S
SPECS=(
  "BTC/USD     90    100   0   60"     # 1-minute touch above 100, oracle starts at 90
  "BTC/USD     110   100   1   300"    # 5-minute touch below 100, oracle starts at 110
  "SUI/USD     5300  5400  0   600"    # 10-minute touch above 5400, oracle starts at 5300
  "ETH/USD     3500  3450  1   1800"   # 30-minute touch below 3450, oracle starts at 3500
)

idx=0
for spec in "${SPECS[@]}"; do
  read -r ASSET INIT BARRIER DIR OFFSET <<< "$spec"
  idx=$((idx + 1))

  hr
  green "[$idx/${#SPECS[@]}]  $ASSET  init=$INIT  barrier=$BARRIER  dir=$DIR  expires=+${OFFSET}s"

  note ">>> create_and_share oracle"
  run_tx "oracle-$idx" \
    sui client call \
      --package "$PKG" --module oracle_adapter --function create_and_share \
      --args "$ASSET" "$INIT" --gas-budget 100000000 --json
  ORACLE=$(created_with_type "/tmp/wick-seed-oracle-$idx.json" "::oracle_adapter::MockOracle")
  note "    oracle: $ORACLE"

  note ">>> split seed coin"
  GAS=$(sui client gas --json 2>/dev/null \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(sorted(d,key=lambda c:int(c["mistBalance"]),reverse=True)[0]["gasCoinId"])')
  run_tx "split-$idx" \
    sui client split-coin --coin-id "$GAS" --amounts "$SEED_MIST" \
      --gas-budget 50000000 --json
  SEED_COIN=$(created_with_type "/tmp/wick-seed-split-$idx.json" "0x2::coin::Coin<0x2::sui::SUI>")

  EXPIRY_MS=$(python3 -c "import time;print(int(time.time()*1000) + ${OFFSET}*1000)")
  note ">>> create_market  expiry_ms=$EXPIRY_MS"
  run_tx "market-$idx" \
    sui client call \
      --package "$PKG" --module wick --function create_market \
      --type-args 0x2::sui::SUI \
      --args "$ASSET" "$DIR" "$BARRIER" "$EXPIRY_MS" "$FEE_BPS" "$SEED_COIN" 0x6 \
      --gas-budget 200000000 --json
  MARKET=$(created_with_type "/tmp/wick-seed-market-$idx.json" "::wick::Market<")
  note "    market: $MARKET"
  note "    https://suiscan.xyz/testnet/object/$MARKET"
done

hr
green "OK — seeded $idx markets. The keeper bot will auto-settle them as expiry / oracle conditions trigger."
