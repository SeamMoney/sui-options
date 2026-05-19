#!/usr/bin/env bash
# Predict CLI spike (DeepVault pattern #120) — verify we can drive
# DeepBook Predict from a Sui CLI before invasively wrapping it in
# `wick::predict_route`.
#
# Flow:
#   1. Preflight   — testnet env, python3, sui CLI, gas >= 0.5 SUI.
#   2. Verify-on-chain (NOT trusting docs) — Predict package, Predict<DUSDC>
#      shared object, Registry, BTC OracleSVI(s), DUSDC type, accepted_quotes.
#      Persist resolved IDs into `deployments/predict-testnet.json`.
#   3. Acquire DUSDC — Predict's DUSDC quote is bare (no on-chain faucet
#      function; TreasuryCap is owned by Mysten's dev address). Detect
#      whether the active address already holds DUSDC; if not, print a
#      clear actionable message (Mysten faucet URL or Discord ask) and
#      exit. Skip if --skip-dusdc-check passed.
#   4. Pick a live BTC OracleSVI — query OraclePricesUpdated events,
#      filter to underlying_asset="BTC", active=true. Choose the one
#      whose forward price is closest to median strike (or just the
#      first ACTIVE if no strike preference given).
#   5. Choose a strike — read the OracleGrid (oracle_config.oracle_grids
#      dynamic field) to learn (min_strike, max_strike, tick_size).
#      Default = nearest grid strike to current spot; configurable via
#      $STRIKE_OFFSET_TICKS.
#   6. Create a PredictManager — predict::create_manager (public, not
#      entry: must be wrapped in a PTB MoveCall). Capture manager_id
#      from PredictManagerCreated event.
#   7. Mint a tiny TOUCH (binary up) position — predict::mint<DUSDC>.
#      mint_collateralized is GONE; the binary entry is `mint` and the
#      range entry is `mint_range`. Capture the resulting position from
#      objectChanges / `Minted` event.
#   8. Print a P&L summary — oracle, manager, strike, side, premium
#      paid, expected payoff if touch fires, current oracle spot.
#   9. (Optional) --redeem  — if oracle is_settled, call predict::redeem
#      (owner-gated) and report the actual payout amount.
#
# IDEMPOTENT — re-running skips steps whose outputs are already in
# `deployments/predict-testnet.json`. Use --reset to wipe state and
# start over.
#
# GRACEFUL FAILURE — every step logs why it stopped and exits with a
# non-zero code. Never claims success it didn't achieve.
#
# Usage:
#   ./scripts/predict-spike.sh                 # run end-to-end (no redeem)
#   ./scripts/predict-spike.sh --redeem        # also redeem if settled
#   ./scripts/predict-spike.sh --reset         # wipe local state
#   ./scripts/predict-spike.sh --skip-dusdc-check
#
# Env vars:
#   PREDICT_PKG=…                              # override docs default
#   PREDICT_OBJ=…
#   REGISTRY=…
#   DUSDC_TYPE=…
#   PREMIUM_USDC=1000000                       # 1 DUSDC (6 decimals)
#   QTY=1                                      # contracts to mint
#   STRIKE_OFFSET_TICKS=2                      # ticks above spot
#   SIDE=up                                    # up | down  (binary leg)

set -euo pipefail

cd "$(dirname "$0")/.."

# ---------- ansi ----------
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

# ---------- args ----------
REDEEM=0
SKIP_DUSDC=0
RESET=0
for arg in "$@"; do
  case "$arg" in
    --redeem) REDEEM=1 ;;
    --skip-dusdc-check) SKIP_DUSDC=1 ;;
    --reset) RESET=1 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) warn "unknown arg: $arg" ;;
  esac
done

# ---------- defaults (overridable via env) ----------
PREDICT_PKG="${PREDICT_PKG:-0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138}"
PREDICT_OBJ="${PREDICT_OBJ:-0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a}"
REGISTRY="${REGISTRY:-0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64}"
DUSDC_TYPE="${DUSDC_TYPE:-0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC}"

