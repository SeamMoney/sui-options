#!/usr/bin/env bash
# End-to-end on-chain smoke test for the Wick Markets package (C.3 ABI).
#
# Flow:
#   1. Preflight: env=testnet, artifact present, vault_sui set, arcade markets seeded
#   2. Bootstrap shared singletons if missing (risk_config, global_exposure_registry,
#      bot_registry, fee_router<SUI>, usd_price_oracle, wick_staking_pool).
#      All admin caps are transferred to the active address and the IDs are persisted
#      to deployments/testnet.json so the next run skips this step.
#   3. Pick the shortest-expiry arcade market.
#   4. Split a small SUI coin off gas and open a TOUCH position via PTB.
#   5. Loop until now > expiry + drain: every 30s, tick the random walk + record path.
#   6. wick::lock_and_settle to crank settlement.
#   7. Inspect market.status, then either redeem (HIT/EXPIRED) or skip (ABORTED).
#   8. Print P&L summary.
#
# This script writes — it costs real testnet gas. Wallet should have >= 1 SUI.
#
# Usage:
#   ./scripts/smoke.sh
#
# Env vars:
#   STAKE_MIST=10000000     # 0.01 SUI stake on the TOUCH position
#   TICK_INTERVAL_S=30      # seconds between random-walk ticks
#   MAX_WAIT_S=1500         # safety cap on the polling loop (25 min)

set -euo pipefail

cd "$(dirname "$0")/.."

# ---------- env ----------

STAKE_MIST="${STAKE_MIST:-100000}"            # 0.0001 SUI (fits 50bps per-position cap on a 0.2 SUI seeded vault)
TICK_INTERVAL_S="${TICK_INTERVAL_S:-30}"
MAX_WAIT_S="${MAX_WAIT_S:-1500}"
SUI_COIN_TYPE="0x2::sui::SUI"
ARTIFACT="deployments/testnet.json"
CLOCK="0x6"

# ---------- ansi ----------

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }

# ---------- preflight ----------

command -v sui >/dev/null 2>&1 || { red "sui CLI not on PATH"; exit 1; }
command -v python3 >/dev/null 2>&1 || { red "python3 not on PATH"; exit 1; }

ACTIVE_ENV=$(sui client active-env 2>/dev/null || echo "")
if [ "$ACTIVE_ENV" != "testnet" ]; then
  red "active sui env is '$ACTIVE_ENV', expected 'testnet'"
  red "run: sui client switch --env testnet"
  exit 1
fi

[ -f "$ARTIFACT" ] || { red "no $ARTIFACT — run ./scripts/deploy-testnet.sh first"; exit 1; }

PKG=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["package_id"])' "$ARTIFACT")
[ -n "$PKG" ] || { red "package_id missing from $ARTIFACT"; exit 1; }
SENDER=$(sui client active-address)

VAULT_ID=$(python3 -c "import json; d=json.load(open('$ARTIFACT')); print(d.get('vault_sui',''))" 2>/dev/null || echo "")
if [ -z "$VAULT_ID" ]; then
  red "vault_sui missing from $ARTIFACT"
  red "run: ./scripts/seed-arcade-markets.sh first (it bootstraps + seeds the MartingalerVault<SUI>)"
  exit 1
fi

ARCADE_COUNT=$(python3 -c "import json; d=json.load(open('$ARTIFACT')); print(len(d.get('arcade_markets',[])))" 2>/dev/null || echo "0")
if [ "$ARCADE_COUNT" -eq 0 ]; then
  red "no arcade_markets in $ARTIFACT"
  red "run: ./scripts/seed-arcade-markets.sh first"
  exit 1
fi

note "package:  $PKG"
note "sender:   $SENDER"
note "vault:    $VAULT_ID"
note "markets:  $ARCADE_COUNT arcade markets in artifact"
hr

# Gas check (need at least 0.5 SUI for ticks + settle + redeem + stake).
TOTAL_GAS_MIST=$(sui client gas --json 2>/dev/null \
  | python3 -c "import json,sys; print(sum(int(c['mistBalance']) for c in json.load(sys.stdin)))")
