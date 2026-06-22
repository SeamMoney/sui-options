#!/usr/bin/env node
/**
 * Play exactly ONE v4 ride end-to-end (open → crank a few segments → close) on
 * the live segment_market_v4 market, then print the `--market`/`--ride` ids so
 * `scripts/verify-v4.ts` can replay it from chain. Used to produce a fresh,
 * non-pruned closed ride for the provably-fair demo.
 *
 * Reuses the deployment's latest v4 market + the faucet wallet (which holds
 * TUSD). Requires WICK_FAUCET_PRIVATE_KEY.
 *
 *   WICK_FAUCET_PRIVATE_KEY=suiprivkey1... node scripts/play-one-v4.mjs [--hold 6]
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const D = JSON.parse(readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"));
const PKG = D.package_id;
const m = D.segment_markets_v4.at(-1);
const { market: MARKET, vault: VAULT, collateral: COLL } = m;
const STAKE = BigInt(m.min_stake_per_segment ?? 10_000);
const ESCROW = (STAKE * BigInt(m.round_duration_segments ?? 75) * 11n) / 10n;
const BOT_REGISTRY = D.bot_registry;
const PRICE_ORACLE = D.usd_price_oracle;
const WICK_TOKEN = D.wick_token_state;
const STAKING_POOL = D.wick_staking_pool;

const holdArg = process.argv.find((a) => a.startsWith("--hold"));
const HOLD = holdArg ? Number(holdArg.split("=")[1] ?? process.argv[process.argv.indexOf(holdArg) + 1]) : 6;

const secret = process.env.WICK_FAUCET_PRIVATE_KEY;
if (!secret) {
  console.error("WICK_FAUCET_PRIVATE_KEY required");
  process.exit(1);
}
const kp = Ed25519Keypair.fromSecretKey(secret);
const sender = kp.getPublicKey().toSuiAddress();
const c = new SuiJsonRpcClient({ network: "testnet", url: getJsonRpcFullnodeUrl("testnet") });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bestCoin(type) {
  const r = await c.getCoins({ owner: sender, coinType: type });
  return (r.data ?? []).sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))[0];
}

async function main() {
  console.log(`play-one-v4 — market ${MARKET.slice(0, 12)}… sender ${sender.slice(0, 12)}…`);
  const coin = await bestCoin(COLL);
  if (!coin || BigInt(coin.balance) < ESCROW) {
    throw new Error(`insufficient collateral (have ${coin?.balance ?? 0}, need ${ESCROW})`);
  }

  // 1. OPEN — open_segment_ride_v4 returns the ride object; transfer it.
  const openTx = new Transaction();
  openTx.setSender(sender);
  const [escrow] = openTx.splitCoins(openTx.object(coin.coinObjectId), [openTx.pure.u64(ESCROW)]);
  const ride = openTx.moveCall({
    target: `${PKG}::wick::open_segment_ride_v4`,
    typeArguments: [COLL],
    arguments: [
      openTx.object(MARKET),
      openTx.object(VAULT),
      openTx.object(BOT_REGISTRY),
      openTx.pure.u64(STAKE),
      escrow,
      openTx.object.clock(),
    ],
  });
  openTx.transferObjects([ride], openTx.pure.address(sender));
  const openRes = await c.signAndExecuteTransaction({
    signer: kp,
    transaction: openTx,
    options: { showObjectChanges: true },
  });
  const created = (openRes.objectChanges ?? []).find(
    (x) => x.type === "created" && x.objectType?.includes("::segment_market_v4::SegmentRidePositionV4"),
  );
  if (!created?.objectId) throw new Error("no ride created");
  const rideId = created.objectId;
  console.log(`  opened ride ${rideId}`);

  // 2. CRANK a few segments (record_segment_v4 is permissionless).
  let cranked = 0;
  for (let i = 0; i < HOLD; i++) {
    try {
      const tx = new Transaction();
      tx.setSender(sender);
      tx.moveCall({
        target: `${PKG}::wick::record_segment_v4`,
        typeArguments: [COLL],
        arguments: [tx.object(MARKET), tx.object.random(), tx.object.clock()],
      });
      const r = await c.signAndExecuteTransaction({
        signer: kp,
        transaction: tx,
        options: { showEffects: true },
      });
      if (r.effects?.status?.status === "success") cranked++;
    } catch (e) {
      console.log(`  crank ${i} failed: ${String(e).slice(0, 100)}`);
      // ESegmentAlreadyRecorded means a concurrent cranker won the slot —
      // retry the next index rather than giving up.
    }
    await sleep(450);
  }
  console.log(`  cranked ${cranked}/${HOLD} segments`);

  // 3. CLOSE — close_segment_ride_v4 returns the payout coin; transfer it.
  const closeTx = new Transaction();
  closeTx.setSender(sender);
  const payout = closeTx.moveCall({
    target: `${PKG}::wick::close_segment_ride_v4`,
    typeArguments: [COLL],
    arguments: [
      closeTx.object(rideId),
      closeTx.object(MARKET),
      closeTx.object(VAULT),
      closeTx.object(PRICE_ORACLE),
      closeTx.object(WICK_TOKEN),
      closeTx.object(STAKING_POOL),
      closeTx.object.clock(),
    ],
  });
  closeTx.transferObjects([payout], closeTx.pure.address(sender));
  const closeRes = await c.signAndExecuteTransaction({
    signer: kp,
    transaction: closeTx,
    options: { showEvents: true },
  });
  const ev = (closeRes.events ?? []).find((e) => (e.type ?? "").includes("::segment_market_v4::RideClosedV4"));
  const kind = ev?.parsedJson?.settlement_kind;
  const payoutAmt = ev?.parsedJson?.payout;
  console.log(`  closed: settlement_kind=${kind} payout=${payoutAmt} touched_side=${ev?.parsedJson?.touched_side}`);
  console.log("");
  console.log("VERIFY WITH:");
  console.log(`  npx tsx scripts/verify-v4.ts --market ${MARKET} --ride ${rideId}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