PREMIUM_USDC="${PREMIUM_USDC:-1000000}"      # 1.0 DUSDC, 6 decimals
QTY="${QTY:-1}"                              # 1 contract
STRIKE_OFFSET_TICKS="${STRIKE_OFFSET_TICKS:-2}"
SIDE="${SIDE:-up}"                           # up | down

ARTIFACT="deployments/predict-testnet.json"
CLOCK="0x6"
RPC="https://fullnode.testnet.sui.io:443"

# ---------- 1. Preflight ----------
hr
green ">>> 1. preflight"

command -v sui     >/dev/null 2>&1 || { red "sui CLI not on PATH";     exit 1; }
command -v python3 >/dev/null 2>&1 || { red "python3 not on PATH";     exit 1; }
command -v curl    >/dev/null 2>&1 || { red "curl not on PATH";        exit 1; }

ACTIVE_ENV=$(sui client active-env 2>/dev/null || echo "")
if [ "$ACTIVE_ENV" != "testnet" ]; then
  red "active sui env is '$ACTIVE_ENV', expected 'testnet'"
  red "run: sui client switch --env testnet"
  exit 1
fi

SENDER=$(sui client active-address)
note "sender: $SENDER"

TOTAL_GAS_MIST=$(sui client gas --json 2>/dev/null \
  | python3 -c "import json,sys; print(sum(int(c['mistBalance']) for c in json.load(sys.stdin)))")
MIN_GAS=500000000   # 0.5 SUI
if [ "$TOTAL_GAS_MIST" -lt "$MIN_GAS" ]; then
  red "insufficient gas: have $TOTAL_GAS_MIST mist, need >= $MIN_GAS mist (0.5 SUI)"
  red "run: ./scripts/faucet.sh   (or: sui client faucet)"
  exit 1
fi
note "gas: $TOTAL_GAS_MIST mist (>= 0.5 SUI)"

if [ "$RESET" -eq 1 ] && [ -f "$ARTIFACT" ]; then
  warn "--reset: wiping $ARTIFACT"
  rm -f "$ARTIFACT"
fi

mkdir -p "$(dirname "$ARTIFACT")"
if [ ! -f "$ARTIFACT" ]; then
  echo '{}' > "$ARTIFACT"
fi

# ---------- helpers ----------

artifact_get() {
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" \
    "$ARTIFACT" "$1"
}

artifact_set() {
  local k="$1" v="$2"
  python3 - "$ARTIFACT" "$k" "$v" <<'PY'
import json, sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f: d = json.load(f)
d[key] = value
with open(path, 'w') as f: json.dump(d, f, indent=2)
PY
}

rpc_call() {
  # $1 = method, $2 = params json
  local method="$1" params="$2"
  curl -sS "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
}

# verify_object <id> <expected_type_substring> — exits non-zero if not alive.
verify_object() {
  local id="$1" needle="$2"
  local resp
  resp=$(rpc_call "sui_getObject" "[\"$id\",{\"showType\":true,\"showOwner\":true}]")
  python3 -c "
import json, sys
d = json.loads('''$resp''')
data = d.get('result', {}).get('data')
if not data:
    print('NOT_FOUND', file=sys.stderr); sys.exit(1)
t = data.get('type','')
if '$needle' not in t:
    print(f'TYPE_MISMATCH: got {t}', file=sys.stderr); sys.exit(2)
print(t)
" 2>&1 || return 1
}

run_tx() {
  # $1 = label, $@ = command. Captures clean JSON to /tmp.
  local label="$1"; shift
  local raw="/tmp/predict-spike-${label}-raw.txt"
  local out="/tmp/predict-spike-${label}.json"
  local err="/tmp/predict-spike-${label}.err"
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

# ---------- 2. Discover and verify on-chain Predict objects ----------
hr
green ">>> 2. verify Predict objects on chain (not trusting docs)"

# 2a. Verify package — must be Immutable / package type.
PKG_TYPE=$(rpc_call "sui_getObject" "[\"$PREDICT_PKG\",{\"showType\":true,\"showOwner\":true}]" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
data = d.get('result', {}).get('data')
if not data: print('NOT_FOUND'); sys.exit(1)
owner = data.get('owner')
if owner != 'Immutable':
    print(f'NOT_IMMUTABLE: {owner}'); sys.exit(2)
print('package=immutable')
")
case "$PKG_TYPE" in
  package=immutable) note "predict pkg: $PREDICT_PKG  (immutable, alive)" ;;
  *) red "predict package $PREDICT_PKG: $PKG_TYPE"; exit 3 ;;
