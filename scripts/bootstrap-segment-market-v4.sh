#!/usr/bin/env bash
# Bootstrap a SegmentMarketV4<SUI> shared object — the touch-either +
# always-open arcade module per doc 25.
#
# v4 differs from v3 in the bootstrap surface:
#   - DROPS OPEN_WINDOW_SEGMENTS env var (no window — every segment opens)
#   - RENAMES MAX_PAYOUT_PER_BARRIER → MAX_PAYOUT_PER_ROUND (single shared
#     cap, replaces v3's per-side cap)
#   - Writes to deployments/testnet.json's NEW `segment_markets_v4[]` array,
#     keeping `segment_markets[]` (v2) and `segment_markets_v3[]` (v3)
#     untouched for backward compat with the frontend's pickSegmentMarket.
#
# Self-consistency check inherited from v3: refuse to bootstrap if the
# min-stake ride payout exceeds MAX_PAYOUT_PER_ROUND.
#
# Usage:
#   ./scripts/bootstrap-segment-market-v4.sh                # all defaults
#   HOME_PRICE=2000000000 ./scripts/bootstrap-segment-market-v4.sh
#
# Env overrides — all optional. Defaults match the B7 sweet-spot calibration:
#
#   HOME_PRICE=1000000000              # $1000 in micro-USD
#   VOL_REGIME_INIT=1000000            # 1.0 in 1e6 fp
#   ROUND_DURATION_SEGMENTS=75         # 30s @ 400ms/segment
#   BARRIER_OFFSET_BPS=1000            # ±10%
#   MULTIPLIER_BPS=17500               # 1.75×
#   MAX_PAYOUT_PER_ROUND=20000000      # shared cap (was per-barrier in v3)
#   DEADBAND_BPS=20
#   SIGMA_BPS_PER_SQRT_SEC=100
#   CASHOUT_SPREAD_BPS=200
#   ABORT_SEGMENT_DEADLINE_MS=30000
#   MIN_STAKE_PER_SEGMENT=10000
#   MAX_STAKE_PER_SEGMENT=150000
#   MAX_CONCURRENT_RIDES=50
#   MAX_RIDES_PER_USER=5

set -euo pipefail
cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

# ── B7-CALIBRATED defaults (same as v3) ──────────────────────────────────────
HOME_PRICE="${HOME_PRICE:-1000000000}"
VOL_REGIME_INIT="${VOL_REGIME_INIT:-1000000}"
ROUND_DURATION_SEGMENTS="${ROUND_DURATION_SEGMENTS:-75}"
BARRIER_OFFSET_BPS="${BARRIER_OFFSET_BPS:-1000}"
MULTIPLIER_BPS="${MULTIPLIER_BPS:-17500}"
# v4 RENAME: was MAX_PAYOUT_PER_BARRIER in v3. Same magnitude semantics —
# now a single shared per-round cap.
MAX_PAYOUT_PER_ROUND="${MAX_PAYOUT_PER_ROUND:-20000000}"
DEADBAND_BPS="${DEADBAND_BPS:-20}"
SIGMA_BPS_PER_SQRT_SEC="${SIGMA_BPS_PER_SQRT_SEC:-100}"
CASHOUT_SPREAD_BPS="${CASHOUT_SPREAD_BPS:-200}"
ABORT_SEGMENT_DEADLINE_MS="${ABORT_SEGMENT_DEADLINE_MS:-30000}"
MIN_STAKE_PER_SEGMENT="${MIN_STAKE_PER_SEGMENT:-10000}"
MAX_STAKE_PER_SEGMENT="${MAX_STAKE_PER_SEGMENT:-150000}"
MAX_CONCURRENT_RIDES="${MAX_CONCURRENT_RIDES:-50}"
MAX_RIDES_PER_USER="${MAX_RIDES_PER_USER:-5}"

SUI_COIN_TYPE="0x2::sui::SUI"
CLOCK_ID="0x6"

# Default name convention: WICK-SEG-V4-{round}-{barrier_bps}.
NAME="${NAME:-WICK-SEG-V4-${ROUND_DURATION_SEGMENTS}-${BARRIER_OFFSET_BPS}bps}"

