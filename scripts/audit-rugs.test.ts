/**
 * Unit tests for the pure classification core of `scripts/audit-rugs.ts`
 * (`npm run check:rugs`). The audit's value is its verdict logic — that it
 * catches a FAKED halt, a halt SUPPRESSED late, a round SUPPRESSED entirely,
 * and accepts only a halt that landed on the first qualifying segment. The
 * network I/O around it is exercised live by `check:rugs`; this locks the
 * decision table in CI so a refactor can't silently weaken the house-edge proof.
 *
 * Run: `npx tsx --test scripts/audit-rugs.test.ts`
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyRound,
  firstQualifyingSegment,
  readMarket,
  readSegmentKey,
  type RugVerdict,
  type MarketInfo,
} from "./audit-rugs.js";
import { rollRugFired } from "./rugRoll.js";

function kind(chainRug: bigint | null, firstQ: bigint | null, rollAtRug = 0n): RugVerdict {
  return classifyRound(chainRug, firstQ, rollAtRug, 150n).kind;
}

// ── Read-path coverage for `firstQualifyingSegment` ─────────────────────────
// Previously only `classifyRound` (the pure verdict) was tested; the read +
// roll-derivation that FEEDS it was live-only. This locks "returns the FIRST
// segment in index order whose deterministic rug roll fires" with a mock client,
// real keccak roll math, and real on-chain keys (so it also guards the #334
// batched scan from a first-fire-ordering regression).
const RUG_MARKET = "0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282";
function keyBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
// Real seg-458 key: fires at round 6 (roll 78 < 150). Verified live on-chain.
const FIRING = keyBytes("0x9d3ecd317edd3f7349fcafd749d8d95ddb26f4ec1e5c6513baa6fff32d80bf95");
// An arbitrary key that does NOT fire at round 6 (asserted below before use).
const QUIET = keyBytes("0x" + "ab".repeat(32));

const MARKET: MarketInfo = {
  marketId: RUG_MARKET,
  typePackage: "0xabc",
  segmentsTableId: "0xtable",
  roundDurationSegments: 75n,
  nextSegmentIndex: 1000n,
  rugChanceBps: 150n,
};

/** Mock ResilientClient: getDynamicFieldObject(k) → the key at index k (or none). */
function mockClient(keyByK: Map<number, Uint8Array>): never {
  return {
    getDynamicFieldObject: async (a: { name: { value: string } }) => {
      const k = Number(a.name.value);
      const key = keyByK.get(k);
      if (!key) return { data: null };
      return {
        data: {
          content: { fields: { value: { fields: { key: Array.from(key) } } } },
        },
      };
    },
  } as never;
}

test("firstQualifyingSegment: the chosen QUIET key really does not fire at round 6", () => {
  assert.equal(rollRugFired(QUIET, RUG_MARKET, 6n, 150n).fired, false);
  assert.equal(rollRugFired(FIRING, RUG_MARKET, 6n, 150n).fired, true);
});

test("firstQualifyingSegment returns the FIRST firing segment in index order", async () => {
  // 450,451 quiet · 452 fires · 453 fires → must return 452 (the first), not 453.
  const m = new Map<number, Uint8Array>([
    [450, QUIET], [451, QUIET], [452, FIRING], [453, FIRING],
  ]);
  const got = await firstQualifyingSegment(mockClient(m), MARKET, 6n, 450n, 454n);
  assert.equal(got, 452n);
});

test("firstQualifyingSegment returns null when no segment fires (clean round)", async () => {
  const m = new Map<number, Uint8Array>([[450, QUIET], [451, QUIET], [452, QUIET]]);
  const got = await firstQualifyingSegment(mockClient(m), MARKET, 6n, 450n, 453n);
  assert.equal(got, null);
});

test("firstQualifyingSegment skips missing segments (null reads) without false-firing", async () => {
  // 450 missing, 451 quiet, 452 fires → 452.
  const m = new Map<number, Uint8Array>([[451, QUIET], [452, FIRING]]);
  const got = await firstQualifyingSegment(mockClient(m), MARKET, 6n, 450n, 453n);
  assert.equal(got, 452n);
});

test("HONEST — chain halted at exactly the first qualifying segment", () => {
  const v = classifyRound(458n, 458n, 78n, 150n);
  assert.equal(v.kind, "honest-halt");
  assert.equal(v.honest, true);
  assert.match(v.status, /✓ HONEST/);
});

test("FAKED — chain halted but no segment qualified", () => {
  // The chain claims a halt @ 100, but the dice never rolled in (firstQ null).
  const v = classifyRound(100n, null, 9000n, 150n);
  assert.equal(v.kind, "faked");
  assert.equal(v.honest, false);
  assert.match(v.status, /FAKED/);
});

