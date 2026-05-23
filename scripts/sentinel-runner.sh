#!/usr/bin/env bash
# Sentinel runner — keep a SegmentMarket chart alive during demos by
# continuously opening + closing a small sentinel ride from the operator's
# currently-active sui CLI wallet.
#
# Why this exists (tonight-demo bridge, v3.6 will retire it):
#   record_segment is wake-gated on `active_ride_count > 0` in
#   move/sources/segment_market.move (line ~349). When nobody is riding,
#   the keeper has no segments to crank, no candles render, the chart is
#   dead. The v3 fix is sponsored cranking + a sentinel rider on a Fly
#   machine (see docs/design/v2/22_sponsored_cranking_v3.md §3.7). For
#   tonight, this bash loop runs from the operator's laptop instead.
#
# What this does NOT do:
#   - Does not try to crank record_segment itself. That's the keeper's job
#     (and/or D4 client-side fallback). The sentinel only OPENS / CLOSES
#     rides — that's enough to keep the wake gate satisfied.
#   - Does not switch sui CLI addresses. The operator picks the wallet
#     BEFORE running by `sui client switch --address <addr>`. The script
#     uses whatever `sui client active-address` returns. This is by design
#     so the operator can never burn the user's burner here.
#
# Burn rate (per round):
#   - escrow:  min_stake_per_segment × round_duration_segments (refunded
#              on TOUCH_WIN / CASHOUT / ABORTED_REFUND; net 0 on average
#              for a 1.75x-payout sentinel ride). For default WICK-SEG-20-1000bps
#              that's 1M × 20 = 20M MIST locked per round (returned at close).
#   - gas:     ~5M MIST for open + ~5M for close = ~10M MIST/round.
#   - cadence: round = round_duration_segments × 400 ms. For 20 segments
#              that's 8 s per round = ~7.5 rounds/min.
#   - burn:    ~75M MIST/min in gas alone — call it ~175M MIST/min including
#              escrow churn surface (the escrow itself comes back; bias loss
#              from EXPIRED_LOSS path is asymmetric).
#
# Usage:
#   ./scripts/sentinel-runner.sh                 # picks segment_markets[-1]
#   MARKET=0xabc... ./scripts/sentinel-runner.sh # override market id
#   BARRIER=1 ./scripts/sentinel-runner.sh       # 0=upper, 1=lower
#   YES=1 ./scripts/sentinel-runner.sh           # skip the y/N prompt
#
# Stop with Ctrl+C — the trap will close any currently-open ride before exit.

set -euo pipefail

cd "$(dirname "$0")/.."

# ── ansi ───────────────────────────────────────────────────────────────────────
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

# ── preflight ──────────────────────────────────────────────────────────────────
command -v sui >/dev/null 2>&1 || { red "sui CLI not on PATH"; exit 1; }
command -v jq  >/dev/null 2>&1 || { red "jq not on PATH"; exit 1; }
command -v python3 >/dev/null 2>&1 || { red "python3 not on PATH"; exit 1; }

ARTIFACT="deployments/testnet.json"
[ -f "$ARTIFACT" ] || { red "no $ARTIFACT — run ./scripts/deploy-testnet.sh first"; exit 1; }

ACTIVE_ENV=$(sui client active-env 2>/dev/null || echo "")
if [ "$ACTIVE_ENV" != "testnet" ]; then
  red "active sui env is '$ACTIVE_ENV', expected 'testnet'"
  red "run: sui client switch --env testnet"
  exit 1
fi

# ── config ─────────────────────────────────────────────────────────────────────
SUI_COIN_TYPE="${SUI_COIN_TYPE:-0x2::sui::SUI}"
CLOCK="0x6"
GAS_BUDGET="${GAS_BUDGET:-200000000}"     # 0.2 SUI per tx; same as smoke
BARRIER="${BARRIER:-0}"                   # 0=upper, 1=lower
POLL_SLEEP_MS="${POLL_SLEEP_MS:-400}"     # how often to recheck market state
WAIT_SLACK_SEGMENTS="${WAIT_SLACK_SEGMENTS:-2}"  # close N segments before round end
SKIP_CONFIRM="${YES:-0}"