# ── input validation ──────────────────────────────────────────────────────────
# Mirror the Move asserts in segment_market_v4::new_segment_market_v4 so we
# fail fast on garbage params before paying gas for an on-chain abort.
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
for var in HOME_PRICE VOL_REGIME_INIT ROUND_DURATION_SEGMENTS \
           BARRIER_OFFSET_BPS MULTIPLIER_BPS MAX_PAYOUT_PER_ROUND DEADBAND_BPS \
           SIGMA_BPS_PER_SQRT_SEC CASHOUT_SPREAD_BPS ABORT_SEGMENT_DEADLINE_MS \
           MIN_STAKE_PER_SEGMENT MAX_STAKE_PER_SEGMENT MAX_CONCURRENT_RIDES MAX_RIDES_PER_USER; do
  val="${!var}"
  if ! is_uint "$val"; then
    red "$var must be a non-negative integer (got: $val)"; exit 1
  fi
done
# Strictly-positive (Move asserts > 0):
for var in HOME_PRICE VOL_REGIME_INIT ROUND_DURATION_SEGMENTS \
           BARRIER_OFFSET_BPS SIGMA_BPS_PER_SQRT_SEC ABORT_SEGMENT_DEADLINE_MS \
           MIN_STAKE_PER_SEGMENT MAX_STAKE_PER_SEGMENT MAX_PAYOUT_PER_ROUND \
           MAX_CONCURRENT_RIDES MAX_RIDES_PER_USER; do
  if [ "${!var}" -eq 0 ]; then
    red "$var must be > 0 (got 0)"; exit 1
  fi
done
# BPS-class fields capped at 10_000 (Move asserts <= BPS_DENOMINATOR):
for var in BARRIER_OFFSET_BPS DEADBAND_BPS CASHOUT_SPREAD_BPS; do
  if [ "${!var}" -gt 10000 ]; then
    red "$var must be <= 10000 bps (got ${!var})"; exit 1
  fi
done
# MULTIPLIER_BPS > 10000 means a real (> 1.0×) payout:
if [ "$MULTIPLIER_BPS" -le 10000 ]; then
  red "MULTIPLIER_BPS must be > 10000 (i.e., > 1.0×) — got $MULTIPLIER_BPS"; exit 1
fi
# MIN_STAKE_PER_SEGMENT <= MAX_STAKE_PER_SEGMENT:
if [ "$MIN_STAKE_PER_SEGMENT" -gt "$MAX_STAKE_PER_SEGMENT" ]; then
  red "MIN_STAKE_PER_SEGMENT ($MIN_STAKE_PER_SEGMENT) > MAX_STAKE_PER_SEGMENT ($MAX_STAKE_PER_SEGMENT)"; exit 1
fi

# Self-consistency: same gate as v3, but checked against MAX_PAYOUT_PER_ROUND
# (single shared cap) instead of MAX_PAYOUT_PER_BARRIER.
MIN_RIDE_PAYOUT=$(( MIN_STAKE_PER_SEGMENT * ROUND_DURATION_SEGMENTS * MULTIPLIER_BPS / 10000 ))
MAX_RIDE_PAYOUT=$(( MAX_STAKE_PER_SEGMENT * ROUND_DURATION_SEGMENTS * MULTIPLIER_BPS / 10000 ))
if [ "$MIN_RIDE_PAYOUT" -gt "$MAX_PAYOUT_PER_ROUND" ]; then
  red "MIN-stake ride payout ($MIN_RIDE_PAYOUT MIST) exceeds MAX_PAYOUT_PER_ROUND ($MAX_PAYOUT_PER_ROUND MIST)"
  red "  - no valid ride could ever open against this market"
  red "  - either lower MIN_STAKE_PER_SEGMENT, shorten ROUND_DURATION_SEGMENTS, or raise MAX_PAYOUT_PER_ROUND"
  exit 1
