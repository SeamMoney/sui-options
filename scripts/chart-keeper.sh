#!/usr/bin/env bash
# chart-keeper.sh — resilient supervisor that keeps the live /ride on-chain
# chart moving for judges by (re)running the v4 sentinel in ALWAYS-ACTIVE mode.
#
# The sentinel (scripts/sentinel-v4-fast.mjs) already self-heals WITHIN a run
# (retries open failures, tolerates crank reverts). This wrapper adds PROCESS-
# level resilience: if the node process itself dies — an RPC outage throwing
# past the internal handlers, an OOM, a transient network drop — it restarts a
# few seconds later instead of leaving the chart frozen until someone notices.
#
# Usage:
#   # needs the operator key — either the active sui CLI key, or:
#   export WICK_FAUCET_PRIVATE_KEY=suiprivkey1...   # (optional; sentinel falls
#                                                    #  back to the CLI keystore)
#   ./scripts/chart-keeper.sh
#
# Burn rate: ~30 SUI/hour (the sentinel's always mode). Ctrl+C stops the
# supervisor; the sentinel traps SIGINT and closes its in-flight ride first.
#
# Tunables pass straight through to the sentinel via the environment, e.g.
#   CRANK_INTERVAL_MS=400 HOLD_SEGMENTS=120 ./scripts/chart-keeper.sh
set -u
cd "$(dirname "$0")/.."

export CRANKER_MODE=always

ts() { date -u +%H:%M:%S; }
restarts=0

# Forward Ctrl+C to the child so its SIGINT trap (close the open ride) runs,
# then exit the supervisor instead of restarting.
trap 'echo "[chart-keeper $(ts)] stopping"; kill "${child:-0}" 2>/dev/null; exit 0' INT TERM

while true; do
  echo "[chart-keeper $(ts)] starting sentinel (restart #${restarts})"
  node scripts/sentinel-v4-fast.mjs &
  child=$!
  wait "$child"
  code=$?
  restarts=$((restarts + 1))
  echo "[chart-keeper $(ts)] sentinel exited (code ${code}); restarting in 5s"
  sleep 5
done
