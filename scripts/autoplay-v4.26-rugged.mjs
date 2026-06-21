#!/usr/bin/env node
/**
 * Autoplay harness for the v4.26 rugged market.
 *
 * Runs N rides end-to-end from a single burner wallet — opens, holds
 * for ~3-5 segments, closes — and tracks outcomes:
 *   - TOUCH_WIN count
 *   - CASHOUT count
 *   - EXPIRED_LOSS count
 *   - RUGGED count (closes where the round had a RugFiredV4 event)
 *
 * Reports:
 *   - observed touch rate
 *   - observed rug rate (matches configured rug_chance_bps × 75?)
 *   - net TUSD P&L for the player
 *   - effective house edge in practice
 *
 * Stress-tests the v4.26 flow + collects real data to compare against
 * scripts/simulate_v4_with_rug.py predictions.
 *
 * Cost: ~0.01 SUI per ride lifecycle (open + 3-5 cranks + close) +
 *       ~0.825 TUSD per non-touch ride. Faucet drips cover this.
 *
 * Prereq:
 *   - v4.26 rugged market bootstrapped (scripts/bootstrap-tusd-market-rugged.sh)
 *   - WICK_FAUCET_PRIVATE_KEY env set (uses faucet wallet as autoplay payer
 *     since it already has SUI + can mint TUSD to itself via the cap)
 *
 * Usage:
 *   WICK_FAUCET_PRIVATE_KEY=suiprivkey1... node scripts/autoplay-v4.26-rugged.mjs --rides 50
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEPLOYMENT = JSON.parse(
  readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"),
);

const PKG = DEPLOYMENT.package_id;
const v4Market = DEPLOYMENT.segment_markets_v4?.at(-1);
if (!v4Market) {
  console.error("No segment_markets_v4 entry — bootstrap a market first.");
  process.exit(1);
}
const RUG_BPS = v4Market.rug_chance_bps ?? 0;
if (RUG_BPS === 0) {
  console.error("WARNING: latest market has rug_chance_bps=0 — rugs are disabled.");
  console.error("Bootstrap with scripts/bootstrap-tusd-market-rugged.sh first.");
}

const MARKET = v4Market.market;
const VAULT = v4Market.vault;
const COLL = v4Market.collateral;
const ROUND_DURATION = Number(v4Market.round_duration_segments ?? 75);
const STAKE = BigInt(v4Market.min_stake_per_segment ?? 10_000);
const ESCROW = (STAKE * BigInt(ROUND_DURATION) * 11n) / 10n;

const BOT_REGISTRY = DEPLOYMENT.bot_registry;
const PRICE_ORACLE = DEPLOYMENT.usd_price_oracle;
const WICK_TOKEN = DEPLOYMENT.wick_token_state;
const STAKING_POOL = DEPLOYMENT.wick_staking_pool;

const args = process.argv.slice(2);
// Accept BOTH `--rides=N` and `--rides N` (the form the usage block shows).
const N_RIDES = (() => {
  const i = args.findIndex((a) => a === "--rides" || a.startsWith("--rides="));
  if (i === -1) return 20;
  const raw = args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

const HOLD_SEGMENTS = 5; // crank ~5 segments per ride before closing

const secret = process.env.WICK_FAUCET_PRIVATE_KEY;
if (!secret) {
  console.error("WICK_FAUCET_PRIVATE_KEY env var is required.");
  process.exit(1);
}
const keypair = Ed25519Keypair.fromSecretKey(secret);
const sender = keypair.getPublicKey().toSuiAddress();

const client = new SuiJsonRpcClient({
  network: "testnet",
  url: process.env.WICK_VERIFY_RPC ?? "https://sui-testnet-rpc.publicnode.com",
});

console.log("─".repeat(64));
console.log(`v4.26 autoplay — ${N_RIDES} rides against ${MARKET.slice(0, 12)}…`);
console.log(`  sender:           ${sender}`);
console.log(`  market:           ${MARKET}`);
console.log(`  rug_chance_bps:   ${RUG_BPS}  (${RUG_BPS/100}% per segment)`);
console.log(`  hold per ride:    ${HOLD_SEGMENTS} segments`);
console.log("─".repeat(64));

const stats = {
  ridesAttempted: 0,
  opensSucceeded: 0,
  touchWins: 0,
  cashouts: 0,
  expiredLoss: 0,
  ruggedLoss: 0,
  totalTUSDIn: 0n,
  totalTUSDOut: 0n,
  errors: 0,
};

async function fetchSomeCoin(coinType) {
  const r = await client.getCoins({ owner: sender, coinType });
  const best = (r.data ?? []).sort(
    (a, b) => Number(BigInt(b.balance) - BigInt(a.balance)),
  )[0];
  return best;
}

async function runOneRide(idx) {
  stats.ridesAttempted += 1;
  // 1. OPEN
  const tusdCoin = await fetchSomeCoin(COLL);
  if (!tusdCoin || BigInt(tusdCoin.balance) < ESCROW) {
    console.log(`  [${idx}] insufficient TUSD (have ${tusdCoin?.balance ?? 0}, need ${ESCROW}) — skipping`);
    stats.errors += 1;
    return;
  }
  let rideId = null;
  try {
    const tx = new Transaction();
    tx.setSender(sender);
    const [escrow] = tx.splitCoins(tx.object(tusdCoin.coinObjectId), [tx.pure.u64(ESCROW)]);
    // open_segment_ride_v4 RETURNS the SegmentRidePositionV4 — the caller
    // must transfer it, else the PTB aborts with UnusedValueWithoutDrop.
    // Mirrors sdk/src/segmentMarketV4.ts:buildOpenSegmentRideV4Tx.
    const ride = tx.moveCall({
      target: `${PKG}::wick::open_segment_ride_v4`,
      typeArguments: [COLL],
      arguments: [
        tx.object(MARKET),
        tx.object(VAULT),
        tx.object(BOT_REGISTRY),
        tx.pure.u64(STAKE),
        escrow,
        tx.object.clock(),
      ],
    });
    tx.transferObjects([ride], tx.pure.address(sender));
    const res = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showObjectChanges: true, showEffects: true },
    });
    const created = (res.objectChanges ?? []).find(
      (c) => c.type === "created" && c.objectType?.includes("::segment_market_v4::SegmentRidePositionV4"),
    );
    if (!created?.objectId) throw new Error("no ride object created");
    rideId = created.objectId;
    stats.opensSucceeded += 1;
    stats.totalTUSDIn += ESCROW;
  } catch (err) {
    console.log(`  [${idx}] open failed: ${String(err).slice(0, 120)}`);
    stats.errors += 1;
    return;
  }

  // 2. CRANK + 3. CLOSE
  for (let s = 0; s < HOLD_SEGMENTS; s++) {
    try {
      const tx = new Transaction();
      tx.setSender(sender);
      // record_segment_v4 consumes &Random AND may write the rug
      // dynamic-field; auto gas-budgeting under-estimates that combo and the
      // crank reverts, so the round never advances and every close cashes out
      // at stake_paid=0. Pin a generous budget.
      tx.setGasBudget(50_000_000);
      tx.moveCall({
        target: `${PKG}::wick::record_segment_v4`,
        typeArguments: [COLL],
        arguments: [tx.object(MARKET), tx.object.random(), tx.object.clock()],
      });
      await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEffects: false },
      });
    } catch (err) {
      // A crank reverts once the ride has settled (touch / rug) — that's the
      // expected stop condition. But a gas/under-budget revert ALSO lands
      // here and silently aborts the hold, leaving segments_held=0 (the very
      // failure mode the pinned gas budget above guards against). Surface it
      // so a stuck harness is debuggable instead of looking like "0 payout".
      const msg = String(err);
      if (/InsufficientGas|budget|GasBalanceTooLow/i.test(msg)) {
        console.log(`  [${idx}] crank ${s} gas revert: ${msg.slice(0, 100)}`);
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // 4. CLOSE — retry transient gas-coin contention so the ride doesn't leak.
  // The payer's single gas coin is shared (faucet + any concurrent runner), so
  // back-to-back txs occasionally race its version ("needs to be rebuilt",
  // "rejected as invalid by >1/3"). A dropped close leaks an unclosed ride
  // toward the per-user cap (10) and eventually aborts opens. Rebuild the tx
  // each attempt (re-resolving gas); real aborts still fail fast.
  // close_segment_ride_v4 RETURNS the payout coin — transfer it, else
  // UnusedValueWithoutDrop. Mirrors the SDK close builder.
  const buildCloseTx = () => {
    const tx = new Transaction();
    tx.setSender(sender);
    const payout = tx.moveCall({
      target: `${PKG}::wick::close_segment_ride_v4`,
      typeArguments: [COLL],
      arguments: [
        tx.object(rideId),
        tx.object(MARKET),
        tx.object(VAULT),
        tx.object(PRICE_ORACLE),
        tx.object(WICK_TOKEN),
        tx.object(STAKING_POOL),
        tx.object.clock(),
      ],
    });
    tx.transferObjects([payout], tx.pure.address(sender));
    return tx;
  };
  let res = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: buildCloseTx(),
        options: { showEvents: true, showEffects: true },
      });
      break;
    } catch (err) {
      const transient = /needs to be rebuilt|unavailable for consumption|rejected as invalid|equivocat|reserved for another/i.test(String(err));
      if (attempt === 3 || !transient) {
        console.log(`  [${idx}] close failed: ${String(err).slice(0, 120)}`);
        stats.errors += 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  const ev = (res.events ?? []).find((e) => (e.type ?? "").includes("::segment_market_v4::RideClosedV4"));
  if (ev?.parsedJson) {
    const kind = Number(ev.parsedJson.settlement_kind ?? -1);
    const payout = BigInt(ev.parsedJson.payout ?? 0);
    stats.totalTUSDOut += payout;
    if (kind === 1) { stats.touchWins += 1; console.log(`  [${idx}] TOUCH WIN  payout=${payout}`); }
    else if (kind === 2) { stats.cashouts += 1; console.log(`  [${idx}] CASHOUT   payout=${payout}`); }
    else if (kind === 3) {
      stats.expiredLoss += 1;
      console.log(`  [${idx}] EXPIRED/RUG  payout=${payout}`);
    }
    else { console.log(`  [${idx}] kind=${kind}  payout=${payout}`); }
  }
}

function printSummary() {
  console.log("\n" + "─".repeat(64));
  console.log("AUTOPLAY SUMMARY");
  console.log("─".repeat(64));
  console.log(`  rides attempted:  ${stats.ridesAttempted}`);
  console.log(`  opens succeeded:  ${stats.opensSucceeded}`);
  console.log(`  touch wins:       ${stats.touchWins}  (${((stats.touchWins / Math.max(stats.opensSucceeded, 1)) * 100).toFixed(1)}%)`);
  console.log(`  cashouts:         ${stats.cashouts}  (${((stats.cashouts / Math.max(stats.opensSucceeded, 1)) * 100).toFixed(1)}%)`);
  console.log(`  expired/rugged:   ${stats.expiredLoss}  (${((stats.expiredLoss / Math.max(stats.opensSucceeded, 1)) * 100).toFixed(1)}%)`);
  console.log(`  errors:           ${stats.errors}`);
  console.log(`  total TUSD in:    ${stats.totalTUSDIn}  (raw)`);
  console.log(`  total TUSD out:   ${stats.totalTUSDOut}  (raw)`);
  const netRaw = Number(stats.totalTUSDOut - stats.totalTUSDIn);
  const houseEdge = stats.totalTUSDIn > 0n ? -netRaw / Number(stats.totalTUSDIn) : 0;
  console.log(`  net to player:    ${netRaw > 0 ? "+" : ""}${netRaw}  (raw TUSD)`);
  console.log(`  effective house edge: ${(houseEdge * 100).toFixed(2)}%  (positive = house wins)`);
  console.log("─".repeat(64));
}

async function main() {
  for (let i = 1; i <= N_RIDES; i++) {
    await runOneRide(i);
    await new Promise((r) => setTimeout(r, 1000));
  }
  printSummary();
}

process.on("SIGINT", () => { printSummary(); process.exit(0); });

main().catch((err) => { console.error("fatal:", err); printSummary(); process.exit(1); });
