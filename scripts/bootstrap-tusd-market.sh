#!/usr/bin/env bash
# Bootstrap a TUSD-collateralized SegmentMarketV4 + the MartingalerVault
# it sits on top of. After this:
#   - wick::martingaler_vault::MartingalerVault<TUSD> shared on chain
#   - vault seeded with `SEED_TUSD_RAW` (default: 100M TUSD = $100M nominal)
#   - wick::segment_market_v4::SegmentMarketV4<TUSD> shared on chain
#   - deployments/testnet.json updated under .segment_markets_v4 (appended
#     last so the frontend's pickSegmentMarketV4() auto-picks it).
#
# Prereqs:
#   - Already published TUSD (deployments/testnet.json:.tusd populated)
#   - Publisher CLI active + has ~0.4 SUI for gas + holds the TUSD bag
#
# Usage:
#   bash scripts/bootstrap-tusd-market.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENT_PATH="$REPO_ROOT/deployments/testnet.json"

# ── Constants pulled from deployments ──────────────────────────────────────
PKG=$(jq -r '.package_id' "$DEPLOYMENT_PATH")
PUBLISHER=$(jq -r '.publisher' "$DEPLOYMENT_PATH")
TUSD_TYPE=$(jq -r '.tusd.coin_type' "$DEPLOYMENT_PATH")
TUSD_PUBLISHER_COIN=$(jq -r '.tusd.publisher_coin' "$DEPLOYMENT_PATH")

CLOCK_ID="0x6"

# ── Bootstrap parameters (match SUI market for consistency) ────────────────
# TUSD has 6 decimals = micro-USD, so the same numeric values that were
# "MIST" for SUI are now "micro-USD = raw TUSD units". Stake sizes stay
# meaningful in dollar terms ($0.01 - $0.15).
HOME_PRICE="${HOME_PRICE:-1000000000}"             # $1000 in micro-USD
VOL_REGIME_INIT="${VOL_REGIME_INIT:-1000000}"      # 1.0 in 1e6 fp
ROUND_DURATION_SEGMENTS="${ROUND_DURATION_SEGMENTS:-75}"
BARRIER_OFFSET_BPS="${BARRIER_OFFSET_BPS:-1000}"   # ±10%
MULTIPLIER_BPS="${MULTIPLIER_BPS:-17500}"          # 1.75×
MAX_PAYOUT_PER_ROUND="${MAX_PAYOUT_PER_ROUND:-500000000}"  # 500 TUSD = $500
DEADBAND_BPS="${DEADBAND_BPS:-20}"
SIGMA_BPS_PER_SQRT_SEC="${SIGMA_BPS_PER_SQRT_SEC:-100}"
CASHOUT_SPREAD_BPS="${CASHOUT_SPREAD_BPS:-200}"
ABORT_SEGMENT_DEADLINE_MS="${ABORT_SEGMENT_DEADLINE_MS:-30000}"
MIN_STAKE_PER_SEGMENT="${MIN_STAKE_PER_SEGMENT:-10000}"   # $0.01
MAX_STAKE_PER_SEGMENT="${MAX_STAKE_PER_SEGMENT:-150000}"  # $0.15
MAX_CONCURRENT_RIDES="${MAX_CONCURRENT_RIDES:-50}"
MAX_RIDES_PER_USER="${MAX_RIDES_PER_USER:-10}"

# How much TUSD to seed the vault with. Default: 100M TUSD = $100M nominal,
# vs $500 max per round = 200K rounds of headroom.
SEED_TUSD_RAW="${SEED_TUSD_RAW:-100000000000000}"  # 100M TUSD at 6 decimals
NAME="${NAME:-WICK-SEG-V4-TUSD-${ROUND_DURATION_SEGMENTS}-${BARRIER_OFFSET_BPS}bps}"

echo "─────────────────────────────────────────────────────"
echo "Bootstrapping TUSD market"
echo "  package:        $PKG"
echo "  publisher:      $PUBLISHER"
echo "  TUSD type:      $TUSD_TYPE"
echo "  seed amount:    $((SEED_TUSD_RAW / 1000000)) TUSD"
echo "  max payout/round: $((MAX_PAYOUT_PER_ROUND / 1000000)) TUSD"
echo "─────────────────────────────────────────────────────"

