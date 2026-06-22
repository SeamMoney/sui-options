#!/usr/bin/env bash
#
# One command to answer "is the demo ready to present RIGHT NOW?" — aggregates the
# two live readiness checks the team would otherwise run separately:
#
#   1. on-chain  — scripts/verify-deployment.py: every demo object live, the
#                  MartingalerVault funded, AND the faucet wallet has runway +
#                  enough gas coins (so a judge can actually fund a burner).
#   2. server    — npm run smoke:demo: routes load, /api/faucet + /api/faucet-tusd
#                  alive, /api/verify-pro confirms a known commit, DeepBook mark live.
#
# Both hit the live network (public fullnode + the production deploy), so this is a
# pre-demo confirmation, not a CI gate. Exits non-zero if either section fails, with
# a single READY / NOT-READY verdict — no parsing two outputs by eye at the deadline.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "═══════════════════════════════════════════════════════"
echo "  1/2 · on-chain deployment (objects · vaults · faucet)"
echo "═══════════════════════════════════════════════════════"
python3 scripts/verify-deployment.py || fail=1

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  2/2 · live server + feed (routes · faucet · verify · DeepBook)"
echo "═══════════════════════════════════════════════════════"
npm run --silent smoke:demo || fail=1

echo ""
echo "═══════════════════════════════════════════════════════"
if [ "$fail" -eq 0 ]; then
  echo "  ✅ DEMO READY — on-chain healthy + live server/feed green."
  echo "     (game-loop + fairness proofs: npm run judge · npm run check:pro)"
else
  echo "  ❌ NOT READY — fix the failing section above before presenting."
fi
echo "═══════════════════════════════════════════════════════"
exit $fail
