#!/usr/bin/env bash
# End-to-end SegmentMarket<SUI> smoke test on testnet.
#
# Flow:
#   1. Read the deployed segment-market ids from deployments/testnet.json.
#   2. Open a fresh upper-barrier SegmentRidePosition.
#   3. Wait briefly for the keeper; if it has not cranked, record 3 segments.
#   4. Close the ride and parse RideClosed.
#   5. Run scripts/verify.ts against the closed ride.
#
# This script intentionally does not mutate deployments/testnet.json.

set -euo pipefail

cd "$(dirname "$0")/.."

# ---------- config ----------

ARTIFACT="deployments/testnet.json"
SUI_COIN_TYPE="${SUI_COIN_TYPE:-0x2::sui::SUI}"
CLOCK="0x6"
RANDOM="0x8"
BARRIER_INDEX="${BARRIER_INDEX:-0}"
GAS_BUDGET="${GAS_BUDGET:-200000000}"
KEEPER_WAIT_S="${KEEPER_WAIT_S:-8}"
KEEPER_POLL_S="${KEEPER_POLL_S:-1}"
FALLBACK_SEGMENTS="${FALLBACK_SEGMENTS:-3}"
REQUESTED_ESCROW_SEGMENTS="${ESCROW_SEGMENTS:-5}"
SEGMENT_MARKET_JQ='(.segment_market_sui // .segment_market.segment_market_sui // .segment_market // .segment_markets[-1] // empty)'

# ---------- ansi ----------

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

# ---------- preflight ----------

command -v sui >/dev/null 2>&1 || { red "sui CLI not on PATH"; exit 1; }
command -v jq >/dev/null 2>&1 || { red "jq not on PATH"; exit 1; }
command -v python3 >/dev/null 2>&1 || { red "python3 not on PATH"; exit 1; }

[ -f "$ARTIFACT" ] || { red "no $ARTIFACT — run the F1 bootstrap first"; exit 1; }

ACTIVE_ENV=$(sui client active-env 2>/dev/null || echo "")
if [ "$ACTIVE_ENV" != "testnet" ]; then
  red "active sui env is '$ACTIVE_ENV', expected 'testnet'"
  red "run: sui client switch --env testnet"
  exit 1
fi

artifact_sha() {
  python3 - "$ARTIFACT" <<'PY'
import hashlib, sys
h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    h.update(f.read())
print(h.hexdigest())
PY
}

ARTIFACT_SHA_BEFORE=$(artifact_sha)

finish() {
  local code=$?
  local after
  after=$(artifact_sha)
  if [ "$after" != "$ARTIFACT_SHA_BEFORE" ]; then
    red "✗ $ARTIFACT changed during smoke; this script must not mutate deployments"
    code=1
  fi
  exit "$code"
}
trap finish EXIT

jq_required() {
  local expr="$1"
  local label="$2"
  local value
  if ! value=$(jq -er "$expr" "$ARTIFACT"); then
    red "$label missing from $ARTIFACT"
    exit 1
  fi
  printf '%s\n' "$value"
}

jq_optional() {
  local expr="$1"
  jq -r "$expr // empty" "$ARTIFACT"
}

PKG=$(jq_required '.package_id' "package_id")
MARKET_ID=$(jq_required "$SEGMENT_MARKET_JQ | .market_id // .market // empty" "segment_market_sui.market_id")
VAULT_ID=$(jq_required "$SEGMENT_MARKET_JQ | .vault_id // .vault // empty" "segment_market_sui.vault_id")
RIDE_CAPS_ID=$(jq_optional "$SEGMENT_MARKET_JQ | .ride_caps_id // .ride_caps")
BOT_REGISTRY=$(jq_required '.bot_registry' "bot_registry")
PRICE_ORACLE=$(jq_required '.usd_price_oracle' "usd_price_oracle")
WICK_STATE=$(jq_required '.wick_token_state' "wick_token_state")
STAKING_POOL=$(jq_required '.wick_staking_pool' "wick_staking_pool")
SENDER=$(sui client active-address)

# ---------- helpers ----------

declare -a STEP_SUMMARY=()
STEP_LABEL=""
STEP_START=0

