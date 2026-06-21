/**
 * subscribeRugFiredV4 archival-fallback regression.
 *
 * The repo's default testnet RPC (PublicNode) prunes old tx events and reliably
 * ERRORS the descending RugFiredV4 scan ("Could not find the referenced
 * transaction events"). Without a fallback the live MARKET HALT feed shows "no
 * rugs" forever even while rugs fire on-chain. The subscription must fall back
 * to an archival client when the primary throws.
 *
 *   npx tsx --test sdk/test/subscribeRugFiredV4Fallback.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { subscribeRugFiredV4 } from "../src/segmentMarketV4.js";

const PKG = "0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924";
const MARKET = "0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282";

function rugPage(marketId: string) {
  return {
    data: [
      {
        id: { txDigest: "DIGESTAAA", eventSeq: "0" },
        timestampMs: "1782060000000",
        parsedJson: { market_id: marketId, round_index: "6", segment_index: "458" },
      },
    ],
    hasNextPage: false,
    nextCursor: null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("falls back to the archival client when the primary queryEvents throws (the live PublicNode case)", async () => {
  let primaryCalls = 0;
  let archivalCalls = 0;
  const primary = {
    queryEvents: async () => {
      primaryCalls++;
      throw new Error("Could not find the referenced transaction events [TransactionDigest(...)]");
    },
  } as never;
  const archivalClient = {
    queryEvents: async () => {
      archivalCalls++;
      return rugPage(MARKET);
    },
  } as never;

  const seen: string[] = [];
  const unsub = subscribeRugFiredV4(
    primary,
    MARKET,
    PKG,
    (e) => seen.push(e.digest),
    { pollIntervalMs: 10_000, archivalClient },
  );
  await sleep(60);
  unsub();

  assert.ok(primaryCalls >= 1, "primary should be tried first");
  assert.ok(archivalCalls >= 1, "archival should be hit after the primary throws");
  assert.deepEqual(seen, ["DIGESTAAA"], "the rug from the archival client must reach the callback");
});

test("uses ONLY the primary when it succeeds (no needless archival hit)", async () => {
  let archivalCalls = 0;
  const primary = { queryEvents: async () => rugPage(MARKET) } as never;
  const archivalClient = {
    queryEvents: async () => {
      archivalCalls++;
      return rugPage(MARKET);
    },
  } as never;

  const seen: string[] = [];
  const unsub = subscribeRugFiredV4(primary, MARKET, PKG, (e) => seen.push(e.digest), {
    pollIntervalMs: 10_000,
    archivalClient,
  });
  await sleep(60);
  unsub();

  assert.equal(archivalCalls, 0, "archival must not be touched when the primary works");
  assert.deepEqual(seen, ["DIGESTAAA"]);
});

test("archivalRpcUrl:null disables the fallback (primary error degrades gracefully, no throw)", async () => {
  const primary = {
    queryEvents: async () => {
      throw new Error("boom");
    },
  } as never;
  const seen: string[] = [];
  // Must not throw out of the polling loop even with no fallback.
  const unsub = subscribeRugFiredV4(primary, MARKET, PKG, (e) => seen.push(e.digest), {
    pollIntervalMs: 10_000,
    archivalRpcUrl: null,
  });
  await sleep(40);
  unsub();
  assert.deepEqual(seen, [], "no events, but no crash");
});

test("filters to the subscribed market (archival page with another market yields nothing)", async () => {
  const primary = {
    queryEvents: async () => {
      throw new Error("pruned");
    },
  } as never;
  const archivalClient = { queryEvents: async () => rugPage("0xOTHERMARKET") } as never;
  const seen: string[] = [];
  const unsub = subscribeRugFiredV4(primary, MARKET, PKG, (e) => seen.push(e.digest), {
    pollIntervalMs: 10_000,
    archivalClient,
  });
  await sleep(60);
  unsub();
  assert.deepEqual(seen, [], "a rug for a different market must be filtered out");
});
