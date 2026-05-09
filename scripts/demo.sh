#!/usr/bin/env bash
# Multi-actor on-chain lifecycle demo for the Wick Markets package.
#
# Two real testnet wallets exchange real testnet SUI through the protocol
# and we print a P&L table that proves conservation:
#
#   bob_payout + alice_lp_claim == SEED + PAY     (vault drained exactly)
#   bob_gain   == alice_loss                       (zero-sum at the protocol)
#
# Default path (HIT): bob buys TOUCH, oracle is moved across the barrier,
# market is marked HIT, both sides redeem.
#
# --expired path: bob buys NO_TOUCH, the market is allowed to expire with
# the oracle parked below the barrier, we settle_expired, both sides redeem.
#
# Either way: alice (LP) is on the losing side and bob (bettor) is on the
# winning side, so the table shows alice_pnl == -bob_pnl modulo gas.

set -euo pipefail

cd "$(dirname "$0")/.."

PATH_FLAG="${1:-}"
EXPIRED=0
case "${PATH_FLAG}" in
  ""|--hit) EXPIRED=0 ;;
  --expired) EXPIRED=1 ;;
  *) echo "usage: $0 [--hit | --expired]" >&2; exit 2 ;;
esac

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

PKG=$(python3 -c 'import json; print(json.load(open("deployments/testnet.json"))["package_id"])')
ALICE=$(python3 -c 'import json; print(json.load(open("deployments/wallets.json"))["actors"]["alice"]["address"])')
BOB=$(python3 -c 'import json; print(json.load(open("deployments/wallets.json"))["actors"]["bob"]["address"])')

note "package: $PKG"
note "alice (LP):     $ALICE"
note "bob   (bettor): $BOB"
note "path: $([ $EXPIRED -eq 1 ] && echo EXPIRED/NO_TOUCH || echo HIT/TOUCH)"

# ---- helpers ----

strip_to_json() { awk '/^{/ {flag=1} flag {print}' "$1" > "$2"; }

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

digest_of() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('digest',''))" "$1"; }

run_tx() {
  local label="$1"; shift
  local raw="/tmp/wick-demo-${label}-raw.txt"
  local out="/tmp/wick-demo-${label}.json"
  note ">>> $label"
  if ! "$@" >"$raw" 2>&1; then
    red "tx '$label' failed:"; cat "$raw" >&2; exit 3
  fi
  strip_to_json "$raw" "$out"
  note "    digest: $(digest_of "$out")"
}

active_switch() {
  local who="$1"
  sui client switch --address "$who" >/dev/null
}

# Sum balanceChanges (mist) at a given owner address from a tx json.
balance_change_at() {
  python3 -c "
import json, sys
data = json.load(open(sys.argv[1]))
addr = sys.argv[2].lower()
total = 0
for b in data.get('balanceChanges', []):
    o = b.get('owner') or {}
    a = (o.get('AddressOwner') or '').lower()
    if a == addr:
        total += int(b.get('amount', 0))
print(total)
" "$1" "$2"
}

# Read a single field of an object's content payload (e.g. "balance" for Coin, "amount" for Position).
object_field() {
  sui client object "$1" --json 2>/dev/null \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
content = d.get('content', {}) or {}
fields = content.get('fields', content)  # CLI nests under .fields on some versions, flat on others
print(fields[sys.argv[1]])
" "$2"
}

# Pick the largest gas coin owned by the active address (mist).
biggest_gas_coin() {
  sui client gas --json 2>/dev/null \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); print(sorted(data, key=lambda c:int(c["mistBalance"]), reverse=True)[0]["gasCoinId"])'
}

total_sui_mist() {
  sui client gas --json 2>/dev/null \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); print(sum(int(c["mistBalance"]) for c in data))'
}

fmt_mist() { python3 -c "v=int($1); print(f'{v:>14,d} mist  ({v/1e9:.6f} SUI)')"; }
fmt_signed() { python3 -c "v=int($1); s='+' if v>=0 else '-'; print(f'{s}{abs(v):>13,d} mist  ({v/1e9:+.6f} SUI)')"; }

# ---- params ----

SEED=200000   # 0.0002 SUI of LP collateral
PAY=80000     # 0.00008 SUI of bettor payment
BARRIER=100
START_PRICE=90
HIT_PRICE=150

if [ $EXPIRED -eq 1 ]; then
  EXPIRY_OFFSET_MS=60000   # 60s — we sleep then settle_expired
  SLEEP_AFTER=70
