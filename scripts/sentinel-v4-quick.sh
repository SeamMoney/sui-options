#!/usr/bin/env bash
# Quick v4 sentinel — chart-alive bot for the SegmentMarketV4 demo.
#
# Why this exists (2026-05-23, mid-demo):
#   The v4 market was just bootstrapped on testnet (commit 9450238). It has
#   the wake-gate `assert!(active_ride_count > 0, ENoActiveRides)` at
#   segment_market_v4.move:591 — the keeper can't crank record_segment_v4
#   while no one is riding. The frontend therefore shows "Waiting for
#   round…" and the chart is dead. The proper fix is wiring the TS keeper
#   for v4 (segmentSentinel.ts + segmentCranker.ts target v3 today); that's
#   a longer change. This script is the laptop-funded bridge until the
#   keeper lands v4 support.
#
# What it does, per round:
#   1. OPEN a v4 ride with escrow = STAKE_PER_SEGMENT × ROUND_DURATION_SEGMENTS
#   2. Crank record_segment_v4 every ~400 ms for HOLD_SEGMENTS segments
#   3. CLOSE the ride (settlement: TOUCH_WIN / CASHOUT / EXPIRED_LOSS / ABORTED_REFUND)
#   4. Repeat until SIGINT
#
# Burn rate:
#   - escrow: ~750_000 MIST × N rides over the demo (refunded on most paths)
#   - gas:    ~5M MIST/open + ~1M MIST/crank × N + ~5M MIST/close
#   - For default 75-seg rounds at 400 ms/seg that's ~30s/round + ~30M
#     MIST/round, so the publisher's 3.5 SUI lasts ~100 rounds (~50 min).
#
# Usage:
#   ./scripts/sentinel-v4-quick.sh         # all defaults from deployments/testnet.json
#   ./scripts/sentinel-v4-quick.sh --one   # one ride then exit (smoke)
#
# Run in background with:
#   nohup ./scripts/sentinel-v4-quick.sh > /tmp/sentinel-v4.log 2>&1 &

set -euo pipefail
cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }

ARTIFACT="${ARTIFACT:-deployments/testnet.json}"
ONE_SHOT="${1:-}"

# ── pull IDs from deployments/testnet.json ────────────────────────────────────
PKG=$(python3 -c "import json; print(json.load(open('$ARTIFACT'))['package_id'])")
VAULT=$(python3 -c "import json; print(json.load(open('$ARTIFACT'))['vault_sui'])")
BOT_REGISTRY=$(python3 -c "import json; print(json.load(open('$ARTIFACT'))['bot_registry'])")
PRICE_ORACLE=$(python3 -c "import json; print(json.load(open('$ARTIFACT'))['usd_price_oracle'])")
WICK_STATE=$(python3 -c "import json; print(json.load(open('$ARTIFACT'))['wick_token_state'])")
STAKING_POOL=$(python3 -c "import json; print(json.load(open('$ARTIFACT'))['wick_staking_pool'])")

# v4 market — the most recent entry in segment_markets_v4[]
MARKET=$(python3 -c "import json; d=json.load(open('$ARTIFACT')); print(d['segment_markets_v4'][-1]['market'])")
ROUND_DURATION_SEGMENTS=$(python3 -c "import json; d=json.load(open('$ARTIFACT')); print(d['segment_markets_v4'][-1]['round_duration_segments'])")
MIN_STAKE_PER_SEGMENT=$(python3 -c "import json; d=json.load(open('$ARTIFACT')); print(d['segment_markets_v4'][-1]['min_stake_per_segment'])")

# Sui system shared objects.
CLOCK="0x6"
RANDOM_OBJ="0x8"
SUI_COIN_TYPE="0x2::sui::SUI"

# Tunables — defaults match the v4 bootstrap-segment-market-v4.sh shape.
STAKE_PER_SEGMENT="${STAKE_PER_SEGMENT:-$MIN_STAKE_PER_SEGMENT}"
# v4 escrow heuristic: raw coin units = stake_per_segment × round_duration_segments.
# Stake is micro-USD per segment; escrow is raw collateral. The 1:1 unit
# pun works at the smoke scale because the wick::usd_price_oracle on
# testnet is pinned to 1 SUI = $1 (see seed-arcade-markets.sh §6).
ESCROW_MIST="${ESCROW_MIST:-$(( STAKE_PER_SEGMENT * ROUND_DURATION_SEGMENTS ))}"
HOLD_SEGMENTS="${HOLD_SEGMENTS:-70}"  # close before round end (75) to avoid EXPIRED_LOSS
SEGMENT_INTERVAL_MS="${SEGMENT_INTERVAL_MS:-450}"  # slightly slower than 400ms to leave headroom
GAS_BUDGET="${GAS_BUDGET:-100000000}"  # 0.1 SUI / tx

SENDER=$(sui client active-address)

# ── helpers (lifted from sentinel-runner.sh) ──────────────────────────────────
now_s() { date +%s; }
sleep_ms() { python3 -c "import time,sys; time.sleep(int(sys.argv[1])/1000.0)" "$1"; }

run_tx_json() {
  local label="$1"; shift
  local raw="/tmp/wick-v4-${label}-raw.txt"
  local out="/tmp/wick-v4-${label}.json"
  local err="/tmp/wick-v4-${label}.err"
  if ! "$@" >"$raw" 2>"$err"; then
    warn "tx '$label' failed:"
    cat "$err" >&2
    cat "$raw" >&2
    return 2
  fi
  awk '/^\{/ {flag=1} flag {print}' "$raw" > "$out"
  if [ ! -s "$out" ]; then
    warn "tx '$label' produced no JSON:"; cat "$raw" >&2
    return 2
  fi
  printf '%s\n' "$out"
}

