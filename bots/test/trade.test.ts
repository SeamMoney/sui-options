/**
 * Unit suite for the bot fleet's pure decision logic — market eligibility,
 * personality side-selection, and trade sizing. These run on every tick to
 * drive organic on-chain activity; the network calls around them are mocked
 * out here so the pure rules are pinned without a live RPC.
 *
 *   npx tsx --test bots/test/trade.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MarketSnapshot } from "@wick/sdk";
import { tradableMarkets, defaultCollateralType, sizeTrade } from "../src/trade.js";
import { personalityFor, PERSONALITIES } from "../src/personalities.js";
import type { BotsConfig } from "../src/config.js";

const NOW = 1_800_000_000_000;

function market(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    id: "0xmkt",
    asset: "BTC",
    direction: "ABOVE",
    barrier: 100,
    expiryMs: NOW + 600_000, // 10 min out by default
    status: "ACTIVE",
    fee_bps: 30,
    collateralVault: 200_000,
    touchSupply: 0,
    noTouchSupply: 0,
    touchReserve: 200_000,
    noTouchReserve: 200_000,
    lpSupply: 200_000,
    underlyingPrice: 95,
    collateralType: defaultCollateralType(),
    ...over,
  };
}

const cfg: BotsConfig = {
  riskMistMin: 30_000n,
  riskMistMax: 120_000n,
} as BotsConfig;

// ── tradableMarkets ──────────────────────────────────────────────────────────

test("tradableMarkets keeps ACTIVE, far-from-expiry, SUI-collateral markets", () => {
  const m = market();
  assert.deepEqual(tradableMarkets([m], NOW), [m]);
});

test("tradableMarkets drops settled, near-expiry, and non-SUI markets", () => {
  const settled = market({ id: "0xa", status: "HIT" });
  const expiringSoon = market({ id: "0xb", expiryMs: NOW + 10_000 }); // < 30s buffer
  const otherCollateral = market({ id: "0xc", collateralType: "0xdead::usdc::USDC" });
  const ok = market({ id: "0xd" });
  const kept = tradableMarkets([settled, expiringSoon, otherCollateral, ok], NOW);
  assert.deepEqual(
    kept.map((m) => m.id),
    ["0xd"],
    "only the clean ACTIVE/SUI/far-expiry market survives",
  );
});

test("tradableMarkets honours the 30s expiry buffer at the boundary", () => {
  const justInside = market({ id: "0xin", expiryMs: NOW + 30_001 }); // > buffer → kept
  const justOutside = market({ id: "0xout", expiryMs: NOW + 30_000 }); // == buffer → dropped
  const kept = tradableMarkets([justInside, justOutside], NOW).map((m) => m.id);
  assert.deepEqual(kept, ["0xin"]);
});

// ── personalities ────────────────────────────────────────────────────────────

test("personalityFor resolves each known name and throws otherwise", () => {
  for (const p of PERSONALITIES) {
    assert.equal(personalityFor(p.name).name, p.name);
  }
  // @ts-expect-error — exercising the runtime guard with a bad name.
  assert.throws(() => personalityFor("wizard"), /unknown personality/);
});

test("bull always buys TOUCH, bear always buys NO_TOUCH", () => {
  const m = market();
  assert.equal(personalityFor("bull").pickSide(m), "TOUCH");
  assert.equal(personalityFor("bear").pickSide(m), "NO_TOUCH");
});

test("contrarian fades the scarcer reserve (cheaper = popular side)", () => {
  const c = personalityFor("contrarian");
  // touchReserve < noTouchReserve → TOUCH is the popular/expensive side → fade to NO_TOUCH.
  assert.equal(c.pickSide(market({ touchReserve: 50_000, noTouchReserve: 200_000 })), "NO_TOUCH");
  // noTouchReserve < touchReserve → fade to TOUCH.
  assert.equal(c.pickSide(market({ touchReserve: 200_000, noTouchReserve: 50_000 })), "TOUCH");
});

// ── sizeTrade ────────────────────────────────────────────────────────────────

test("sizeTrade stays within the clamped [min, max] band over many draws", () => {
  // minReserve 200k → 5% = 10k, 25% = 50k. cfg floor 30k, cap 120k.
  // lo = max(30k, 10k) = 30k ; hi = min(120k, 50k) = 50k.
  const m = market({ touchReserve: 200_000, noTouchReserve: 200_000 });
  for (let i = 0; i < 200; i++) {
    const r = sizeTrade(m, cfg);
    assert.ok(r >= 30_000n, `size ${r} below floor`);
    assert.ok(r <= 50_000n, `size ${r} above 25%-of-reserve cap`);
  }
});

test("sizeTrade never returns below the configured risk floor on a tiny market", () => {
  // Tiny reserves → 5%/25% are minuscule, so the configured floor must win.
  const tiny = market({ touchReserve: 100, noTouchReserve: 100 });
  for (let i = 0; i < 50; i++) {
    assert.ok(sizeTrade(tiny, cfg) >= cfg.riskMistMin, "floor must hold on tiny reserves");
  }
});