else
  EXPIRY_OFFSET_MS=300000  # 5 min — plenty of headroom; we mark_hit immediately
  SLEEP_AFTER=0
fi

# ---- starting balances ----

active_switch "$ALICE"
ALICE_START=$(total_sui_mist)
active_switch "$BOB"
BOB_START=$(total_sui_mist)

hr
note "PHASE 0 — starting wallet balances"
note "  alice: $(fmt_mist $ALICE_START)"
note "  bob:   $(fmt_mist $BOB_START)"

# ---- PHASE 1: alice creates oracle + market ----

active_switch "$ALICE"

run_tx "oracle" \
  sui client call \
    --package "$PKG" --module oracle_adapter --function create_and_share \
    --args "BTC/USD" $START_PRICE \
    --gas-budget 100000000 --json
ORACLE=$(created_with_type /tmp/wick-demo-oracle.json "::oracle_adapter::MockOracle")
[ -n "$ORACLE" ] || { red "no oracle"; exit 4; }
note "    MockOracle: $ORACLE"

ALICE_GAS=$(biggest_gas_coin)
run_tx "split_seed" \
  sui client split-coin --coin-id "$ALICE_GAS" --amounts $SEED \
    --gas-budget 50000000 --json
SEED_COIN=$(created_with_type /tmp/wick-demo-split_seed.json "0x2::coin::Coin<0x2::sui::SUI>")
[ -n "$SEED_COIN" ] || { red "no seed coin"; exit 5; }

EXPIRY_MS=$(python3 -c "import time; print(int(time.time()*1000) + $EXPIRY_OFFSET_MS)")
note "expiry_ms: $EXPIRY_MS"

run_tx "create_market" \
  sui client call \
    --package "$PKG" --module wick --function create_market \
    --type-args 0x2::sui::SUI \
    --args "BTC/USD" 0 $BARRIER "$EXPIRY_MS" 30 "$SEED_COIN" 0x6 \
    --gas-budget 200000000 --json
MARKET=$(created_with_type /tmp/wick-demo-create_market.json "::wick::Market<")
LP=$(created_with_type /tmp/wick-demo-create_market.json "::wick::LpPosition")
[ -n "$MARKET" ] && [ -n "$LP" ] || { red "create_market parse"; exit 6; }
note "    Market<SUI>: $MARKET"
note "    LpPosition:  $LP   (alice)"

# ---- PHASE 2: bob bets ----

active_switch "$BOB"

if [ $EXPIRED -eq 1 ]; then
  BUY_FN="buy_no_touch"
  SIDE="NO_TOUCH"
else
  BUY_FN="buy_touch"
  SIDE="TOUCH"
fi

run_tx "buy" \
  sui client ptb \
    --split-coins gas "[$PAY]" --assign payment \
    --move-call "${PKG}::wick::${BUY_FN}" "<0x2::sui::SUI>" "@${MARKET}" payment.0 @0x6 \
    --assign pos \
    --transfer-objects "[pos]" "@${BOB}" \
    --gas-budget 200000000 --json
POS=$(created_with_type /tmp/wick-demo-buy.json "::wick::Position")
[ -n "$POS" ] || { red "no position"; exit 7; }
note "    Position($SIDE): $POS  (bob)"

POS_AMT=$(object_field "$POS" amount)
note "    bob's $SIDE amount: $POS_AMT mist (notional)"

# ---- PHASE 3: resolve market ----

active_switch "$ALICE"

if [ $EXPIRED -eq 1 ]; then
  note "sleeping ${SLEEP_AFTER}s for expiry…"
  sleep $SLEEP_AFTER
  run_tx "settle_expired" \
    sui client call \
      --package "$PKG" --module wick --function settle_expired \
      --type-args 0x2::sui::SUI \
      --args "$MARKET" 0x6 \
      --gas-budget 100000000 --json
else
  run_tx "set_price" \
    sui client call \
      --package "$PKG" --module oracle_adapter --function set_price \
      --args "$ORACLE" $HIT_PRICE \
      --gas-budget 50000000 --json
  run_tx "mark_hit" \
    sui client call \
      --package "$PKG" --module wick --function mark_hit \
      --type-args 0x2::sui::SUI \
      --args "$MARKET" "$ORACLE" 0x6 \
      --gas-budget 100000000 --json
fi

