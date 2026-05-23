/**
 * gen-conformance — generative differential test generator (doc 17 §8).
 *
 * Proves wick::seeded_path::expand_segment (Move) is byte-identical to
 * @wick/sdk seededPath.ts expandSegment (TypeScript) across N vectors —
 * spine test 1: "the chart you watch is the price you settle against."
 *
 * WHY A ROLLING DIGEST (not embedded vectors): a Move package has a hard
 * total-bytecode cap (PACKAGE_ARENA_LIMIT). Embedding 10k vectors as Move
 * code — in any number of functions or modules — blows it. Instead, BOTH
 * sides DERIVE the N inputs deterministically from one shared 32-byte master
 * seed (via the already-proven blake2b keystream), run expand_segment, and
 * fold every output field into a rolling blake2b accumulator. The generated
 * Move test embeds only the master seed and one 32-byte digest per chunk —
 * so it is package-size-independent and scales to any N. A chunk digest
 * mismatch means Move and TS diverged somewhere in that chunk's CHUNK
 * vectors. derive_input / fold are built entirely on primitives already
 * proven byte-identical (keystream_word, blake2b256, BCS u64 = LE 8 bytes).
 *
 * Run:  npx tsx sdk/scripts/gen-conformance.ts   (npm run conformance -w @wick/sdk)
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2.js";
import {
  expandSegment,
  stateWith,
  keystreamWord,
  type WalkState,
} from "../src/seededPath.js";

// doc 17 Gate A bar: 10_000 vectors. Enough that the walk's rare branches —
// the 4% volatility-regime jump and the 7% fat-tail tick — are each exercised
// thousands of times, so a Move/TS divergence on an uncommon path cannot hide.
const N = 10_000;
// Vectors per #[test] function. 50 is the execution-budget-proven unit; one
// digest is embedded per chunk, and a failure localises to these 50 vectors.
const CHUNK = 50;

// Fixed 32-byte master seed — both Move and TS derive every input from it.
const MASTER_SEED = new TextEncoder().encode("wick:seeded_path:conformance/v1!");
// Per-chunk rolling-accumulator seed — fixed 32 zero bytes.
const ACC_INIT = new Uint8Array(32);

const hexOf = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** u64 -> 8 little-endian bytes (matches Move `bcs::to_bytes(&u64)`). */
function u64le(v: bigint): Uint8Array {
  const o = new Uint8Array(8);
  let x = v & 0xffffffffffffffffn;
  for (let k = 0; k < 8; k++) {
    o[k] = Number(x & 0xffn);
    x >>= 8n;
  }
  return o;
}

// ── Deterministic input derivation — must match Move `derive_input` ─────────
function deriveInput(i: number): { key: Uint8Array; state: WalkState } {
  const c = i * 8; // keystream counter base — 8 words reserved per vector
  // key = blake2b256(MASTER_SEED ‖ le8(c))
  const kin = new Uint8Array(MASTER_SEED.length + 8);
  kin.set(MASTER_SEED, 0);
  kin.set(u64le(BigInt(c)), MASTER_SEED.length);
  const key = blake2b(kin, { dkLen: 32 });

  const price = 50_000_000n + (keystreamWord(MASTER_SEED, c + 1) % 4_950_000_001n);
  const volRegime = 250_000n + (keystreamWord(MASTER_SEED, c + 2) % 3_350_001n);
  const homeMul = 700_000n + (keystreamWord(MASTER_SEED, c + 3) % 600_001n);
  const home = (price * homeMul) / 1_000_000n;
  const mcap = (price * 13_000n) / 1_000_000n;
  const momMag = keystreamWord(MASTER_SEED, c + 4) % (mcap + 1n);
  const momNeg = keystreamWord(MASTER_SEED, c + 5) % 2n === 1n;

  return { key, state: stateWith(price, momNeg, momMag, volRegime, home) };
}

// ── Output folding — must match Move `fold_outputs` ─────────────────────────
// Field order: 24 candle OHLC u64s, then (price, momNeg, momMag, volRegime,
// patternId, candlesRemaining, segMin, segMax). The two new FSM fields are
// emitted as u64 (matching Move u8 -> u64 cast in fold_outputs) so the
// digest is invariant under encoding width.
function fold(acc: Uint8Array, i: number): Uint8Array {
  const { key, state } = deriveInput(i);
  const r = expandSegment(state, key);
  const fields: bigint[] = [];
  for (const c of r.candles) fields.push(c.open, c.high, c.low, c.close);
  fields.push(r.newState.price);
  fields.push(r.newState.momentum.neg ? 1n : 0n);
  fields.push(r.newState.momentum.mag);
  fields.push(r.newState.volRegime);
  fields.push(r.newState.patternId);
  fields.push(r.newState.candlesRemaining);
  fields.push(r.min, r.max);

  const buf = new Uint8Array(32 + fields.length * 8);
  buf.set(acc, 0);
  for (let k = 0; k < fields.length; k++) buf.set(u64le(fields[k]!), 32 + k * 8);
  return blake2b(buf, { dkLen: 32 });
}

// ── Compute one digest per chunk ────────────────────────────────────────────
const chunkCount = Math.ceil(N / CHUNK);
const digests: string[] = [];
for (let ch = 0; ch < chunkCount; ch++) {
  const start = ch * CHUNK;
  const end = Math.min(start + CHUNK, N);
  let acc = ACC_INIT;
  for (let i = start; i < end; i++) acc = fold(acc, i);
  digests.push(hexOf(acc));
}

