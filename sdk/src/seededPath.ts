/**
 * seededPath — the deterministic, provably-fair price walk for the arcade.
 *
 * BYTE-IDENTICAL TypeScript twin of `wick::seeded_path` (Move). Same
 * fixed-point contract; `expandSegment` here MUST equal `expand_segment`
 * there for every input. `move/tests/seeded_path_conformance.move` is the
 * generative differential test that proves it (doc 17 §8, spine test 1).
 * Design: docs/design/v2/17_provably_fair_arcade.md.
 *
 * Three consumers, one definition: the frontend chart renders from this,
 * `/verify` replays on-chain keys through this, and `record_segment` runs the
 * Move twin. All magnitudes are `bigint` — JS `number` cannot hold the u128
 * intermediates (doc 17 §7, A3).
 */
import { blake2b } from "@noble/hashes/blake2.js";

// ── Fixed-point scales (must match seeded_path.move) ────────────────────────
const ONE = 1_000_000n;
const HALF = 500_000n;
const DRAW_DEN = 1_000_000n;
const E18 = 1_000_000_000_000_000_000n;
const MIN_PRICE = 1n;

export const CANDLES_PER_SEGMENT = 6;
export const TICKS_PER_CANDLE = 6;
export const DRAWS_PER_TICK = 7;

// ── Walk coefficients — round(c * 1e6) of the useRideGesture float walk ─────
const VR_MIN = 250_000n;
const VR_MAX = 3_600_000n;
const C_VR_JITTER = 300_000n;
const C_VR_JUMP_PROB = 40_000n;
const C_VR_JUMP = 3_000_000n;
const C_VR_REVERT = 45_000n;
const C_MOM_JITTER = 2_600n;
const C_MOM_DECAY = 820_000n;
const C_MOM_CAP = 13_000n;
const C_REVERT = 7_000n;
const C_VOL = 6_000n;
const VOL_FLOOR = 400_000n;
const C_FAT_PROB = 70_000n;
const C_FAT_BASE = 2_500_000n;
const C_MAX_DELTA = 60_000n;

// ── Types ───────────────────────────────────────────────────────────────────

/** Sign-magnitude integer. `mag === 0n` is canonically non-negative. */
export interface Signed {
  readonly neg: boolean;
  readonly mag: bigint;
}

/** One OHLC candle, prices in micro-USD. */
export interface Candle {
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
}

/** Walk state carried across segments. */
export interface WalkState {
  price: bigint;
  momentum: Signed;
  volRegime: bigint;
  home: bigint;
}

/** Result of expanding one segment. */
export interface SegmentResult {
  candles: Candle[];
  newState: WalkState;
  min: bigint;
  max: bigint;
}

// ── Signed arithmetic ───────────────────────────────────────────────────────

export const sZero = (): Signed => ({ neg: false, mag: 0n });

/** Canonical constructor: zero is always non-negative. */
export const sNew = (neg: boolean, mag: bigint): Signed => ({
  neg: neg && mag !== 0n,
  mag,
});

const sPos = (mag: bigint): Signed => ({ neg: false, mag });

/** a + b */
export function sAdd(a: Signed, b: Signed): Signed {
  if (a.neg === b.neg) return sNew(a.neg, a.mag + b.mag);
  if (a.mag >= b.mag) return sNew(a.neg, a.mag - b.mag);
  return sNew(b.neg, b.mag - a.mag);
}

/** a - b */
export const sSub = (a: Signed, b: Signed): Signed =>
  sAdd(a, sNew(!b.neg, b.mag));

/** (a.mag * mul / div) carrying a's sign. */
export const sMulDiv = (a: Signed, mul: bigint, div: bigint): Signed =>
  sNew(a.neg, (a.mag * mul) / div);

/** Clamp |a| to at most maxMag. */
export const sClampMag = (a: Signed, maxMag: bigint): Signed =>
  a.mag > maxMag ? sNew(a.neg, maxMag) : a;

/** price + delta, floored at MIN_PRICE — never underflows. */
function sApply(price: bigint, delta: Signed): bigint {
  if (!delta.neg) return price + delta.mag;
  const d = delta.mag;
  if (d >= price) return MIN_PRICE;
  const r = price - d;
  return r < MIN_PRICE ? MIN_PRICE : r;
}

/** A draw d in [0,1e6) recentred to the signed value d - 0.5 (scale 1e6). */
const centered = (d: bigint): Signed =>
  d >= HALF ? sPos(d - HALF) : sNew(true, HALF - d);

/** Clamp a Signed into [lo,hi] (a negative value -> lo). */
function clampToU64(s: Signed, lo: bigint, hi: bigint): bigint {
  if (s.neg) return lo;
  const m = s.mag;
  return m < lo ? lo : m > hi ? hi : m;
}

// ── Entropy layer ───────────────────────────────────────────────────────────

