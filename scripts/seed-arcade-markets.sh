#!/usr/bin/env bash
# Seed a fresh batch of arcade (random-walk) markets against the live
# C.3 ABI. Bootstraps a MartingalerVault<SUI> if one isn't recorded yet,
# seeds it with a small LP, then creates N random-walk touch markets
# with rolling expiries.
#
# Re-runnable: skips vault bootstrap if deployments/testnet.json already
# has a vault_sui. Always creates fresh markets.
#
# Usage:
#   ./scripts/seed-arcade-markets.sh
#
# Env vars:
#   SEED_MIST=200000000   # 0.2 SUI vault seed (LP)
#   MARKET_COUNT=3
#   PAYOUT_MULT_BPS=18000 # 1.8x payout
#   VOL_BPS=50
#   FRESHNESS_MS=5000

set -euo pipefail

cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

SEED_MIST="${SEED_MIST:-200000000}"        # 0.2 SUI
MARKET_COUNT="${MARKET_COUNT:-3}"
PAYOUT_MULT_BPS="${PAYOUT_MULT_BPS:-18000}"
VOL_BPS="${VOL_BPS:-50}"
FRESHNESS_MS="${FRESHNESS_MS:-120000}"  # 2min — the keeper needs real time to crank lock_and_settle after the first post-expiry tick latches settlement_observation
CORRELATION_BUCKET=0
SUI_COIN_TYPE="0x2::sui::SUI"

ARTIFACT="deployments/testnet.json"
[ -f "$ARTIFACT" ] || { red "no $ARTIFACT — run ./scripts/deploy-testnet.sh first"; exit 1; }

PKG=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["package_id"])' "$ARTIFACT")
SENDER=$(sui client active-address)
note "package: $PKG"
note "sender:  $SENDER"

# ---------- helpers ----------

run_tx() {
  local label="$1"; shift
  local out="/tmp/wick-seed-${label}.json"
  if ! "$@" >"$out" 2>"/tmp/wick-seed-${label}.err"; then
    red "tx '$label' failed:"; cat "/tmp/wick-seed-${label}.err" >&2; exit 2
  fi
  awk '/^{/ {flag=1} flag {print}' "$out" > "/tmp/wick-seed-${label}-clean.json"
  echo "/tmp/wick-seed-${label}-clean.json"
}

created_of_type() {
  python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
needle = sys.argv[2]
for c in d.get('objectChanges', []):
    if c.get('type') == 'created' and needle in c.get('objectType', ''):
        print(c.get('objectId',''))
        break
" "$1" "$2"
}

all_created_of_type() {
  python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
needle = sys.argv[2]
for c in d.get('objectChanges', []):
    if c.get('type') == 'created' and needle in c.get('objectType', ''):
        print(c.get('objectId',''))
" "$1" "$2"
}

biggest_gas_coin_above() {
  local floor_mist="$1"
  sui client gas --json 2>/dev/null \
    | python3 -c "
import json, sys
floor = int(sys.argv[1])
coins = json.load(sys.stdin)
ok = [c for c in coins if int(c['mistBalance']) > floor]
if not ok:
    sys.exit(1)
ok.sort(key=lambda c: int(c['mistBalance']), reverse=True)
print(ok[0]['gasCoinId'])
" "$floor_mist"
}

upsert_artifact() {
  python3 - "$ARTIFACT" <<PY
import json, sys
path = sys.argv[1]
with open(path) as f: d = json.load(f)
for k, v in {
    "vault_sui": "$VAULT_ID",
    "vault_admin_cap_sui": "$VAULT_CAP",
}.items():
    if v: d[k] = v
markets = d.get("arcade_markets", [])
$MARKETS_PY
d["arcade_markets"] = markets
with open(path, "w") as f: json.dump(d, f, indent=2)
PY
}

# ---------- 1. Bootstrap vault (if needed) ----------

VAULT_ID=$(python3 -c "import json; d=json.load(open('$ARTIFACT')); print(d.get('vault_sui',''))" 2>/dev/null || echo "")
VAULT_CAP=$(python3 -c "import json; d=json.load(open('$ARTIFACT')); print(d.get('vault_admin_cap_sui',''))" 2>/dev/null || echo "")