// ── Code-gen the Move test ──────────────────────────────────────────────────
let testFns = "";
for (let ch = 0; ch < chunkCount; ch++) {
  const start = ch * CHUNK;
  const count = Math.min(CHUNK, N - start);
  testFns +=
    `#[test] fun conformance_${String(ch).padStart(3, "0")}()` +
    ` { run_chunk(${start}, ${count}, x"${digests[ch]}") }\n`;
}

const move = `#[test_only]
module wick::seeded_path_conformance;

use wick::seeded_path::{Self, Candle, WalkState};
use sui::bcs;
use sui::hash::blake2b256;

// ───────────────────────────────────────────────────────────────────────────
//  AUTO-GENERATED — DO NOT EDIT BY HAND.
//  Source:  sdk/scripts/gen-conformance.ts
//  Regen:   npx tsx sdk/scripts/gen-conformance.ts   (npm run conformance -w @wick/sdk)
//
//  ${N} vectors, ${chunkCount} chunks of ${CHUNK} — doc 17 §8, spine test 1:
//  proof that Move seeded_path::expand_segment is byte-identical to the
//  TypeScript @wick/sdk seededPath.ts expandSegment.
//
//  Both sides derive every input deterministically from MASTER_SEED and fold
//  all outputs into a rolling blake2b digest; this test embeds only the seed
//  and one digest per chunk (package-size-independent — see the harness
//  header for why). A failing conformance_NNN means Move and TS diverged
//  within vectors [NNN*${CHUNK} .. NNN*${CHUNK}+${CHUNK}); the abort code is that start index.
// ───────────────────────────────────────────────────────────────────────────

const MASTER_SEED: vector<u8> = x"${hexOf(MASTER_SEED)}";
const ACC_INIT: vector<u8> = x"${hexOf(ACC_INIT)}";

/// Derive conformance input i. Must match deriveInput() in gen-conformance.ts.
fun derive_input(i: u64): (vector<u8>, u64, bool, u128, u64, u64) {
    let seed = MASTER_SEED;
    let c = i * 8;
    let price = 50_000_000 + (seeded_path::keystream_word(&seed, c + 1) % 4_950_000_001);
    let vr = 250_000 + (seeded_path::keystream_word(&seed, c + 2) % 3_350_001);
    let home_mul = 700_000 + (seeded_path::keystream_word(&seed, c + 3) % 600_001);
    let home = (((price as u128) * (home_mul as u128)) / 1_000_000) as u64;
    let mcap = ((price as u128) * 13_000) / 1_000_000;
    let mom_mag = (seeded_path::keystream_word(&seed, c + 4) as u128) % (mcap + 1);
    let mom_neg = seeded_path::keystream_word(&seed, c + 5) % 2 == 1;
    // key = blake2b256(MASTER_SEED ‖ le8(c)) — built last so \`seed\` can move in
    let mut kin = seed;
    vector::append(&mut kin, bcs::to_bytes(&c));
    let key = blake2b256(&kin);
    (key, price, mom_neg, mom_mag, vr, home)
}

/// Fold one segment's outputs into the rolling accumulator. Field order must
/// match fold() in gen-conformance.ts.
fun fold_outputs(
    acc: vector<u8>,
    candles: &vector<Candle>,
    new_st: &WalkState,
    smin: u64,
    smax: u64,
): vector<u8> {
    let mut buf = acc;
    let mut j = 0;
    while (j < 6) {
        let c = vector::borrow(candles, j);
        let o = seeded_path::candle_open(c);
        let h = seeded_path::candle_high(c);
        let l = seeded_path::candle_low(c);
        let cl = seeded_path::candle_close(c);
        vector::append(&mut buf, bcs::to_bytes(&o));
        vector::append(&mut buf, bcs::to_bytes(&h));
        vector::append(&mut buf, bcs::to_bytes(&l));
        vector::append(&mut buf, bcs::to_bytes(&cl));
        j = j + 1;
    };
    let p = seeded_path::state_price(new_st);
    let mn: u64 = if (seeded_path::state_momentum_neg(new_st)) 1 else 0;
    let mm: u64 = (seeded_path::state_momentum_mag(new_st) as u64);
    let vr = seeded_path::state_vol_regime(new_st);
    // FSM fields (u8 in Move, widened to u64 for the digest).
    let pid: u64 = (seeded_path::state_pattern_id(new_st) as u64);
    let cr:  u64 = (seeded_path::state_candles_remaining(new_st) as u64);
    vector::append(&mut buf, bcs::to_bytes(&p));
    vector::append(&mut buf, bcs::to_bytes(&mn));
    vector::append(&mut buf, bcs::to_bytes(&mm));
    vector::append(&mut buf, bcs::to_bytes(&vr));
    vector::append(&mut buf, bcs::to_bytes(&pid));
    vector::append(&mut buf, bcs::to_bytes(&cr));
    vector::append(&mut buf, bcs::to_bytes(&smin));
    vector::append(&mut buf, bcs::to_bytes(&smax));
    blake2b256(&buf)
}

/// Fold count vectors from start, assert the rolling digest matches.
fun run_chunk(start: u64, count: u64, expected: vector<u8>) {
    let mut acc = ACC_INIT;
    let mut i = 0;
    while (i < count) {
        let (key, price, mneg, mmag, vr, home) = derive_input(start + i);
        let st = seeded_path::state_with(price, mneg, mmag, vr, home);
        let (candles, new_st, smin, smax) = seeded_path::expand_segment(st, key);
        acc = fold_outputs(acc, &candles, &new_st, smin, smax);
        i = i + 1;
    };
    assert!(acc == expected, start);
}

${testFns}`;

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../../move/tests/seeded_path_conformance.move");
writeFileSync(outPath, move);
console.log(
  `gen-conformance: wrote ${N} vectors across ${chunkCount} chunks -> ${outPath}`,
);