MIN_GAS=$((STAKE_MIST + 500000000))   # stake + ~0.5 SUI for ticks + settle + redeem
if [ "$TOTAL_GAS_MIST" -lt "$MIN_GAS" ]; then
  red "insufficient gas: have $TOTAL_GAS_MIST mist, need >= $MIN_GAS mist"
  red "run: ./scripts/faucet.sh"
  exit 1
fi
note "gas:      $TOTAL_GAS_MIST mist (need >= $MIN_GAS)"

# ---------- helpers ----------

# Run a sui command. Capture stdout to json file, stderr to err file.
# Strips Sui CLI's preamble (everything before the first '{').
run_tx() {
  local label="$1"; shift
  local raw="/tmp/wick-smoke-${label}-raw.txt"
  local out="/tmp/wick-smoke-${label}.json"
  local err="/tmp/wick-smoke-${label}.err"
  if ! "$@" >"$raw" 2>"$err"; then
    red "tx '$label' failed:"
    red "  stderr:"; cat "$err" >&2
    red "  stdout:"; cat "$raw" >&2
    exit 2
  fi
  awk '/^{/ {flag=1} flag {print}' "$raw" > "$out"
  if [ ! -s "$out" ]; then
    red "tx '$label' produced no JSON output:"
    cat "$raw" >&2
    exit 2
  fi
  echo "$out"
}

# Parse a created object id whose type contains $2. Returns first match.
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

# Parse digest.
digest_of() {
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('digest',''))" "$1"
}

# Status code of a transaction (success/failure).
status_of() {
  python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
eff=d.get('effects',{}).get('status',{})
print(eff.get('status','unknown'))
" "$1"
}

# Pick the gas coin with the largest balance above a floor.
biggest_gas_coin_above() {
  local floor_mist="$1"
  sui client gas --json 2>/dev/null \
    | python3 -c "
import json, sys
floor = int(sys.argv[1])
coins = json.load(sys.stdin)
ok = [c for c in coins if int(c['mistBalance']) > floor]
if not ok: sys.exit(1)
ok.sort(key=lambda c: int(c['mistBalance']), reverse=True)
print(ok[0]['gasCoinId'])
" "$floor_mist"
}

# Patch a top-level key=value (string) into the artifact.
patch_artifact_kv() {
  local key="$1" value="$2"
  python3 - "$ARTIFACT" "$key" "$value" <<'PY'
import json, sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f: d = json.load(f)
d[key] = value
with open(path, 'w') as f: json.dump(d, f, indent=2)
PY
}

# Look up a string key from the artifact (empty if missing).
artifact_get() {
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$ARTIFACT" "$1"
}

# Sum mist-denominated balanceChange for SUI at $owner from a tx json.
sui_balance_change_for() {
  local txjson="$1" owner="$2"
  python3 -c "
import json, sys
d=json.load(open(sys.argv[1]))
owner=sys.argv[2]
total=0
for ch in d.get('balanceChanges',[]):
    o=ch.get('owner',{})
    addr=o.get('AddressOwner','') if isinstance(o,dict) else ''
    if addr==owner and ch.get('coinType','').endswith('::sui::SUI'):
        total += int(ch.get('amount','0'))
print(total)
" "$txjson" "$owner"
}

# Read market.status (u8) from on-chain object.
fetch_market_status() {
  local market="$1"
  sui client object "$market" --json 2>/dev/null | python3 -c "
import json, sys
d=json.load(sys.stdin)
# Sui RPC v1: fields live directly under 'content' (not 'content.fields').
# Status comes back as a JSON number — could be int or float — coerce.
content = d.get('content', {})
s = content.get('status', content.get('fields', {}).get('status', -1))
try:
    print(int(float(s)))
except (TypeError, ValueError):
    print(-1)
"
}

