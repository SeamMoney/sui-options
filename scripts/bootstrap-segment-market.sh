#!/usr/bin/env bash
# Bootstrap a SegmentMarket<SUI> shared object with the B7-CALIBRATED
# sweet-spot parameters from doc 19 §4 (post-Agent E joint sweep).
#
# This is the one-command "deploy a new round-based arcade market" script.
# F1 (deploy arcade to testnet) starts from here.
#
# Re-runnable: always creates a fresh SegmentMarket and appends to
# deployments/testnet.json's `segment_markets` array. Per-market caps are
# arguments to bootstrap_segment_market, not a separate admin object, so
# there is no shared state to reuse between markets — each call yields a
# clean new market with its own bound vault, walk anchor, and caps.
#
# Usage:
#   ./scripts/bootstrap-segment-market.sh                       # all defaults
#   HOME_PRICE=2000000000 ./scripts/bootstrap-segment-market.sh # $2000 market
#
# Env overrides — all optional. Defaults are doc 19 §4 v1 calibrated values
# from B7 (see docs/design/v2/15_montecarlo_validation_report.md §12.4):
#
#   HOME_PRICE=1000000000              # $1000 in micro-USD; walk's mean-revert anchor
#   VOL_REGIME_INIT=1000000            # 1.0 in 1e6 fp (neutral starting vol)
#   ROUND_DURATION_SEGMENTS=75         # 30s @ 400ms/segment
#   OPEN_WINDOW_SEGMENTS=13            # ~5.2s open window at round start
#   BARRIER_OFFSET_BPS=1000            # ±10% — B7 SWEET SPOT (was 500/±5%)
#   MULTIPLIER_BPS=17500               # 1.75× — B7 SWEET SPOT (was 20000/2×)
#   MAX_PAYOUT_PER_BARRIER=20000000    # 0.02 SUI cap = 10% of typical 0.2-SUI vault
#                                      # seed per doc 15 §12.3 invariant; override if
#                                      # your vault is seeded larger. NEVER set so that
#                                      # 2× cap > seed treasury (worst-case pile-on).
#   DEADBAND_BPS=20                    # 0.2% anti-jitter margin around barrier
#   SIGMA_BPS_PER_SQRT_SEC=100         # cashout Bachelier vol (1% / √sec)
#   CASHOUT_SPREAD_BPS=200             # 2% taken off the cashout factor
#   ABORT_SEGMENT_DEADLINE_MS=30000    # 30s wall-time before abort_segment_ride
#   MIN_STAKE_PER_SEGMENT=1000000      # $1/segment minimum
#   MAX_STAKE_PER_SEGMENT=100000000    # $100/segment maximum
#   MAX_CONCURRENT_RIDES=50
#   MAX_RIDES_PER_USER=5
#
# After this lands, start the keeper with:
#   WICK_KEEPER_SEGMENT_MARKETS=<market_id> npm run --silent -w keeper watch

set -euo pipefail
cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

# ── doc 19 §4 v1 calibrated defaults (B7 sweet spot) ──────────────────────────
HOME_PRICE="${HOME_PRICE:-1000000000}"
VOL_REGIME_INIT="${VOL_REGIME_INIT:-1000000}"
ROUND_DURATION_SEGMENTS="${ROUND_DURATION_SEGMENTS:-75}"
OPEN_WINDOW_SEGMENTS="${OPEN_WINDOW_SEGMENTS:-13}"
BARRIER_OFFSET_BPS="${BARRIER_OFFSET_BPS:-1000}"
MULTIPLIER_BPS="${MULTIPLIER_BPS:-17500}"
MAX_PAYOUT_PER_BARRIER="${MAX_PAYOUT_PER_BARRIER:-20000000}"
DEADBAND_BPS="${DEADBAND_BPS:-20}"
SIGMA_BPS_PER_SQRT_SEC="${SIGMA_BPS_PER_SQRT_SEC:-100}"
CASHOUT_SPREAD_BPS="${CASHOUT_SPREAD_BPS:-200}"
ABORT_SEGMENT_DEADLINE_MS="${ABORT_SEGMENT_DEADLINE_MS:-30000}"
MIN_STAKE_PER_SEGMENT="${MIN_STAKE_PER_SEGMENT:-1000000}"
MAX_STAKE_PER_SEGMENT="${MAX_STAKE_PER_SEGMENT:-100000000}"
MAX_CONCURRENT_RIDES="${MAX_CONCURRENT_RIDES:-50}"
MAX_RIDES_PER_USER="${MAX_RIDES_PER_USER:-5}"

SUI_COIN_TYPE="0x2::sui::SUI"
CLOCK_ID="0x6"