now_s() { date +%s; }

step_begin() {
  STEP_LABEL="$1"
  STEP_START=$(now_s)
  hr
  green ">>> $STEP_LABEL"
}

step_ok() {
  local dur=$(( $(now_s) - STEP_START ))
  STEP_SUMMARY+=("${STEP_LABEL}|ok|${dur}s")
  note "done in ${dur}s"
}

print_summary() {
  local ok="$1"
  hr
  if [ "$ok" = "ok" ]; then
    green "✓ segment smoke passed"
  else
    red "✗ segment smoke failed"
  fi
  for row in "${STEP_SUMMARY[@]}"; do
    IFS='|' read -r label status dur <<<"$row"
    printf "  %-30s %-4s %s\n" "$label" "$status" "$dur"
  done
}

# Run a sui command. Capture stdout to json file, stderr to err file.
# Strips Sui CLI's banner/preamble before the first JSON object.
run_tx() {
  local label="$1"; shift
  local raw="/tmp/wick-segment-smoke-${label}-raw.txt"
  local out="/tmp/wick-segment-smoke-${label}.json"
  local err="/tmp/wick-segment-smoke-${label}.err"
  if ! "$@" >"$raw" 2>"$err"; then
    red "tx '$label' failed:"
    red "  stderr:"; cat "$err" >&2
    red "  stdout:"; cat "$raw" >&2
    exit 2
  fi
  awk '/^\{/ {flag=1} flag {print}' "$raw" > "$out"
  if [ ! -s "$out" ]; then
    red "tx '$label' produced no JSON output:"
    cat "$raw" >&2
    exit 2
  fi
  printf '%s\n' "$out"
}

run_json() {
  local label="$1"; shift
  local raw="/tmp/wick-segment-smoke-${label}-raw.txt"
  local out="/tmp/wick-segment-smoke-${label}.json"
  local err="/tmp/wick-segment-smoke-${label}.err"
  if ! "$@" >"$raw" 2>"$err"; then
    red "command '$label' failed:"
    cat "$err" >&2
    exit 2
  fi
  awk '/^\{/ {flag=1} flag {print}' "$raw" > "$out"
  [ -s "$out" ] || cp "$raw" "$out"
  printf '%s\n' "$out"
}

tx_digest() {
  jq -r '.digest // empty' "$1"
}

event_field() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
path, needle, field = sys.argv[1:4]
d = json.load(open(path))
for ev in d.get("events", []):
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
d = json.load(open(sys.argv[1]))
needle = sys.argv[2]
for chg in d.get("objectChanges", []):
    if chg.get("type") == "created" and needle in chg.get("objectType", ""):
        print(chg.get("objectId", ""))
        sys.exit(0)
sys.exit(1)
PY
}

market_json() {
  run_json "market-object" sui client object "$MARKET_ID" --json
}

market_field() {
  local field="$1"
  local default="${2:-}"
  local json
  json=$(market_json)
  jq -r --arg f "$field" --arg d "$default" \
    '(.data.content.fields[$f] // .content.fields[$f] // $d)' "$json"
}

calc_product() {
  python3 - "$1" "$2" <<'PY'
import sys
print(int(sys.argv[1]) * int(sys.argv[2]))
PY
}

is_uint() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

lower_id() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
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

# ---------- load market state ----------

step_begin "load deployment"
ROUND_DURATION_SEGMENTS=$(market_field round_duration_segments "$(jq_optional "$SEGMENT_MARKET_JQ | .round_duration_segments")")
OPEN_WINDOW_SEGMENTS=$(market_field open_window_segments "$(jq_optional "$SEGMENT_MARKET_JQ | .open_window_segments")")
MIN_STAKE_PER_SEGMENT="${MIN_STAKE_PER_SEGMENT:-$(market_field min_stake_per_segment "$(jq_optional "$SEGMENT_MARKET_JQ | .min_stake_per_segment")")}"
NEXT_SEGMENT_INDEX=$(market_field next_segment_index "0")

ROUND_DURATION_SEGMENTS="${ROUND_DURATION_SEGMENTS:-5}"
OPEN_WINDOW_SEGMENTS="${OPEN_WINDOW_SEGMENTS:-1}"
MIN_STAKE_PER_SEGMENT="${MIN_STAKE_PER_SEGMENT:-1000000}"

