/**
 * gen-conformance — generative differential test generator (doc 17 §8).
 *
 * Generates N reproducible random (key, WalkState) inputs, runs the TS
 * `expandSegment`, and code-gens `move/tests/seeded_path_conformance.move` —
 * a Move test that runs the Move `expand_segment` on the SAME inputs and
 * asserts byte-identical outputs. This is spine test 1: proof that the chart
 * the player watches is the price the chain settles against.
 *
 * Run:  npx tsx sdk/scripts/gen-conformance.ts   (or: npm run conformance -w @wick/sdk)
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expandSegment, stateWith } from "../src/seededPath.js";

// doc 17 Gate A requires 10_000+. 500 keeps the generated file fast to compile
// for the in-CI conformance run; raise N for the Gate A milestone.
const N = 500;

// Move caps a single function's bytecode at 65535 bytes, so the vectors are
// split across many small #[test] functions that each call a shared `check`.
const CHUNK = 50;

// ── Reproducible PRNG (mulberry32) — the harness's OWN entropy, distinct from
//    the walk. A fixed seed makes the vector set fully deterministic. ────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0x5eedf00d);
const randInt = (lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));
const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

interface Vec {
  keyHex: string;
  inputs: bigint[]; // [price, momNeg, momMag, volRegime, home]
  outputs: bigint[]; // 6*OHLC, newPrice, newMomNeg, newMomMag, newVolRegime, segMin, segMax
}

function genVector(): Vec {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = randInt(0, 255);

  const price = BigInt(randInt(50_000_000, 5_000_000_000)); // $50 .. $5000
  const volRegime = BigInt(randInt(250_000, 3_600_000));
  const home = BigInt(
    Math.max(1, Math.floor(Number(price) * (0.7 + rng() * 0.6))), // +-30%
  );
  // momentum within its realistic clamp: +- price * 0.013
  const mcap = (price * 13_000n) / 1_000_000n;
  const momMag = mcap > 0n ? BigInt(randInt(0, Number(mcap))) : 0n;
  const momNeg = rng() < 0.5;

  const r = expandSegment(stateWith(price, momNeg, momMag, volRegime, home), key);
  const outputs: bigint[] = [];
  for (const c of r.candles) outputs.push(c.open, c.high, c.low, c.close);
  outputs.push(r.newState.price);
  outputs.push(r.newState.momentum.neg ? 1n : 0n);
  outputs.push(r.newState.momentum.mag);
  outputs.push(r.newState.volRegime);
  outputs.push(r.min, r.max);

  return {
    keyHex: toHex(key),
    inputs: [price, momNeg ? 1n : 0n, momMag, volRegime, home],
    outputs,
  };
}

const vecs: Vec[] = [];
for (let i = 0; i < N; i++) vecs.push(genVector());

// ── Code-gen the Move test ──────────────────────────────────────────────────
let testFns = "";
const chunkCount = Math.ceil(N / CHUNK);
for (let c = 0; c < chunkCount; c++) {
  const start = c * CHUNK;
  const end = Math.min(start + CHUNK, N);
  let body = "";
  for (let i = start; i < end; i++) {
    const v = vecs[i]!;
    body +=
      `    check(x"${v.keyHex}", vector[${v.inputs.join(", ")}]` +
      `, vector[${v.outputs.join(", ")}], ${i});\n`;
  }
  testFns += `
#[test]
fun conformance_${String(c).padStart(3, "0")}() {
${body}}
`;
}

const move = `#[test_only]
module wick::seeded_path_conformance;

use wick::seeded_path;

// ───────────────────────────────────────────────────────────────────────────
//  AUTO-GENERATED — DO NOT EDIT BY HAND.
//  Source:  sdk/scripts/gen-conformance.ts
//  Regen:   npx tsx sdk/scripts/gen-conformance.ts   (npm run conformance -w @wick/sdk)
//
//  ${N} vectors. Proves wick::seeded_path::expand_segment is byte-identical to
//  the TypeScript @wick/sdk seededPath.ts expandSegment — doc 17 §8, the first
//  of the two provable-fairness spine tests. Vectors are split across
//  ${chunkCount} test functions (Move caps a function's bytecode at 64 KiB).
//  An abort code decodes as vector_index * 100 + field_index.
// ───────────────────────────────────────────────────────────────────────────

/// Run one conformance vector: expand the segment in Move, assert every
/// output field equals the TypeScript reference.
fun check(key: vector<u8>, inp: vector<u64>, exp: vector<u64>, vid: u64) {
    let st = seeded_path::state_with(
        *vector::borrow(&inp, 0),
        *vector::borrow(&inp, 1) == 1,
        (*vector::borrow(&inp, 2) as u128),
        *vector::borrow(&inp, 3),
        *vector::borrow(&inp, 4),
    );
    let (candles, new_st, smin, smax) = seeded_path::expand_segment(st, key);
    let mut j = 0;
    while (j < 6) {
        let c = vector::borrow(&candles, j);
        let b = j * 4;
        assert!(seeded_path::candle_open(c)  == *vector::borrow(&exp, b),     vid * 100 + b);
        assert!(seeded_path::candle_high(c)  == *vector::borrow(&exp, b + 1), vid * 100 + b + 1);
        assert!(seeded_path::candle_low(c)   == *vector::borrow(&exp, b + 2), vid * 100 + b + 2);
        assert!(seeded_path::candle_close(c) == *vector::borrow(&exp, b + 3), vid * 100 + b + 3);
        j = j + 1;
    };
    assert!(seeded_path::state_price(&new_st) == *vector::borrow(&exp, 24), vid * 100 + 90);
    let mom_neg: u64 = if (seeded_path::state_momentum_neg(&new_st)) 1 else 0;
    assert!(mom_neg == *vector::borrow(&exp, 25), vid * 100 + 91);
    assert!((seeded_path::state_momentum_mag(&new_st) as u64) == *vector::borrow(&exp, 26), vid * 100 + 92);
    assert!(seeded_path::state_vol_regime(&new_st) == *vector::borrow(&exp, 27), vid * 100 + 93);
    assert!(smin == *vector::borrow(&exp, 28), vid * 100 + 94);
    assert!(smax == *vector::borrow(&exp, 29), vid * 100 + 95);
}
${testFns}`;

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../move/tests/seeded_path_conformance.move");
writeFileSync(outPath, move);
console.log(
  `gen-conformance: wrote ${N} vectors across ${chunkCount} test functions -> ${outPath}`,
);