# Validate BARRIER input early.
if [ "$BARRIER" != "0" ] && [ "$BARRIER" != "1" ]; then
  red "BARRIER must be 0 (upper) or 1 (lower), got '$BARRIER'"
  exit 1
fi

PKG=$(jq -er '.package_id' "$ARTIFACT")
BOT_REGISTRY=$(jq -er '.bot_registry' "$ARTIFACT")
PRICE_ORACLE=$(jq -er '.usd_price_oracle' "$ARTIFACT")
WICK_STATE=$(jq -er '.wick_token_state' "$ARTIFACT")
STAKING_POOL=$(jq -er '.wick_staking_pool' "$ARTIFACT")

# Pull segment_markets[-1] entry — same convention as segment-smoke.sh.
if [ -n "${MARKET:-}" ]; then
  MARKET_ID="$MARKET"
  VAULT_ID=$(jq -er --arg m "$MARKET_ID" \
    '(.segment_markets // []) | map(select(.market == $m)) | .[-1].vault // empty' "$ARTIFACT")
  if [ -z "$VAULT_ID" ] || [ "$VAULT_ID" = "null" ]; then
    red "MARKET=$MARKET_ID not found in $ARTIFACT segment_markets[]; cannot resolve vault"
    exit 1
  fi
  MIN_STAKE_HINT=$(jq -er --arg m "$MARKET_ID" \
    '(.segment_markets // []) | map(select(.market == $m)) | .[-1].min_stake_per_segment // empty' "$ARTIFACT")
else
  MARKET_ID=$(jq -er '(.segment_markets // []) | .[-1].market // empty' "$ARTIFACT")
  VAULT_ID=$(jq -er '(.segment_markets // []) | .[-1].vault // empty' "$ARTIFACT")
  MIN_STAKE_HINT=$(jq -er '(.segment_markets // []) | .[-1].min_stake_per_segment // empty' "$ARTIFACT")
fi

if [ -z "$MARKET_ID" ] || [ "$MARKET_ID" = "null" ]; then
  red "no SegmentMarket found in $ARTIFACT segment_markets[]"
  red "run: ./scripts/bootstrap-segment-market.sh"
  exit 1
fi

SENDER=$(sui client active-address)

# ── helpers ────────────────────────────────────────────────────────────────────
now_s() { date +%s; }

# Run a sui CLI subcommand, strip CLI banner before first JSON object,
# write the clean JSON to $2. Returns 0 on success, non-zero on failure.
# Matches the awk pattern used by bootstrap-segment-market.sh +
# segment-smoke.sh — modern sui CLI versions sometimes prepend warning
# notices before the JSON blob, and json.loads chokes without this strip.
run_tx_json() {
  local label="$1"; shift
  local raw="/tmp/wick-sentinel-${label}-raw.txt"
  local out="/tmp/wick-sentinel-${label}.json"
  local err="/tmp/wick-sentinel-${label}.err"
  if ! "$@" >"$raw" 2>"$err"; then
    red "tx '$label' failed:"
    red "  stderr:"; cat "$err" >&2
    red "  stdout:"; cat "$raw" >&2
    return 2
  fi
  awk '/^\{/ {flag=1} flag {print}' "$raw" > "$out"
  if [ ! -s "$out" ]; then
    red "tx '$label' produced no JSON output:"
    cat "$raw" >&2
    return 2
  fi
  printf '%s\n' "$out"
}

run_read_json() {
  local label="$1"; shift
  local raw="/tmp/wick-sentinel-${label}-raw.txt"
  local out="/tmp/wick-sentinel-${label}.json"
  local err="/tmp/wick-sentinel-${label}.err"
  if ! "$@" >"$raw" 2>"$err"; then
    red "read '$label' failed:"; cat "$err" >&2
    return 2
  fi
  awk '/^\{/ {flag=1} flag {print}' "$raw" > "$out"
  [ -s "$out" ] || cp "$raw" "$out"
  printf '%s\n' "$out"
}

tx_digest() { jq -r '.digest // empty' "$1"; }