test("SUPPRESSED (late) — an earlier segment qualified; chain halted later", () => {
  // First qualifier was 440, but the chain only halted @ 458 — it skipped 440,
  // keeping a ride alive past a rug it owed.
  const v = classifyRound(458n, 440n, 78n, 150n);
  assert.equal(v.kind, "suppressed-late");
  assert.equal(v.honest, false);
  assert.match(v.status, /SUPPRESSED/);
});

test("SUPPRESSED (full) — a segment qualified but the chain fired NO halt", () => {
  // The round should have halted @ 30, but the chain emitted no RugFiredV4.
  const v = classifyRound(null, 30n, 0n, 150n);
  assert.equal(v.kind, "suppressed-full");
  assert.equal(v.honest, false);
  assert.match(v.status, /SUPPRESSED/);
});

test("CLEAN — no segment qualified and the chain correctly didn't halt", () => {
  const v = classifyRound(null, null, 0n, 150n);
  assert.equal(v.kind, "clean");
  assert.equal(v.honest, true);
});

test("only honest-halt and clean are accepted as honest", () => {
  // Decision-table sweep: every (chainRug, firstQ) combination.
  assert.equal(classifyRound(5n, 5n, 1n, 150n).honest, true);   // halted at first qualifier
  assert.equal(classifyRound(5n, 3n, 1n, 150n).honest, false);  // earlier qualifier skipped
  assert.equal(classifyRound(5n, null, 1n, 150n).honest, false); // halted with no qualifier
  assert.equal(classifyRound(null, 5n, 0n, 150n).honest, false); // qualifier but no halt
  assert.equal(classifyRound(null, null, 0n, 150n).honest, true); // clean
});

test("the 7 real rounds on the rugged TUSD market all classify HONEST", () => {
  // (round → rugged segment) as emitted on-chain; each is its own first
  // qualifier, so every one is an honest halt. Locks the live-validated result.
  const live: Array<[bigint, bigint]> = [
    [0n, 35n], [1n, 88n], [2n, 211n], [3n, 240n], [4n, 362n], [5n, 447n], [6n, 458n],
  ];
  for (const [round, seg] of live) {
    assert.equal(kind(seg, seg), "honest-halt", `round ${round} should be honest`);
  }
});


// ── readMarket / readSegmentKey parsers ─────────────────────────────────────
// readMarket's rug_chance_bps parse is load-bearing: a wrong parse reads 0 →
// "rug not enabled" → check:rugs silently audits NOTHING and PASSes vacuously.
// Lock it (and the key parse) offline so a Move structure rename can't make the
// house-edge proof a no-op without CI noticing.
const MKT4_TYPE = "0xpkg::segment_market_v4::SegmentMarketV4<0x2::sui::SUI>";
function marketMock(fields: Record<string, unknown>, rugBps?: number): never {
  return {
    getObject: async () => ({ data: { content: { type: MKT4_TYPE, fields } } }),
    getDynamicFieldObject: async () =>
      rugBps === undefined
        ? { data: null }
        : { data: { content: { fields: { value: { fields: { rug_chance_bps: String(rugBps) } } } } } },
  } as never;
}
const MKT_FIELDS = {
  segments: { fields: { id: { id: "0xTBL" } } },
  round_duration_segments: "75", next_segment_index: "4021",
};

test("readMarket: parses tableId, round length, and the rug_chance threshold", async () => {
  const m = await readMarket(marketMock(MKT_FIELDS, 150), "0xmkt");
  assert.equal(m.typePackage, "0xpkg");
  assert.equal(m.segmentsTableId, "0xTBL");
  assert.equal(m.roundDurationSegments, 75n);
  assert.equal(m.nextSegmentIndex, 4021n);
  assert.equal(m.rugChanceBps, 150n);
});

test("readMarket: rug-config absent → rugChanceBps 0 (rug disabled), not a throw", async () => {
  const m = await readMarket(marketMock(MKT_FIELDS), "0xmkt");
  assert.equal(m.rugChanceBps, 0n);
});

test("readMarket: rejects a non-SegmentMarketV4 object", async () => {
  const wrongType = {
    getObject: async () => ({ data: { content: { type: "0x2::coin::Coin<0x2::sui::SUI>", fields: {} } } }),
    getDynamicFieldObject: async () => ({ data: null }),
  } as never;
  await assert.rejects(() => readMarket(wrongType, "0xmkt"));
});

function keyMock(key: number[] | undefined): never {
  return {
    getDynamicFieldObject: async () =>
      key === undefined
        ? { data: null }
        : { data: { content: { fields: { value: { fields: { key } } } } } },
  } as never;
}

test("readSegmentKey: parses the 32-byte key", async () => {
  const bytes = Array.from({ length: 32 }, (_, i) => i);
  const got = await readSegmentKey(keyMock(bytes), "0xt", 5n);
  assert.deepEqual(Array.from(got!), bytes);
});

test("readSegmentKey: missing segment → null", async () => {
  assert.equal(await readSegmentKey(keyMock(undefined), "0xt", 5n), null);
});
