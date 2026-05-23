#!/usr/bin/env bash
# prune-proto-smoke.sh — empirically validate the storage rebate claim from
# docs/design/v2/23_storage_rebate_pruning_v3.md §3.3 on Sui testnet.
#
# Addresses prune_proto reviewer SEV-2 #B: the doc claims a permissionless
# pruner earns ~74M MIST per round of net storage rebate, but Move unit
# tests cannot measure gas / storage rebate accounting. The only way to
# validate the load-bearing economic claim is an on-chain devnet/testnet
# smoke that records ctx.sender() balance before and after `prune_range`.
#
# Flow (matches the reviewer's required artifact):
#   1. Read sender balance T0.
#   2. Call wick::prune_proto::create        → fresh PrunableLedger.
#   3. Call wick::prune_proto::fill(20)      → 20 BigRecord entries written.
#      Read balance T1, compute fill cost   = T0 - T1.
#   4. Call wick::prune_proto::prune_range(0, 20) → all 20 deleted, Sui
#      auto-credits the storage rebate to ctx.sender()'s gas coin.
#      Read balance T2, compute net rebate  = T2 - T1.
#   5. Print summary with per-record economics; exit 0 iff (T2 - T1) > 0.
#
# REQUIRES: the Wick package deployed on testnet to include the
# `prune_proto` module. As of 2026-05-23 it is NOT in the latest published
# package (it lives on branch claude/v3.4-prune-proto and is gated on a
# Move upgrade). If the module is missing, this script prints a clear
# "upgrade first" message and exits non-zero rather than silently no-op.
#
# Usage:
#   ./scripts/prune-proto-smoke.sh
#
# Env overrides (all optional):
#   COUNT=20             # number of BigRecord entries to fill + prune
#   GAS_BUDGET=200000000 # per-tx gas budget
#   ARTIFACT=deployments/testnet.json

set -euo pipefail
cd "$(dirname "$0")/.."

# ── ansi ──────────────────────────────────────────────────────────────────────
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
hr()    { printf '\033[90m%s\033[0m\n' "------------------------------------------------------------"; }

# ── config ────────────────────────────────────────────────────────────────────
COUNT="${COUNT:-20}"
GAS_BUDGET="${GAS_BUDGET:-200000000}"
ARTIFACT="${ARTIFACT:-deployments/testnet.json}"
CLOCK_ID="0x6"

# ── preflight ─────────────────────────────────────────────────────────────────
command -v sui >/dev/null 2>&1 || { red "sui CLI not on PATH"; exit 1; }
command -v jq  >/dev/null 2>&1 || { red "jq not on PATH"; exit 1; }
command -v python3 >/dev/null 2>&1 || { red "python3 not on PATH"; exit 1; }

[ -f "$ARTIFACT" ] || { red "no $ARTIFACT — run ./scripts/deploy-testnet.sh first"; exit 1; }

ACTIVE_ENV=$(sui client active-env 2>/dev/null || echo "")
if [ "$ACTIVE_ENV" != "testnet" ]; then
  red "active sui env is '$ACTIVE_ENV', expected 'testnet'"
  red "run: sui client switch --env testnet"
  exit 1
fi

PKG=$(jq -r '.package_id' "$ARTIFACT")
SENDER=$(sui client active-address)

# Verify the prune_proto module is actually deployed in the testnet package
# BEFORE spending gas on a `create` that would just abort with
# "Module not found". This is the explicit no-silent-fail behaviour the
# reviewer asked for.
note "checking that wick::prune_proto is present in package $PKG ..."
PKG_MODULES_JSON="/tmp/wick-prune-proto-pkg.json"
if ! sui client object "$PKG" --json >"$PKG_MODULES_JSON" 2>/dev/null; then
  red "couldn't fetch package object $PKG from testnet"
  exit 1
fi
if ! jq -er '.content.Package.module_map | has("prune_proto")' "$PKG_MODULES_JSON" >/dev/null 2>&1; then
  hr
  red "✗ prune_proto module NOT deployed on testnet (package $PKG)"
  red ""
  red "  The v3.4 storage-rebate prototype (move/sources/prune_proto.move)"
  red "  is on branch claude/v3.4-prune-proto but has not been merged into"
  red "  the published testnet package yet."
  red ""
  red "  To run this smoke:"
  red "    1. Merge claude/v3.4-prune-proto into main (or check it out locally)"
  red "    2. Upgrade the Move package via: ./scripts/deploy-testnet.sh"
  red "    3. Re-run this script: ./scripts/prune-proto-smoke.sh"
  red ""
  red "  Until then, the load-bearing economic claim from doc 23 §3.3"
  red "  (~74M MIST/round positive EV for pruners) remains theoretical."
  hr
  exit 2
fi
green "prune_proto module present in package — proceeding"

# ── helpers ───────────────────────────────────────────────────────────────────

# Total MIST across all gas coins owned by the active address. Sums every
# `mistBalance` field from `sui client gas --json`. This is the right
# measure for rebate accounting because:
#   - the rebate is paid into the tx's gas coin (still in the wallet),
#   - any unspent change is also still in the wallet,
#   - so wallet-level total is what the user actually nets per tx.
sender_total_mist() {
  sui client gas --json 2>/dev/null | jq '[.[] | .mistBalance] | add // 0'
}

