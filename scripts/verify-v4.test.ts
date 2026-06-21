/**
 * Offline proof that the v4 provable-fairness CLI verifier is honest:
 *   - the synthetic (untampered) v4 market + ride PASSes (exit 0),
 *   - a single tampered segment extremum flips it to FAIL (exit 1),
 *   - the failure pinpoints the tampered segment.
 *
 * Black-box (spawns the real CLI) so it covers arg-parsing, the synthetic
 * client, the seeded-path replay, the touch predicate and the settlement
 * mirror in one shot. No network. Run with:
 *   npx tsx --test scripts/verify-v4.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  rollRugFires,
  deriveSettlementKind,
  SETTLEMENT_TOUCH_WIN,
  SETTLEMENT_CASHOUT,
  SETTLEMENT_EXPIRED_LOSS,
  type RideInfo,
} from "./verify-v4.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "verify-v4.ts");

function run(rpc: string): { code: number; out: string } {
  const r = spawnSync(
    "npx",
    ["tsx", cli, "--rpc", rpc, "--ride", "0xmock"],
    { encoding: "utf8", cwd: join(here, "..") },
  );
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

test("synthetic v4 ride PASSes verification (exit 0)", () => {
  const { code, out } = run("mock://synthetic-v4");
  assert.match(out, /extrema replay:\s+match \(every segment\)/);
  assert.match(out, /off-chain verdict: CASHOUT/);
  assert.match(out, /on-chain verdict:\s+CASHOUT/);
  assert.match(out, /PASS — the chain was honest\./);
  assert.equal(code, 0, "honest synthetic must exit 0");
});

test("a tampered extremum FAILs verification (exit 1) and is pinpointed", () => {
  const { code, out } = run("mock://tamper-v4");
  assert.match(out, /extrema replay:\s+MISMATCH/);
  assert.match(out, /FAIL — the chain lied\./);
  // The tamper is on segment k=5: its integ column must read FAIL.
  assert.match(out, /^\s*5\b.*\bFAIL\s*$/m, "segment 5 should be flagged FAIL");
  assert.equal(code, 1, "a dishonest house must exit non-zero");
});

// ── v4.26 rug-roll determinism (mirror of Move roll_rug) ────────────────────

const KEY = new Uint8Array(32).map((_v, i) => (i * 13 + 7) % 251);
const MKT = new Uint8Array(32).map((_v, i) => (i * 5 + 1) % 251);

test("rollRugFires is deterministic and threshold-monotonic", () => {
  // chance 0 → never fires; chance 10000 → always fires.
  assert.equal(rollRugFires(KEY, MKT, 6n, 0n), false, "0 bps never fires");
  assert.equal(rollRugFires(KEY, MKT, 6n, 10_000n), true, "10000 bps always fires");
  // deterministic for fixed (key, market, round).
  assert.equal(
    rollRugFires(KEY, MKT, 6n, 150n),
    rollRugFires(KEY, MKT, 6n, 150n),
    "same inputs → same roll",
  );
  // the round is part of the preimage → a different round can flip the roll.
  const a = rollRugFires(KEY, MKT, 6n, 5_000n);
  const b = rollRugFires(KEY, MKT, 7n, 5_000n);
  assert.equal(typeof a, "boolean");
  assert.equal(typeof b, "boolean");
});

// ── settlement precedence (mirror of decide_settlement) ─────────────────────

function ride(roundIndex: bigint, entry: bigint): RideInfo {
  return {
    entrySegmentIndex: entry,
    roundIndex,
    upperBarrier: 0n,
    lowerBarrier: 0n,
    closed: true,
    closedAtMs: 0n,
    settlementKind: 0,
  };
}

test("rug routing wins over a touch (real ride 0x7b3… shape)", () => {
  // entry 457, rug @ 458, closed @ next=459 → caught, even if touched.
  const k = deriveSettlementKind(/*rugApplies*/ true, /*touched*/ true, 459n, ride(6n, 457n), 75n);
  assert.equal(k, SETTLEMENT_EXPIRED_LOSS);
});

test("touch wins when the rug does not apply (real ride 0xf52f… shape)", () => {
  // touched & closed before the rug fired → rugApplies false → TOUCH_WIN.
  const k = deriveSettlementKind(false, true, 440n, ride(5n, 439n), 75n);
  assert.equal(k, SETTLEMENT_TOUCH_WIN);
});

test("no rug, no touch, mid-round → CASHOUT (real ride 0x0f2e… shape)", () => {
  // entry 459 entered after the rug → rugApplies false; no touch; 459 < 525.
  const k = deriveSettlementKind(false, false, 459n, ride(6n, 459n), 75n);
  assert.equal(k, SETTLEMENT_CASHOUT);
});

test("no rug, no touch, round ended → EXPIRED_LOSS", () => {
  const k = deriveSettlementKind(false, false, 525n, ride(6n, 460n), 75n);
  assert.equal(k, SETTLEMENT_EXPIRED_LOSS);
});