# Pretty status label.
status_label() {
  case "$1" in
    0) echo "ACTIVE" ;;
    1) echo "HIT" ;;
    2) echo "EXPIRED" ;;
    3) echo "ABORTED" ;;
    4) echo "CANCELLED" ;;
    5) echo "DNT_HELD" ;;
    6) echo "DNT_BROKEN" ;;
    *) echo "UNKNOWN($1)" ;;
  esac
}

# ---------- 1. Bootstrap shared singletons if missing ----------

# Each of these returns an AdminCap (transferred to the sender) and shares the
# underlying object. We persist the shared object id (NOT the cap id) into
# deployments/testnet.json. None of the init_* fns are #[test_only] — they are
# production entry points that just haven't been called yet on this package.

RISK_CONFIG=$(artifact_get "risk_config")
EXPOSURE_REGISTRY=$(artifact_get "global_exposure_registry")
BOT_REGISTRY=$(artifact_get "bot_registry")
FEE_ROUTER_SUI=$(artifact_get "fee_router_sui")
PRICE_ORACLE=$(artifact_get "usd_price_oracle")
STAKING_POOL=$(artifact_get "wick_staking_pool")

bootstrap_singleton() {
  # $1=label, $2=module, $3=function, $4=share-object-type-needle,
  # $5=cap-type-needle, $6..=extra positional args to the init function
  # (e.g. an address arg for wick_staking::init_pool).
  #
  # These init_* functions return a cap object — plain `sui client call`
  # crashes with UnusedValueWithoutDrop because the returned cap isn't
  # consumed. PTB syntax with `--assign cap --transfer-objects [cap] @addr`
  # is required so the cap lands in the sender's wallet.
  local label="$1" module="$2" func="$3" obj_needle="$4" cap_needle="$5"
  shift 5
  # IMPORTANT: status output goes to stderr — bootstrap_singleton's stdout
  # is captured by $() to extract the shared_id. Anything written to stdout
  # other than the final `echo "$shared_id"` corrupts the caller's variable.
  green ">>> init: $label" >&2

  # Build positional args for the move-call. For init_pool's address arg
  # the value is already in the form expected by sui PTB CLI (no @).
  local mc_args=()
  if [ "$#" -gt 0 ]; then mc_args=("$@"); fi

  # Type-arg suffix (currently only fee_router needs <SUI>).
  local target="$PKG::$module::$func"
  if [ "$module" = "fee_router" ]; then
    target="$target<$SUI_COIN_TYPE>"
  fi

  local out
  out=$(run_tx "init-$label" \
    sui client ptb \
      --move-call "$target" ${mc_args[@]+"${mc_args[@]}"} \
      --assign cap \
      --transfer-objects "[cap]" "@$SENDER" \
      --gas-budget 100000000 --json)

  local shared_id cap_id
  shared_id=$(created_of_type "$out" "$obj_needle")
  cap_id=$(created_of_type "$out" "$cap_needle")
  if [ -z "$shared_id" ]; then
    red "could not parse shared object id (needle: $obj_needle) from $label init"
    exit 4
  fi
  note "    shared: $shared_id" >&2
  note "    cap:    $cap_id" >&2
  echo "$shared_id"
}

if [ -z "$RISK_CONFIG" ]; then
  hr
  RISK_CONFIG=$(bootstrap_singleton "risk_config" "risk_config" "init_config" \
    "::risk_config::RiskConfig" "::risk_config::RiskAdminCap")
  patch_artifact_kv "risk_config" "$RISK_CONFIG"
fi
note "risk_config:       $RISK_CONFIG"

if [ -z "$EXPOSURE_REGISTRY" ]; then
  hr
  EXPOSURE_REGISTRY=$(bootstrap_singleton "global_exposure_registry" \
    "global_exposure_registry" "init_registry" \
    "::global_exposure_registry::GlobalExposureRegistry" \
    "::global_exposure_registry::RegistryAdminCap")
  patch_artifact_kv "global_exposure_registry" "$EXPOSURE_REGISTRY"
fi
note "exposure_registry: $EXPOSURE_REGISTRY"