esac

# 2b. Verify Predict<DUSDC> shared object.
PREDICT_OBJ_TYPE=$(verify_object "$PREDICT_OBJ" "::predict::Predict") || {
  red "Predict shared object $PREDICT_OBJ not found or wrong type"
  exit 3
}
note "predict obj: $PREDICT_OBJ  ($PREDICT_OBJ_TYPE)"

# 2c. Verify Predict isn't paused and DUSDC is in accepted_quotes.
PREDICT_RAW=$(rpc_call "sui_getObject" "[\"$PREDICT_OBJ\",{\"showContent\":true}]")
python3 - <<PY
import json, sys
d = json.loads('''$PREDICT_RAW''')
fields = d['result']['data']['content']['fields']
paused = fields.get('trading_paused')
if paused:
    print('TRADING_PAUSED', file=sys.stderr)
    sys.exit(2)
quotes = fields['treasury_config']['fields']['accepted_quotes']['fields']['contents']
qnames = [q['fields']['name'] for q in quotes]
dusdc_short = "$DUSDC_TYPE".lstrip('0x')
ok = any(qn.lstrip('0x').lower() == dusdc_short.lower() for qn in qnames)
if not ok:
    print(f'DUSDC_NOT_ACCEPTED quotes={qnames}', file=sys.stderr)
    sys.exit(3)
print('predict OK: trading_paused=False, DUSDC accepted')
PY

# 2d. Verify Registry.
REGISTRY_TYPE=$(verify_object "$REGISTRY" "::registry::Registry") || {
  red "Registry $REGISTRY not found"; exit 3
}
note "registry: $REGISTRY  ($REGISTRY_TYPE)"

artifact_set predict_pkg "$PREDICT_PKG"
artifact_set predict_obj "$PREDICT_OBJ"
artifact_set registry    "$REGISTRY"
artifact_set dusdc_type  "$DUSDC_TYPE"

# 2e. Discover the entry-point ABI (mint vs mint_range vs mint_collateralized).
hr
green ">>> 2e. discover Predict entrypoints via getNormalizedMoveModulesByPackage"

NORM_RAW=$(rpc_call "sui_getNormalizedMoveModulesByPackage" "[\"$PREDICT_PKG\"]")
echo "$NORM_RAW" > /tmp/predict-spike-norm.json

ENTRYPOINTS=$(python3 - <<'PY'
import json
d = json.load(open('/tmp/predict-spike-norm.json'))
mods = d.get('result', {})
predict = mods.get('predict', {}).get('exposedFunctions', {})
wanted = ['create_manager','mint','mint_range','mint_collateralized',
          'redeem','redeem_permissionless','redeem_range']
present = [n for n in wanted if n in predict]
print(','.join(present))
PY
)
note "predict funcs present: $ENTRYPOINTS"
if [[ ",$ENTRYPOINTS," != *",mint,"* ]]; then
  red "predict::mint not found — ABI changed; this spike needs adapting"
  exit 4
fi
if [[ ",$ENTRYPOINTS," == *",mint_collateralized,"* ]]; then
  warn "mint_collateralized still exists — branch may be older than expected"
fi

# ---------- 3. DUSDC sanity check ----------
hr
green ">>> 3. DUSDC sanity check"

if [ "$SKIP_DUSDC" -eq 1 ]; then
  warn "--skip-dusdc-check: not checking balance"
