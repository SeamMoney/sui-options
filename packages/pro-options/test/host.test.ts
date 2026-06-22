import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MARKET_PRESETS,
  RoundEngine,
  RoundHost,
  presetById,
  roundConfigFromPreset,
  type HostEvent,
} from "../src/index";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("pro-options host + presets");

check("presets exist and build a valid engine", () => {
  assert.ok(MARKET_PRESETS.length >= 4);
  const preset = presetById("volatile");
  assert.ok(preset, "volatile preset");
  const cfg = roundConfigFromPreset({ preset: preset!, seed: 7, startedAtMs: 0 });
  const engine = new RoundEngine(cfg);
  assert.ok(engine.commit.length > 0);
  assert.equal(engine.spotAt(0), preset!.startPrice); // lobby shows the open
});

check("host drives a full round and emits the phase/reveal/settle/seed events", () => {
  const preset = presetById("volatile")!;
  const engine = new RoundEngine(roundConfigFromPreset({ preset, seed: 7, startedAtMs: 0 }));
  const host = new RoundHost(engine);
  const events: HostEvent[] = [];
  host.on((e) => events.push(e));

  // Open a position in the lobby so we get a settled event later.
  const liveStart = 60_000;
  engine.open({ id: "p1", side: "call", strike: 101, expiryMs: liveStart + 40_000, contracts: 5, nowMs: 1_000 });

  for (let t = 0; t <= 160_000; t += 2_000) host.tick(t);

  const phases = events.filter((e) => e.type === "phase").map((e) => (e as { phase: string }).phase);
  assert.deepEqual([...new Set(phases)], ["lobby", "live", "settle", "results"]);

  const reveals = events.filter((e) => e.type === "reveal-step");
  assert.ok(reveals.length > 1, "reveal should advance during live");

  const settled = events.filter((e) => e.type === "settled");
  assert.ok(settled.length >= 1, "the open position should settle");

  const seed = events.find((e) => e.type === "reveal-seed") as
    | { verified: boolean; seed: number; commit: string; paramsJson: string }
    | undefined;
  assert.ok(seed?.verified, "seed reveal should verify against the commit");
  // The reveal event must carry the full preimage so the UI can show a player
  // the three values needed to independently re-hash their round.
  assert.match(seed!.commit, /^[0-9a-f]{64}$/, "reveal-seed should emit the 64-hex SHA-256 commit");
  assert.equal(typeof seed!.paramsJson, "string", "reveal-seed should emit the revealed paramsJson");
  const independent = createHash("sha256").update(`${seed!.seed}:${seed!.paramsJson}`).digest("hex");
  assert.equal(independent, seed!.commit, "the emitted seed+params must hash to the emitted commit");
});

check("engine.livePnl at expiry equals realized playerPnl (live == settlement)", () => {
  const preset = presetById("volatile")!;
  const cfg = roundConfigFromPreset({ preset, seed: 7, startedAtMs: 0 });
  const engine = new RoundEngine(cfg);

  // Open a couple of positions during the round.
  const liveStart = cfg.round.lobbyMs;
  const expiry = liveStart + cfg.round.liveMs; // expire at end of live
  engine.open({ id: "c1", side: "call", strike: preset.startPrice * 1.01, expiryMs: expiry, contracts: 3, nowMs: 1_000 });
  engine.open({ id: "p1", side: "put", strike: preset.startPrice * 0.99, expiryMs: expiry, contracts: 2, nowMs: 1_000 });

  // The live readout at the expiry instant must equal what settlement realizes.
  const expiryNow = expiry;
  const live = engine.livePnl(expiryNow);
  engine.settleAll();
  const realized = engine.playerPnl();
  assert.ok(
    Math.abs(live - realized) < 1e-9,
    `livePnl(${live}) != playerPnl(${realized}) at expiry`,
  );
  assert.ok(engine.premiumAtRisk() > 0, "premium denominator should be positive");
});

check("livePnl freezes an expired-but-unsettled position at its expiry spot (live == settlement in the unsettled window)", () => {
  const preset = presetById("volatile")!;
  const cfg = roundConfigFromPreset({ preset, seed: 7, startedAtMs: 0 });
  const engine = new RoundEngine(cfg);

  const liveStart = cfg.round.lobbyMs;
  // Expire MID-round so the price path keeps moving past the position's expiry.
  const expiry = liveStart + Math.floor(cfg.round.liveMs / 2);
  // Deep-ITM call: intrinsic tracks spot, so any mark-to-now drift is unmistakable.
  engine.open({ id: "mid", side: "call", strike: preset.startPrice * 0.5, expiryMs: expiry, contracts: 2, nowMs: 1_000 });

  // Precondition: the spot genuinely moves between expiry and a later in-round tick.
  const laterMs = expiry + Math.floor(cfg.round.liveMs / 4);
  assert.notEqual(engine.spotAt(expiry), engine.spotAt(laterMs), "precondition: spot must move after expiry");

  // The headline at the expiry instant, then again later while the position is
  // STILL OPEN (the rAF settle tick lags the 200ms headline refresh). It must
  // stay FROZEN at the expiry value — settlement pays intrinsic at spotAt(expiry),
  // so marking to the later moved spot would make the headline lie.
  const atExpiry = engine.livePnl(expiry);
  const pastExpiry = engine.livePnl(laterMs); // not settled yet
  assert.ok(
    Math.abs(pastExpiry - atExpiry) < 1e-9,
    `livePnl drifted after expiry: ${atExpiry} -> ${pastExpiry} (must freeze at the expiry spot)`,
  );

  // And it equals what settlement actually realizes.
  engine.settleAll();
  assert.ok(
    Math.abs(pastExpiry - engine.playerPnl()) < 1e-9,
    `post-expiry livePnl(${pastExpiry}) != realized playerPnl(${engine.playerPnl()})`,
  );
});

check("reveal() exposes the preimage so a THIRD PARTY can verify the commit", () => {
  const preset = presetById("trending")!;
  const cfg = roundConfigFromPreset({ preset, seed: 42, startedAtMs: 0 });
  const engine = new RoundEngine(cfg);

  const published = engine.commit; // published before the lobby
  const r = engine.reveal(); // preimage revealed at settle

  // The fairness guarantee is that the reveal carries the FULL preimage, not
  // just the engine's own boolean — anyone can recompute SHA-256 and bind it.
  assert.equal(r.seed, 42);
  assert.equal(typeof r.paramsJson, "string");
  assert.equal(r.commit, published);
  assert.ok(r.verified, "engine self-check must pass");

  // INDEPENDENT recomputation — must not call any pro-options code.
  const independent = createHash("sha256").update(`${r.seed}:${r.paramsJson}`).digest("hex");
  assert.equal(independent, published, "independent SHA-256 must equal the published commit");

  // Binding: the wrong seed must not reproduce the commit.
  const tampered = createHash("sha256").update(`${r.seed + 1}:${r.paramsJson}`).digest("hex");
  assert.notEqual(tampered, published, "a tampered seed must not reproduce the commit");
});

check("host.on returns a working unsubscribe", () => {
  const preset = presetById("calm")!;
  const host = new RoundHost(new RoundEngine(roundConfigFromPreset({ preset, seed: 1, startedAtMs: 0 })));
  let count = 0;
  const off = host.on(() => count++);
  host.tick(1_000);
  const afterFirst = count;
  assert.ok(afterFirst >= 1, "should receive at least one event");
  off();
  host.tick(70_000);
  assert.equal(count, afterFirst, "no events after unsubscribe");
});

console.log(`\n${passed} checks passed`);
