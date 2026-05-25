#!/usr/bin/env bash
# v4.26 — Bootstrap a TUSD-collateralized SegmentMarketV4 WITH RUG ENABLED.
#
# Identical to scripts/bootstrap-tusd-market.sh except for the new
# RUG_CHANCE_BPS arg passed to bootstrap_segment_market_v4. After this
# script runs:
#   - new SegmentMarketV4<TUSD> appended to deployments/testnet.json
#     under .segment_markets_v4 (frontend auto-picks the LAST entry)
#   - reuses the existing vault_tusd (already seeded with 100M TUSD)
#   - rug_chance_bps = 150 → 1.5% per segment → ~+3.4% house edge
#
# Prereqs:
#   - Move package upgraded to include rug fields (see PHASE 1 agent)
#   - sui CLI active = publisher
#   - Publisher holds ≥ 0.1 SUI for bootstrap gas
#
# Usage:
#   bash scripts/bootstrap-tusd-market-rugged.sh
#   RUG_CHANCE_BPS=200 bash scripts/bootstrap-tusd-market-rugged.sh
#
# NOTE: arg position of rug_chance_bps in bootstrap_segment_market_v4
# WILL DEPEND ON HOW PHASE 1 AGENT INSERTED IT into wick.move's entry.
# This script assumes it was appended AFTER max_rides_per_user but
# BEFORE the vault arg, which is the most natural insertion point.
# If the agent put it elsewhere, fix the --args block below before
# running.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENT_PATH="$REPO_ROOT/deployments/testnet.json"

PKG=$(jq -r '.package_id' "$DEPLOYMENT_PATH")
PUBLISHER=$(jq -r '.publisher' "$DEPLOYMENT_PATH")
TUSD_TYPE=$(jq -r '.tusd.coin_type' "$DEPLOYMENT_PATH")
VAULT_TUSD=$(jq -r '.vault_tusd' "$DEPLOYMENT_PATH")

CLOCK_ID="0x6"

# Bootstrap parameters — same as existing TUSD market, only rug changes.
HOME_PRICE="${HOME_PRICE:-1000000000}"
VOL_REGIME_INIT="${VOL_REGIME_INIT:-1000000}"
ROUND_DURATION_SEGMENTS="${ROUND_DURATION_SEGMENTS:-75}"
BARRIER_OFFSET_BPS="${BARRIER_OFFSET_BPS:-1000}"
MULTIPLIER_BPS="${MULTIPLIER_BPS:-17500}"
MAX_PAYOUT_PER_ROUND="${MAX_PAYOUT_PER_ROUND:-500000000}"
DEADBAND_BPS="${DEADBAND_BPS:-20}"
SIGMA_BPS_PER_SQRT_SEC="${SIGMA_BPS_PER_SQRT_SEC:-100}"
CASHOUT_SPREAD_BPS="${CASHOUT_SPREAD_BPS:-200}"
ABORT_SEGMENT_DEADLINE_MS="${ABORT_SEGMENT_DEADLINE_MS:-30000}"
MIN_STAKE_PER_SEGMENT="${MIN_STAKE_PER_SEGMENT:-10000}"
MAX_STAKE_PER_SEGMENT="${MAX_STAKE_PER_SEGMENT:-150000}"
MAX_CONCURRENT_RIDES="${MAX_CONCURRENT_RIDES:-50}"
MAX_RIDES_PER_USER="${MAX_RIDES_PER_USER:-10}"

# v4.26 — the new param. 150 = 1.5% per segment = MC-validated sweet
# spot (~+3.4% house edge with current ±10% / 1.75× kept).
RUG_CHANCE_BPS="${RUG_CHANCE_BPS:-150}"

NAME="${NAME:-WICK-SEG-V4-TUSD-RUG-${RUG_CHANCE_BPS}bps}"

echo "─────────────────────────────────────────────────────"
echo "v4.26 rug-enabled TUSD market bootstrap"
echo "  package:            $PKG"
echo "  vault:              $VAULT_TUSD"
echo "  TUSD type:          $TUSD_TYPE"
echo "  rug_chance_bps:     $RUG_CHANCE_BPS  (= $(echo "scale=2; $RUG_CHANCE_BPS/100" | bc)% per segment)"
echo "─────────────────────────────────────────────────────"