if [ -z "$VAULT_ID" ]; then
  hr
  green "bootstrapping MartingalerVault<SUI>"
  OUT=$(run_tx "bootstrap-vault" \
    sui client call \
      --package "$PKG" --module wick --function bootstrap_vault \
      --type-args "$SUI_COIN_TYPE" \
      --gas-budget 100000000 --json)
  VAULT_ID=$(created_of_type "$OUT" "::martingaler_vault::MartingalerVault<")
  VAULT_CAP=$(created_of_type "$OUT" "::martingaler_vault::VaultAdminCap")
  note "vault: $VAULT_ID"
  note "cap:   $VAULT_CAP"
fi

# ---------- 2. Seed vault with LP ----------

hr
green "seeding vault with $SEED_MIST MIST"
GAS=$(biggest_gas_coin_above $((SEED_MIST + 100000000))) || {
  red "no gas coin large enough to split off $SEED_MIST + 0.1 SUI fee"
  red "current gas:"
  sui client gas 2>&1 | head -8
  exit 3
}

SPLIT_OUT=$(run_tx "split-seed" \
  sui client split-coin --coin-id "$GAS" --amounts "$SEED_MIST" \
    --gas-budget 50000000 --json)
SEED_COIN=$(created_of_type "$SPLIT_OUT" "0x2::coin::Coin<0x2::sui::SUI>")
note "seed coin: $SEED_COIN"

run_tx "seed-vault" \
  sui client call \
    --package "$PKG" --module wick --function seed_vault \
    --type-args "$SUI_COIN_TYPE" \
    --args "$VAULT_ID" "$SEED_COIN" 0x6 \
    --gas-budget 100000000 --json >/dev/null
note "vault seeded with $SEED_MIST MIST"

# ---------- 3. Bootstrap N random-walk markets ----------

# Market specs: (name, underlying, starting_price, barrier, direction, expiry_offset_s)
# starting_price is in micro-USD; barrier offset is ±5% of start.
SPECS=(
  "WICK-RNG-25      WICK_RNG      25000000      26000000     0   300"     # 5min, touch-above (4% room)
  "WICK-RNG-100     WICK_RNG_HI   100000000     95000000     1   600"     # 10min, touch-below (5% room)
  "WICK-RNG-1000    WICK_RNG_MEM  1000000000    1030000000   0   1200"    # 20min, touch-above (3% room)
)

MARKETS_PY=""
idx=0
for spec in "${SPECS[@]}"; do
  idx=$((idx + 1))
  [ "$idx" -gt "$MARKET_COUNT" ] && break
  read -r NAME UNDER START BARRIER DIR OFFSET <<< "$spec"
  EXPIRY_MS=$(python3 -c "import time; print(int(time.time()*1000) + ${OFFSET}*1000)")

  hr
  green "[$idx] $NAME ($UNDER)  start=$START  barrier=$BARRIER  dir=$DIR  expires=+${OFFSET}s"
  OUT=$(run_tx "market-$idx" \
    sui client call \
      --package "$PKG" --module wick --function bootstrap_random_walk_market \
      --type-args "$SUI_COIN_TYPE" \
      --args "$NAME" "$UNDER" "$START" "$VOL_BPS" "$BARRIER" "$DIR" \
             "$EXPIRY_MS" "$FRESHNESS_MS" "$PAYOUT_MULT_BPS" \
             "$CORRELATION_BUCKET" "$VAULT_ID" 0x6 \
      --gas-budget 200000000 --json)

  MARKET=$(created_of_type "$OUT" "::market::Market<")
  ORACLE=$(created_of_type "$OUT" "::wick_oracle::WickOracle")
  PATH_OBS=$(created_of_type "$OUT" "::path_observation::PathObservation")
  RW=$(created_of_type "$OUT" "::random_walk_driver::RandomWalk")
  note "  market: $MARKET"
  note "  oracle: $ORACLE"
  note "  path:   $PATH_OBS"
  note "  rwalk:  $RW"

  MARKETS_PY+="markets.append({\"name\":\"$NAME\",\"market\":\"$MARKET\",\"oracle\":\"$ORACLE\",\"path\":\"$PATH_OBS\",\"random_walk\":\"$RW\",\"barrier\":$BARRIER,\"direction\":$DIR,\"expiry_ms\":$EXPIRY_MS});"
done

upsert_artifact

hr
green "OK — seeded $idx markets against package $PKG"
note "artifact updated: $ARTIFACT"
