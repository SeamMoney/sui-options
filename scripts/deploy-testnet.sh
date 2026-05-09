#!/usr/bin/env bash
# Publish the Wick Move package to Sui testnet and persist the deployment
# artifact so the frontend, keeper, and smoke-test scripts can find it.
#
# Idempotent in the sense that re-running it produces a fresh deployment;
# old deployments are timestamped and kept under deployments/archive/.
#
# Usage:
#   ./scripts/deploy-testnet.sh
#
# Required:
#   - sui CLI installed and on PATH
#   - active environment is testnet (script will refuse otherwise)
#   - active address has at least MIN_BALANCE_MIST of SUI for gas

set -euo pipefail

cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '%s\n' "$*"; }

# 1 SUI = 1e9 MIST. Publish typically costs < 0.1 SUI; require 0.5 SUI of headroom.
MIN_BALANCE_MIST=500000000

# --- Preflight ---

if ! command -v sui >/dev/null 2>&1; then
  red "deploy: 'sui' CLI not found. Install it first (brew install sui)."
  exit 1
fi

env_name="$(sui client active-env 2>/dev/null || echo unknown)"
if [ "$env_name" != "testnet" ]; then
  red "deploy: active sui env is '$env_name', expected 'testnet'."
  red "        Run: sui client switch --env testnet"
  exit 1
fi

addr="$(sui client active-address 2>/dev/null || true)"
if [ -z "$addr" ]; then
  red "deploy: no active address. Run: sui client new-address ed25519"
  exit 1
fi

note "deploy: env=testnet  address=$addr"

# Sum gas-coin balances (in MIST) to check headroom.
total_mist="$(
  sui client gas --json 2>/dev/null \
    | python3 -c '
import json, sys
data = json.load(sys.stdin)
print(sum(int(c["mistBalance"]) for c in data) if data else 0)
' 2>/dev/null || echo 0
)"
note "deploy: gas balance = ${total_mist} MIST (~$(awk "BEGIN { printf \"%.4f\", $total_mist/1e9 }") SUI)"

if [ "$total_mist" -lt "$MIN_BALANCE_MIST" ]; then
  red "deploy: insufficient gas. Need at least ${MIN_BALANCE_MIST} MIST."
  red "        Fund this address via the testnet faucet:"
  red "        https://faucet.sui.io/?address=$addr"
  exit 2
fi

# --- Publish ---

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out_dir="deployments"
archive_dir="${out_dir}/archive"
mkdir -p "$archive_dir"

# Archive any prior deployment file before overwriting.
if [ -f "${out_dir}/testnet.json" ]; then
  cp "${out_dir}/testnet.json" "${archive_dir}/testnet-${stamp}.json"
fi

publish_log="${archive_dir}/publish-${stamp}.json"
note "deploy: running 'sui client publish' (this can take ~30-60s)..."
sui client publish move/ --json --gas-budget 200000000 > "$publish_log"

# Extract the Package object id (objectType == "package") and the tx digest.
package_id="$(
  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
changes = data.get("objectChanges") or []
for c in changes:
    if c.get("type") == "published":
        print(c.get("packageId", ""))
        break
' "$publish_log"
)"
digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("digest", ""))' "$publish_log")"

if [ -z "$package_id" ]; then
  red "deploy: could not parse package id from publish output. See $publish_log"
  exit 3
fi

# --- Persist artifact ---

cat > "${out_dir}/testnet.json" <<JSON
{
  "network": "testnet",
  "package_id": "$package_id",
  "publisher": "$addr",
  "publish_digest": "$digest",
  "published_at": "$stamp",
  "raw_log": "${archive_dir}/publish-${stamp}.json"
}
JSON

green "deploy: ok"
note "  package_id = $package_id"
note "  digest     = $digest"
note "  artifact   = ${out_dir}/testnet.json"
note ""
note "Next:"
note "  - inspect: https://suiscan.xyz/testnet/object/$package_id"
note "  - smoke:   ./scripts/smoke.sh    (creates oracle + market, exercises trade/redeem path)"
