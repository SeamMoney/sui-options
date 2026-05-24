#!/usr/bin/env bash
# Publish the wick-tusd test stablecoin package + mint a billion TUSD
# to the publisher. After this lands, the operator holds the TreasuryCap
# (= unlimited mint authority) plus a 1B TUSD bag they can hand out
# however they want.
#
# Prerequisites:
#   - sui CLI logged in as the publisher (`sui client active-address`
#     should match deployments/testnet.json:publisher)
#   - At least 0.6 SUI in the publisher wallet for publish + mint gas
#
# Writes the new addresses (package id, treasury cap id, coin type tag)
# into deployments/testnet.json under the `tusd` key, so the frontend
# and bootstrap scripts can find them.
#
# Usage:
#   bash scripts/publish-tusd.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENT_PATH="$REPO_ROOT/deployments/testnet.json"
TUSD_PKG_DIR="$REPO_ROOT/move/wick-tusd"

GAS_BUDGET_PUBLISH=500000000   # 0.5 SUI
GAS_BUDGET_MINT=20000000        # 0.02 SUI
MINT_AMOUNT_RAW=1000000000000000  # 1B TUSD (6 decimals) = 1_000_000_000.000000

if ! command -v sui >/dev/null 2>&1; then
  echo "sui CLI not found in PATH" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found in PATH" >&2
  exit 1
fi

PUBLISHER=$(sui client active-address)
EXPECTED_PUBLISHER=$(jq -r '.publisher' "$DEPLOYMENT_PATH")
if [ "$PUBLISHER" != "$EXPECTED_PUBLISHER" ]; then
  echo "active sui address $PUBLISHER != deployments publisher $EXPECTED_PUBLISHER" >&2
  echo "switch with: sui client switch --address $EXPECTED_PUBLISHER" >&2
  exit 1
fi

echo "─────────────────────────────────────────────────────"
echo "Publishing wick-tusd from $TUSD_PKG_DIR"
echo "Publisher: $PUBLISHER"
echo "Gas budget: $((GAS_BUDGET_PUBLISH / 1000000000)).$(printf '%09d' $((GAS_BUDGET_PUBLISH % 1000000000)) | cut -c1-3) SUI"
echo "─────────────────────────────────────────────────────"

# ── 1. PUBLISH ──────────────────────────────────────────────────────────
PUBLISH_OUT=$(sui client publish \
  --gas-budget "$GAS_BUDGET_PUBLISH" \
  --json \
  "$TUSD_PKG_DIR")

# Extract package id and TreasuryCap id from objectChanges
TUSD_PKG=$(echo "$PUBLISH_OUT" | jq -r '
  .objectChanges[] | select(.type == "published") | .packageId
')
TREASURY_CAP=$(echo "$PUBLISH_OUT" | jq -r '
  .objectChanges[]
  | select(.type == "created" and (.objectType | contains("0x2::coin::TreasuryCap<")))
  | .objectId
')
METADATA=$(echo "$PUBLISH_OUT" | jq -r '
  .objectChanges[]
  | select(.type == "created" and (.objectType | contains("0x2::coin::CoinMetadata<")))
  | .objectId
')

if [ -z "$TUSD_PKG" ] || [ "$TUSD_PKG" = "null" ]; then
  echo "could not extract published package id" >&2
  echo "$PUBLISH_OUT"
  exit 1
fi

COIN_TYPE="${TUSD_PKG}::tusd::TUSD"
echo "✓ Published wick-tusd"
echo "  package_id:    $TUSD_PKG"
echo "  treasury_cap:  $TREASURY_CAP"
echo "  metadata:      $METADATA"
echo "  coin_type:     $COIN_TYPE"
echo ""

# ── 2. MINT 1B TUSD to publisher ────────────────────────────────────────
echo "Minting $((MINT_AMOUNT_RAW / 1000000)) TUSD to publisher"
MINT_OUT=$(sui client call \
  --package "$TUSD_PKG" \
  --module tusd \
  --function mint \
  --args "$TREASURY_CAP" "$MINT_AMOUNT_RAW" "$PUBLISHER" \
  --gas-budget "$GAS_BUDGET_MINT" \
  --json)

MINTED_COIN=$(echo "$MINT_OUT" | jq -r '
  .objectChanges[]
  | select(.type == "created" and (.objectType | contains("0x2::coin::Coin<")) and (.objectType | contains("tusd::TUSD")))
  | .objectId
')
echo "✓ Minted. New coin object: $MINTED_COIN"
echo ""

# ── 3. Write to deployments/testnet.json ────────────────────────────────
TMP=$(mktemp)
jq --arg pkg "$TUSD_PKG" \
   --arg cap "$TREASURY_CAP" \
   --arg meta "$METADATA" \
   --arg type "$COIN_TYPE" \
   --arg coin "$MINTED_COIN" \
   --arg amt  "$MINT_AMOUNT_RAW" \
   '.tusd = {
      "package_id": $pkg,
      "treasury_cap": $cap,
      "metadata": $meta,
      "coin_type": $type,
      "publisher_coin": $coin,
      "publisher_balance_raw": $amt,
      "decimals": 6
    }' "$DEPLOYMENT_PATH" > "$TMP"
mv "$TMP" "$DEPLOYMENT_PATH"

echo "✓ Updated deployments/testnet.json with .tusd block"
echo ""
echo "─────────────────────────────────────────────────────"
echo "DONE. The operator now holds:"
echo "  - The TreasuryCap (unlimited future mint authority)"
echo "  - 1,000,000,000 TUSD in coin $MINTED_COIN"
echo ""
echo "Next step (only if you want TUSD-collateralized markets):"
echo "  - Bootstrap MartingalerVault<TUSD> + SegmentMarketV4<TUSD>"
echo "  - Frontend market picker + TUSD faucet endpoint"
echo "─────────────────────────────────────────────────────"