# Pull a named field from the first event whose type contains the needle.
event_field() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
path, needle, field = sys.argv[1:4]
with open(path) as f:
    d = json.load(f)
for ev in d.get("events", []) or []:
    if needle in ev.get("type", ""):
        parsed = ev.get("parsedJson") or {}
        if field in parsed:
            print(parsed[field])
            sys.exit(0)
sys.exit(1)
PY
}

created_of_type() {
  python3 - "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
needle = sys.argv[2]
for chg in d.get("objectChanges", []) or []:
    if chg.get("type") == "created" and needle in chg.get("objectType", ""):
        print(chg.get("objectId", ""))
        sys.exit(0)
sys.exit(1)
PY
}

# Read a snapshot of the SegmentMarket. The on-chain object's fields are
# either directly under .content.* (current sui CLI default) or under
# .content.fields.* (legacy). Probe both so we don't break across CLI
# versions — same fallback the segment-smoke.sh helper uses.
snapshot_market() {
  local json
  if ! json=$(run_read_json "market-snapshot" sui client object "$MARKET_ID" --json); then
    return 2
  fi
  python3 - "$json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
c = d.get("content", {}) or {}
src = c.get("fields", c) if isinstance(c, dict) else {}
def g(k, default="0"):
    v = src.get(k, default)
    return v if v is not None else default
out = {
    "active_ride_count":           g("active_ride_count"),
    "next_segment_index":          g("next_segment_index"),
    "cached_round_index":          g("cached_round_index"),
    "cached_round_started_at_segment": g("cached_round_started_at_segment"),
    "round_duration_segments":     g("round_duration_segments"),
    "open_window_segments":        g("open_window_segments"),
    "min_stake_per_segment":       g("min_stake_per_segment"),
}
for k, v in out.items():
    print(f"{k}={v}")
PY
}

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

# Sleep N millis. macOS bash 3.2 lacks fractional `sleep`; use python.
sleep_ms() {
  python3 -c "import time; time.sleep(int($1)/1000.0)"
}

SETTLEMENT_NAME() {
  case "$1" in
    0) printf 'OPEN' ;;
    1) printf 'TOUCH_WIN' ;;
    2) printf 'CASHOUT' ;;
    3) printf 'EXPIRED_LOSS' ;;
    4) printf 'ABORTED_REFUND' ;;
    *) printf 'UNKNOWN_%s' "$1" ;;
  esac
}

# ── load market state ──────────────────────────────────────────────────────────
note "package:   $PKG"
note "sender:    $SENDER"
note "market:    $MARKET_ID"
note "vault:     $VAULT_ID"

SNAP=$(snapshot_market)
eval "$SNAP"

# Validate everything we read is a non-empty uint.
for var in active_ride_count next_segment_index cached_round_index \
           cached_round_started_at_segment round_duration_segments \
           open_window_segments min_stake_per_segment; do
  val="${!var}"
  if ! [[ "$val" =~ ^[0-9]+$ ]]; then
    red "market field '$var' missing or non-numeric (got: '$val')"
    red "  if the sui CLI's JSON layout changed, update snapshot_market()"
    exit 1
  fi
done

# Prefer the deployments JSON's min_stake hint if the on-chain probe came back
# zero (defensive — shouldn't happen on a real market, but tolerate it).
if [ "$min_stake_per_segment" = "0" ] && [ -n "${MIN_STAKE_HINT:-}" ] && [ "$MIN_STAKE_HINT" != "null" ]; then
  min_stake_per_segment="$MIN_STAKE_HINT"
fi

ROUND_DURATION_SEGMENTS="$round_duration_segments"
OPEN_WINDOW_SEGMENTS="$open_window_segments"
MIN_STAKE_PER_SEGMENT="$min_stake_per_segment"
STAKE_PER_SEGMENT="$MIN_STAKE_PER_SEGMENT"
ESCROW_MIST=$(( MIN_STAKE_PER_SEGMENT * ROUND_DURATION_SEGMENTS ))
ROUND_MS=$(( ROUND_DURATION_SEGMENTS * 400 ))
HOLD_MS=$(( (ROUND_DURATION_SEGMENTS - WAIT_SLACK_SEGMENTS) * 400 ))
if [ "$HOLD_MS" -lt 400 ]; then HOLD_MS=400; fi