fi
if [ "$MAX_RIDE_PAYOUT" -gt "$MAX_PAYOUT_PER_ROUND" ]; then
  red "MAX-stake ride payout ($MAX_RIDE_PAYOUT MIST) exceeds MAX_PAYOUT_PER_ROUND ($MAX_PAYOUT_PER_ROUND MIST)"
  red "  - the largest valid stake would abort with ERoundCapExceeded"
  red "  - either lower MAX_STAKE_PER_SEGMENT, shorten ROUND_DURATION_SEGMENTS, or raise MAX_PAYOUT_PER_ROUND"
  exit 1
fi

# ── load deployment artifact ─────────────────────────────────────────────────
ARTIFACT="deployments/testnet.json"
[ -f "$ARTIFACT" ] || { red "no $ARTIFACT — run ./scripts/deploy-testnet.sh first"; exit 1; }

PKG=$(python3 -c "import json; print(json.load(open('$ARTIFACT'))['package_id'])")
VAULT=$(python3 -c "import json; print(json.load(open('$ARTIFACT')).get('vault_sui', ''))")

if [ -z "$VAULT" ]; then
  red "no vault_sui in $ARTIFACT — run ./scripts/seed-arcade-markets.sh first to bootstrap MartingalerVault<SUI>"
  exit 1
fi

SENDER=$(sui client active-address)

# ── show config ───────────────────────────────────────────────────────────────
mult_display=$(python3 -c "print(f'{$MULTIPLIER_BPS/10000:.2f}')")
offset_pct=$(python3 -c "print(f'{$BARRIER_OFFSET_BPS/100:.2f}')")
round_sec=$(python3 -c "print(f'{$ROUND_DURATION_SEGMENTS*400/1000:.1f}')")

note "package:                  $PKG"
note "vault<SUI>:               $VAULT"
note "sender:                   $SENDER"
hr
note "doc 25 (V4 touch-either, always-open) parameters:"
note "  HOME_PRICE:               $HOME_PRICE  micro-USD  (≈ \$$(python3 -c "print(f'{$HOME_PRICE/1e6:.0f}')"))"
note "  VOL_REGIME_INIT:          $VOL_REGIME_INIT  (1.0 in 1e6 fp)"
note "  ROUND_DURATION_SEGMENTS:  $ROUND_DURATION_SEGMENTS  (~${round_sec}s @ 400ms/seg)"
note "  (no OPEN_WINDOW_SEGMENTS — v4 is always-open)"
note "  BARRIER_OFFSET_BPS:       $BARRIER_OFFSET_BPS  (±${offset_pct}% from spot at round start)"
note "  MULTIPLIER_BPS:           $MULTIPLIER_BPS  (${mult_display}× payout on touch)"
note "  MAX_PAYOUT_PER_ROUND:     $MAX_PAYOUT_PER_ROUND  MIST  (shared cap — v4 collapse of v3's per-side)"
note "  DEADBAND_BPS:             $DEADBAND_BPS"
note "  SIGMA_BPS_PER_SQRT_SEC:   $SIGMA_BPS_PER_SQRT_SEC"
note "  CASHOUT_SPREAD_BPS:       $CASHOUT_SPREAD_BPS"
note "  ABORT_SEGMENT_DEADLINE_MS: $ABORT_SEGMENT_DEADLINE_MS"
note "  STAKE_PER_SEGMENT:        [$MIN_STAKE_PER_SEGMENT, $MAX_STAKE_PER_SEGMENT] micro-USD"
note "  MAX_CONCURRENT_RIDES:     $MAX_CONCURRENT_RIDES"
note "  MAX_RIDES_PER_USER:       $MAX_RIDES_PER_USER"
hr

green "calling wick::bootstrap_segment_market_v4<SUI>"

OUT="/tmp/wick-bootstrap-segment-market-v4.json"
ERR="/tmp/wick-bootstrap-segment-market-v4.err"

