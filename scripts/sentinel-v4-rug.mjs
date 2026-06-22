#!/usr/bin/env node
/**
 * sentinel-v4-rug.mjs — sustainable sponsor-wallet cranker for the
 *                       v4.26 rugged TUSD market.
 *
 * What this script is for
 * ────────────────────────────────────────────────────────────────────────
 * The v4.26 rug-pull mechanism only fires inside `record_segment_v4` — so
 * the on-chain chart only advances (and rugs only fire) when SOMEBODY
 * cranks. When nobody is playing, the chart on Suiscan looks dead even
 * though the frontend fakes visual motion via the client-side idle walk.
 *
 * This script keeps the on-chain chart alive by cranking from the SPONSOR
 * wallet at a sustainable cadence, BOUNDED BY THE SPONSOR'S BALANCE so it
 * shuts itself down before draining. Two side effects worth shipping:
 *
 *   1. Rugs fire visibly on chain. The frontend's RugFeed panel
 *      subscribes to RugFiredV4 — it stays empty unless segments are
 *      being recorded. This makes the panel actually show rugs to anyone
 *      visiting the page, not just to active riders.
 *   2. Suiscan shows live activity on the rugged market. Demo viewers
 *      can click through to the explorer and see real `record_segment_v4`
 *      transactions landing every N seconds.
 *
 * Differences from sentinel-v4-fast.mjs
 * ────────────────────────────────────────────────────────────────────────
 *   - Targets the LAST market with `rug_chance_bps > 0` (the rugged
 *     TUSD market) rather than whatever the active sui CLI key is paired
 *     with. Reads vault from the market entry, not deployment.vault_sui.
 *   - Loads the SPONSOR wallet keypair from the local sui keystore by
 *     matching `deployments/testnet.json:sponsor.sponsor_address` rather
 *     than `~/.sui/sui_config/client.yaml:active_address`. So this script
 *     is safe to run while you have a different address active.
 *   - Has a HARD SPEND CAP. Default = burn no more than half the sponsor's
 *     current balance (≈ 0.15 SUI on a 0.3 SUI wallet). When the wallet
 *     dips below the floor, the script shuts itself down with a summary.
 *   - Subscribes to RugFiredV4 events and prints them in the foreground
 *     so you can see the mechanism working in real time.
 *
 * Usage
 * ────────────────────────────────────────────────────────────────────────
 *   # Default — 60 s cadence, hard-stops near sponsor floor:
 *   node scripts/sentinel-v4-rug.mjs
 *
 *   # Faster cadence for a live demo (5 s = ~6.5 SUI/hour — only for
 *   # short demos; default lets you walk away for ~30 min):
 *   CRANK_INTERVAL_MS=5000 node scripts/sentinel-v4-rug.mjs
 *
 *   # Tight budget — burn at most 0.05 SUI of the sponsor before halting:
 *   MAX_SPEND_MIST=50000000 node scripts/sentinel-v4-rug.mjs
 *
 *   # Time-boxed session — stop after 5 minutes regardless of balance:
 *   MAX_SESSION_MS=300000 node scripts/sentinel-v4-rug.mjs
 *
 *   # Override the market (default = last rugged segment_markets_v4 entry):
 *   MARKET_ID=0x... node scripts/sentinel-v4-rug.mjs
 *
 * Burn-rate budget
 * ────────────────────────────────────────────────────────────────────────
 *   Measured cost of `record_segment_v4`:  ~0.009 SUI / crank
 *
 *   cadence | burn rate    | sponsor (0.30 SUI) runway
 *   --------|--------------|--------------------------
 *   5  s    | 6.48 SUI/hr  |  ~2.5 min     ← demo-only
 *   10 s    | 3.24 SUI/hr  |  ~5 min       ← demo-only
 *   30 s    | 1.08 SUI/hr  |  ~16 min
 *   60 s    | 0.54 SUI/hr  |  ~33 min      ← DEFAULT (sustainable)
 *   120 s   | 0.27 SUI/hr  |  ~66 min
 *
 *   Cranks are interleaved with balance polls; if the wallet dips below
 *   MIN_FLOOR_MIST (default 50M MIST = 0.05 SUI), the cranker halts and
 *   prints a session summary.
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

// ── Constants ─────────────────────────────────────────────────────────────
const SUI_RANDOM_OBJECT_ID = "0x8";
const SUI_COIN_TYPE = "0x2::sui::SUI";

// ── Config ────────────────────────────────────────────────────────────────
const deployment = JSON.parse(
  readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"),
);

const PKG = deployment.package_id;
const SPONSOR_ADDRESS = deployment.sponsor?.sponsor_address;
if (!SPONSOR_ADDRESS) {
  console.error("deployments/testnet.json has no sponsor.sponsor_address");
  process.exit(1);
}

// Pick the rugged market: env override, else last market with rug_chance_bps > 0.
const ruggedMarkets = (deployment.segment_markets_v4 ?? []).filter(
  (m) => Number(m.rug_chance_bps ?? 0) > 0,
);
const overrideMarketId = process.env.MARKET_ID;
const market =
  overrideMarketId != null
    ? deployment.segment_markets_v4?.find((m) => m.market === overrideMarketId)
    : ruggedMarkets.at(-1);

if (!market) {
  console.error(
    overrideMarketId
      ? `MARKET_ID=${overrideMarketId} not found in segment_markets_v4`
      : "no segment_markets_v4 entry has rug_chance_bps > 0 — bootstrap a rugged market first",
  );
  process.exit(1);
}

const MARKET = market.market;
const VAULT = market.vault;
const COLLATERAL_TYPE = market.collateral;
const RUG_BPS = Number(market.rug_chance_bps ?? 0);
const ROUND_DURATION_SEGMENTS = Number(market.round_duration_segments ?? 75);

// Cranking cadence + budget knobs.
const CRANK_INTERVAL_MS = Number(process.env.CRANK_INTERVAL_MS ?? "60000");
const GAS_BUDGET_MIST = BigInt(process.env.GAS_BUDGET ?? "50000000"); // 0.05 SUI/tx upper
const MIN_FLOOR_MIST = BigInt(process.env.MIN_FLOOR_MIST ?? "50000000"); // halt below 0.05 SUI
const MAX_SPEND_MIST = process.env.MAX_SPEND_MIST
  ? BigInt(process.env.MAX_SPEND_MIST)
  : null;
const MAX_SESSION_MS = process.env.MAX_SESSION_MS
  ? Number(process.env.MAX_SESSION_MS)
  : null;
const BALANCE_POLL_EVERY_N_CRANKS = Number(
  process.env.BALANCE_POLL_EVERY_N_CRANKS ?? "5",
);

// ── Load SPONSOR wallet from keystore ─────────────────────────────────────
const KEYSTORE_PATH = join(homedir(), ".sui/sui_config/sui.keystore");
if (!existsSync(KEYSTORE_PATH)) {
  console.error(`keystore not found at ${KEYSTORE_PATH}`);
  process.exit(1);
}
const keystoreKeys = JSON.parse(readFileSync(KEYSTORE_PATH, "utf8"));
let keypair = null;
for (const b64 of keystoreKeys) {
  const bytes = Buffer.from(b64, "base64");
  // Sui keystore: 1-byte scheme prefix (0x00=Ed25519, 0x01=Secp256k1, 0x02=Secp256r1) + 32-byte raw.
  if (bytes.length !== 33 || bytes[0] !== 0x00) continue;
  const kp = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
  if (kp.getPublicKey().toSuiAddress() === SPONSOR_ADDRESS) {
    keypair = kp;
    break;
  }
}
if (!keypair) {
  console.error(`sponsor address ${SPONSOR_ADDRESS} not found in ${KEYSTORE_PATH}`);
  console.error("import the sponsor key via `sui keytool import <bech32>` first");
  process.exit(1);
}
const SENDER = keypair.getPublicKey().toSuiAddress();

// ── Sui client ────────────────────────────────────────────────────────────
const client = new SuiJsonRpcClient({
  url: process.env.WICK_VERIFY_RPC ?? "https://sui-testnet-rpc.publicnode.com",
});
// Dedicated client for the RugFiredV4 event reads. PublicNode prunes old tx
// events and reliably ERRORS the RugFiredV4 scan ("Could not find the
// referenced transaction events"), so the rug log stays silent on the default
// RPC even while rugs fire. The Mysten fullnode retains history — use it for
// the event reads (txs/balance keep using `client`). Override with
// WICK_RUG_RPC. (Same fallback the SDK's subscribeRugFiredV4 applies.)
const rugClient = new SuiJsonRpcClient({
  url: process.env.WICK_RUG_RPC ?? "https://fullnode.testnet.sui.io:443",
});

// ── Helpers ───────────────────────────────────────────────────────────────
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtSui = (mist) => `${(Number(mist) / 1e9).toFixed(4)} SUI`;

async function getSponsorBalanceMist() {
  const r = await client.getBalance({ owner: SENDER, coinType: SUI_COIN_TYPE });
  return BigInt(r.totalBalance ?? "0");
}

function buildCrankTx() {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::wick::record_segment_v4`,
    typeArguments: [COLLATERAL_TYPE],
    arguments: [
      tx.object(MARKET),
      tx.object(SUI_RANDOM_OBJECT_ID),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.setGasBudget(Number(GAS_BUDGET_MIST));
  return tx;
}

// ── RugFiredV4 subscriber ─────────────────────────────────────────────────
const RUG_EVENT_TYPE = `${PKG}::segment_market_v4::RugFiredV4`;
let lastEventCursor = null;
const seenRugs = new Set();

async function pollRugEvents() {
  try {
    const res = await rugClient.queryEvents({
      query: { MoveEventType: RUG_EVENT_TYPE },
      cursor: lastEventCursor,
      limit: 25,
      order: "ascending",
    });
    for (const ev of res.data ?? []) {
      const j = ev.parsedJson ?? {};
      const marketIdRaw = j.market_id ?? j.marketId;
      if (marketIdRaw && marketIdRaw !== MARKET) continue;
      const key = `${ev.id?.txDigest ?? "?"}:${ev.id?.eventSeq ?? "?"}`;
      if (seenRugs.has(key)) continue;
      seenRugs.add(key);
      const round = j.round_index ?? j.roundIndex ?? "?";
      const seg = j.segment_index ?? j.segmentIndex ?? "?";
      log(`  💥 RUG FIRED — round ${round} segment ${seg}  digest=${(ev.id?.txDigest ?? "").slice(0, 14)}…`);
      session.rugsObserved += 1;
    }
    if (res.hasNextPage && res.nextCursor) lastEventCursor = res.nextCursor;
    else if (res.data?.length) lastEventCursor = res.data.at(-1).id;
  } catch (err) {
    log(`  rug-poll err: ${err.message?.slice(0, 80)}`);
  }
}

// ── Session state ─────────────────────────────────────────────────────────
const session = {
  startTimeMs: Date.now(),
  startBalanceMist: 0n,
  currentBalanceMist: 0n,
  cranksAttempted: 0,
  cranksLanded: 0,
  cranksFailed: 0,
  rugsObserved: 0,
  haltReason: null,
};

function spentMist() {
  return session.startBalanceMist > session.currentBalanceMist
    ? session.startBalanceMist - session.currentBalanceMist
    : 0n;
}

function printSummary() {
  const sessionSec = (Date.now() - session.startTimeMs) / 1000;
  const burnRatePerHr = session.cranksLanded
    ? (Number(spentMist()) / 1e9) * (3600 / sessionSec)
    : 0;
  console.log("\n" + "─".repeat(64));
  console.log("SENTINEL SESSION SUMMARY");
  console.log("─".repeat(64));
  console.log(`  market:               ${MARKET}`);
  console.log(`  sponsor:              ${SENDER}`);
  console.log(`  duration:             ${sessionSec.toFixed(1)}s`);
  console.log(`  cranks attempted:     ${session.cranksAttempted}`);
  console.log(`  cranks landed:        ${session.cranksLanded}`);
  console.log(`  cranks failed:        ${session.cranksFailed}`);
  console.log(`  rugs observed:        ${session.rugsObserved}`);
  console.log(`  spent:                ${fmtSui(spentMist())}`);
  console.log(`  cost / crank:         ${session.cranksLanded ? fmtSui(spentMist() / BigInt(session.cranksLanded)) : "—"}`);
  console.log(`  burn rate:            ${burnRatePerHr.toFixed(3)} SUI / hour`);
  console.log(`  final balance:        ${fmtSui(session.currentBalanceMist)}`);
  console.log(`  halt reason:          ${session.haltReason ?? "?"}`);
  // Sanity check the rug rate against the configured rate.
  if (session.cranksLanded > 0 && RUG_BPS > 0) {
    const observedRate = (session.rugsObserved / session.cranksLanded) * 10_000;
    console.log(`  rug rate (observed):  ${observedRate.toFixed(1)} bps  (configured: ${RUG_BPS} bps)`);
  }
  console.log("─".repeat(64));
}

async function gracefulShutdown(reason) {
  session.haltReason = reason;
  session.currentBalanceMist = await getSponsorBalanceMist().catch(() => session.currentBalanceMist);
  printSummary();
  process.exit(0);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ── Banner ────────────────────────────────────────────────────────────────
log("─────────────────────────────────────────────────────");
log("Wick v4.26 rugged-market sentinel (sponsor wallet)");
log(`  sponsor:          ${SENDER}`);
log(`  package:          ${PKG}`);
log(`  market:           ${MARKET}`);
log(`  collateral:       ${COLLATERAL_TYPE}`);
log(`  vault:            ${VAULT}`);
log(`  rug_chance_bps:   ${RUG_BPS}  (${(RUG_BPS / 100).toFixed(2)}% per segment)`);
log(`  round duration:   ${ROUND_DURATION_SEGMENTS} segments`);
log(`  cadence:          ${CRANK_INTERVAL_MS}ms`);
log(`  min floor:        ${fmtSui(MIN_FLOOR_MIST)}`);
log(`  max spend:        ${MAX_SPEND_MIST ? fmtSui(MAX_SPEND_MIST) : "(unbounded)"}`);
log(`  max session:      ${MAX_SESSION_MS ? `${MAX_SESSION_MS / 1000}s` : "(unbounded)"}`);
log("─────────────────────────────────────────────────────");

// ── Bootstrap ─────────────────────────────────────────────────────────────
session.startBalanceMist = await getSponsorBalanceMist();
session.currentBalanceMist = session.startBalanceMist;
log(`opening balance:   ${fmtSui(session.startBalanceMist)}`);
if (session.startBalanceMist <= MIN_FLOOR_MIST) {
  log(`sponsor already at/below floor — refill before running`);
  gracefulShutdown("below_floor_at_start");
}

// Seed the rug-event cursor to "now" so we only report NEW rugs.
try {
  const seed = await rugClient.queryEvents({
    query: { MoveEventType: RUG_EVENT_TYPE },
    limit: 1,
    order: "descending",
  });
  if (seed.data?.length) lastEventCursor = seed.data[0].id;
  log(`rug subscriber seeded at cursor ${seed.data?.length ? (seed.data[0].id.txDigest ?? "").slice(0, 14) + "…" : "(no prior rugs)"}`);
} catch (err) {
  log(`rug-seed err: ${err.message?.slice(0, 100)} — starting from null cursor`);
}

// ── Main loop ─────────────────────────────────────────────────────────────
let tick = 0;
let consecutiveErrs = 0;
while (true) {
  tick += 1;
  session.cranksAttempted += 1;

  // Time-budget check.
  if (MAX_SESSION_MS && Date.now() - session.startTimeMs >= MAX_SESSION_MS) {
    await gracefulShutdown(`time_budget_exhausted (${MAX_SESSION_MS / 1000}s)`);
  }

  // Crank.
  try {
    await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: buildCrankTx(),
      options: { showEffects: true },
    });
    session.cranksLanded += 1;
    consecutiveErrs = 0;
  } catch (err) {
    session.cranksFailed += 1;
    consecutiveErrs += 1;
    const msg = err.message?.slice(0, 100) ?? "(no message)";
    if (consecutiveErrs <= 3 || consecutiveErrs % 10 === 0) {
      log(`[${tick}] crank err #${consecutiveErrs}: ${msg}`);
    }
    if (consecutiveErrs >= 8) {
      await gracefulShutdown(`too_many_consecutive_errors (${consecutiveErrs})`);
    }
  }

  // Poll rugs every cycle (cheap: read-only).
  await pollRugEvents();

  // Periodic balance + budget check.
  if (tick % BALANCE_POLL_EVERY_N_CRANKS === 0) {
    session.currentBalanceMist = await getSponsorBalanceMist().catch(
      () => session.currentBalanceMist,
    );
    const spent = spentMist();
    log(
      `[${tick}] landed=${session.cranksLanded} rugs=${session.rugsObserved} balance=${fmtSui(session.currentBalanceMist)} spent=${fmtSui(spent)}`,
    );
    if (session.currentBalanceMist <= MIN_FLOOR_MIST) {
      await gracefulShutdown(`balance_below_floor (${fmtSui(session.currentBalanceMist)} ≤ ${fmtSui(MIN_FLOOR_MIST)})`);
    }
    if (MAX_SPEND_MIST && spent >= MAX_SPEND_MIST) {
      await gracefulShutdown(`max_spend_reached (${fmtSui(spent)} ≥ ${fmtSui(MAX_SPEND_MIST)})`);
    }
  }

  await sleep(CRANK_INTERVAL_MS);
}