/** BCS-style 8-byte little-endian encoding of a u64 counter. */
function le8(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * One 64-bit keystream word — blake2b256(key ‖ le8(n)), low 8 bytes read
 * little-endian. Deterministic expansion of the on-chain `segment_key` into
 * an unbounded uniform stream. Returns a bigint in [0, 2^64).
 */
export function keystreamWord(key: Uint8Array, n: number): bigint {
  const input = new Uint8Array(key.length + 8);
  input.set(key, 0);
  input.set(le8(n), key.length);
  const digest = blake2b(input, { dkLen: 32 });
  let word = 0n;
  for (let i = 0; i < 8; i++) {
    word |= BigInt(digest[i]!) << BigInt(8 * i);
  }
  return word;
}

/** A uniform draw in [0, 1_000_000). */
export const draw = (key: Uint8Array, n: number): bigint =>
  keystreamWord(key, n) % DRAW_DEN;

// ── The walk ────────────────────────────────────────────────────────────────

/**
 * One walk step — folds a single sub-price into the path. Mutates
 * price / momentum / volRegime in `st`. `base` is the keystream counter of
 * this step's first draw; a step always consumes exactly 7 draws.
 *
 * Verbatim transcription of `useRideGesture.nextPrice()`.
 */
function step(st: WalkState, key: Uint8Array, base: number): void {
  const d0 = draw(key, base);
  const d1 = draw(key, base + 1);
  const d2 = draw(key, base + 2);
  const d3 = draw(key, base + 3);
  const d4 = draw(key, base + 4);
  const d5 = draw(key, base + 5);
  const d6 = draw(key, base + 6);

  // 1 ── Volatility regime — clusters quiet vs wild stretches
  let vr = sPos(st.volRegime);
  vr = sAdd(vr, sMulDiv(centered(d0), C_VR_JITTER, ONE)); // +-0.30
  if (d1 < C_VR_JUMP_PROB) {
    vr = sAdd(vr, sMulDiv(centered(d2), C_VR_JUMP, ONE)); // rare jump
  }
  const toOne = sSub(sPos(ONE), vr); // (1 - vr)
  vr = sAdd(vr, sMulDiv(toOne, C_VR_REVERT, ONE)); // revert
  st.volRegime = clampToU64(vr, VR_MIN, VR_MAX);

  const price = st.price;
  const vrU = st.volRegime;

  // 2 ── Momentum — a trend term, regime-scaled, fast-decaying
  const cj = centered(d3);
  const jitter = sNew(cj.neg, (cj.mag * price * C_MOM_JITTER * vrU) / E18);
  let mom = sAdd(st.momentum, jitter);
  mom = sMulDiv(mom, C_MOM_DECAY, ONE); // decay 0.82
  const mcap = (price * C_MOM_CAP) / ONE; // +- price*0.013
  st.momentum = sClampMag(mom, mcap);

  // 3 ── Per-tick delta = momentum + revert + fat-tailed noise
  const revert = sMulDiv(sSub(sPos(st.home), sPos(price)), C_REVERT, ONE);
  let vol = (price * C_VOL) / ONE; // price * 0.006
  if (vol < VOL_FLOOR) vol = VOL_FLOOR;
  vol = (vol * vrU) / ONE; // * volRegime
  if (d4 < C_FAT_PROB) {
    const fat = C_FAT_BASE + (d5 * C_FAT_BASE) / ONE; // 2.5 + d5*2.5
    vol = (vol * fat) / ONE;
  }
  const noise = sMulDiv(centered(d6), vol, ONE); // (d6 - 0.5) * vol
  let delta = sAdd(sAdd(st.momentum, revert), noise);
  delta = sClampMag(delta, (price * C_MAX_DELTA) / ONE); // +- price*0.06
  st.price = sApply(st.price, delta);
}

/**
 * Expand one segment: 6 candles from the carried walk state and a 32-byte
 * segment_key. PURE and deterministic — the cross-language conformance
 * contract with Move `expand_segment`. The input `state` is not mutated.
 */
export function expandSegment(state: WalkState, key: Uint8Array): SegmentResult {
  const st: WalkState = {
    price: state.price,
    momentum: { neg: state.momentum.neg, mag: state.momentum.mag },
    volRegime: state.volRegime,
    home: state.home,
  };
  const candles: Candle[] = [];
  let segMin = st.price;
  let segMax = st.price;
  for (let ci = 0; ci < CANDLES_PER_SEGMENT; ci++) {
    const open = st.price;
    let high = open;
    let low = open;
    for (let ti = 0; ti < TICKS_PER_CANDLE; ti++) {
      const base = (ci * TICKS_PER_CANDLE + ti) * DRAWS_PER_TICK;
      step(st, key, base);
      if (st.price > high) high = st.price;
      if (st.price < low) low = st.price;
    }
    candles.push({ open, high, low, close: st.price });
    if (low < segMin) segMin = low;
    if (high > segMax) segMax = high;
  }
  return { candles, newState: st, min: segMin, max: segMax };
}

// ── Constructors mirroring the Move API ─────────────────────────────────────

/** A fresh walk state with zero momentum. */
export const newState = (
  price: bigint,
  volRegime: bigint,
  home: bigint,
): WalkState => ({ price, momentum: sZero(), volRegime, home });

/** Build a WalkState with an explicit momentum — used by the conformance test. */
export const stateWith = (
  price: bigint,
  momNeg: boolean,
  momMag: bigint,
  volRegime: bigint,
  home: bigint,
): WalkState => ({ price, momentum: sNew(momNeg, momMag), volRegime, home });