else
  DUSDC_BAL=$(sui client balance --json 2>/dev/null \
    | python3 -c "
import json, sys
need = '$DUSDC_TYPE'.lstrip('0x').lower()
try:
    coins = json.load(sys.stdin)
except Exception:
    print('0'); sys.exit(0)
# 'sui client balance --json' shape: list of {coinType, totalBalance, ...}
# Older versions return a wrapped object — handle both.
if isinstance(coins, dict):
    coins = coins.get('coins', coins.get('balances', []))
total = 0
for c in coins if isinstance(coins, list) else []:
    ct = (c.get('coinType') or c.get('coin_type') or '').lstrip('0x').lower()
    if ct == need:
        total += int(c.get('totalBalance') or c.get('total_balance') or 0)
print(total)
" || echo 0)
  note "DUSDC balance: $DUSDC_BAL (need >= $PREMIUM_USDC)"
  if [ -z "$DUSDC_BAL" ] || [ "$DUSDC_BAL" -lt "$PREMIUM_USDC" ]; then
    red "active address holds insufficient DUSDC ($DUSDC_BAL < $PREMIUM_USDC)"
    red ""
    red "The DUSDC quote token has NO on-chain mint function. Its TreasuryCap"
    red "is owned by Mysten's dev address ($PREDICT_PKG publisher)."
    red "Get testnet DUSDC by one of:"
    red "  - DeepBook Discord faucet channel"
    red "  - https://docs.sui.io/guides/developer/getting-started/get-coins"
    red "  - asking the Mysten DeepBook team"
    red ""
    red "Once the active address holds DUSDC, re-run this script."
    red "(Or run with --skip-dusdc-check to bypass for ABI-only smoke.)"
    exit 5
  fi
fi

# ---------- 4. Pick a live BTC OracleSVI ----------
hr
green ">>> 4. discover live BTC OracleSVI"

ORACLE_ID=$(artifact_get "oracle_id_btc")
if [ -z "$ORACLE_ID" ]; then
  # Query recent OraclePricesUpdated events; collect unique oracle_ids,
  # then read each to find one with underlying_asset == "BTC" and active.
  EVT_RAW=$(rpc_call "suix_queryEvents" \
    "[{\"MoveEventType\":\"${PREDICT_PKG}::oracle::OraclePricesUpdated\"},null,50,true]")
  echo "$EVT_RAW" > /tmp/predict-spike-events.json
  CANDIDATES=$(python3 - <<'PY'
import json
d = json.load(open('/tmp/predict-spike-events.json'))
ids = []
seen = set()
for e in d.get('result',{}).get('data',[]):
    oid = e.get('parsedJson',{}).get('oracle_id')
    if oid and oid not in seen:
        ids.append(oid); seen.add(oid)
print('\n'.join(ids))
PY
  )
  if [ -z "$CANDIDATES" ]; then
    red "no recent OraclePricesUpdated events — Predict oracle keeper may be down"
    exit 6
  fi
  note "candidate oracle ids (from recent events):"
  echo "$CANDIDATES" | head -10 | sed 's/^/    /'

  while IFS= read -r cand; do
    [ -z "$cand" ] && continue
    OR=$(rpc_call "sui_getObject" "[\"$cand\",{\"showContent\":true}]")
    OK=$(python3 - <<PY
import json
d = json.loads('''$OR''')
data = d.get('result',{}).get('data')
if not data: print('no'); raise SystemExit
fields = data.get('content',{}).get('fields',{})
if fields.get('underlying_asset') == 'BTC' and fields.get('active'):
    print('yes')
else:
    print('no')
PY
)
    if [ "$OK" = "yes" ]; then
      ORACLE_ID="$cand"
      note "picked oracle: $ORACLE_ID (BTC, active)"
      break
    fi
  done <<<"$CANDIDATES"

  if [ -z "$ORACLE_ID" ]; then
    red "no live BTC OracleSVI among recent oracle events"
    exit 6
  fi
  artifact_set oracle_id_btc "$ORACLE_ID"
else
  # Verify cached oracle is still active.
  OR=$(rpc_call "sui_getObject" "[\"$ORACLE_ID\",{\"showContent\":true}]")
  STILL_OK=$(python3 - <<PY
import json
d = json.loads('''$OR''')
fields = d['result']['data']['content']['fields']
print('yes' if fields.get('active') else 'no')
PY
)
  if [ "$STILL_OK" != "yes" ]; then
    red "cached oracle $ORACLE_ID no longer active — re-run with --reset"
    exit 6
  fi
  note "cached oracle: $ORACLE_ID  (still active)"
fi

# Read current spot + expiry from oracle.
ORACLE_JSON=$(rpc_call "sui_getObject" "[\"$ORACLE_ID\",{\"showContent\":true}]")
SPOT=$(python3 -c "
import json
d = json.loads('''$ORACLE_JSON''')
print(d['result']['data']['content']['fields']['prices']['fields']['spot'])
")
EXPIRY_MS=$(python3 -c "
import json
d = json.loads('''$ORACLE_JSON''')
print(d['result']['data']['content']['fields']['expiry'])
")
NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
TTL_MIN=$(( (EXPIRY_MS - NOW_MS) / 60000 ))
note "oracle spot:   $SPOT (scaled 1e9)"
note "oracle expiry: $EXPIRY_MS  (in ${TTL_MIN} min)"

if [ "$TTL_MIN" -le 0 ]; then
  red "oracle already past expiry — pick another with --reset"
  exit 6
fi

# ---------- 5. Choose strike from OracleGrid ----------
hr
green ">>> 5. read OracleGrid (strike matrix)"

# Find oracle_grids table id from Predict.oracle_config.
ORACLE_GRIDS_TBL=$(python3 -c "
import json
d = json.loads('''$PREDICT_RAW''')
f = d['result']['data']['content']['fields']
print(f['oracle_config']['fields']['oracle_grids']['fields']['id']['id'])
")
note "oracle_grids table: $ORACLE_GRIDS_TBL"

GRID_RAW=$(rpc_call "suix_getDynamicFieldObject" \
  "[\"$ORACLE_GRIDS_TBL\",{\"type\":\"0x2::object::ID\",\"value\":\"$ORACLE_ID\"}]")
GRID=$(python3 - <<PY
import json
d = json.loads('''$GRID_RAW''')
v = d.get('result',{}).get('data',{}).get('content',{}).get('fields',{}).get('value',{}).get('fields',{})
if not v:
    raise SystemExit('NO_GRID')
print(v.get('min_strike'), v.get('max_strike'), v.get('tick_size'))
PY
) || { red "no OracleGrid for $ORACLE_ID"; exit 7; }

read -r MIN_STRIKE MAX_STRIKE TICK_SIZE <<<"$GRID"
note "grid: min=$MIN_STRIKE  max=$MAX_STRIKE  tick=$TICK_SIZE"

# Nearest grid strike to spot, then offset by STRIKE_OFFSET_TICKS.
STRIKE=$(python3 -c "
spot   = $SPOT
mn     = $MIN_STRIKE
tk     = $TICK_SIZE
offset = $STRIKE_OFFSET_TICKS
# round-down to grid
base = ((spot - mn) // tk) * tk + mn
strike = base + offset * tk
mx = $MAX_STRIKE
if strike < mn: strike = mn
if strike > mx: strike = mx
print(strike)
")
note "chosen strike: $STRIKE  (spot=$SPOT, offset=+$STRIKE_OFFSET_TICKS ticks)"

case "$SIDE" in
  up)   IS_UP=true ;;
  down) IS_UP=false ;;
  *) red "SIDE must be 'up' or 'down' (got '$SIDE')"; exit 1 ;;
esac

artifact_set strike    "$STRIKE"
artifact_set is_up_leg "$IS_UP"

# ---------- 6. Create a PredictManager ----------
hr
green ">>> 6. predict::create_manager"

MANAGER_ID=$(artifact_get "manager_id")
if [ -z "$MANAGER_ID" ]; then
  # create_manager is public (NOT entry) — must wrap in a PTB MoveCall +
  # share/transfer the returned manager. The Predict module shares the
  # manager itself inside create_manager via `transfer::share_object`,
  # so the PTB simply ignores the return.
  OUT=$(run_tx "create-manager" \
    sui client ptb \
      --move-call "${PREDICT_PKG}::predict::create_manager" \
      --gas-budget 200000000 --json)
  MANAGER_ID=$(created_of_type "$OUT" "::predict_manager::PredictManager")
  if [ -z "$MANAGER_ID" ]; then
    # Fallback: parse PredictManagerCreated event.
    MANAGER_ID=$(python3 -c "
import json
d=json.load(open('$OUT'))
for e in d.get('events',[]):
    if e.get('type','').endswith('::predict_manager::PredictManagerCreated'):
        print(e['parsedJson']['manager_id']); break
")
  fi
  [ -n "$MANAGER_ID" ] || { red "could not parse manager_id"; exit 8; }
  note "created manager: $MANAGER_ID"
  artifact_set manager_id "$MANAGER_ID"
else
  note "cached manager: $MANAGER_ID"
fi

# ---------- 7. Mint a tiny TOUCH position ----------
hr
green ">>> 7. predict::mint<DUSDC>  qty=$QTY  premium_max=$PREMIUM_USDC"

POSITION_TX=$(artifact_get "position_tx_digest")
if [ -z "$POSITION_TX" ]; then
  if [ "$SKIP_DUSDC" -eq 1 ]; then
    warn "--skip-dusdc-check set — refusing to attempt mint (would burn gas)"
    warn "to actually mint, re-run without --skip-dusdc-check (after acquiring DUSDC)"
    exit 0
  fi

  # We need to put DUSDC into the manager's BalanceManager before mint.
  # Predict's mint reads from the manager's BalanceManager balance and
  # debits at the computed ask price. Topping up is via the manager's
  # `deposit<DUSDC>` (predict_manager module, public, takes Coin<DUSDC>).
  #
  # Find a DUSDC coin >= PREMIUM_USDC (or merge / split). Simplest:
  # pick the largest one; if too small, exit (user can pre-merge).
  DUSDC_COIN=$(sui client objects --json 2>/dev/null \
    | python3 -c "
import json, sys
need = '$DUSDC_TYPE'.lstrip('0x').lower()
want = int('$PREMIUM_USDC')
try:
    objs = json.load(sys.stdin)
except Exception:
    sys.exit(1)
best = None
for o in objs if isinstance(objs, list) else []:
    t = (o.get('data',{}).get('type') or '').lstrip('0x').lower()
    if not t.startswith('0x2::coin::coin<'):
        # try short coin type field
        ct = (o.get('coinType') or '').lstrip('0x').lower()
        if ct != need: continue
    elif need not in t:
        continue
    bal = int(o.get('data',{}).get('content',{}).get('fields',{}).get('balance', 0))
    if bal >= want and (best is None or bal < best[1]):
        best = (o['data']['objectId'], bal)
if best:
    print(best[0])
")
  if [ -z "$DUSDC_COIN" ]; then
    red "no single DUSDC coin object holds >= $PREMIUM_USDC. merge first:"
    red "  sui client merge-coin --primary-coin <a> --coin-to-merge <b> --gas-budget …"
    exit 9
  fi
  note "dusdc coin: $DUSDC_COIN"

  # Build a PTB:
  #   1. split premium DUSDC off the coin
  #   2. predict_manager::deposit<DUSDC>(manager, premium_coin, &mut ctx)
  #   3. let key = market_key::new(oracle_id, expiry, strike, is_up)
  #   4. predict::mint<DUSDC>(predict, manager, oracle, key, qty, clock, ctx)
  OUT=$(run_tx "mint-touch" \
    sui client ptb \
      --split-coins "@${DUSDC_COIN}" "[${PREMIUM_USDC}]" --assign premium \
      --move-call "${PREDICT_PKG}::predict_manager::deposit" \
        "<${DUSDC_TYPE}>" "@${MANAGER_ID}" premium.0 \
      --move-call "${PREDICT_PKG}::market_key::new" \
        "@${ORACLE_ID}" "${EXPIRY_MS}" "${STRIKE}" "${IS_UP}" \
      --assign mkey \
      --move-call "${PREDICT_PKG}::predict::mint" \
        "<${DUSDC_TYPE}>" "@${PREDICT_OBJ}" "@${MANAGER_ID}" "@${ORACLE_ID}" \
        mkey "${QTY}" "@${CLOCK}" \
      --gas-budget 300000000 --json)

  POSITION_TX=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('digest',''))" "$OUT")
  note "mint digest: $POSITION_TX"
  artifact_set position_tx_digest "$POSITION_TX"

  # Pull Minted event for human-readable summary.
  python3 - <<PY || true
import json
d = json.load(open('$OUT'))
for e in d.get('events', []):
    t = e.get('type','')
    if t.endswith('::predict::Minted') or t.endswith('::predict::RangeMinted'):
        print('  minted event:', e['parsedJson'])
PY
else
  note "cached mint tx: $POSITION_TX"
fi

# ---------- 8. P&L summary ----------
hr
green "=== PREDICT SPIKE SUMMARY ==="
printf "  %-22s %s\n" "predict pkg"        "$PREDICT_PKG"
printf "  %-22s %s\n" "predict<DUSDC>"     "$PREDICT_OBJ"
printf "  %-22s %s\n" "registry"           "$REGISTRY"
printf "  %-22s %s\n" "dusdc type"         "$DUSDC_TYPE"
printf "  %-22s %s\n" "oracle (BTC)"       "$ORACLE_ID"
printf "  %-22s %s\n" "current spot"       "$SPOT  (scaled 1e9)"
printf "  %-22s %s\n" "expiry (ms)"        "$EXPIRY_MS  (~${TTL_MIN} min)"
printf "  %-22s %s\n" "strike"             "$STRIKE  (scaled 1e9)"
printf "  %-22s %s\n" "side"               "$SIDE (is_up=$IS_UP)"
printf "  %-22s %s\n" "manager"            "$MANAGER_ID"
printf "  %-22s %s\n" "premium paid"       "$PREMIUM_USDC DUSDC (6dp)"
printf "  %-22s %s\n" "qty"                "$QTY"
printf "  %-22s %s\n" "mint tx"            "$POSITION_TX"
printf "  %-22s %s\n" "predict funcs"      "$ENTRYPOINTS"
gray ""
gray "If oracle settles favorable to your leg, expected payoff is"
gray "approximately ${QTY} * 1.0 DUSDC (binary 0/1 settlement on Predict)."
gray "Net P&L = payoff - premium."
gray ""
gray "explorer:"
gray "  predict:  https://suiscan.xyz/testnet/object/$PREDICT_OBJ"
gray "  oracle:   https://suiscan.xyz/testnet/object/$ORACLE_ID"
gray "  manager:  https://suiscan.xyz/testnet/object/$MANAGER_ID"
[ -n "$POSITION_TX" ] && gray "  mint tx:  https://suiscan.xyz/testnet/tx/$POSITION_TX"

# ---------- 9. Optional redeem ----------
if [ "$REDEEM" -eq 1 ]; then
  hr
  green ">>> 9. predict::redeem<DUSDC>  (owner-gated)"

  # Refresh oracle settled status.
  OR=$(rpc_call "sui_getObject" "[\"$ORACLE_ID\",{\"showContent\":true}]")
  SETTLED=$(python3 -c "
import json
d = json.loads('''$OR''')
f = d['result']['data']['content']['fields']
print('yes' if f.get('settlement_price') else 'no')
")
  if [ "$SETTLED" != "yes" ]; then
    warn "oracle not yet settled — redeem would abort. exiting."
    exit 0
  fi

  OUT=$(run_tx "redeem" \
    sui client ptb \
      --move-call "${PREDICT_PKG}::market_key::new" \
        "@${ORACLE_ID}" "${EXPIRY_MS}" "${STRIKE}" "${IS_UP}" \
      --assign mkey \
      --move-call "${PREDICT_PKG}::predict::redeem" \
        "<${DUSDC_TYPE}>" "@${PREDICT_OBJ}" "@${MANAGER_ID}" "@${ORACLE_ID}" \
        mkey "${QTY}" "@${CLOCK}" \
      --gas-budget 300000000 --json)
  REDEEM_DIGEST=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('digest',''))" "$OUT")
  note "redeem digest: $REDEEM_DIGEST"

  # Pull a balance-change summary.
  python3 - <<PY || true
import json
d = json.load(open('$OUT'))
for ch in d.get('balanceChanges', []):
    owner = ch.get('owner',{}).get('AddressOwner','?')
    print(f"  balance change: {owner[:10]}…  {ch.get('coinType')[:80]}  {ch.get('amount')}")
PY
fi

green ""
green "OK — predict spike complete"
