#!/usr/bin/env node
/**
 * sentinel-v4-fast.mjs — fast v4 chart-alive bridge using @mysten/sui directly.
 *
 * The bash version (scripts/sentinel-v4-quick.sh) is bottlenecked by the
 * `sui client ptb` CLI shell roundtrip (~1.5s per crank) — way slower than
 * the chart needs to feel smooth. User complaint 2026-05-23: "why is the
 * chart so slow now. The chart moves 85ms fast remember?"
 *
 * This script keeps the same open/crank/close lifecycle but uses
 * @mysten/sui in-process so each `record_segment_v4` is ~150-200ms
 * end-to-end. Chart updates land at ~6 candles every 200ms vs every 1.5s.
 *
 * Usage:
 *   node scripts/sentinel-v4-fast.mjs
 *   nohup node scripts/sentinel-v4-fast.mjs > /tmp/sentinel-v4-fast.log 2>&1 &
 *
 * Keypair: loads the active sui CLI key from ~/.sui/sui_config/sui.keystore.
 *
 * Burn rate: ~30M MIST/round of gas + ~7.5M MIST/round of escrow (refunded).
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");

// ── Config ────────────────────────────────────────────────────────────────
const SUI_RANDOM_OBJECT_ID = "0x8";
const SUI_COIN_TYPE = "0x2::sui::SUI";

const deployment = JSON.parse(
  readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"),
);

const PKG = deployment.package_id;
const VAULT = deployment.vault_sui;
const BOT_REGISTRY = deployment.bot_registry;
const PRICE_ORACLE = deployment.usd_price_oracle;
const WICK_STATE = deployment.wick_token_state;
const STAKING_POOL = deployment.wick_staking_pool;

const v4Market = deployment.segment_markets_v4?.at(-1);
if (!v4Market) {
  console.error("no segment_markets_v4 entry in deployments/testnet.json");
  process.exit(1);
}
const MARKET = v4Market.market;
const ROUND_DURATION_SEGMENTS = Number(v4Market.round_duration_segments);
const MIN_STAKE_PER_SEGMENT = BigInt(v4Market.min_stake_per_segment);
const STAKE_PER_SEGMENT = MIN_STAKE_PER_SEGMENT;
const ESCROW_MIST = STAKE_PER_SEGMENT * BigInt(ROUND_DURATION_SEGMENTS);

// 2026-05-24 — bumped from 200 to 600 ms after the user's session got
// locked out: at 200 ms the cranker was holding the SegmentMarketV4
// shared-object lock almost continuously (~5/sec × ~700 ms RPC roundtrip
// = >100% duty cycle), and the user's open/close txs hit
// "object … unavailable for consumption" and "already locked by a
// different transaction" because they couldn't grab a fresh version
// between cranks. At 600 ms there's a ~500 ms gap each cycle for the
// user's tx to land.
const CRANK_INTERVAL_MS = Number(process.env.CRANK_INTERVAL_MS ?? "600");
const HOLD_SEGMENTS = Number(process.env.HOLD_SEGMENTS ?? "70");
const GAS_BUDGET = BigInt(process.env.GAS_BUDGET ?? "50000000"); // 0.1 SUI

// ── Load active sui CLI keypair ───────────────────────────────────────────
const KEYSTORE_PATH = join(homedir(), ".sui/sui_config/sui.keystore");
const CLIENT_YAML_PATH = join(homedir(), ".sui/sui_config/client.yaml");

if (!existsSync(KEYSTORE_PATH)) {
  console.error(`keystore not found at ${KEYSTORE_PATH}`);
  process.exit(1);
}

// client.yaml has a `active_address: 0x...` line. Use it to find the right key.
const clientYaml = readFileSync(CLIENT_YAML_PATH, "utf8");
const activeAddrMatch = clientYaml.match(/active_address:\s*"?(0x[a-f0-9]+)"?/);
if (!activeAddrMatch) {
  console.error("could not parse active_address from client.yaml");
  process.exit(1);
}
const ACTIVE_ADDRESS = activeAddrMatch[1];

const keystoreKeys = JSON.parse(readFileSync(KEYSTORE_PATH, "utf8"));
// Each key is base64 of (scheme byte + 32-byte raw key). Find the one whose
// derived Sui address matches the active address.
let keypair = null;
for (const b64 of keystoreKeys) {
  const bytes = Buffer.from(b64, "base64");
  // Sui keystore prepends a scheme byte: 0x00 = Ed25519, 0x01 = Secp256k1, 0x02 = Secp256r1.
  if (bytes.length !== 33 || bytes[0] !== 0x00) continue;
  const kp = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
  if (kp.getPublicKey().toSuiAddress() === ACTIVE_ADDRESS) {
    keypair = kp;
    break;
  }
}
if (!keypair) {
  console.error(`could not find Ed25519 key for ${ACTIVE_ADDRESS} in keystore`);
  process.exit(1);
}
const SENDER = keypair.getPublicKey().toSuiAddress();

// ── Sui client ────────────────────────────────────────────────────────────
const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl("testnet") });

// ── Helpers ───────────────────────────────────────────────────────────────
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildOpenTx() {
  const tx = new Transaction();
  const [escrow] = tx.splitCoins(tx.gas, [tx.pure.u64(ESCROW_MIST)]);
  const ride = tx.moveCall({
    target: `${PKG}::wick::open_segment_ride_v4`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(MARKET),
      tx.object(VAULT),
      tx.object(BOT_REGISTRY),
      tx.pure.u64(STAKE_PER_SEGMENT),
      escrow,
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.transferObjects([ride], tx.pure.address(SENDER));
  tx.setGasBudget(Number(GAS_BUDGET));
  return tx;
}

function buildCrankTx() {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::wick::record_segment_v4`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(MARKET),
      tx.object(SUI_RANDOM_OBJECT_ID),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.setGasBudget(Number(GAS_BUDGET));
  return tx;
}

function buildCloseTx(rideId) {
  const tx = new Transaction();
  const payout = tx.moveCall({
    target: `${PKG}::wick::close_segment_ride_v4`,
    typeArguments: [SUI_COIN_TYPE],
    arguments: [
      tx.object(rideId),
      tx.object(MARKET),
      tx.object(VAULT),
      tx.object(PRICE_ORACLE),
      tx.object(WICK_STATE),
      tx.object(STAKING_POOL),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.transferObjects([payout], tx.pure.address(SENDER));
  tx.setGasBudget(Number(GAS_BUDGET));
  return tx;
}

async function signAndExecute(tx, label) {
  return client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
}

// ── Banner ────────────────────────────────────────────────────────────────
log("─────────────────────────────────────────────────────");
log("Wick v4 FAST sentinel (Node + @mysten/sui)");
log(`  sender:        ${SENDER}`);
log(`  package:       ${PKG}`);
log(`  v4 market:     ${MARKET}`);
log(`  stake/seg:     ${STAKE_PER_SEGMENT} micro-USD`);
log(`  escrow/ride:   ${ESCROW_MIST} MIST  (${Number(ESCROW_MIST) / 1e9} SUI)`);
log(`  crank cadence: ${CRANK_INTERVAL_MS}ms`);
log(`  hold:          ${HOLD_SEGMENTS} segments`);
log("─────────────────────────────────────────────────────");

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// ── Main loop ─────────────────────────────────────────────────────────────
//
// 2026-05-24 — cost reduction. The old loop opened its own ride
// (escrow 0.00075 SUI) then cranked 70 segments then closed — burning
// ~0.36 SUI per cycle (~0.7 SUI/min, ~43 SUI/hour) JUST to keep the
// chart alive when nobody was playing.
//
// New behavior: cranker NEVER opens its own ride. It only polls
// market.active_ride_count; if > 0 (a real user is riding, or a stale
// ride is still open), it cranks record_segment_v4. If 0, it sleeps
// quietly. Cost drops to near-zero when idle, and only burns
// crank-gas (~5M MIST per crank) when real users are playing — which
// is what they'd be paying for anyway if we'd built v3.1 sponsored
// cranking instead.
//
// Idle cost: 1 RPC call per IDLE_POLL_MS (free, just a getObject).
// Active cost: 1 record_segment_v4 tx per CRANK_INTERVAL_MS during
//              user rides. ~5M MIST/tx ≈ 0.03 SUI/min of actual play.
const IDLE_POLL_MS = Number(process.env.IDLE_POLL_MS ?? "2000");

async function readActiveRideCount() {
  try {
    const obj = await client.getObject({
      id: MARKET,
      options: { showContent: true },
    });
    const fields =
      // newer SDK shape
      obj.data?.content?.fields ??
      // legacy fallback
      obj.data?.content;
    const n =
      Number(fields?.active_ride_count ?? fields?.activeRideCount ?? 0) || 0;
    return n;
  } catch (err) {
    log(`pollErr: ${err.message?.slice(0, 80)}`);
    return -1;
  }
}

let tick = 0;
let consecutiveCrankErrs = 0;
let lastLoggedState = "";

while (true) {
  tick += 1;
  const arc = await readActiveRideCount();

  if (arc <= 0) {
    if (lastLoggedState !== "idle") {
      log(`idle — active_ride_count=0, polling every ${IDLE_POLL_MS}ms (zero burn)`);
      lastLoggedState = "idle";
    }
    await sleep(IDLE_POLL_MS);
    continue;
  }

  if (lastLoggedState !== "cranking") {
    log(`cranking — active_ride_count=${arc} at ${CRANK_INTERVAL_MS}ms cadence`);
    lastLoggedState = "cranking";
  }

  try {
    await signAndExecute(buildCrankTx(), `crank-${tick}`);
    consecutiveCrankErrs = 0;
  } catch (err) {
    consecutiveCrankErrs += 1;
    if (consecutiveCrankErrs <= 3 || consecutiveCrankErrs % 10 === 0) {
      log(`[${tick}] crank err #${consecutiveCrankErrs}: ${err.message?.slice(0, 100)}`);
    }
    // Many crank errors in a row — the user's ride probably just settled.
    // Re-poll active_ride_count quickly.
    if (consecutiveCrankErrs >= 5) {
      lastLoggedState = "";
      await sleep(IDLE_POLL_MS);
      consecutiveCrankErrs = 0;
      continue;
    }
  }
  await sleep(CRANK_INTERVAL_MS);
}

// Dead code (the old open/crank/close cycle, kept for reference).
// The new main loop above never reaches this; it's an infinite while-true.
async function _legacyOpenCrankCloseCycle() {
  let loop = 0;
  let currentRideId = null;
  loop += 1;
  const tStart = Date.now();

  let openRes;
  try {
    openRes = await signAndExecute(buildOpenTx(), `open-${loop}`);
  } catch (err) {
    log(`[${loop}] open failed — sleep 5s. ${err.message?.slice(0, 120)}`);
    await sleep(5000);
    return;
  }
  const ridePos = openRes.objectChanges?.find(
    (c) =>
      c.type === "created" &&
      typeof c.objectType === "string" &&
      c.objectType.includes("::segment_market_v4::SegmentRidePositionV4"),
  );
  if (!ridePos) {
    log(`[${loop}] open returned no ride object — skipping`);
    await sleep(2000);
    return;
  }
  currentRideId = ridePos.objectId;
  log(`[${loop}] OPEN ride=${currentRideId.slice(0, 12)}… digest=${openRes.digest.slice(0, 16)}`);

  let crankErrors = 0;
  for (let seg = 0; seg < HOLD_SEGMENTS; seg++) {
    try {
      await signAndExecute(buildCrankTx(), `crank-${loop}-${seg}`);
    } catch (err) {
      crankErrors += 1;
      if (crankErrors > 5) {
        log(`[${loop}] >5 crank errors, bailing this ride. last: ${err.message?.slice(0, 100)}`);
        break;
      }
    }
    if (seg % 10 === 0) {
      log(`[${loop}] cranked ${seg}/${HOLD_SEGMENTS}`);
    }
    await sleep(CRANK_INTERVAL_MS);
  }

  try {
    const closeRes = await signAndExecute(buildCloseTx(currentRideId), `close-${loop}`);
    log(`[${loop}] CLOSE digest=${closeRes.digest.slice(0, 16)}`);
  } catch (err) {
    log(`[${loop}] close failed: ${err.message?.slice(0, 120)} — ride may have auto-settled`);
  }
  currentRideId = null;

  const dur = ((Date.now() - tStart) / 1000).toFixed(1);
  log(`[${loop}] loop complete in ${dur}s`);
  await sleep(500);
}
// End of _legacyOpenCrankCloseCycle (unreachable; the new poll-only loop
// above is an infinite while-true). Kept as a reference for the old
// open/crank/close pattern in case we ever want a sentinel that PROVIDES
// activity rather than just AMPLIFIES it.