# ---- PHASE 4: bob redeems winning position ----

active_switch "$BOB"
run_tx "redeem_winner" \
  sui client ptb \
    --move-call "${PKG}::wick::redeem_winner" "<0x2::sui::SUI>" "@${MARKET}" "@${POS}" \
    --assign payout \
    --transfer-objects "[payout]" "@${BOB}" \
    --gas-budget 200000000 --json
BOB_PAYOUT_COIN=$(created_with_type /tmp/wick-demo-redeem_winner.json "0x2::coin::Coin<0x2::sui::SUI>")
[ -n "$BOB_PAYOUT_COIN" ] || { red "no bob payout coin"; exit 8; }
BOB_PAYOUT=$(object_field "$BOB_PAYOUT_COIN" balance)
note "    bob payout coin: $BOB_PAYOUT_COIN  ($BOB_PAYOUT mist)"

# ---- PHASE 5: alice redeems LP ----

active_switch "$ALICE"
run_tx "redeem_lp" \
  sui client ptb \
    --move-call "${PKG}::wick::redeem_lp" "<0x2::sui::SUI>" "@${MARKET}" "@${LP}" \
    --assign claim \
    --transfer-objects "[claim]" "@${ALICE}" \
    --gas-budget 200000000 --json
ALICE_CLAIM_COIN=$(created_with_type /tmp/wick-demo-redeem_lp.json "0x2::coin::Coin<0x2::sui::SUI>")
[ -n "$ALICE_CLAIM_COIN" ] || { red "no alice claim coin"; exit 9; }
ALICE_CLAIM=$(object_field "$ALICE_CLAIM_COIN" balance)
note "    alice lp claim coin: $ALICE_CLAIM_COIN  ($ALICE_CLAIM mist)"

# ---- PHASE 6: ending balances + P&L ----

active_switch "$ALICE"
ALICE_END=$(total_sui_mist)
active_switch "$BOB"
BOB_END=$(total_sui_mist)

ALICE_PNL=$((ALICE_END - ALICE_START))
BOB_PNL=$((BOB_END - BOB_START))

# protocol-level (excluding gas):
ALICE_PROTOCOL=$((ALICE_CLAIM - SEED))     # net out of pool minus what she put in
BOB_PROTOCOL=$((BOB_PAYOUT - PAY))         # net out of pool minus what he paid in
DEPOSITS=$((SEED + PAY))
EXITS=$((BOB_PAYOUT + ALICE_CLAIM))
DELTA=$((EXITS - DEPOSITS))
ZERO_SUM=$((BOB_PROTOCOL + ALICE_PROTOCOL))

hr
green "=== Wick Markets — multi-actor demo ($([ $EXPIRED -eq 1 ] && echo EXPIRED || echo HIT) path) ==="
hr
echo
echo "  Wallet balance changes (include gas):"
echo "    alice : $(fmt_signed $ALICE_PNL)"
echo "    bob   : $(fmt_signed $BOB_PNL)"
echo
echo "  Protocol-level cashflows (real on-chain, exclude gas):"
echo "    alice deposit (LP):     $(fmt_mist $SEED)"
echo "    bob   deposit (bet):    $(fmt_mist $PAY)"
echo "    bob   payout:           $(fmt_mist $BOB_PAYOUT)"
echo "    alice lp claim:         $(fmt_mist $ALICE_CLAIM)"
echo
echo "    alice protocol P&L:     $(fmt_signed $ALICE_PROTOCOL)   (LP)"
echo "    bob   protocol P&L:     $(fmt_signed $BOB_PROTOCOL)   (bettor)"
echo
hr
echo "  Conservation (must hold exactly):"
printf "    deposits:   %s\n" "$(fmt_mist $DEPOSITS)"
printf "    exits:      %s\n" "$(fmt_mist $EXITS)"
printf "    delta:      %s\n" "$(fmt_signed $DELTA)"
echo
printf "    zero-sum:   alice_pnl + bob_pnl = %s\n" "$(fmt_signed $ZERO_SUM)"
hr

if [ "$DELTA" -ne 0 ] || [ "$ZERO_SUM" -ne 0 ]; then
  red "FAIL: protocol did not conserve."
  exit 10
fi

green "OK — protocol conserved exactly. real payoffs settled on testnet."
note "  market:   https://suiscan.xyz/testnet/object/$MARKET"
note "  oracle:   https://suiscan.xyz/testnet/object/$ORACLE"