ACTIVE=$(sui client active-address)
if [ "$ACTIVE" != "$PUBLISHER" ]; then
  echo "active address $ACTIVE != publisher $PUBLISHER" >&2
  echo "switch with: sui client switch --address $PUBLISHER" >&2
  exit 1
fi

# ── 1. bootstrap_vault<TUSD> ────────────────────────────────────────────────
echo ""
echo "[1/3] bootstrap_vault<TUSD>"
VAULT_OUT=$(sui client call \
  --package "$PKG" \
  --module wick \
  --function bootstrap_vault \
  --type-args "$TUSD_TYPE" \
  --gas-budget 100000000 \
  --json)
VAULT_TUSD=$(echo "$VAULT_OUT" | jq -r '
  .objectChanges[]
  | select(.type == "created" and (.objectType | contains("::martingaler_vault::MartingalerVault<")))
  | .objectId
')
VAULT_ADMIN_CAP_TUSD=$(echo "$VAULT_OUT" | jq -r '
  .objectChanges[]
  | select(.type == "created" and (.objectType | contains("::martingaler_vault::VaultAdminCap")))
  | .objectId
')
echo "    vault:     $VAULT_TUSD"
echo "    admin cap: $VAULT_ADMIN_CAP_TUSD"

# ── 2. Split + seed_vault<TUSD> ─────────────────────────────────────────────
echo ""
echo "[2/3] split $((SEED_TUSD_RAW / 1000000)) TUSD off the publisher bag + seed_vault"
SPLIT_OUT=$(sui client split-coin \
  --coin-id "$TUSD_PUBLISHER_COIN" \
  --amounts "$SEED_TUSD_RAW" \
  --gas-budget 20000000 \
  --json)
SEED_COIN=$(echo "$SPLIT_OUT" | jq -r '
  .objectChanges[]
  | select(.type == "created" and (.objectType | contains("0x2::coin::Coin<")) and (.objectType | contains("tusd::TUSD")))
  | .objectId
')
echo "    seed coin: $SEED_COIN"

sui client call \
  --package "$PKG" \
  --module wick \
  --function seed_vault \
  --type-args "$TUSD_TYPE" \
  --args "$VAULT_TUSD" "$SEED_COIN" "$CLOCK_ID" \
  --gas-budget 100000000 \
  --json > /dev/null
echo "    vault seeded"

# ── 3. bootstrap_segment_market_v4<TUSD> ───────────────────────────────────
echo ""
echo "[3/3] bootstrap_segment_market_v4<TUSD>"
MARKET_OUT=$(sui client call \
  --package "$PKG" \
  --module wick \
  --function bootstrap_segment_market_v4 \
  --type-args "$TUSD_TYPE" \
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
    "$VAULT_TUSD" \
    "$CLOCK_ID" \
  --json)
MARKET_TUSD=$(echo "$MARKET_OUT" | jq -r '
  .objectChanges[]
  | select(.type == "created" and (.objectType | contains("::segment_market_v4::SegmentMarketV4<")))
  | .objectId
')
echo "    market:    $MARKET_TUSD"

# ── 4. Write to deployments/testnet.json ───────────────────────────────────
echo ""
echo "[4/4] update deployments/testnet.json"
TMP=$(mktemp)
jq --arg name "$NAME" \
   --arg market "$MARKET_TUSD" \
   --arg coll "$TUSD_TYPE" \
   --arg vault "$VAULT_TUSD" \
   --arg cap "$VAULT_ADMIN_CAP_TUSD" \
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
   '.vault_tusd = $vault
    | .vault_admin_cap_tusd = $cap
    | .segment_markets_v4 += [{
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
        "max_rides_per_user": $maxpu
      }]' "$DEPLOYMENT_PATH" > "$TMP"
mv "$TMP" "$DEPLOYMENT_PATH"

echo ""
echo "─────────────────────────────────────────────────────"
echo "DONE. The TUSD market is now the LATEST segment_markets_v4 entry,"
echo "so the frontend's pickSegmentMarketV4() will auto-pick it on next"
echo "reload. SUI market still exists (earlier in the array) — anyone"
echo "with a bookmark to its market id can still use it."
echo "─────────────────────────────────────────────────────"