if [ -z "$BOT_REGISTRY" ]; then
  hr
  BOT_REGISTRY=$(bootstrap_singleton "bot_registry" \
    "bot_registry" "init_registry" \
    "::bot_registry::BotRegistry" "::bot_registry::BotAdminCap")
  patch_artifact_kv "bot_registry" "$BOT_REGISTRY"
fi
note "bot_registry:      $BOT_REGISTRY"

if [ -z "$FEE_ROUTER_SUI" ]; then
  hr
  FEE_ROUTER_SUI=$(bootstrap_singleton "fee_router_sui" \
    "fee_router" "init_router" \
    "::fee_router::FeeRouter" "::fee_router::FeeRouterAdminCap")
  patch_artifact_kv "fee_router_sui" "$FEE_ROUTER_SUI"
fi
note "fee_router<SUI>:   $FEE_ROUTER_SUI"

if [ -z "$PRICE_ORACLE" ]; then
  hr
  PRICE_ORACLE=$(bootstrap_singleton "usd_price_oracle" \
    "usd_price_oracle" "init_oracle" \
    "::usd_price_oracle::UsdPriceOracle" "::usd_price_oracle::PriceAdminCap")
  patch_artifact_kv "usd_price_oracle" "$PRICE_ORACLE"
fi
note "price_oracle:      $PRICE_ORACLE"

if [ -z "$STAKING_POOL" ]; then
  hr
  STAKING_POOL=$(bootstrap_singleton "wick_staking_pool" \
    "wick_staking" "init_pool" \
    "::wick_staking::WickStakingPool" "::wick_staking::StakingAdminCap" \
    "@$SENDER")
  patch_artifact_kv "wick_staking_pool" "$STAKING_POOL"
fi
note "staking_pool:      $STAKING_POOL"

# WickTokenState is auto-shared at publish — read from publish archive if not set.
WICK_STATE=$(artifact_get "wick_token_state")
if [ -z "$WICK_STATE" ]; then
  PUBLISH_LOG=$(artifact_get "raw_log")
  if [ -n "$PUBLISH_LOG" ] && [ -f "$PUBLISH_LOG" ]; then
    WICK_STATE=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
for c in d.get('objectChanges',[]):
    if c.get('type')=='created' and '::wick_token::WickTokenState' in c.get('objectType',''):
        print(c.get('objectId','')); break
" "$PUBLISH_LOG")
    [ -n "$WICK_STATE" ] && patch_artifact_kv "wick_token_state" "$WICK_STATE"
  fi
fi
if [ -z "$WICK_STATE" ]; then
  red "could not resolve WickTokenState id (not in artifact, publish log missing)"
  red "redeem will fail without it. add 'wick_token_state' to $ARTIFACT and rerun."
  exit 5
fi
note "wick_state:        $WICK_STATE"

# ---------- 2. Pick the shortest-expiry arcade market ----------

hr
green ">>> selecting shortest-expiry arcade market"