# Default name follows the arcade_markets convention: WICK-SEG-{round}-{barrier_bps}.
# Override via NAME env var.
NAME="${NAME:-WICK-SEG-${ROUND_DURATION_SEGMENTS}-${BARRIER_OFFSET_BPS}bps}"

# ── input validation ──────────────────────────────────────────────────────────
# Mirror the Move asserts in segment_market::new_segment_market so we fail
# fast on garbage params before paying gas for an on-chain abort.
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
for var in HOME_PRICE VOL_REGIME_INIT ROUND_DURATION_SEGMENTS OPEN_WINDOW_SEGMENTS \
           BARRIER_OFFSET_BPS MULTIPLIER_BPS MAX_PAYOUT_PER_BARRIER DEADBAND_BPS \
           SIGMA_BPS_PER_SQRT_SEC CASHOUT_SPREAD_BPS ABORT_SEGMENT_DEADLINE_MS \
           MIN_STAKE_PER_SEGMENT MAX_STAKE_PER_SEGMENT MAX_CONCURRENT_RIDES MAX_RIDES_PER_USER; do
  val="${!var}"
  if ! is_uint "$val"; then
    red "$var must be a non-negative integer (got: $val)"; exit 1
  fi
done
# Strictly-positive (Move asserts > 0):
for var in HOME_PRICE VOL_REGIME_INIT ROUND_DURATION_SEGMENTS OPEN_WINDOW_SEGMENTS \
           BARRIER_OFFSET_BPS SIGMA_BPS_PER_SQRT_SEC ABORT_SEGMENT_DEADLINE_MS \
           MIN_STAKE_PER_SEGMENT MAX_STAKE_PER_SEGMENT MAX_PAYOUT_PER_BARRIER \
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
# OPEN_WINDOW_SEGMENTS <= ROUND_DURATION_SEGMENTS (Move uses <=; loosened
# here from the prior strict <):
if [ "$OPEN_WINDOW_SEGMENTS" -gt "$ROUND_DURATION_SEGMENTS" ]; then
  red "OPEN_WINDOW_SEGMENTS ($OPEN_WINDOW_SEGMENTS) must be <= ROUND_DURATION_SEGMENTS ($ROUND_DURATION_SEGMENTS)"; exit 1
fi
# MULTIPLIER_BPS > 10000 means a real (> 1.0×) payout:
if [ "$MULTIPLIER_BPS" -le 10000 ]; then
  red "MULTIPLIER_BPS must be > 10000 (i.e., > 1.0×) — got $MULTIPLIER_BPS"; exit 1
fi
# MIN_STAKE_PER_SEGMENT <= MAX_STAKE_PER_SEGMENT:
if [ "$MIN_STAKE_PER_SEGMENT" -gt "$MAX_STAKE_PER_SEGMENT" ]; then
  red "MIN_STAKE_PER_SEGMENT ($MIN_STAKE_PER_SEGMENT) > MAX_STAKE_PER_SEGMENT ($MAX_STAKE_PER_SEGMENT)"; exit 1
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
window_sec=$(python3 -c "print(f'{$OPEN_WINDOW_SEGMENTS*400/1000:.1f}')")

note "package:                  $PKG"
note "vault<SUI>:               $VAULT"
note "sender:                   $SENDER"
hr
note "doc 19 §4 (B7-CALIBRATED) parameters:"
note "  HOME_PRICE:               $HOME_PRICE  micro-USD  (≈ \$$(python3 -c "print(f'{$HOME_PRICE/1e6:.0f}')"))"
note "  VOL_REGIME_INIT:          $VOL_REGIME_INIT  (1.0 in 1e6 fp)"
note "  ROUND_DURATION_SEGMENTS:  $ROUND_DURATION_SEGMENTS  (~${round_sec}s @ 400ms/seg)"
note "  OPEN_WINDOW_SEGMENTS:     $OPEN_WINDOW_SEGMENTS  (~${window_sec}s open window)"
note "  BARRIER_OFFSET_BPS:       $BARRIER_OFFSET_BPS  (±${offset_pct}% from spot at round start)"
note "  MULTIPLIER_BPS:           $MULTIPLIER_BPS  (${mult_display}× payout on touch)"
note "  MAX_PAYOUT_PER_BARRIER:   $MAX_PAYOUT_PER_BARRIER  MIST"
note "  DEADBAND_BPS:             $DEADBAND_BPS"
note "  SIGMA_BPS_PER_SQRT_SEC:   $SIGMA_BPS_PER_SQRT_SEC"
note "  CASHOUT_SPREAD_BPS:       $CASHOUT_SPREAD_BPS"
note "  ABORT_SEGMENT_DEADLINE_MS: $ABORT_SEGMENT_DEADLINE_MS"
note "  STAKE_PER_SEGMENT:        [$MIN_STAKE_PER_SEGMENT, $MAX_STAKE_PER_SEGMENT] micro-USD"
note "  MAX_CONCURRENT_RIDES:     $MAX_CONCURRENT_RIDES"
note "  MAX_RIDES_PER_USER:       $MAX_RIDES_PER_USER"
hr