note "round:     $ROUND_DURATION_SEGMENTS segments (~$(python3 -c "print(f'{$ROUND_MS/1000:.1f}')")s)"
note "open win:  $OPEN_WINDOW_SEGMENTS segments (~$(python3 -c "print(f'{$OPEN_WINDOW_SEGMENTS*400/1000:.1f}')")s)"
note "stake/seg: $STAKE_PER_SEGMENT mist"
note "escrow:    $ESCROW_MIST mist per round (refunded on close)"
note "barrier:   $BARRIER ($( [ "$BARRIER" = "0" ] && echo upper || echo lower ))"

# ── burn rate + balance preflight ──────────────────────────────────────────────
# Gas-cost rough estimate per round (open + close) = 10M MIST. The escrow
# itself is loop-locked but refunded at close (in expectation; the EXPIRED_LOSS
# tail leaks ~stake_paid each lose). Net practical burn including expected loss
# tail ≈ 25M MIST / round at the WICK-SEG-20 default.
EST_BURN_PER_ROUND_MIST=25000000
ROUNDS_PER_MIN=$(( 60000 / (ROUND_MS > 0 ? ROUND_MS : 8000) ))
[ "$ROUNDS_PER_MIN" -lt 1 ] && ROUNDS_PER_MIN=1
EST_BURN_PER_MIN_MIST=$(( EST_BURN_PER_ROUND_MIST * ROUNDS_PER_MIN ))
EST_BURN_PER_HOUR_MIST=$(( EST_BURN_PER_MIN_MIST * 60 ))

BAL_MIST=$(current_balance_mist)
BAL_SUI_DEC=$(python3 -c "print(f'{$BAL_MIST/1e9:.3f}')")
BURN_PER_MIN_SUI=$(python3 -c "print(f'{$EST_BURN_PER_MIN_MIST/1e9:.3f}')")
BURN_PER_HOUR_SUI=$(python3 -c "print(f'{$EST_BURN_PER_HOUR_MIST/1e9:.2f}')")

if [ "$EST_BURN_PER_MIN_MIST" -gt 0 ]; then
  EST_MIN_BEFORE_DRAIN=$(( BAL_MIST / EST_BURN_PER_MIN_MIST ))
else
  EST_MIN_BEFORE_DRAIN=0
fi

hr
warn "Sentinel burn rate: ~${EST_BURN_PER_MIN_MIST} MIST/min (~${BURN_PER_MIN_SUI} SUI/min, ~${BURN_PER_HOUR_SUI} SUI/hour)."
warn "Your active wallet has: ${BAL_SUI_DEC} SUI."
warn "Will run for approximately ${EST_MIN_BEFORE_DRAIN} minutes before drain."
warn "Note: escrow (${ESCROW_MIST} mist/round) is REFUNDED on close — actual burn is dominated by gas + EXPIRED_LOSS tail."

if [ "$SKIP_CONFIRM" = "1" ] || [ -n "${WICK_SENTINEL_YES:-}" ]; then
  warn "YES=1 set; skipping confirmation."
else
  printf '\033[33mContinue? [y/N]\033[0m '
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|YES) ;;
    *) red "aborted by user"; exit 0 ;;
  esac
fi
hr

# ── trap: gracefully close any in-flight ride on SIGINT / EXIT ────────────────
CURRENT_RIDE_ID=""
SHUTDOWN=0
LAST_SEGMENT_TS=$(now_s)

