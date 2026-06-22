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
 *   # Default — poll mode (cheap, ~0 SUI when idle, used by frontend's
 *   # stall-cranker pattern):
 *   node scripts/sentinel-v4-fast.mjs
 *
 *   # 24/7 always-active mode — BURNS ~60 SUI/HOUR. Only for live demos:
 *   CRANKER_MODE=always node scripts/sentinel-v4-fast.mjs
 *
 * Keypair: loads the active sui CLI key from ~/.sui/sui_config/sui.keystore.
 *
 * Burn-rate budget per mode:
 *   - poll  (default): ~0 SUI when no rides are open, ~0.05 SUI per
 *                      real user ride lifecycle.
 *   - always:           ~0.5 SUI / minute = ~30 SUI / hour. Was draining
 *                      the operator faster than the Sui faucet refilled.
 *
 * 2026-05-24 — Default flipped always→poll. The frontend's client-side
 * idle walk (useRideGestureV4 v4.15) already fakes visual motion for $0,
 * so we don't need on-chain cranking when nobody's playing. The always
 * mode survives behind an env flag for live in-person demos where you
 * want the on-chain truth visible.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
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
// v4.24 — markets can be SUI or a non-SUI collateral (e.g. TUSD). The live
// demo market (segment_markets_v4[-1]) is the rugged TUSD one, so the open
// PTB must split escrow from a TUSD coin and pass the right type arg —
// splitting from gas (SUI) on a TUSD market silently produces no ride.
const COLLATERAL = v4Market.collateral || SUI_COIN_TYPE;
const IS_SUI_COLLATERAL = COLLATERAL === SUI_COIN_TYPE;
// open/close take MartingalerVault<C> — must be the MARKET'S vault, not the
// SUI vault. The TUSD demo market binds the TUSD vault; passing vault_sui
// fails with a TypeMismatch on the vault arg and no ride is created.
const VAULT = v4Market.vault || deployment.vault_sui;
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
const client = new SuiJsonRpcClient({
  url: process.env.WICK_VERIFY_RPC ?? "https://sui-testnet-rpc.publicnode.com",
});