green "calling wick::bootstrap_segment_market<SUI>"

OUT="/tmp/wick-bootstrap-segment-market.json"
ERR="/tmp/wick-bootstrap-segment-market.err"

# Argument order matches sdk/src/segmentMarket.ts buildBootstrapSegmentMarketTx:
#   1..15 = u64 params in the SDK builder's order
#   16    = vault (shared object)
#   17    = clock (0x6)
if ! sui client call \
  --package "$PKG" \
  --module wick \
  --function bootstrap_segment_market \
  --type-args "$SUI_COIN_TYPE" \
  --gas-budget 200000000 \
  --args \
    "$HOME_PRICE" \
    "$VOL_REGIME_INIT" \
    "$ROUND_DURATION_SEGMENTS" \
    "$OPEN_WINDOW_SEGMENTS" \
    "$BARRIER_OFFSET_BPS" \
    "$MULTIPLIER_BPS" \
    "$MAX_PAYOUT_PER_BARRIER" \
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
  red "bootstrap_segment_market tx failed:"
  cat "$ERR" >&2
  exit 2
fi

# Strip any pre-JSON banner lines that modern sui CLI versions emit before the
# JSON blob ("Transaction Dry Run", warning notices, etc.). Matches the
# pattern in scripts/bootstrap-ride-caps.sh + scripts/seed-arcade-markets.sh.
# Without this, `json.load` can throw AFTER the tx has landed on chain,
# leaving a ghost SegmentMarket alive on testnet and deployments/testnet.json
# un-patched. [reviewer SEV-1]
CLEAN="${OUT%.json}-clean.json"
awk '/^\{/ {flag=1} flag {print}' "$OUT" > "$CLEAN"

green "tx landed; parsing created SegmentMarket"

# Pull the created SegmentMarket<SUI> from objectChanges. Substring match on
# "::segment_market::SegmentMarket<" is defensive against type-tag
# normalisation differences across sui CLI versions.
SEG_MARKET=$(python3 -c "
import json, sys
d = json.load(open('$CLEAN'))
needle = '::segment_market::SegmentMarket<'
for chg in d.get('objectChanges', []):
    if chg.get('type') == 'created' and needle in chg.get('objectType', ''):
        print(chg['objectId'])
        sys.exit(0)
sys.exit('no SegmentMarket<SUI> in objectChanges — check $CLEAN')
")

note "SegmentMarket<SUI>: $SEG_MARKET"

# ── append to deployments/testnet.json ───────────────────────────────────────
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
    "open_window_segments":      $OPEN_WINDOW_SEGMENTS,
    "barrier_offset_bps":        $BARRIER_OFFSET_BPS,
    "multiplier_bps":            $MULTIPLIER_BPS,
    "max_payout_per_barrier":    $MAX_PAYOUT_PER_BARRIER,
    "deadband_bps":              $DEADBAND_BPS,
    "sigma_bps_per_sqrt_sec":    $SIGMA_BPS_PER_SQRT_SEC,
    "cashout_spread_bps":        $CASHOUT_SPREAD_BPS,
    "abort_segment_deadline_ms": $ABORT_SEGMENT_DEADLINE_MS,
    "min_stake_per_segment":     $MIN_STAKE_PER_SEGMENT,
    "max_stake_per_segment":     $MAX_STAKE_PER_SEGMENT,
    "max_concurrent_rides":      $MAX_CONCURRENT_RIDES,
    "max_rides_per_user":        $MAX_RIDES_PER_USER,
}
d.setdefault("segment_markets", []).append(entry)
# Atomic write via tmp file + os.replace, so a SIGKILL mid-write doesn't
# corrupt deployments/testnet.json. [reviewer SEV-3]
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PYEOF

green "appended segment_markets[] entry to $ARTIFACT"

hr
green "DONE — SegmentMarket<SUI>: $SEG_MARKET"
note "Next steps:"
note "  1. Start the keeper:    WICK_KEEPER_SEGMENT_MARKETS=$SEG_MARKET npm run --silent -w keeper watch"
note "  2. Frontend /ride will auto-pick the first segment_markets entry"
note "  3. Open a ride and watch the on-chain candles render"