for pair in \
  "ROUND_DURATION_SEGMENTS:$ROUND_DURATION_SEGMENTS" \
  "OPEN_WINDOW_SEGMENTS:$OPEN_WINDOW_SEGMENTS" \
  "MIN_STAKE_PER_SEGMENT:$MIN_STAKE_PER_SEGMENT" \
  "NEXT_SEGMENT_INDEX:$NEXT_SEGMENT_INDEX"; do
  name=${pair%%:*}
  value=${pair#*:}
  if ! is_uint "$value"; then
    red "$name must be a uint, got '$value'"
    exit 1
  fi
done

SEGMENTS_INTO_ROUND=$(( NEXT_SEGMENT_INDEX % ROUND_DURATION_SEGMENTS ))
if [ "$SEGMENTS_INTO_ROUND" -ge "$OPEN_WINDOW_SEGMENTS" ]; then
  red "market open window is closed: next_segment_index=$NEXT_SEGMENT_INDEX, round_duration=$ROUND_DURATION_SEGMENTS, open_window=$OPEN_WINDOW_SEGMENTS"
  red "wait for the next round or bootstrap a fresh segment market before rerunning"
  exit 1
fi

ESCROW_SEGMENTS="$REQUESTED_ESCROW_SEGMENTS"
if [ "$ROUND_DURATION_SEGMENTS" -gt "$ESCROW_SEGMENTS" ]; then
  warn "requested $ESCROW_SEGMENTS segment escrow, but Move requires full-round escrow; using $ROUND_DURATION_SEGMENTS segments"
  ESCROW_SEGMENTS="$ROUND_DURATION_SEGMENTS"
fi
ESCROW_MIST=$(calc_product "$MIN_STAKE_PER_SEGMENT" "$ESCROW_SEGMENTS")
STAKE_PER_SEGMENT="$MIN_STAKE_PER_SEGMENT"

note "package:             $PKG"
note "sender:              $SENDER"
note "market:              $MARKET_ID"
note "vault:               $VAULT_ID"
[ -n "$RIDE_CAPS_ID" ] && note "ride caps:           $RIDE_CAPS_ID"
note "round_duration:      $ROUND_DURATION_SEGMENTS segments"
note "open_window:         $OPEN_WINDOW_SEGMENTS segments"
note "next_segment_index:  $NEXT_SEGMENT_INDEX"
note "stake_per_segment:   $STAKE_PER_SEGMENT"
note "escrow:              $ESCROW_MIST mist ($ESCROW_SEGMENTS segments)"
step_ok

# ---------- open ride ----------

step_begin "open_segment_ride"
OPEN_OUT=$(run_tx "open-segment-ride" \
  sui client ptb \
    --split-coins gas "[$ESCROW_MIST]" --assign escrow \
    --move-call "${PKG}::wick::open_segment_ride" "<$SUI_COIN_TYPE>" \
      "@${MARKET_ID}" "@${VAULT_ID}" "@${BOT_REGISTRY}" \
      "$BARRIER_INDEX" "$STAKE_PER_SEGMENT" escrow.0 "@${CLOCK}" \
    --assign ride \
    --transfer-objects "[ride]" "@${SENDER}" \
    --gas-budget "$GAS_BUDGET" --json)
OPEN_DIGEST=$(tx_digest "$OPEN_OUT")
RIDE_ID=$(event_field "$OPEN_OUT" "::segment_market::RideOpened" ride_id 2>/dev/null || true)
ENTRY_SEGMENT_INDEX=$(event_field "$OPEN_OUT" "::segment_market::RideOpened" entry_segment_index 2>/dev/null || true)
if [ -z "$RIDE_ID" ]; then
  RIDE_ID=$(created_of_type "$OPEN_OUT" "::segment_market::SegmentRidePosition" 2>/dev/null || true)
fi
[ -n "$RIDE_ID" ] || { red "could not parse SegmentRidePosition id from open_segment_ride"; exit 2; }
ENTRY_SEGMENT_INDEX="${ENTRY_SEGMENT_INDEX:-$NEXT_SEGMENT_INDEX}"
note "ride:    $RIDE_ID"
note "entry:   $ENTRY_SEGMENT_INDEX"
note "digest:  $OPEN_DIGEST"
step_ok

# ---------- wait for keeper or fallback crank ----------

step_begin "record segments"
TARGET_SEGMENT_INDEX=$(( ENTRY_SEGMENT_INDEX + FALLBACK_SEGMENTS ))
WAIT_DEADLINE=$(( $(now_s) + KEEPER_WAIT_S ))
while [ "$(now_s)" -lt "$WAIT_DEADLINE" ]; do
  CURRENT_NEXT=$(market_field next_segment_index "$ENTRY_SEGMENT_INDEX")
  if [ "$CURRENT_NEXT" -ge "$TARGET_SEGMENT_INDEX" ]; then
    note "keeper already cranked to segment $CURRENT_NEXT"
    step_ok
    KEEPER_DONE=1
    break
  fi
  gray "waiting for keeper: next_segment_index=$CURRENT_NEXT target=$TARGET_SEGMENT_INDEX"
  sleep "$KEEPER_POLL_S"
done

if [ "${KEEPER_DONE:-0}" != "1" ]; then
  CURRENT_NEXT=$(market_field next_segment_index "$ENTRY_SEGMENT_INDEX")
  while [ "$CURRENT_NEXT" -lt "$TARGET_SEGMENT_INDEX" ]; do
    idx=$(( CURRENT_NEXT + 1 ))
    OUT=$(run_tx "record-segment-${idx}" \
      sui client ptb \
        --move-call "${PKG}::wick::record_segment" "<$SUI_COIN_TYPE>" \
          "@${MARKET_ID}" "@${RANDOM}" "@${CLOCK}" \
        --gas-budget "$GAS_BUDGET" --json)
    note "record_segment #$idx digest: $(tx_digest "$OUT")"
    CURRENT_NEXT=$(market_field next_segment_index "$CURRENT_NEXT")
  done
  step_ok
fi

# ---------- close ride ----------

step_begin "close_segment_ride"
CLOSE_OUT=$(run_tx "close-segment-ride" \
  sui client ptb \
    --move-call "${PKG}::wick::close_segment_ride" "<$SUI_COIN_TYPE>" \
      "@${RIDE_ID}" "@${MARKET_ID}" "@${VAULT_ID}" \
      "@${PRICE_ORACLE}" "@${WICK_STATE}" "@${STAKING_POOL}" "@${CLOCK}" \
    --assign payout \
    --transfer-objects "[payout]" "@${SENDER}" \
    --gas-budget "$GAS_BUDGET" --json)
CLOSE_DIGEST=$(tx_digest "$CLOSE_OUT")
CLOSED_RIDE_ID=$(event_field "$CLOSE_OUT" "::segment_market::RideClosed" ride_id 2>/dev/null || true)
SETTLEMENT_KIND=$(event_field "$CLOSE_OUT" "::segment_market::RideClosed" settlement_kind 2>/dev/null || true)
if [ -z "$SETTLEMENT_KIND" ]; then
  red "could not parse RideClosed settlement_kind from close_segment_ride"
  exit 2
fi
if [ -n "$CLOSED_RIDE_ID" ] && [ "$(lower_id "$CLOSED_RIDE_ID")" != "$(lower_id "$RIDE_ID")" ]; then
  red "RideClosed event ride_id mismatch: expected $RIDE_ID, got $CLOSED_RIDE_ID"
  exit 2
fi
note "settlement: $(SETTLEMENT_NAME "$SETTLEMENT_KIND") ($SETTLEMENT_KIND)"
note "digest:     $CLOSE_DIGEST"
step_ok

# ---------- verify replay ----------

step_begin "verify replay"
VERIFY_ARGS=(scripts/verify.ts --market "$MARKET_ID" --ride "$RIDE_ID")
if [ -n "${RPC_URL:-}" ]; then
  VERIFY_ARGS+=(--rpc "$RPC_URL")
fi
npx tsx "${VERIFY_ARGS[@]}"
step_ok

print_summary ok