ACTIVE=$(sui client active-address)
if [ "$ACTIVE" != "$PUBLISHER" ]; then
  echo "active address $ACTIVE != publisher $PUBLISHER" >&2
  exit 1
fi

echo "[1/2] bootstrap_segment_market_v4 (no rug param — same as v4.23 bootstrap)"
MARKET_OUT=$(sui client call \
  --package "$PKG" \
  --module wick \
  --function bootstrap_segment_market_v4 \
  --type-args "$TUSD_TYPE" \
  --gas-budget 100000000 \
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
    "$VAULT_TUSD" \
    "$CLOCK_ID" \
  --json)

MARKET_ID=$(echo "$MARKET_OUT" | jq -r '
  .objectChanges[]?
  | select(.type == "created" and (.objectType | contains("::segment_market_v4::SegmentMarketV4<")))
  | .objectId
')

if [ -z "$MARKET_ID" ] || [ "$MARKET_ID" = "null" ]; then
  echo "MARKET CREATION FAILED" >&2
  echo "$MARKET_OUT" | head -30 >&2
  exit 1
fi
echo "    market: $MARKET_ID"

echo ""
echo "[2/2] enable_rug — attaches RugConfig dynamic field with rug_chance_bps=$RUG_CHANCE_BPS"
sui client call \
  --package "$PKG" \
  --module wick \
  --function enable_rug \
  --type-args "$TUSD_TYPE" \
  --args "$MARKET_ID" "$RUG_CHANCE_BPS" \
  --gas-budget 20000000 \
  --json > /dev/null
echo "    ✓ Rug enabled on market $MARKET_ID"

TMP=$(mktemp)
jq --arg market "$MARKET_ID" \
   --arg coll "$TUSD_TYPE" \
   --arg vault "$VAULT_TUSD" \
   --arg name "$NAME" \
   --argjson home "$HOME_PRICE" \
   --argjson vol "$VOL_REGIME_INIT" \
   --argjson rds "$ROUND_DURATION_SEGMENTS" \
   --argjson boff "$BARRIER_OFFSET_BPS" \
   --argjson mult "$MULTIPLIER_BPS" \
   --argjson maxpay "$MAX_PAYOUT_PER_ROUND" \
   --argjson db "$DEADBAND_BPS" \
   --argjson sig "$SIGMA_BPS_PER_SQRT_SEC" \
   --argjson csp "$CASHOUT_SPREAD_BPS" \
   --argjson aborts "$ABORT_SEGMENT_DEADLINE_MS" \
   --argjson minstk "$MIN_STAKE_PER_SEGMENT" \
   --argjson maxstk "$MAX_STAKE_PER_SEGMENT" \
   --argjson maxcc "$MAX_CONCURRENT_RIDES" \
   --argjson maxpu "$MAX_RIDES_PER_USER" \
   --argjson rug "$RUG_CHANCE_BPS" \
   '.segment_markets_v4 += [{
     "name": $name,
     "market": $market,
     "collateral": $coll,
     "vault": $vault,
     "home_price": $home,
     "vol_regime_init": $vol,
     "round_duration_segments": $rds,
     "barrier_offset_bps": $boff,
     "multiplier_bps": $mult,
     "max_payout_per_round": $maxpay,
     "deadband_bps": $db,
     "sigma_bps_per_sqrt_sec": $sig,
     "cashout_spread_bps": $csp,
     "abort_segment_deadline_ms": $aborts,
     "min_stake_per_segment": $minstk,
     "max_stake_per_segment": $maxstk,
     "max_concurrent_rides": $maxcc,
     "max_rides_per_user": $maxpu,
     "rug_chance_bps": $rug
   }]' "$DEPLOYMENT_PATH" > "$TMP"
mv "$TMP" "$DEPLOYMENT_PATH"

echo "✓ deployments/testnet.json updated"
echo ""
echo "Frontend will auto-pick the new market on next reload"
echo "(pickSegmentMarketV4 returns segment_markets_v4[length-1])"
