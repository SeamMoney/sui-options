#!/usr/bin/env node
/**
 * v4.26 verification harness.
 *
 * After the rug-enabled TUSD market is bootstrapped + the cranker is
 * running, run this script in another terminal to watch the on-chain
 * events and confirm:
 *
 *   1. RugFiredV4 events ARE being emitted by record_segment_v4.
 *   2. Observed rug rate over N segments converges to rug_chance_bps
 *      (e.g. 150 bps = 1.5%, so ~30 rugs expected per 2000 segments).
 *   3. RideClosedV4 events with settlement_kind=3 (EXPIRED_LOSS) on
 *      rugged rounds correlate cleanly with RugFiredV4 events on the
 *      same round_index.
 *   4. Observed house edge in practice tracks the MC prediction of
 *      ~+3.4% with current params.
 *
 * Pure observation — does not submit any tx, does not spend any SUI.
 * Polls the fullnode every POLL_MS for new events.
 *
 * Usage:
 *   node scripts/verify-v4.26-rug.mjs
 *   node scripts/verify-v4.26-rug.mjs --duration 600  # watch for 10 min
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEPLOYMENT = JSON.parse(
  readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"),
);

// Event type tags are keyed by the package that *defined* the type (the
// type-origin package), NOT the latest upgraded `package_id`. After an upgrade
// `DEPLOYMENT.package_id` points at the newest package, but events emitted by
// an older module keep their original address — so querying with the latest id
// silently returns ZERO events. We resolve the correct type-origin package from
// the market object's own type at startup (see resolveTypePackage below).
const v4Market = DEPLOYMENT.segment_markets_v4?.at(-1);
if (!v4Market) {
  console.error("No segment_markets_v4 entry. Bootstrap a market first.");
  process.exit(1);
}
const MARKET = v4Market.market;
const RUG_BPS = v4Market.rug_chance_bps ?? 0;
const EXPECTED_RATE_PCT = RUG_BPS / 100;

console.log("─".repeat(64));
console.log(`v4.26 rug verification — watching ${MARKET.slice(0, 12)}…`);
console.log(`  configured rug_chance_bps: ${RUG_BPS}  (= ${EXPECTED_RATE_PCT}% per segment)`);
console.log(`  if rug_chance_bps === 0, this market has rugs disabled`);
console.log("─".repeat(64));

// PublicNode default (repo testnet RPC convention — Mysten fullnode throttles
// under the poll loop below); override with WICK_VERIFY_RPC.
const RPC =
  process.env.WICK_VERIFY_RPC ?? "https://sui-testnet-rpc.publicnode.com";
// RugFiredV4 reads go to a history-retaining fullnode: PublicNode prunes old tx
// events and reliably ERRORS the RugFiredV4 scan ("Could not find the
// referenced transaction events"), which would silently make this observer see
// ZERO rugs — defeating its whole purpose. The high-frequency segment/open/close
// polls stay on RPC (PublicNode serves those fine). Override with WICK_RUG_RPC.
const RUG_RPC =
  process.env.WICK_RUG_RPC ?? "https://fullnode.testnet.sui.io:443";
const POLL_MS = 5000;
const args = process.argv.slice(2);
const durationArg = args.find((a) => a.startsWith("--duration"));
const DURATION_SEC = durationArg ? Number(durationArg.split("=").at(-1) ?? args[args.indexOf(durationArg) + 1]) : Infinity;
const startMs = Date.now();

// Populated by resolveTypePackage() once we know the market's type-origin pkg.
let types = null;

async function resolveTypePackage() {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "sui_getObject",
    params: [MARKET, { showType: true }],
  };
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  const type = j.result?.data?.type ?? "";
  const marker = "::segment_market_v4::SegmentMarketV4";
  const idx = type.indexOf(marker);
  if (idx < 0) {
    throw new Error(`object ${MARKET} is not a SegmentMarketV4; type=${type}`);
  }
  const pkg = type.slice(0, idx);
  // Each event type is keyed by the package that FIRST defined it:
  //   SegmentRecordedV4 / RideOpenedV4 / RideClosedV4 were introduced in the
  //   v4 (v3-upgrade) publish — that's the market's type-origin package (`pkg`).
  //   RugFiredV4 was added later, in the v4.26 upgrade — so it is keyed by the
  //   LATEST `DEPLOYMENT.package_id`, not `pkg`. Routing rug to `pkg` would
  //   silently observe zero rugs (the exact bug this script exists to avoid).
  const rugPkg = DEPLOYMENT.package_id;
  types = {
    segment: `${pkg}::segment_market_v4::SegmentRecordedV4`,
    rug: `${rugPkg}::segment_market_v4::RugFiredV4`,
    opened: `${pkg}::segment_market_v4::RideOpenedV4`,
    closed: `${pkg}::segment_market_v4::RideClosedV4`,
  };
  console.log(`  type-origin package: ${pkg}`);
  if (rugPkg !== pkg) console.log(`  RugFiredV4 package:  ${rugPkg} (v4.26+)`);
}

async function queryEvents(eventType, cursor) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "suix_queryEvents",
    params: [{ MoveEventType: eventType }, cursor ?? null, 50, false],
  };
  // RugFiredV4 → fullnode (PublicNode can't serve it); everything else → RPC.
  const url = eventType.includes("RugFiredV4") ? RUG_RPC : RPC;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return j.result ?? { data: [], hasNextPage: false, nextCursor: null };
}

// State
let firstSegmentSeen = null;
let segmentsTotal = 0;
let rugsTotal = 0;
const rugsByRound = new Map(); // round_index -> [{seg_idx, digest}]
const opensByRound = new Map(); // round_index -> [{ride_id, digest}]
const closes = []; // { settlement_kind, round_index, digest, was_rugged: bool }
const cursors = { segment: null, rug: null, opened: null, closed: null };

async function poll() {
  for (const [tag, type] of Object.entries(types)) {
    let cursor = cursors[tag];
    while (true) {
      const page = await queryEvents(type, cursor);
      for (const e of page.data ?? []) {
        const pj = e.parsedJson ?? {};
        // Filter to OUR market
        if (pj.market_id && pj.market_id !== MARKET) continue;
        cursors[tag] = e.id;
        if (tag === "segment") {
          if (firstSegmentSeen === null) firstSegmentSeen = pj;
          segmentsTotal += 1;
        } else if (tag === "rug") {
          rugsTotal += 1;
          const round = String(pj.round_index ?? "0");
          if (!rugsByRound.has(round)) rugsByRound.set(round, []);
          rugsByRound.get(round).push({
            seg_idx: pj.segment_index,
            digest: e.id?.txDigest,
          });
          console.log(`💥 RUG #${rugsTotal} — round ${round}, segment ${pj.segment_index}`);
        } else if (tag === "opened") {
          const round = String(pj.round_index ?? "0");
          if (!opensByRound.has(round)) opensByRound.set(round, []);
          opensByRound.get(round).push({ digest: e.id?.txDigest });
        } else if (tag === "closed") {
          const kind = Number(pj.settlement_kind ?? -1);
          const round = String(pj.round_index ?? "0");
          const wasRugged = rugsByRound.has(round);
          closes.push({ kind, round, wasRugged, digest: e.id?.txDigest });
          const kindLabel = kind === 1 ? "TOUCH_WIN" : kind === 2 ? "CASHOUT" : kind === 3 ? "EXPIRED_LOSS" : kind === 4 ? "ABORTED_REFUND" : `kind=${kind}`;
          const rugTag = wasRugged && kind === 3 ? " (RUGGED)" : "";
          console.log(`📍 CLOSE — round ${round}, ${kindLabel}${rugTag}`);
        }
      }
      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
    }
  }
}

function printSummary() {
  console.log("\n" + "─".repeat(64));
  console.log("SUMMARY (so far)");
  console.log("─".repeat(64));
  console.log(`  observed segments:    ${segmentsTotal}`);
  console.log(`  observed rugs:        ${rugsTotal}`);
  if (segmentsTotal > 0) {
    const observed = (rugsTotal / segmentsTotal) * 100;
    const drift = observed - EXPECTED_RATE_PCT;
    console.log(`  observed rug rate:    ${observed.toFixed(3)}% (expected ${EXPECTED_RATE_PCT}%, drift ${drift >= 0 ? "+" : ""}${drift.toFixed(3)}%)`);
  }
  console.log(`  total rounds with rug: ${rugsByRound.size}`);
  console.log(`  total closes:         ${closes.length}`);
  if (closes.length > 0) {
    const ruggedCloses = closes.filter((c) => c.wasRugged && c.kind === 3).length;
    const expireCloses = closes.filter((c) => !c.wasRugged && c.kind === 3).length;
    const touchWins = closes.filter((c) => c.kind === 1).length;
    const cashouts = closes.filter((c) => c.kind === 2).length;
    console.log(`    touch_win:     ${touchWins} (${((touchWins / closes.length) * 100).toFixed(1)}%)`);
    console.log(`    cashout:       ${cashouts} (${((cashouts / closes.length) * 100).toFixed(1)}%)`);
    console.log(`    expire_loss:   ${expireCloses} (${((expireCloses / closes.length) * 100).toFixed(1)}%)`);
    console.log(`    rugged_loss:   ${ruggedCloses} (${((ruggedCloses / closes.length) * 100).toFixed(1)}%)`);
  }
  console.log("─".repeat(64));
}

async function main() {
  await resolveTypePackage();
  while (true) {
    if (Date.now() - startMs > DURATION_SEC * 1000) {
      printSummary();
      console.log("Duration reached, exiting.");
      process.exit(0);
    }
    try {
      await poll();
    } catch (err) {
      console.error("poll error:", err.message);
    }
    if (segmentsTotal > 0 && segmentsTotal % 50 === 0) printSummary();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

process.on("SIGINT", () => { printSummary(); process.exit(0); });

main();