tx_digest() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('digest',''))" "$1"; }

# Find the v4 ride object ID from the open tx output.
parse_ride_id() {
  python3 - "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for c in d.get('objectChanges', []) or []:
    if c.get('type') == 'created' and 'SegmentRidePositionV4' in c.get('objectType', ''):
        print(c['objectId'])
        sys.exit(0)
sys.exit(1)
PY
}

# ── banner ────────────────────────────────────────────────────────────────────
note "------------------------------------------------------------"
note "Wick v4 sentinel (chart-alive bridge)"
note "  package:      $PKG"
note "  v4 market:    $MARKET"
note "  vault:        $VAULT"
note "  sender:       $SENDER"
note "  stake/seg:    $STAKE_PER_SEGMENT (micro-USD)"
note "  escrow/ride:  $ESCROW_MIST MIST  ($(python3 -c "print($ESCROW_MIST/1e9)") SUI)"
note "  hold:         $HOLD_SEGMENTS segments × ${SEGMENT_INTERVAL_MS}ms"
note "  one-shot:     ${ONE_SHOT:-no}"
note "------------------------------------------------------------"

# ── trap: close any open ride on SIGINT so we don't leak escrow ──────────────
CURRENT_RIDE=""
on_exit() {
  if [ -n "$CURRENT_RIDE" ]; then
    warn "shutdown — closing in-flight ride $CURRENT_RIDE"
    run_tx_json "close-trap" \
      sui client ptb \
        --move-call "${PKG}::wick::close_segment_ride_v4" "<$SUI_COIN_TYPE>" \
          "@${CURRENT_RIDE}" "@${MARKET}" "@${VAULT}" \
          "@${PRICE_ORACLE}" "@${WICK_STATE}" "@${STAKING_POOL}" "@${CLOCK}" \
        --assign payout \
        --transfer-objects "[payout]" "@${SENDER}" \
        --gas-budget "$GAS_BUDGET" --json >/dev/null || warn "trap close failed"
  fi
  exit 0
}
trap on_exit INT TERM

# ── main loop ─────────────────────────────────────────────────────────────────
LOOP=0
while true; do
  LOOP=$(( LOOP + 1 ))
  T_LOOP_START=$(now_s)

  # 1. OPEN
  note "[loop $LOOP] opening v4 ride…"
  if ! OPEN_OUT=$(run_tx_json "open-$LOOP" \
    sui client ptb \
      --split-coins gas "[$ESCROW_MIST]" --assign escrow \
      --move-call "${PKG}::wick::open_segment_ride_v4" "<$SUI_COIN_TYPE>" \
        "@${MARKET}" "@${VAULT}" "@${BOT_REGISTRY}" \
        "$STAKE_PER_SEGMENT" escrow.0 "@${CLOCK}" \
      --assign ride \
      --transfer-objects "[ride]" "@${SENDER}" \
      --gas-budget "$GAS_BUDGET" --json); then
    warn "[loop $LOOP] open failed — backing off 5s"
    sleep 5
    continue
  fi
  CURRENT_RIDE=$(parse_ride_id "$OPEN_OUT" 2>/dev/null || true)
  if [ -z "$CURRENT_RIDE" ]; then
    red "[loop $LOOP] could not parse ride ID from open output:"
    cat "$OPEN_OUT" | python3 -m json.tool | head -40
    sleep 5
    continue
  fi
  green "[loop $LOOP] OPEN ride=$CURRENT_RIDE digest=$(tx_digest $OPEN_OUT)"

  # 2. CRANK record_segment_v4 in a tight loop
  for ((seg = 0; seg < HOLD_SEGMENTS; seg++)); do
    if ! run_tx_json "crank-$LOOP-$seg" \
        sui client ptb \
          --move-call "${PKG}::wick::record_segment_v4" "<$SUI_COIN_TYPE>" \
            "@${MARKET}" "@${RANDOM_OBJ}" "@${CLOCK}" \
          --gas-budget "$GAS_BUDGET" --json >/dev/null 2>&1; then
      gray "[loop $LOOP seg $seg] crank failed — possibly settled; checking"
      # If the ride settled mid-crank, the next open will skip it.
      break
    fi
    if (( seg % 10 == 0 )); then
      gray "[loop $LOOP] cranked ${seg}/${HOLD_SEGMENTS} segments"
    fi
    sleep_ms "$SEGMENT_INTERVAL_MS"
  done

  # 3. CLOSE
  note "[loop $LOOP] closing ride $CURRENT_RIDE…"
  if ! CLOSE_OUT=$(run_tx_json "close-$LOOP" \
    sui client ptb \
      --move-call "${PKG}::wick::close_segment_ride_v4" "<$SUI_COIN_TYPE>" \
        "@${CURRENT_RIDE}" "@${MARKET}" "@${VAULT}" \
        "@${PRICE_ORACLE}" "@${WICK_STATE}" "@${STAKING_POOL}" "@${CLOCK}" \
      --assign payout \
      --transfer-objects "[payout]" "@${SENDER}" \
      --gas-budget "$GAS_BUDGET" --json); then
    warn "[loop $LOOP] close failed — ride may have auto-settled"
  else
    green "[loop $LOOP] CLOSE digest=$(tx_digest $CLOSE_OUT)"
  fi
  CURRENT_RIDE=""

  T_LOOP_END=$(now_s)
  DUR=$(( T_LOOP_END - T_LOOP_START ))
  note "[loop $LOOP] complete in ${DUR}s"

  if [ "$ONE_SHOT" = "--one" ]; then
    note "one-shot — exiting"
    break
  fi
  sleep 1
done