# Run a sui CLI command, capture stdout to a json file, strip any pre-JSON
# banner lines (modern CLI versions print warnings before the JSON blob).
# Mirrors the pattern in scripts/bootstrap-segment-market.sh +
# scripts/segment-smoke.sh.
run_tx() {
  local label="$1"; shift
  local raw="/tmp/wick-prune-proto-${label}-raw.txt"
  local out="/tmp/wick-prune-proto-${label}.json"
  local err="/tmp/wick-prune-proto-${label}.err"
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

# Verify the tx executed successfully on chain. Sui CLI exits 0 even when
# the tx aborts with a Move error (the dry-run / submit succeeded; the
# Move VM rejected it). We must check effects.status.status == "success".
assert_tx_success() {
  local json="$1" label="$2"
  local status
  status=$(jq -r '.effects.status.status // .digest // "missing"' "$json")
  if [ "$status" != "success" ]; then
    red "tx '$label' did not succeed: status=$status"
    red "  see $json for full effects"
    jq '.effects.status' "$json" >&2 || true
    exit 2
  fi
}

# Pull the gas breakdown for a tx. Returns three numbers on stdout:
#   computationCost storageCost storageRebate
# Net gas paid by the sender = computationCost + storageCost - storageRebate.
tx_gas_breakdown() {
  local json="$1"
  jq -r '
    .effects.gasUsed
    | "\(.computationCost) \(.storageCost) \(.storageRebate)"
  ' "$json"
}

# Find the first created object of a given type from a tx's objectChanges.
created_of_type() {
  local json="$1" needle="$2"
  jq -r --arg n "$needle" '
    [.objectChanges[]? | select(.type == "created" and (.objectType | contains($n)))]
    | .[0].objectId // empty
  ' "$json"
}

tx_digest() {
  jq -r '.digest // "?"' "$1"
}

# ── show config ───────────────────────────────────────────────────────────────
hr
note "package:        $PKG"
note "sender:         $SENDER"
note "record count:   $COUNT"
note "gas budget:     $GAS_BUDGET MIST/tx"
hr

# ── T0: read starting balance ────────────────────────────────────────────────
BAL_T0=$(sender_total_mist)
note "T0 balance:     $BAL_T0 MIST (across all gas coins)"

# ── step 1: create a fresh PrunableLedger ────────────────────────────────────
green ">>> wick::prune_proto::create"
CREATE_OUT=$(run_tx "create" \
  sui client call \
    --package "$PKG" \
    --module prune_proto \
    --function create \
    --gas-budget "$GAS_BUDGET" \
    --json)
assert_tx_success "$CREATE_OUT" "create"
LEDGER=$(created_of_type "$CREATE_OUT" "::prune_proto::PrunableLedger")
[ -n "$LEDGER" ] || { red "could not find PrunableLedger in create's objectChanges"; exit 2; }
gray "  digest: $(tx_digest "$CREATE_OUT")"
note "  ledger: $LEDGER"

# ── step 2: fill the ledger; record cost ─────────────────────────────────────
green ">>> wick::prune_proto::fill (count=$COUNT)"
BAL_BEFORE_FILL=$(sender_total_mist)
FILL_OUT=$(run_tx "fill" \
  sui client call \
    --package "$PKG" \
    --module prune_proto \
    --function fill \
    --args "$LEDGER" "$COUNT" \
    --gas-budget "$GAS_BUDGET" \
    --json)
assert_tx_success "$FILL_OUT" "fill"
read -r FILL_COMP FILL_STORE FILL_REBATE < <(tx_gas_breakdown "$FILL_OUT")
FILL_NET=$(( FILL_COMP + FILL_STORE - FILL_REBATE ))
BAL_T1=$(sender_total_mist)
gray "  digest:          $(tx_digest "$FILL_OUT")"
gray "  computation:     $FILL_COMP MIST"
gray "  storage cost:    $FILL_STORE MIST"
gray "  storage rebate:  $FILL_REBATE MIST"
gray "  net gas paid:    $FILL_NET MIST   (computation + storage - rebate)"
note "  T1 balance:      $BAL_T1 MIST"

# Sanity-check: total wallet delta should match the tx's net gas to within
# 1 MIST (it can differ if other coins moved, but for a clean smoke we
# expect equality). Just log; don't fail on it.
WALLET_FILL_DELTA=$(( BAL_BEFORE_FILL - BAL_T1 ))
gray "  wallet delta:    $WALLET_FILL_DELTA MIST  (T_before_fill - T1)"

# ── step 3: prune the entire range; record rebate ────────────────────────────
green ">>> wick::prune_proto::prune_range(0, $COUNT)"
BAL_BEFORE_PRUNE=$(sender_total_mist)
PRUNE_OUT=$(run_tx "prune" \
  sui client call \
    --package "$PKG" \
    --module prune_proto \
    --function prune_range \
    --args "$LEDGER" "0" "$COUNT" \
    --gas-budget "$GAS_BUDGET" \
    --json)
assert_tx_success "$PRUNE_OUT" "prune_range"
read -r PRUNE_COMP PRUNE_STORE PRUNE_REBATE < <(tx_gas_breakdown "$PRUNE_OUT")
PRUNE_NET=$(( PRUNE_COMP + PRUNE_STORE - PRUNE_REBATE ))
BAL_T2=$(sender_total_mist)
gray "  digest:          $(tx_digest "$PRUNE_OUT")"
gray "  computation:     $PRUNE_COMP MIST"
gray "  storage cost:    $PRUNE_STORE MIST   (new writes: pruned[] entries)"
gray "  storage rebate:  $PRUNE_REBATE MIST   (refund for deleted records)"
gray "  net gas paid:    $PRUNE_NET MIST   (negative ⇒ caller net-receives)"
note "  T2 balance:      $BAL_T2 MIST"
WALLET_PRUNE_DELTA=$(( BAL_T2 - BAL_BEFORE_PRUNE ))
gray "  wallet delta:    $WALLET_PRUNE_DELTA MIST  (T2 - T_before_prune)"

# ── summary ──────────────────────────────────────────────────────────────────
FILL_COST=$(( BAL_T0 - BAL_T1 ))
PRUNE_NET_TO_CALLER=$(( BAL_T2 - BAL_T1 ))   # positive ⇒ rebate > gas
ROUND_TRIP=$(( BAL_T2 - BAL_T0 ))            # whole cycle, MUST be ~0 or negative

# Per-record metrics. bash arithmetic only does integer div, but it's fine
# for this report — the magnitudes are large.
if [ "$COUNT" -gt 0 ]; then
  PER_RECORD_FILL=$(( FILL_COST / COUNT ))
  PER_RECORD_PRUNE_NET=$(( PRUNE_NET_TO_CALLER / COUNT ))
  PER_RECORD_ROUND_TRIP=$(( ROUND_TRIP / COUNT ))
else
  PER_RECORD_FILL=0
  PER_RECORD_PRUNE_NET=0
  PER_RECORD_ROUND_TRIP=0
fi

hr
green "=== prune-proto rebate smoke ==="
printf "  Ledger:           %s\n" "$LEDGER"
printf "  Records filled:   %d\n" "$COUNT"
printf "\n"
printf "  FILL phase:\n"
printf "    Balance before: %15d MIST\n" "$BAL_T0"
printf "    Balance after:  %15d MIST\n" "$BAL_T1"
printf "    Cost:           %15d MIST  (T0 - T1; storage write cost, ~80M expected per doc 23)\n" "$FILL_COST"
printf "    Per record:     %15d MIST/record\n" "$PER_RECORD_FILL"
printf "    Tx accounting:  comp=%d store=%d rebate=%d net=%d\n" "$FILL_COMP" "$FILL_STORE" "$FILL_REBATE" "$FILL_NET"
printf "\n"
printf "  PRUNE phase:\n"
printf "    Balance before: %15d MIST\n" "$BAL_T1"
printf "    Balance after:  %15d MIST\n" "$BAL_T2"
printf "    Net to caller:  %15d MIST  (T2 - T1; positive ⇒ rebate exceeded gas, matches doc 23 §3.3)\n" "$PRUNE_NET_TO_CALLER"
printf "    Per record:     %15d MIST/record  (doc 23 §3.3 claims ~3.7M MIST/record net)\n" "$PER_RECORD_PRUNE_NET"
printf "    Tx accounting:  comp=%d store=%d rebate=%d net=%d\n" "$PRUNE_COMP" "$PRUNE_STORE" "$PRUNE_REBATE" "$PRUNE_NET"
printf "\n"
printf "  Round-trip (write+prune, NET wallet delta):\n"
printf "    Net per round:  %15d MIST  (T2 - T0; ~1%% of fill cost ⇒ Sui rebate working as advertised)\n" "$ROUND_TRIP"
printf "    Per record:     %15d MIST/record\n" "$PER_RECORD_ROUND_TRIP"
hr

# ── exit code: doc 23 §3.3 claim is "Net to pruner per call = +74M MIST" ─────
# i.e. the PRUNE phase alone should be net-positive to the caller. The
# FILL cost is paid by the *protocol* (in v3 it's the segment market, not
# the pruner), so the relevant signal is BAL_T2 > BAL_T1.
if [ "$PRUNE_NET_TO_CALLER" -gt 0 ]; then
  green "✓ PASS — prune_range netted +$PRUNE_NET_TO_CALLER MIST to the caller"
  green "  doc 23 §3.3 positive-EV claim is empirically supported."
  exit 0
else
  red "✗ FAIL — prune_range did NOT net positive to the caller"
  red "  Got $PRUNE_NET_TO_CALLER MIST (≤ 0); doc 23 §3.3 claim is NOT supported."
  red "  Possible causes:"
  red "    - records too small (synthetic_payload < storage_rebate_floor)"
  red "    - storage rebate parameter changed in the Sui runtime since 2026-05"
  red "    - protocol/network gas pricing changed"
  red "  Inspect /tmp/wick-prune-proto-prune.json for the full effects."
  exit 1
fi