// ── Helpers ───────────────────────────────────────────────────────────────
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hard timeout on every RPC/tx await. Without it, a black-hole RPC connection
// (accepts the request, never sends a response body) parks the single awaited
// loop FOREVER — the process stays alive so the chart-keeper supervisor never
// restarts it, and the live chart freezes permanently. A timeout turns the hang
// into a throw the existing catch/retry recovers from cleanly. (The TS sibling
// segmentSentinel.ts already guards its fetch this way; the fast .mjs never got
// it.) Generous default (20s): normal RPC is ~150-200ms, so this only fires on a
// genuine hang, never on a healthy-but-slow call.
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? "20000");
function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} RPC timed out after ${RPC_TIMEOUT_MS}ms`)),
      RPC_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function buildOpenTx() {
  const tx = new Transaction();
  // Escrow source: gas for SUI markets, a sender-owned coin for non-SUI
  // (mirrors sdk/src/segmentMarketV4.ts buildOpenSegmentRideV4Tx). Merge the
  // sender's other coins of that type in first so a single split always has
  // enough, even if escrow drips have fragmented the balance.
  let escrow;
  if (IS_SUI_COLLATERAL) {
    [escrow] = tx.splitCoins(tx.gas, [tx.pure.u64(ESCROW_MIST)]);
  } else {
    const r = await withTimeout(
      client.getCoins({ owner: SENDER, coinType: COLLATERAL }),
      "getCoins",
    );
    const coins = (r.data ?? []).slice().sort((a, b) =>
      BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
    );
    if (coins.length === 0) {
      throw new Error(`no ${COLLATERAL} coins owned by ${SENDER} to escrow`);
    }
    const primary = tx.object(coins[0].coinObjectId);
    if (coins.length > 1) {
      tx.mergeCoins(primary, coins.slice(1).map((c) => tx.object(c.coinObjectId)));
    }
    [escrow] = tx.splitCoins(primary, [tx.pure.u64(ESCROW_MIST)]);
  }
  const ride = tx.moveCall({
    target: `${PKG}::wick::open_segment_ride_v4`,
    typeArguments: [COLLATERAL],
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
    typeArguments: [COLLATERAL],
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
    typeArguments: [COLLATERAL],
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
  return withTimeout(
    client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showObjectChanges: true, showEffects: true },
    }),
    label ?? "signAndExecute",
  );
}

// Retry transient gas-coin / validator contention. The operator wallet has a
// single gas coin shared with the faucet, so back-to-back txs occasionally
// race its version ("needs to be rebuilt", "unavailable for consumption",
// "rejected as invalid by >1/3 of validators"). REBUILD the tx each attempt
// (so gas re-resolves to the now-advanced coin) instead of resubmitting a
// stale one. Non-contention errors (e.g. a real abort) fail fast. `buildTx`
// may be sync or async. Without this, a transient close failure leaks an
// unclosed ride toward the per-user cap and eventually stalls the chart.
const RETRYABLE = /needs to be rebuilt|unavailable for consumption|rejected as invalid|equivocat|reserved for another|not available for consumption/i;
async function execWithRetry(buildTx, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await signAndExecute(await buildTx(), label);
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE.test(String(err?.message ?? err))) throw err;
      await sleep(700 * (i + 1));
    }
  }
  throw lastErr;
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

// 2026-05-24 — Tracks the in-flight ride object id so SIGINT can
// close it instead of leaking escrow into the vault.
let activeSentinelRideId = null;
async function gracefulShutdown() {
  if (activeSentinelRideId) {
    log(`shutdown — closing sentinel ride ${activeSentinelRideId.slice(0, 12)}…`);
    try {
      await signAndExecute(buildCloseTx(activeSentinelRideId), "shutdown-close");
    } catch (err) {
      log(`  trap close failed: ${err.message?.slice(0, 120)}`);
    }
  }
  process.exit(0);
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// ── Main loop ─────────────────────────────────────────────────────────────
//
// 2026-05-24 — operator mode:
//   CRANKER_MODE=poll     (DEFAULT) — only crank when a real user has a
//                                     ride open. Cost ~0 SUI when idle.
//                                     The frontend's client-side idle-
//                                     walk (useRideGestureV4 v4.15) fakes
//                                     visual motion for $0 so the chart
//                                     never LOOKS dead to a first-timer.
//   CRANKER_MODE=always            — open/crank/close in a loop forever.
//                                     Chart is genuinely on-chain alive
//                                     24/7 but burns ~60 SUI/HOUR
//                                     (measured: 0.00909 SUI per crank at
//                                     600 ms cadence). Only use this for
//                                     a live in-person demo where you
//                                     CAN'T trust the idle-walk illusion.
//                                     STOP IT before walking away.
//
// 2026-05-24 default flipped always→poll. Running this script 24/7 in
// always mode was draining the operator wallet faster than the public
// Sui faucet refilled it (~1 SUI / 90 s public-faucet drip vs. 60 SUI/
// hour burn). The idle-walk visual is good enough for the demo.
const CRANKER_MODE = (process.env.CRANKER_MODE ?? "poll").toLowerCase();
const IDLE_POLL_MS = Number(process.env.IDLE_POLL_MS ?? "2000");

// ALWAYS-ACTIVE mode — open / crank / close in a loop.
if (CRANKER_MODE === "always") {
  log(`mode: ALWAYS-ACTIVE — sentinel ride keeps chart alive 24/7`);
  let loop = 0;
  while (true) {
    loop += 1;
    const tStart = Date.now();
    // 1. OPEN
    let openRes;
    try {
      openRes = await execWithRetry(() => buildOpenTx(), `open-${loop}`);
    } catch (err) {
      const msg = err.message ?? String(err);
      // F1 — distinguish FUND EXHAUSTION (operator wallet out of escrow coins or
      // gas) from a transient error and surface it loudly + greppably. On
      // exhaustion every open fails identically forever and the chart freezes
      // while the process looks "healthy" — a silent wedge a restart can't fix.
      // A distinct line lets monitoring / a human alarm and refill.
      if (/no .*coins owned|InsufficientGas|GasBalanceTooLow|insufficient.*(gas|balance)/i.test(msg)) {
        log(`[${loop}] ⛔ FUNDS-EXHAUSTED — operator wallet out of escrow/gas; the live chart will FREEZE until refilled: ${msg.slice(0, 140)}`);
      } else {
        log(`[${loop}] open failed: ${msg.slice(0, 100)} — sleep 10s`);
      }
      await sleep(10_000);
      continue;
    }
    const ridePos = openRes.objectChanges?.find(
      (c) =>
        c.type === "created" &&
        typeof c.objectType === "string" &&
        c.objectType.includes("::segment_market_v4::SegmentRidePositionV4"),
    );
    if (!ridePos) {
      log(`[${loop}] open returned no ride object — sleep 5s`);
      await sleep(5_000);
      continue;
    }
    activeSentinelRideId = ridePos.objectId;
    log(`[${loop}] OPEN ride=${activeSentinelRideId.slice(0, 12)}…`);

    // 2. CRANK for HOLD_SEGMENTS segments
    let crankErrors = 0;
    for (let seg = 0; seg < HOLD_SEGMENTS; seg++) {
      try {
        await signAndExecute(buildCrankTx(), `crank-${loop}-${seg}`);
        crankErrors = 0;
      } catch (err) {
        crankErrors += 1;
        if (crankErrors > 8) {
          log(`[${loop}] >8 crank errors, bailing this ride`);
          break;
        }
      }
      if (seg % 20 === 0) log(`[${loop}] cranked ${seg}/${HOLD_SEGMENTS}`);
      await sleep(CRANK_INTERVAL_MS);
    }

    // 3. CLOSE (retry transient contention so the ride doesn't leak)
    try {
      const rideId = activeSentinelRideId;
      await execWithRetry(() => buildCloseTx(rideId), `close-${loop}`);
      log(`[${loop}] CLOSE in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
    } catch (err) {
      log(`[${loop}] close failed: ${err.message?.slice(0, 100)}`);
    }
    activeSentinelRideId = null;
    await sleep(500); // breath between loops
  }
}

// POLL-ONLY mode (legacy) — only crank when a real user is riding.

async function readActiveRideCount() {
  try {
    const obj = await withTimeout(
      client.getObject({
        id: MARKET,
        options: { showContent: true },
      }),
      "getObject",
    );
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
    openRes = await signAndExecute(await buildOpenTx(), `open-${loop}`);
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