# Argument order matches wick::bootstrap_segment_market_v4 signature:
#   1..14 = u64 params (no open_window_segments; max_payout_per_round renamed)
#   15    = vault (shared object)
#   16    = clock (0x6)
if ! sui client call \
  --package "$PKG" \
  --module wick \
  --function bootstrap_segment_market_v4 \
  --type-args "$SUI_COIN_TYPE" \
  --gas-budget 200000000 \
  --args \
    "$HOME_PRICE" \
    "$VOL_REGIME_INIT" \
    "$ROUND_DURATION_SEGMENTS" \
    "$BARRIER_OFFSET_BPS" \
    "$MULTIPLIER_BPS" \
    "$MAX_PAYOUT_PER_ROUND" \
    "$DEADBAND_BPS" \
    "$SIGMA_BPS_PER_SQRT_SEC" \
    "$CASHOUT_SPREAD_BPS" \
    "$ABORT_SEGMENT_DEADLINE_MS" \
    "$MIN_STAKE_PER_SEGMENT" \
    "$MAX_STAKE_PER_SEGMENT" \
    "$MAX_CONCURRENT_RIDES" \
    "$MAX_RIDES_PER_USER" \
    "$VAULT" \
    "$CLOCK_ID" \
  --json >"$OUT" 2>"$ERR"; then
  red "bootstrap_segment_market_v4 tx failed:"
  cat "$ERR" >&2
  exit 2
fi

# Strip any pre-JSON banner lines (sui CLI version drift).
CLEAN="${OUT%.json}-clean.json"
awk '/^\{/ {flag=1} flag {print}' "$OUT" > "$CLEAN"

green "tx landed; parsing created SegmentMarketV4"

# Pull the created SegmentMarketV4<SUI> from objectChanges.
SEG_MARKET=$(python3 -c "
import json, sys
d = json.load(open('$CLEAN'))
needle = '::segment_market_v4::SegmentMarketV4<'
for chg in d.get('objectChanges', []):
    if chg.get('type') == 'created' and needle in chg.get('objectType', ''):
        print(chg['objectId'])
        sys.exit(0)
sys.exit('no SegmentMarketV4<SUI> in objectChanges — check $CLEAN')
")

note "SegmentMarketV4<SUI>: $SEG_MARKET"

# ── append to deployments/testnet.json (segment_markets_v4[]) ────────────────
python3 - <<PYEOF
import json, os
path = "$ARTIFACT"
tmp  = path + ".tmp"
d = json.load(open(path))
entry = {
    "name":                      "$NAME",
    "market":                    "$SEG_MARKET",
    "collateral":                "$SUI_COIN_TYPE",
    "vault":                     "$VAULT",
    "home_price":                $HOME_PRICE,
    "vol_regime_init":           $VOL_REGIME_INIT,
    "round_duration_segments":   $ROUND_DURATION_SEGMENTS,
    "barrier_offset_bps":        $BARRIER_OFFSET_BPS,
    "multiplier_bps":            $MULTIPLIER_BPS,
    "max_payout_per_round":      $MAX_PAYOUT_PER_ROUND,
    "deadband_bps":              $DEADBAND_BPS,
    "sigma_bps_per_sqrt_sec":    $SIGMA_BPS_PER_SQRT_SEC,
    "cashout_spread_bps":        $CASHOUT_SPREAD_BPS,
    "abort_segment_deadline_ms": $ABORT_SEGMENT_DEADLINE_MS,
    "min_stake_per_segment":     $MIN_STAKE_PER_SEGMENT,
    "max_stake_per_segment":     $MAX_STAKE_PER_SEGMENT,
    "max_concurrent_rides":      $MAX_CONCURRENT_RIDES,
    "max_rides_per_user":        $MAX_RIDES_PER_USER,
}
# v4 NEW array — segment_markets_v4[] is distinct from segment_markets[] (v2)
# and segment_markets_v3[] so the frontend can opt in to v4 markets without
# disturbing the existing pickers.
d.setdefault("segment_markets_v4", []).append(entry)
# Atomic write via tmp file + os.replace.
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PYEOF

green "appended segment_markets_v4[] entry to $ARTIFACT"

hr
green "DONE — SegmentMarketV4<SUI>: $SEG_MARKET"
note "Next steps:"
note "  1. Start the keeper (v4):  WICK_KEEPER_SEGMENT_MARKETS_V4=$SEG_MARKET npm run --silent -w keeper watch"
note "  2. Frontend /ride should opt into V4 once SDK helpers land"
note "  3. Open a touch-either ride — touch on EITHER barrier wins 1.75×"