graceful_close() {
  if [ -z "$CURRENT_RIDE_ID" ]; then
    return 0
  fi
  warn "closing in-flight ride $CURRENT_RIDE_ID before exit"
  local out
  if out=$(run_tx_json "close-shutdown" \
    sui client ptb \
      --move-call "${PKG}::wick::close_segment_ride" "<$SUI_COIN_TYPE>" \
        "@${CURRENT_RIDE_ID}" "@${MARKET_ID}" "@${VAULT_ID}" \
        "@${PRICE_ORACLE}" "@${WICK_STATE}" "@${STAKING_POOL}" "@${CLOCK}" \
      --assign payout \
      --transfer-objects "[payout]" "@${SENDER}" \
      --gas-budget "$GAS_BUDGET" --json); then
    local digest kind
    digest=$(tx_digest "$out")
    kind=$(event_field "$out" "::segment_market::RideClosed" settlement_kind 2>/dev/null || echo "?")
    green "shutdown close OK — digest=$digest settlement=$(SETTLEMENT_NAME "$kind")"
  else
    red "shutdown close failed; ride $CURRENT_RIDE_ID may remain open. Run scripts/segment-smoke.sh against it or close manually."
  fi
  CURRENT_RIDE_ID=""
}

on_signal() {
  SHUTDOWN=1
  warn "signal received — winding down after current ride"
  graceful_close
  exit 0
}
trap on_signal INT TERM

# Best-effort EXIT trap as a backup (kicks in if the loop dies unexpectedly).
on_exit() {
  if [ "$SHUTDOWN" != "1" ] && [ -n "$CURRENT_RIDE_ID" ]; then
    graceful_close
  fi
}
trap on_exit EXIT

# ── main loop ─────────────────────────────────────────────────────────────────
green "sentinel running; Ctrl+C to stop"

