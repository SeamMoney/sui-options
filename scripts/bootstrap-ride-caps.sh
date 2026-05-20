#!/usr/bin/env bash
# Bootstrap a RideMarketCaps<SUI> shared object for one of the seeded arcade
# markets. Without this, `open_ride` reverts because the caps object doesn't
# exist for the chosen market.
#
# Re-runnable: by default targets the latest market in deployments/testnet.json
# whose name matches MARKET_NAME (default "WICK-RNG-1000" — longest expiry).
# Patches deployments/testnet.json with a `ride_caps_sui` entry per market.
#
# Usage:
#   ./scripts/bootstrap-ride-caps.sh                          # WRNG-1000
#   MARKET_NAME="WICK-RNG-25" ./scripts/bootstrap-ride-caps.sh
#
# Env overrides (all optional; defaults from docs/design/v2/14_ride_economics.md
# placeholders — tuned later via Monte Carlo):
#   SIGMA_BPS_PER_SQRT_SEC=100
#   MULTIPLIER_BPS=20000              # 2.0x
#   MAX_CONCURRENT_ESCROW=100000000   # 0.1 SUI total
#   PER_USER_MAX_ESCROW=50000000      # 0.05 SUI per user
#   MIN_RATE_MICRO_USD_PER_SEC=100000      # $0.10/sec
#   MAX_RATE_MICRO_USD_PER_SEC=10000000    # $10/sec
#   CASHOUT_SPREAD_BPS=200            # 2%

set -euo pipefail
cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

MARKET_NAME="${MARKET_NAME:-WICK-RNG-1000}"
SIGMA_BPS_PER_SQRT_SEC="${SIGMA_BPS_PER_SQRT_SEC:-100}"
MULTIPLIER_BPS="${MULTIPLIER_BPS:-20000}"
MAX_CONCURRENT_ESCROW="${MAX_CONCURRENT_ESCROW:-100000000}"
PER_USER_MAX_ESCROW="${PER_USER_MAX_ESCROW:-50000000}"
MIN_RATE_MICRO_USD_PER_SEC="${MIN_RATE_MICRO_USD_PER_SEC:-100000}"
MAX_RATE_MICRO_USD_PER_SEC="${MAX_RATE_MICRO_USD_PER_SEC:-10000000}"
CASHOUT_SPREAD_BPS="${CASHOUT_SPREAD_BPS:-200}"
SUI_COIN_TYPE="0x2::sui::SUI"

ARTIFACT="deployments/testnet.json"
[ -f "$ARTIFACT" ] || { red "no $ARTIFACT — run ./scripts/deploy-testnet.sh first"; exit 1; }

PKG=$(python3 -c "import json; print(json.load(open('$ARTIFACT'))['package_id'])")
SENDER=$(sui client active-address)

# Pick the latest market with the requested name (highest expiry_ms).
read -r MARKET PATH_OBS EXPIRY_MS < <(python3 -c "
import json, sys
d = json.load(open('$ARTIFACT'))
name = '$MARKET_NAME'
matches = [m for m in d.get('arcade_markets', []) if m['name'] == name]
if not matches:
    sys.exit(f'no arcade market named {name}')
m = max(matches, key=lambda x: x['expiry_ms'])
print(m['market'], m['path'], m['expiry_ms'])
")

note "package:     $PKG"
note "sender:      $SENDER"
note "market name: $MARKET_NAME"
note "market id:   $MARKET"
note "path id:     $PATH_OBS"
note "expiry_ms:   $EXPIRY_MS"

hr
green "calling ride_market_caps::new<SUI>"
note "  sigma_bps_per_sqrt_sec: $SIGMA_BPS_PER_SQRT_SEC"
note "  multiplier_bps:         $MULTIPLIER_BPS"
note "  max_concurrent_escrow:  $MAX_CONCURRENT_ESCROW MIST"
note "  per_user_max_escrow:    $PER_USER_MAX_ESCROW MIST"
note "  min_rate:               $MIN_RATE_MICRO_USD_PER_SEC micro-USD/sec"
note "  max_rate:               $MAX_RATE_MICRO_USD_PER_SEC micro-USD/sec"
note "  cashout_spread_bps:     $CASHOUT_SPREAD_BPS"

# `new<C>` returns (caps, admin_cap). Share the first, transfer the second.
OUT="/tmp/wick-bootstrap-ride-caps.json"
ERR="/tmp/wick-bootstrap-ride-caps.err"

if ! sui client ptb \
  --move-call "$PKG::ride_market_caps::new" "<$SUI_COIN_TYPE>" \
    "@$MARKET" \
    "@$PATH_OBS" \
    "$SIGMA_BPS_PER_SQRT_SEC" \
    "$MULTIPLIER_BPS" \
    "$MAX_CONCURRENT_ESCROW" \
    "$PER_USER_MAX_ESCROW" \
    "$MIN_RATE_MICRO_USD_PER_SEC" \
    "$MAX_RATE_MICRO_USD_PER_SEC" \
    "$CASHOUT_SPREAD_BPS" \
  --assign result \
  --move-call "$PKG::ride_market_caps::share" "result.0" \
  --transfer-objects "[result.1]" "@$SENDER" \
  --gas-budget 200000000 --json >"$OUT" 2>"$ERR"; then
  red "tx failed:"
  cat "$ERR" >&2
  exit 2
fi

# Strip pre-JSON banner lines.
awk '/^{/ {flag=1} flag {print}' "$OUT" > "${OUT}.clean"

DIGEST=$(python3 -c "import json; print(json.load(open('${OUT}.clean')).get('digest',''))")
CAPS_ID=$(python3 -c "
import json
d = json.load(open('${OUT}.clean'))
for c in d.get('objectChanges', []):
    if c.get('type') == 'created' and '::ride_market_caps::RideMarketCaps' in c.get('objectType',''):
        print(c['objectId']); break
")
ADMIN_CAP_ID=$(python3 -c "
import json
d = json.load(open('${OUT}.clean'))
for c in d.get('objectChanges', []):
    if c.get('type') == 'created' and '::ride_market_caps::RideMarketAdminCap' in c.get('objectType',''):
        print(c['objectId']); break
")

[ -n "$CAPS_ID" ] || { red "couldn't find RideMarketCaps in objectChanges"; exit 3; }
[ -n "$ADMIN_CAP_ID" ] || { red "couldn't find RideMarketAdminCap in objectChanges"; exit 3; }

hr
green "OK"
note "digest:            $DIGEST"
note "RideMarketCaps:    $CAPS_ID"
note "RideMarketAdminCap: $ADMIN_CAP_ID"

# Patch the artifact: attach ride_caps to the chosen market entry, plus a
# top-level convenience alias for the freshest cap so the frontend can find
# one without scanning.
python3 - "$ARTIFACT" <<PY
import json, sys
path = sys.argv[1]
with open(path) as f: d = json.load(f)

market_id = "$MARKET"
caps_id = "$CAPS_ID"
admin_cap_id = "$ADMIN_CAP_ID"

for m in d.get("arcade_markets", []):
    if m["market"] == market_id:
        m["ride_caps"] = caps_id
        m["ride_caps_admin"] = admin_cap_id

# Top-level convenience: latest ride caps for the SUI vault.
d["ride_caps_sui"] = caps_id
d["ride_caps_sui_admin"] = admin_cap_id

with open(path, "w") as f:
    json.dump(d, f, indent=2)
print(f"patched {path}")
PY

hr
green "DONE — ride caps live on testnet, artifact patched"
note "next: open http://localhost:5173/ride-test, connect Slush, hit Open"
