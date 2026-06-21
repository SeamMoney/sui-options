#!/usr/bin/env bash
# Demo-readiness smoke — is the LIVE judge-facing demo green right now?
#
#   npm run smoke:demo              # checks production
#   BASE=http://127.0.0.1:4173 npm run smoke:demo   # checks a local serve
#
# Curl-only (no browser/deps) so anyone can run it in ~5s before a demo or after
# a merge. Verifies the key routes serve HTML, the faucet endpoints answer
# (200 drip or 429 cooldown — both mean "configured & alive"), and the DeepBook
# mark indexer that Wick Pro prices against is reachable. Exits non-zero on any
# hard failure so it can gate a runbook.

set -uo pipefail
BASE="${BASE:-https://wick-markets.vercel.app}"
INDEXER="${DEEPBOOK_INDEXER_URL:-https://deepbook-indexer.mainnet.mystenlabs.com}"
fails=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

echo "demo smoke @ $BASE"

# Routes must serve the SPA HTML shell (200).
for path in "/" "/pro" "/coach" "/verify"; do
  code=$(curl -s -o /dev/null -m 20 -w "%{http_code}" "$BASE$path")
  [ "$code" = "200" ] && ok "GET $path → 200" || bad "GET $path → $code"
done

# Faucet endpoints: 200 (dripped) or 429 (cooldown) both prove configured+alive.
# 500 ("not configured") / 503 (drained) are hard failures.
fresh="0x$(printf '%064d' "$((RANDOM))" | cut -c1-64)"
for ep in faucet faucet-tusd; do
  code=$(curl -s -o /dev/null -m 30 -w "%{http_code}" -X POST "$BASE/api/$ep" \
    -H 'Content-Type: application/json' -d "{\"recipient\":\"$fresh\"}")
  case "$code" in
    200|429) ok "POST /api/$ep → $code (alive)";;
    *)       bad "POST /api/$ep → $code";;
  esac
done

# DeepBook mark indexer (Wick Pro prices options off this live mid).
mid=$(curl -s -m 20 "$INDEXER/orderbook/SUI_USDC?level=1" \
  | python3 -c "import json,sys
try:
  d=json.load(sys.stdin); b=d['bids'][0][0]; a=d['asks'][0][0]
  print(round((float(a)+float(b))/2,5))
except Exception: print('')" 2>/dev/null)
[ -n "$mid" ] && ok "DeepBook SUI/USDC mid = \$$mid" || bad "DeepBook indexer unreachable"

echo ""
if [ "$fails" -gt 0 ]; then echo -e "\033[31mFAIL — $fails check(s) down\033[0m"; exit 1; fi
echo -e "\033[32mPASS — demo is live & green\033[0m"
