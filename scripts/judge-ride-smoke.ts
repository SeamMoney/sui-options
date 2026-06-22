#!/usr/bin/env tsx
/**
 * judge-ride-smoke — prove the WHOLE on-chain loop a judge would do, cold, in
 * one command, against LIVE testnet. No wallet extension, no pre-funded key.
 *
 *   npx tsx scripts/judge-ride-smoke.ts          # or: npm run smoke:ride
 *
 * Steps (each one a real testnet tx, with a SuiScan link):
 *   1. mint a throwaway burner keypair (in memory, never saved)
 *   2. fund it from the production faucet API — SUI gas + TUSD stake, the exact
 *      two requests the /ride UI fires for a fresh player (amounts are read from
 *      the live response, so they track the server's configured drip)
 *   3. open a real `open_segment_ride_v4` ride on the live touch-either market
 *   4. crank a handful of segments (`record_segment_v4`)
 *   5. close it (`close_segment_ride_v4`) — on-chain settlement
 *   6. hand the closed ride to `scripts/audit-ride.ts` (the COMPLETE audit) and
 *      assert it PASSes — barriers (not cherry-picked) · candles (⟸ keys) ·
 *      MARKET HALT · verdict · payout, every dimension proven from the chain
 *
 * This is the end-to-end companion to `scripts/demo-smoke.sh` (which only pings
 * routes + faucet liveness). Exits non-zero on any hard failure so it can gate
 * a demo runbook.
 *
 * Env:
 *   BASE   faucet origin (default https://wick-markets.vercel.app)
 *   RPC    Sui testnet RPC (default the public node; Mysten fullnode also works)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  buildOpenSegmentRideV4Tx,
  buildRecordSegmentV4Tx,
  buildCloseSegmentRideV4Tx,
  SETTLEMENT_NAME_V4,
} from "../sdk/src/segmentMarketV4.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const D = JSON.parse(readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"));

const BASE = process.env.BASE ?? "https://wick-markets.vercel.app";
const RPC = process.env.RPC ?? "https://sui-testnet-rpc.publicnode.com";
const HOLD = Number(process.env.HOLD ?? 5);

const PKG = D.package_id as string;
const m = D.segment_markets_v4.at(-1);
const MARKET = m.market as string;
const VAULT = m.vault as string;
const COLL = m.collateral as string;
// Stake at MAX per-segment to faithfully reproduce the ride a judge actually
// plays: the /ride UI (useSegmentRideV4, v4.30) stakes at max_stake_per_segment,
// so its escrow is max × round × 1.1 (≈12.375 TUSD on the live market). Opening
// at min here would (a) prove a smaller ride than the judge plays and (b) pass
// even when the faucet drips below the funding gate (the #373 lockout: 10 TUSD
// > a 0.825 min-escrow, so a min-stake smoke never caught it). Matching max
// means this cold loop only succeeds if funding genuinely clears the gate.
const STAKE = BigInt(m.max_stake_per_segment ?? m.min_stake_per_segment ?? 10_000);
const ESCROW = (STAKE * BigInt(m.round_duration_segments ?? 75) * 11n) / 10n;

const client = new SuiJsonRpcClient({ url: RPC, network: "testnet" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scan = (kind: string, id: string) => `https://suiscan.xyz/testnet/${kind}/${id}`;

let step = 0;
function log(msg: string) {
  console.log(`\x1b[36m[${++step}]\x1b[0m ${msg}`);
}
function ok(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function die(msg: string): never {
  console.error(`  \x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

async function postFaucet(
  path: string,
  recipient: string,
): Promise<{ digest: string; label: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    die(`${path} → HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  // Derive the human label from the actual response so it never drifts from the
  // server's configured drip (SUI faucet → amount_mist; TUSD faucet → amount_raw).
  let label = "";
  if (body.amount_mist != null) {
    label = `${(Number(body.amount_mist) / 1e9).toLocaleString()} SUI`;
  } else if (body.amount_raw != null) {
    label = `${(Number(body.amount_raw) / 1e6).toLocaleString()} TUSD`;
  }
  return { digest: String(body.digest ?? ""), label };
}

async function balance(owner: string, coinType: string): Promise<bigint> {
  const r = await client.getCoins({ owner, coinType });
  return (r.data ?? []).reduce((a, c) => a + BigInt(c.balance), 0n);
}

async function waitFor(
  label: string,
  fn: () => Promise<boolean>,
  tries = 30,
  gapMs = 1500,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return;
    await sleep(gapMs);
  }
  die(`timed out waiting for ${label}`);
}

async function exec(tx: unknown, kp: Ed25519Keypair, opts = {}) {
  return client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx as never,
    options: { showEffects: true, showObjectChanges: true, showEvents: true, ...opts },
  });
}

async function main() {
  console.log(`judge-ride-smoke — live on-chain loop @ ${BASE}`);
  console.log(`  market ${MARKET}`);
  console.log(`  rpc    ${RPC}\n`);

  // 1. burner
  const kp = Ed25519Keypair.generate();
  const me = kp.getPublicKey().toSuiAddress();
  log(`fresh burner wallet ${me}`);

  // 2. fund via the production faucet (the judge's exact two requests)
  log("funding from the production faucet…");
  const gas = await postFaucet("/api/faucet", me);
  ok(`${gas.label || "SUI gas"}  ${scan("tx", gas.digest)}`);
  const tusd = await postFaucet("/api/faucet-tusd", me);
  ok(`${tusd.label || "TUSD stake"}  ${scan("tx", tusd.digest)}`);

  await waitFor("gas + stake to land", async () => {
    const sui = await balance(me, "0x2::sui::SUI");
    const tusd = await balance(me, COLL);
    return sui > 0n && tusd >= ESCROW;
  });
  ok("funds confirmed on-chain");

  // 3. open
  log("opening a touch-either ride…");
  const coins = await client.getCoins({ owner: me, coinType: COLL });
  const sorted = (coins.data ?? []).sort((a, b) =>
    Number(BigInt(b.balance) - BigInt(a.balance)),
  );
  const escrowSourceCoinId = sorted[0]?.coinObjectId;
  if (!escrowSourceCoinId) die("no TUSD coin to stake from");
  const openTx = buildOpenSegmentRideV4Tx({
    packageId: PKG,
    collateralType: COLL,
    sender: me,
    marketId: MARKET,
    vaultId: VAULT,
    botRegistryId: D.bot_registry,
    stakePerSegment: STAKE,
    escrowMist: ESCROW,
    escrowSourceCoinId,
    additionalCoinIds: sorted.slice(1).map((c) => c.coinObjectId),
  });
  const openRes = await exec(openTx, kp);
  if (openRes.effects?.status?.status !== "success") {
    die(`open failed: ${JSON.stringify(openRes.effects?.status)}`);
  }
  const created = (openRes.objectChanges ?? []).find(
    (c: { type?: string; objectType?: string }) =>
      c.type === "created" &&
      c.objectType?.includes("::segment_market_v4::SegmentRidePositionV4"),
  ) as { objectId?: string } | undefined;
  const rideId = created?.objectId;
  if (!rideId) die("ride object not created");
  ok(`ride ${rideId}`);
  ok(`open tx ${scan("tx", openRes.digest)}`);

  // 4. crank a few segments
  log(`cranking ~${HOLD} segments…`);
  let cranked = 0;
  for (let i = 0; i < HOLD; i++) {
    try {
      const tx = buildRecordSegmentV4Tx({
        packageId: PKG,
        collateralType: COLL,
        sender: me,
        marketId: MARKET,
      });
      const r = await exec(tx, kp, { showObjectChanges: false });
      if (r.effects?.status?.status === "success") cranked++;
    } catch {
      // ESegmentAlreadyRecorded (concurrent cranker won) or self-settle on
      // touch — both fine; keep trying the next index.
    }
    await sleep(500);
  }
  ok(`recorded ${cranked} segment(s)`);

  // 5. close
  log("closing the ride (on-chain settlement)…");
  const closeTx = buildCloseSegmentRideV4Tx({
    packageId: PKG,
    collateralType: COLL,
    sender: me,
    rideId: rideId as string,
    marketId: MARKET,
    vaultId: VAULT,
    priceOracleId: D.usd_price_oracle,
    tokenStateId: D.wick_token_state,
    stakingPoolId: D.wick_staking_pool,
  });
  const closeRes = await exec(closeTx, kp);
  if (closeRes.effects?.status?.status !== "success") {
    die(`close failed: ${JSON.stringify(closeRes.effects?.status)}`);
  }
  const ev = (closeRes.events ?? []).find((e: { type?: string }) =>
    (e.type ?? "").includes("::segment_market_v4::RideClosedV4"),
  ) as { parsedJson?: Record<string, unknown> } | undefined;
  const kind = Number(ev?.parsedJson?.settlement_kind ?? -1);
  const payout = String(ev?.parsedJson?.payout ?? "?");
  ok(
    `settled ${SETTLEMENT_NAME_V4[kind as keyof typeof SETTLEMENT_NAME_V4] ?? kind} ` +
      `payout=${payout}  ${scan("tx", closeRes.digest)}`,
  );

  // 6. COMPLETE independent audit via scripts/audit-ride.ts — barriers (not
  //    cherry-picked) · candles · MARKET HALT · verdict · payout. Exits non-zero
  //    if ANY dimension fails, so the try/catch is the real gate.
  log("auditing the closed ride with scripts/audit-ride.ts (barriers · candles · halt · verdict · payout)…");
  let verifyOut = "";
  try {
    verifyOut = execFileSync(
      "npx",
      ["tsx", join(REPO_ROOT, "scripts/audit-ride.ts"), "--market", MARKET, "--ride", rideId as string, "--rpc", RPC],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    console.log(err.stdout ?? "");
    console.log(err.stderr ?? "");
    die("the complete audit did NOT pass — a dimension of the ride failed to reproduce");
  }
  const passed = /COMPLETE AUDIT PASS/.test(verifyOut);
  // echo the audit's final verdict lines
  for (const line of verifyOut.trim().split("\n").slice(-4)) console.log(`    ${line}`);
  if (!passed) die("audit output did not contain COMPLETE AUDIT PASS");

  console.log(`\n\x1b[32m✅ full on-chain loop verified\x1b[0m — funded a cold wallet, opened, cranked, settled, and ran the COMPLETE audit (barriers, candles, halt, verdict, payout) on a real ride on testnet.`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