LOOP=0
while [ "$SHUTDOWN" = "0" ]; do
  LOOP=$(( LOOP + 1 ))
  ROUND_START_TS=$(now_s)

  # 1. Refresh market state.
  if ! SNAP=$(snapshot_market 2>/dev/null); then
    warn "snapshot_market failed; sleeping ${POLL_SLEEP_MS}ms then retrying"
    sleep_ms "$POLL_SLEEP_MS"
    continue
  fi
  eval "$SNAP"

  # 2. If a human (or another sentinel) is already riding, this loop's job
  #    is done for the moment — skip until the count drops. We're a backstop,
  #    not a stack-amplifier.
  if [ "${active_ride_count:-0}" -gt 0 ]; then
    gray "[loop $LOOP] active_ride_count=${active_ride_count} > 0 — skipping (human present)"
    sleep_ms "$ROUND_MS"
    continue
  fi

  # 3. Compute the next open-window start. The market opens a window from
  #    round_start_segment for OPEN_WINDOW_SEGMENTS segments. If we're inside
  #    the window now, open immediately. Otherwise sleep to the next round.
  ROUND_START_SEG="${cached_round_started_at_segment:-0}"
  NEXT_SEG="${next_segment_index:-0}"
  SEGS_INTO_ROUND=$(( NEXT_SEG - ROUND_START_SEG ))
  if [ "$SEGS_INTO_ROUND" -lt 0 ]; then SEGS_INTO_ROUND=0; fi
  if [ "$SEGS_INTO_ROUND" -ge "$OPEN_WINDOW_SEGMENTS" ]; then
    SEGS_TO_NEXT_ROUND=$(( ROUND_DURATION_SEGMENTS - SEGS_INTO_ROUND ))
    if [ "$SEGS_TO_NEXT_ROUND" -lt 1 ]; then SEGS_TO_NEXT_ROUND=1; fi
    WAIT_MS=$(( SEGS_TO_NEXT_ROUND * 400 ))
    gray "[loop $LOOP] window closed (segs_into_round=$SEGS_INTO_ROUND); sleeping ${WAIT_MS}ms"
    sleep_ms "$WAIT_MS"
    continue
  fi

  # 4. Open a sentinel ride. PTB shape mirrors scripts/segment-smoke.sh +
  #    sdk/src/segmentMarket.ts buildOpenSegmentRideTx. The split-coins from
  #    `gas` pulls exactly ESCROW_MIST from the gas coin, opens, transfers
  #    the SegmentRidePosition back to the sender.
  T_OPEN_START=$(now_s)
  if ! OPEN_OUT=$(run_tx_json "open-${LOOP}" \
    sui client ptb \
      --split-coins gas "[$ESCROW_MIST]" --assign escrow \
      --move-call "${PKG}::wick::open_segment_ride" "<$SUI_COIN_TYPE>" \
        "@${MARKET_ID}" "@${VAULT_ID}" "@${BOT_REGISTRY}" \
        "$BARRIER" "$STAKE_PER_SEGMENT" escrow.0 "@${CLOCK}" \
      --assign ride \
      --transfer-objects "[ride]" "@${SENDER}" \
      --gas-budget "$GAS_BUDGET" --json); then
    warn "[loop $LOOP] open failed; backing off ${POLL_SLEEP_MS}ms"
    sleep_ms "$POLL_SLEEP_MS"
    continue
  fi
  OPEN_DIGEST=$(tx_digest "$OPEN_OUT")
  CURRENT_RIDE_ID=$(event_field "$OPEN_OUT" "::segment_market::RideOpened" ride_id 2>/dev/null || true)
  if [ -z "$CURRENT_RIDE_ID" ]; then
    CURRENT_RIDE_ID=$(created_of_type "$OPEN_OUT" "::segment_market::SegmentRidePosition" 2>/dev/null || true)
  fi
  if [ -z "$CURRENT_RIDE_ID" ]; then
    red "[loop $LOOP] could not parse ride id from open tx (digest=$OPEN_DIGEST); skipping close"
    sleep_ms "$ROUND_MS"
    continue
  fi
  SECONDS_SINCE_LAST_SEG=$(( $(now_s) - LAST_SEGMENT_TS ))
  green "[loop $LOOP] OPEN  ride=$CURRENT_RIDE_ID digest=$OPEN_DIGEST since_last_segment=${SECONDS_SINCE_LAST_SEG}s"

  # 5. Hold for ~round_duration - WAIT_SLACK_SEGMENTS. The keeper cranks
  #    segments while we hold; we close just before round end so we don't
  #    get auto-cranked to EXPIRED_LOSS (which would drain the wallet fast).
  sleep_ms "$HOLD_MS"

  # If a signal landed during the sleep, the trap already handled close.
  if [ "$SHUTDOWN" = "1" ]; then
    break
  fi

  # 6. Close. Settlement kind is decided on-chain — log it for the operator.
  T_CLOSE_START=$(now_s)
  if ! CLOSE_OUT=$(run_tx_json "close-${LOOP}" \
    sui client ptb \
      --move-call "${PKG}::wick::close_segment_ride" "<$SUI_COIN_TYPE>" \
        "@${CURRENT_RIDE_ID}" "@${MARKET_ID}" "@${VAULT_ID}" \
        "@${PRICE_ORACLE}" "@${WICK_STATE}" "@${STAKING_POOL}" "@${CLOCK}" \
      --assign payout \
      --transfer-objects "[payout]" "@${SENDER}" \
      --gas-budget "$GAS_BUDGET" --json); then
    warn "[loop $LOOP] close failed for ride $CURRENT_RIDE_ID; will retry from trap on exit"
    # Don't clear CURRENT_RIDE_ID so the trap or next iter can try again.
    sleep_ms "$POLL_SLEEP_MS"
    continue
  fi
  CLOSE_DIGEST=$(tx_digest "$CLOSE_OUT")
  SETTLEMENT_KIND=$(event_field "$CLOSE_OUT" "::segment_market::RideClosed" settlement_kind 2>/dev/null || echo "?")
  SECONDS_SINCE_LAST_SEG=$(( $(now_s) - LAST_SEGMENT_TS ))
  green "[loop $LOOP] CLOSE ride=$CURRENT_RIDE_ID digest=$CLOSE_DIGEST settlement=$(SETTLEMENT_NAME "$SETTLEMENT_KIND") since_last_segment=${SECONDS_SINCE_LAST_SEG}s"

  # Update freshness tracker — a successful close means segments were cranked
  # during the hold (otherwise the keeper would be cold). Crude proxy: stamp
  # close time as last-segment time.
  LAST_SEGMENT_TS=$(now_s)
  CURRENT_RIDE_ID=""

  # 7. Tiny gap before the next iter — gives the keeper a beat and avoids
  #    hammering the RPC.
  sleep_ms "$POLL_SLEEP_MS"
done

green "sentinel loop exited cleanly after $LOOP iterations"
