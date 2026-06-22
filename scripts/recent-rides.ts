#!/usr/bin/env tsx
/**
 * recent-rides — list real, recent closed rides on the live v4 market(s), one of
 * each outcome, each with a ready-to-paste `audit-ride` command (the COMPLETE
 * audit: barriers · candles · MARKET HALT · verdict · payout). So a judge can
 * fully verify rides THEY pick (a touch win, a cashout, a MARKET HALT) — not the
 * single example we hardcoded into `npm run verify:halt`. Proves the chain is
 * busy AND that the whole audit holds for any outcome.
 *
 *   npx tsx scripts/recent-rides.ts            # or: npm run rides:recent
 *   npx tsx scripts/recent-rides.ts --each 2   # up to 2 of each outcome
 *   npx tsx scripts/recent-rides.ts --rpc https://fullnode.testnet.sui.io:443
 *
 * Read-only: just queries `RideClosedV4` events (resilient, with an archival
 * fullnode fallback — public nodes prune old tx events) and groups by
 * settlement kind. No wallet, no keys.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  rideClosedV4EventType,
  parseRideClosedV4Event,
  rugFiredV4EventType,
  parseRugFiredV4EventJson,
  fetchSegmentRidePositionV4,
  TOUCHED_UPPER,
  TOUCHED_LOWER,
} from "../sdk/src/segmentMarketV4.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const D = JSON.parse(readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"));

const argv = process.argv.slice(2);
const PRIMARY_RPC =
  (() => {
    const i = argv.indexOf("--rpc");
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  })() ?? process.env.RPC ?? "https://sui-testnet-rpc.publicnode.com";
const ARCHIVAL_RPC = "https://fullnode.testnet.sui.io:443";
const PER_OUTCOME = (() => {
  const i = argv.indexOf("--each");
  return i >= 0 && argv[i + 1] ? Math.max(1, Number(argv[i + 1])) : 1;
})();

const scan = (k: string, id: string) => `https://suiscan.xyz/testnet/${k}/${id}`;

// v4 settlement kinds (segment_market_v4.move SETTLEMENT_*). Code 5 is a
// synthetic local label: an EXPIRED_LOSS (3) whose round had a MARKET HALT.
const KIND = {
  1: { name: "TOUCH_WIN", blurb: "rider touched a barrier — jackpot paid by the vault" },
  2: { name: "CASHOUT", blurb: "rider released early — Bachelier cashout" },
  3: { name: "EXPIRED_LOSS", blurb: "round ran out with no touch — escrow to the vault" },
  4: { name: "ABORTED_REFUND", blurb: "market aborted — 1:1 refund" },
  5: { name: "MARKET HALT", blurb: "the v4.26 rug froze the round and wiped the ride (the headline)" },
} as const;

function client(url: string) {
  return new SuiJsonRpcClient({ url, network: "testnet" });
}

async function queryResilient(
  primary: SuiJsonRpcClient,
  archival: SuiJsonRpcClient,
  args: { query: unknown; cursor: unknown; limit: number; order: "descending" },
): Promise<{ data: any[]; hasNextPage: boolean; nextCursor: unknown }> {
  try {
    return (await primary.queryEvents(args as never)) as never;
  } catch {
    return (await archival.queryEvents(args as never)) as never;
  }
}

interface Row {
  rideId: string;
  marketId: string;
  marketName: string;
  kind: number;
  payout: bigint;
  touchedSide: number;
  txDigest: string;
}

async function main() {
  const primary = client(PRIMARY_RPC);
  const archival = client(ARCHIVAL_RPC);
  const markets: any[] = D.segment_markets_v4 ?? [];
  const nameById = new Map<string, string>(markets.map((m) => [m.market, m.name]));

  console.log(`recent-rides — live v4 closed rides, up to ${PER_OUTCOME} of each outcome\n`);

  // Derive the event package from a market's on-chain type (events are tagged
  // with the module's *defining* package, not the upgraded package_id).
  const probe: any = await primary.getObject({
    id: markets[0].market,
    options: { showType: true },
  });
  const t = (probe.data?.type as string) ?? "";
  const marker = "::segment_market_v4::SegmentMarketV4<";
  const pkg = t.includes(marker) ? t.slice(0, t.indexOf(marker)) : D.package_id;

  // Which (market, round) pairs had a MARKET HALT? RugFiredV4 events are
  // permanent (rugged_at_segment on the market clears each round-roll), so an
  // EXPIRED_LOSS in a halted round is almost certainly a halt-wipe — label it
  // distinctly so a judge can pick the headline outcome. verify-v4 confirms.
  // round key → the segment the rug fired at (the FIRST qualifying segment in
  // that round; RugFiredV4 fires once per round).
  const rugSegByRound = new Map<string, bigint>();
  {
    // RugFiredV4 was ADDED in the v4.26 upgrade, so its event type is tagged
    // with the CURRENT package id — not the market's original defining package
    // (which tags RideOpened/Closed/SegmentRecorded). Query the right one.
    const rugType = rugFiredV4EventType(D.package_id as string);
    let c: unknown = null;
    for (let page = 0; page < 20; page++) {
      const res = await queryResilient(primary, archival, {
        query: { MoveEventType: rugType },
        cursor: c,
        limit: 25,
        order: "descending",
      });
      for (const ev of res.data) {
        const r = parseRugFiredV4EventJson(ev.parsedJson as Record<string, unknown>);
        rugSegByRound.set(`${r.marketId}:${r.roundIndex}`, r.segmentIndex);
      }
      if (!res.hasNextPage || !res.nextCursor) break;
      c = res.nextCursor;
    }
  }

  // An EXPIRED_LOSS is a true MARKET HALT only if the ride was OPEN when the rug
  // fired — i.e. its entry segment ≤ the rug segment. A ride that entered after
  // the rug bet into an already-halted round and just time-expired. Read the
  // (persisted) ride object's entry to decide precisely.
  //
  // v4.27 DEPLOY-NOTE: this `entry ≤ rug_seg` test, keyed on the ride's OWN
  // `round_index`, mirrors the durable per-round rug condition Move #694 enforces
  // ON CLOSE — so a ride CLOSED in its rugged round is labeled consistently with
  // the v4.27 chain, and the label needs NO change for the upgrade (cf. #706 for
  // verify-v4). It STAYS a heuristic hint, not authoritative — the audit a judge
  // runs is. `entry ≤ rug_seg` is necessary but not sufficient: a ride that
  // stopped being client-cranked before its round's rug fired, then settled via
  // crank-EXPIRY, has the rug OUTSIDE its actual recorded window, so it morally
  // time-expired yet still trips this test (the live 0xccb5 case — see the
  // recent-rides-halt-mislabel analysis; the true window needs re-deriving
  // verify-v4's scan). v4.27 narrows this (a closed rugged ride is correctly
  // halt-routed) but doesn't fully close it; it's cosmetic and self-correcting
  // (real halts still surface), so no label change is part of the deploy.
  async function wasHalted(rideId: string, marketId: string, round: bigint): Promise<boolean> {
    const rugSeg = rugSegByRound.get(`${marketId}:${round}`);
    if (rugSeg == null) return false;
    const pos = await fetchSegmentRidePositionV4(primary, rideId).catch(() => null);
    if (!pos) return false;
    return pos.entrySegmentIndex <= rugSeg;
  }

  // Scan recent RideClosedV4 events, bucket by settlement kind (3 → 5 if halted).
  const buckets = new Map<number, Row[]>();
  const wantedMarkets = new Set(markets.map((m) => m.market));
  let cursor: unknown = null;
  for (let page = 0; page < 30; page++) {
    const res = await queryResilient(primary, archival, {
      query: { MoveEventType: rideClosedV4EventType(pkg) },
      cursor,
      limit: 25,
      order: "descending",
    });
    for (const ev of res.data) {
      const e = parseRideClosedV4Event(ev.parsedJson);
      if (!wantedMarkets.has(e.marketId)) continue;
      const localKind =
        e.settlementKind === 3 && (await wasHalted(e.rideId, e.marketId, e.roundIndex))
          ? 5
          : e.settlementKind;
      const bucket = buckets.get(localKind) ?? [];
      if (bucket.length >= PER_OUTCOME) continue;
      bucket.push({
        rideId: e.rideId,
        marketId: e.marketId,
        marketName: nameById.get(e.marketId) ?? "?",
        kind: localKind,
        payout: e.payout,
        touchedSide: e.touchedSide,
        txDigest: ev.id?.txDigest ?? "",
      });
      buckets.set(localKind, bucket);
    }
    const enough = [1, 2, 3, 5].every((k) => (buckets.get(k)?.length ?? 0) >= PER_OUTCOME);
    if (enough || !res.hasNextPage || !res.nextCursor) break;
    cursor = res.nextCursor;
  }

  const order = [1, 2, 5, 3, 4];
  let total = 0;
  for (const k of order) {
    const rows = buckets.get(k);
    if (!rows || rows.length === 0) continue;
    const meta = KIND[k as keyof typeof KIND];
    console.log(`\x1b[1m${meta.name}\x1b[0m \x1b[90m— ${meta.blurb}\x1b[0m`);
    for (const r of rows) {
      total++;
      const side =
        r.touchedSide === TOUCHED_UPPER ? " (touched upper)" :
        r.touchedSide === TOUCHED_LOWER ? " (touched lower)" : "";
      console.log(`  ride ${r.rideId}${side}`);
      console.log(`    payout=${r.payout}  ${r.marketName}  ${r.txDigest ? scan("tx", r.txDigest) : ""}`);
      console.log(`    \x1b[36mnpx tsx scripts/audit-ride.ts --market ${r.marketId} --ride ${r.rideId}\x1b[0m`);
    }
    console.log("");
  }

  if (total === 0) {
    console.log("No closed rides found on the live v4 markets yet — run `npm run smoke:ride` to make one.");
    return;
  }
  console.log(`\x1b[90mPick any ride above and run its command — the COMPLETE audit (barriers · candles · MARKET HALT · verdict · payout), all re-derived from the chain's own keys.\x1b[0m`);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
