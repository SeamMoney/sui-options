#!/usr/bin/env bash
# End-to-end on-chain smoke test for the Wick Markets package.
#
# Sequence (HIT path):
#   1. read package_id from deployments/testnet.json
#   2. create+share a MockOracle at price < barrier
#   3. split a small seed coin from gas
#   4. create_market<SUI> (60s expiry, barrier = 100, fee = 30bps)
#   5. buy_touch with a small payment, transfer Position back to sender
#   6. set_price across the barrier
#   7. mark_hit
#   8. redeem_winner (TOUCH wins under HIT) — transfer Coin back to sender
#   9. print final object IDs and Suiscan links
#
# Designed to fail fast: any non-zero rc from a tx aborts the whole run.

set -euo pipefail

cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }

# ---- read deployment ----

PKG=$(python3 -c 'import json; print(json.load(open("deployments/testnet.json"))["package_id"])')
SENDER=$(sui client active-address)
note "package: $PKG"
note "sender:  $SENDER"

# ---- helpers ----

# Parse a created object id whose type contains $1.
created_with_type() {
  python3 -c "
import json, sys
data = json.load(open(sys.argv[1]))
needle = sys.argv[2]
for c in data.get('objectChanges', []):
    if c.get('type') == 'created' and needle in c.get('objectType', ''):
        print(c.get('objectId', ''))
        break
" "$1" "$2"
}

# Parse the digest field.
digest_of() {
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('digest',''))" "$1"
}

# Strip Sui CLI's preamble lines (everything before the first line that starts with `{`).
strip_to_json() {
  awk '/^{/ {flag=1} flag {print}' "$1" > "$2"
}

run_tx() {
  local label="$1"
  shift
  local raw="/tmp/wick-${label}-raw.txt"
  local out="/tmp/wick-${label}.json"
  note ">>> $label"
  if ! "$@" >"$raw" 2>&1; then
    red "tx '$label' failed:"
    cat "$raw" >&2
    exit 2
  fi
  strip_to_json "$raw" "$out"
  note "    digest: $(digest_of "$out")"
}

# ---- step 1: create + share oracle ----

run_tx "oracle" \
  sui client call \
    --package "$PKG" \
    --module oracle_adapter \
    --function create_and_share \
    --args "BTC/USD" 90 \
    --gas-budget 100000000 \
    --json
ORACLE=$(created_with_type /tmp/wick-oracle.json "::oracle_adapter::MockOracle")
[ -n "$ORACLE" ] || { red "could not parse oracle id"; exit 3; }
note "    MockOracle: $ORACLE"

# ---- step 2: pick a gas coin and split a tiny seed ----

GAS_COIN=$(sui client gas --json 2>/dev/null \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); print(sorted(data, key=lambda c:int(c["mistBalance"]), reverse=True)[0]["gasCoinId"])')
note "gas coin: $GAS_COIN"

run_tx "split" \
  sui client split-coin \
    --coin-id "$GAS_COIN" \
    --amounts 100000 \
    --gas-budget 50000000 \
    --json
SEED_COIN=$(created_with_type /tmp/wick-split.json "0x2::coin::Coin<0x2::sui::SUI>")
[ -n "$SEED_COIN" ] || { red "could not parse split coin id"; exit 4; }
note "    seed coin: $SEED_COIN (100_000 MIST)"

# ---- step 3: create_market ----

# expiry = now + 5 minutes (give us breathing room)
EXPIRY_MS=$(python3 -c 'import time; print(int(time.time()*1000) + 5*60*1000)')
note "expiry_ms: $EXPIRY_MS"

# barrier = 100. oracle starts at 90 (below). We'll set above before mark_hit.
run_tx "create_market" \
  sui client call \
    --package "$PKG" \
    --module wick \
    --function create_market \
    --type-args 0x2::sui::SUI \
    --args "BTC/USD" 0 100 "$EXPIRY_MS" 30 "$SEED_COIN" 0x6 \
    --gas-budget 200000000 \
    --json
MARKET=$(created_with_type /tmp/wick-create_market.json "::wick::Market<")
LP=$(created_with_type /tmp/wick-create_market.json "::wick::LpPosition")
[ -n "$MARKET" ] || { red "could not parse market id"; exit 5; }
note "    Market<SUI>: $MARKET"
note "    LpPosition:  $LP"

# ---- step 4: buy_touch (PTB so we can transfer the returned Position) ----

run_tx "buy_touch" \
  sui client ptb \
    --split-coins gas "[50000]" \
    --assign payment \
    --move-call "${PKG}::wick::buy_touch" "<0x2::sui::SUI>" "@${MARKET}" payment.0 @0x6 \
    --assign pos \
    --transfer-objects "[pos]" "@${SENDER}" \
    --gas-budget 200000000 \
    --json
POS=$(created_with_type /tmp/wick-buy_touch.json "::wick::Position")
[ -n "$POS" ] || { red "could not parse position id"; exit 6; }
note "    Position(TOUCH): $POS"

# ---- step 5: set oracle price above barrier ----

run_tx "set_price" \
  sui client call \
    --package "$PKG" \
    --module oracle_adapter \
    --function set_price \
    --args "$ORACLE" 150 \
    --gas-budget 50000000 \
    --json

# ---- step 6: mark_hit ----

run_tx "mark_hit" \
  sui client call \
    --package "$PKG" \
    --module wick \
    --function mark_hit \
    --type-args 0x2::sui::SUI \
    --args "$MARKET" "$ORACLE" 0x6 \
    --gas-budget 100000000 \
    --json

# ---- step 7: redeem_winner (PTB to transfer returned Coin) ----

run_tx "redeem_winner" \
  sui client ptb \
    --move-call "${PKG}::wick::redeem_winner" "<0x2::sui::SUI>" "@${MARKET}" "@${POS}" \
    --assign payout \
    --transfer-objects "[payout]" "@${SENDER}" \
    --gas-budget 200000000 \
    --json

green ""
green "=== smoke: ok ==="
note "  package_id:  $PKG"
note "  oracle:      $ORACLE       https://suiscan.xyz/testnet/object/$ORACLE"
note "  market:      $MARKET       https://suiscan.xyz/testnet/object/$MARKET"
note "  lp:          $LP           https://suiscan.xyz/testnet/object/$LP"
note "  position:    $POS (consumed by redeem_winner)"
note ""
note "Inspect the market post-redeem: sui client object $MARKET --json"
