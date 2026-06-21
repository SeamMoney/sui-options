/**
 * Headless playable round — the "is the project alive?" harness.
 *
 *   npx tsx sim/play-round.ts        (or: npm run play)
 *
 * Generates a market, commits its path, runs a lobby→live→settle round with a
 * couple of synthetic traders (open in the lobby, one sells to close mid-live),
 * settles against the revealed path, and prints the whole timeline + the player
 * vs house tally. No UI — this is the spine everything else wraps.
 */
import { RoundEngine, type MarketConfig } from "../src/engine";
import { realizedPnl } from "../src/option";
import type { RoundConfig } from "../src/round";

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const px = (n: number) => `$${n.toFixed(2)}`;

const market: MarketConfig = {
  id: "volatile-1",
  label: "Volatile",
  startPrice: 100,
  sigmaAnnual: 0.9,
  driftAnnual: 0,
  rugChanceBps: 80,
  rugDownPct: 0.05,
};

const round: RoundConfig = { startedAtMs: 0, lobbyMs: 60_000, liveMs: 90_000, settleMs: 5_000 };

// `--seed <n>` replays a SPECIFIC round deterministically (e.g. the seed the
// engine revealed at settle for a round you played) — same market, same clock,
// so the candles + commit reproduce exactly. Default is the showcase seed.
const seedArgIdx = process.argv.indexOf("--seed");
const seedArg = seedArgIdx >= 0 ? Number(process.argv[seedArgIdx + 1]) : 424242;
const seed = Number.isFinite(seedArg) ? seedArg : 424242;

const engine = new RoundEngine({
  market,
  round,
  seed,
  steps: 90,
  stepMs: 1000,
  spreadBps: 150, // 1.5% vig
  // Accelerated clock: a 90s live reveal feels like ~2 trading months of action.
  yearsPerSecond: 0.002,
});

console.log(`\n  ${market.label} market — round committed`);
console.log(`  commit: ${engine.commit}   (seed sealed until settle)\n`);

const liveStart = round.lobbyMs;

// ── Lobby: two traders study the desk and open positions ───────────────────
const lobbyAt = 30_000;
console.log(`  [lobby  t=${(lobbyAt / 1000).toFixed(0)}s]  spot ${px(engine.spotAt(lobbyAt))}`);

const alice = engine.open({ id: "alice", side: "call", strike: 101, expiryMs: liveStart + 40_000, contracts: 10, nowMs: lobbyAt });
console.log(`    alice  BUY  10x CALL 101  exp t+${((alice.expiryMs - liveStart) / 1000).toFixed(0)}s   premium ${usd(alice.premiumPaid)}`);

const bob = engine.open({ id: "bob", side: "put", strike: 99, expiryMs: liveStart + 70_000, contracts: 10, nowMs: lobbyAt });
console.log(`    bob    BUY  10x PUT  99   exp t+${((bob.expiryMs - liveStart) / 1000).toFixed(0)}s   premium ${usd(bob.premiumPaid)}\n`);

// ── Live: reveal the path; alice manages, bob holds ────────────────────────
console.log(`  live reveal ──`);
for (let s = 0; s <= 90; s += 15) {
  const now = liveStart + s * 1000;
  engine.settleExpired(now);
  const aliveMark = engine.getPositions().find((p) => p.id === "alice");
  const tag = aliveMark?.status === "open" ? `alice mark ${usd(engine.quote("call", 101, alice.expiryMs, now).premium * alice.contracts)}` : `alice ${aliveMark?.status}`;
  console.log(`    t+${String(s).padStart(2)}s  spot ${px(engine.spotAt(now))}   ${tag}`);

  // Alice bails at t+25s (Sell to close) — the cash-out, in options language.
  if (s === 30 && engine.getPositions().find((p) => p.id === "alice")?.status === "open") {
    const sold = engine.sellToClose("alice", now);
    if (sold) console.log(`    >>> alice SELL TO CLOSE  proceeds ${usd(sold.proceeds ?? 0)}  (P&L ${usd(realizedPnl(sold))})`);
  }
}

// ── Settle: sweep anything still open, reveal, tally ───────────────────────
engine.settleAll();
const reveal = engine.reveal();
console.log(`\n  settle — seed revealed: ${reveal.seed}   commit verified: ${reveal.verified ? "✓" : "✗"}\n`);

console.log(`  results`);
for (const p of engine.getPositions()) {
  console.log(`    ${p.id.padEnd(6)} ${p.status.padEnd(18)} paid ${usd(p.premiumPaid).padStart(9)}  got ${usd(p.proceeds ?? 0).padStart(9)}  P&L ${usd(realizedPnl(p))}`);
}
console.log(`\n  players net ${usd(engine.playerPnl())}    house ${usd(engine.housePnl())}\n`);

// The verification triple — re-hash these yourself to confirm the path was fixed
// before the bet (no frontend needed; this closes the commit-reveal loop CLI-only).
console.log(`  ── verify this round (the path was committed before the reveal) ──`);
console.log(`    commit     : ${engine.commit}`);
console.log(`    seed       : ${reveal.seed}`);
console.log(`    paramsJson : ${reveal.paramsJson}`);
console.log(`    re-hash it : SHA-256("<seed>:<paramsJson>") must equal commit. Confirm it any way you like —`);
console.log(`                 paste the three values into scripts/verify-pro.html (client-side, offline),`);
console.log(`                 POST them to /api/verify-pro, or call the SDK's verifyProRound(commit, seed, paramsJson).\n`);