MARKET_PICK=$(python3 -c "
import json, time
d=json.load(open('$ARTIFACT'))
mkts=d.get('arcade_markets',[])
if not mkts:
    raise SystemExit('no arcade markets')
now_ms = int(time.time()*1000)
# Prefer markets with time remaining (so we can exercise open + tick + settle).
# Fall back to the most-recently-expired market if all have passed expiry.
unexpired = [m for m in mkts if m['expiry_ms'] > now_ms]
if unexpired:
    pick = min(unexpired, key=lambda m: m['expiry_ms'])
else:
    # All expired — pick the one closest to expiry (least time past). Settlement
    # is idempotent so this is safe even if already settled.
    pick = max(mkts, key=lambda m: m['expiry_ms'])
print(pick['name'], pick['market'], pick['oracle'], pick['path'], pick['random_walk'], pick['barrier'], pick['direction'], pick['expiry_ms'])
")
read -r M_NAME MARKET ORACLE PATH_OBS RWALK BARRIER DIRECTION EXPIRY_MS <<< "$MARKET_PICK"
note "name:      $M_NAME"
note "market:    $MARKET"
note "oracle:    $ORACLE"
note "path:      $PATH_OBS"
note "rwalk:     $RWALK"
note "barrier:   $BARRIER  (direction=$DIRECTION  0=above,1=below)"
note "expiry_ms: $EXPIRY_MS"

NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
SECS_TO_EXPIRY=$(( (EXPIRY_MS - NOW_MS) / 1000 ))
if [ "$SECS_TO_EXPIRY" -le 0 ]; then
  warn "market already past expiry by $((-SECS_TO_EXPIRY))s — skipping open, going straight to settle"
  SKIP_OPEN=1
else
  note "time-to-expiry: ${SECS_TO_EXPIRY}s"
  SKIP_OPEN=0
fi

# Live market sanity: status must be ACTIVE for open.
LIVE_STATUS=$(fetch_market_status "$MARKET")
LIVE_STATUS_LABEL=$(status_label "$LIVE_STATUS")
note "live market status: $LIVE_STATUS_LABEL ($LIVE_STATUS)"

# ---------- 3. Open TOUCH position (PTB) ----------

POS_ID=""
OPEN_DIGEST=""
OPENED_AT_MS=""

if [ "$SKIP_OPEN" -eq 0 ] && [ "$LIVE_STATUS" = "0" ]; then
  hr
  green ">>> opening TOUCH position with $STAKE_MIST mist stake"

  # Use the latest oracle price as `spot`; if no observation yet, fall back to barrier.
  SPOT=$(sui client object "$ORACLE" --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
f=d.get('content',{}).get('fields',{})
latest=f.get('latest')
if isinstance(latest, dict):
    v=latest.get('fields',{}).get('vec',[])
    if v:
        po=v[0].get('fields',{}) if isinstance(v[0],dict) else {}
        print(po.get('price','0')); sys.exit(0)
print('0')
")
  if [ -z "$SPOT" ] || [ "$SPOT" = "0" ]; then
    SPOT="$BARRIER"
    note "no oracle obs yet, using barrier as spot: $SPOT"
  else
    note "oracle spot: $SPOT"
  fi

  OPENED_AT_MS=$(python3 -c "import time; print(int(time.time()*1000))")
  OPEN_OUT=$(run_tx "open-touch" \
    sui client ptb \
      --split-coins gas "[$STAKE_MIST]" --assign stake \
      --move-call "${PKG}::wick::open_touch" "<$SUI_COIN_TYPE>" \
        "@${MARKET}" "@${VAULT_ID}" "@${RISK_CONFIG}" \
        "@${EXPOSURE_REGISTRY}" "@${BOT_REGISTRY}" "@${PATH_OBS}" \
        stake.0 "$SPOT" "@${CLOCK}" \
      --assign pos \
      --transfer-objects "[pos]" "@${SENDER}" \
      --gas-budget 300000000 --json)
  OPEN_DIGEST=$(digest_of "$OPEN_OUT")
  POS_ID=$(created_of_type "$OPEN_OUT" "::market::Position")
  [ -n "$POS_ID" ] || { red "could not parse Position id from open_touch"; exit 6; }
  note "    position: $POS_ID"
  note "    digest:   $OPEN_DIGEST"
else
  warn "skipping open (status=$LIVE_STATUS_LABEL or past expiry)"
fi

# ---------- 4. Tick loop until past expiry+drain ----------

hr
green ">>> ticking random walk every ${TICK_INTERVAL_S}s until expiry+drain"

# Pull pre_lock_drain_ms from the path observation.
DRAIN_MS=$(sui client object "$PATH_OBS" --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('content',{}).get('fields',{}).get('pre_lock_drain_ms','5000'))
")
note "drain_ms: $DRAIN_MS"
SETTLE_UNLOCK_MS=$(( EXPIRY_MS + DRAIN_MS + 2000 ))   # +2s buffer

TICK_COUNT=0
LOOP_START=$(python3 -c "import time; print(int(time.time()*1000))")
while true; do
  NOW=$(python3 -c "import time; print(int(time.time()*1000))")
  if [ "$NOW" -ge "$SETTLE_UNLOCK_MS" ]; then
    note "now=$NOW >= settle_unlock=$SETTLE_UNLOCK_MS, exiting tick loop"
    break
  fi
  if [ $(( (NOW - LOOP_START) / 1000 )) -ge "$MAX_WAIT_S" ]; then
    warn "MAX_WAIT_S=$MAX_WAIT_S reached, exiting tick loop"
    break
  fi

  TICK_COUNT=$((TICK_COUNT + 1))
  gray "tick #$TICK_COUNT — t-${SECS_TO_EXPIRY}s to expiry"

  # tick the random walk (mutates oracle.latest)
  if ! sui client ptb \
      --move-call "${PKG}::random_walk_driver::tick" \
        "@${RWALK}" "@${ORACLE}" "@${CLOCK}" \
      --gas-budget 50000000 --json >/tmp/wick-smoke-tick-$TICK_COUNT.txt 2>&1; then
    warn "tick #$TICK_COUNT failed (continuing):"
    tail -5 /tmp/wick-smoke-tick-$TICK_COUNT.txt >&2 || true
  fi

  # record path obs (consumes the new oracle observation)
  if ! sui client ptb \
      --move-call "${PKG}::path_observation::record" \
        "@${PATH_OBS}" "@${ORACLE}" "@${CLOCK}" \
      --gas-budget 50000000 --json >/tmp/wick-smoke-rec-$TICK_COUNT.txt 2>&1; then
    warn "record #$TICK_COUNT failed (continuing):"
    tail -5 /tmp/wick-smoke-rec-$TICK_COUNT.txt >&2 || true
  fi

  # Recompute time-to-expiry for next iter
  NOW=$(python3 -c "import time; print(int(time.time()*1000))")
  SECS_TO_EXPIRY=$(( (EXPIRY_MS - NOW) / 1000 ))

  REMAINING=$(( SETTLE_UNLOCK_MS - NOW ))
  if [ "$REMAINING" -gt 0 ] && [ "$REMAINING" -gt $((TICK_INTERVAL_S * 1000)) ]; then
    sleep "$TICK_INTERVAL_S"
  elif [ "$REMAINING" -gt 0 ]; then
    sleep $(( (REMAINING / 1000) + 1 ))
  fi
done

note "ticks issued: $TICK_COUNT"

# ---------- 5. lock_and_settle ----------

hr
green ">>> wick::lock_and_settle"
SETTLE_OUT=$(run_tx "lock-and-settle" \
  sui client ptb \
    --move-call "${PKG}::wick::lock_and_settle" "<$SUI_COIN_TYPE>" \
      "@${MARKET}" "@${VAULT_ID}" "@${PATH_OBS}" "@${ORACLE}" \
      "@${EXPOSURE_REGISTRY}" "@${CLOCK}" \
    --gas-budget 200000000 --json)
SETTLE_DIGEST=$(digest_of "$SETTLE_OUT")
note "    digest: $SETTLE_DIGEST"
SETTLED_AT_MS=$(python3 -c "import time; print(int(time.time()*1000))")

# ---------- 6. inspect market status, then redeem (or skip) ----------

FINAL_STATUS=$(fetch_market_status "$MARKET")
FINAL_STATUS_LABEL=$(status_label "$FINAL_STATUS")
hr
note "post-settle market status: $FINAL_STATUS_LABEL ($FINAL_STATUS)"

PAYOUT_MIST=0
REDEEM_DIGEST=""
REDEEM_STATUS="skipped"

if [ -z "$POS_ID" ]; then
  warn "no position opened — skipping redeem"
elif [ "$FINAL_STATUS" = "0" ]; then
  red "market still ACTIVE post-settle — settlement may not be eligible yet"
  REDEEM_STATUS="market-still-active"
elif [ "$FINAL_STATUS" = "3" ]; then
  # ABORTED: redeem still works and returns a 1:1 refund per market::redeem.
  warn "market ABORTED — redeem returns 1:1 refund (no fee, no WICK mint)"
  green ">>> wick::redeem (aborted refund path)"
  REDEEM_OUT=$(run_tx "redeem-aborted" \
    sui client ptb \
      --move-call "${PKG}::wick::redeem" "<$SUI_COIN_TYPE>" \
        "@${MARKET}" "@${VAULT_ID}" "@${RISK_CONFIG}" "@${FEE_ROUTER_SUI}" \
        "@${WICK_STATE}" "@${STAKING_POOL}" "@${PRICE_ORACLE}" \
        "@${POS_ID}" "@${CLOCK}" \
      --assign payout \
      --transfer-objects "[payout]" "@${SENDER}" \
      --gas-budget 300000000 --json)
  REDEEM_DIGEST=$(digest_of "$REDEEM_OUT")
  PAYOUT_MIST=$(sui_balance_change_for "$REDEEM_OUT" "$SENDER")
  REDEEM_STATUS="aborted-refund"
else
  green ">>> wick::redeem (HIT or EXPIRED — winner or loser)"
  REDEEM_OUT=$(run_tx "redeem" \
    sui client ptb \
      --move-call "${PKG}::wick::redeem" "<$SUI_COIN_TYPE>" \
        "@${MARKET}" "@${VAULT_ID}" "@${RISK_CONFIG}" "@${FEE_ROUTER_SUI}" \
        "@${WICK_STATE}" "@${STAKING_POOL}" "@${PRICE_ORACLE}" \
        "@${POS_ID}" "@${CLOCK}" \
      --assign payout \
      --transfer-objects "[payout]" "@${SENDER}" \
      --gas-budget 300000000 --json)
  REDEEM_DIGEST=$(digest_of "$REDEEM_OUT")
  PAYOUT_MIST=$(sui_balance_change_for "$REDEEM_OUT" "$SENDER")
  REDEEM_STATUS="ok"
fi

# ---------- 7. P&L summary ----------

hr
green "=== SMOKE TEST SUMMARY ==="
printf "  %-22s %s\n" "package"            "$PKG"
printf "  %-22s %s\n" "sender"             "$SENDER"
printf "  %-22s %s\n" "market"             "$M_NAME ($MARKET)"
printf "  %-22s %s\n" "barrier/direction"  "$BARRIER  dir=$DIRECTION"
printf "  %-22s %s\n" "expiry_ms"          "$EXPIRY_MS"
printf "  %-22s %s\n" "drain_ms"           "$DRAIN_MS"
printf "  %-22s %s\n" "opened_at_ms"       "${OPENED_AT_MS:-(skipped)}"
printf "  %-22s %s\n" "settled_at_ms"      "$SETTLED_AT_MS"
printf "  %-22s %s\n" "final_status"       "$FINAL_STATUS_LABEL"
printf "  %-22s %s\n" "ticks_issued"       "$TICK_COUNT"
printf "  %-22s %s\n" "position_id"        "${POS_ID:-(none)}"
printf "  %-22s %s\n" "stake_mist"         "$STAKE_MIST"
printf "  %-22s %s\n" "payout_mist"        "$PAYOUT_MIST"
printf "  %-22s %s\n" "redeem"             "$REDEEM_STATUS"
if [ -n "$POS_ID" ]; then
  # P&L is payout - stake. For a winner: payout = stake*multiplier => P&L > 0.
  # For a loser: payout = 0 => P&L = -stake.
  PNL=$(( PAYOUT_MIST - STAKE_MIST ))
  printf "  %-22s %s mist\n" "P&L (gross)"   "$PNL"
fi
gray ""
gray "tx digests:"
gray "  open:    ${OPEN_DIGEST:-(n/a)}"
gray "  settle:  $SETTLE_DIGEST"
gray "  redeem:  ${REDEEM_DIGEST:-(n/a)}"
gray ""
gray "explorer:"
gray "  market:  https://suiscan.xyz/testnet/object/$MARKET"
[ -n "$POS_ID" ] && gray "  position(consumed): $POS_ID"

green ""
green "OK — smoke complete"
