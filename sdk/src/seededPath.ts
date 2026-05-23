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

// ── Pattern FSM (doc 17 §15.2 — must match seeded_path.move byte-for-byte) ──
export const PATTERN_NONE = 0;
export const PATTERN_DOJI = 1;
export const PATTERN_HAMMER = 2;
export const PATTERN_SHOOTING_STAR = 3;
export const PATTERN_BULLISH_ENGULFING = 4;
export const PATTERN_BEARISH_ENGULFING = 5;
export const PATTERN_THREE_WHITE_SOLDIERS = 6;

const FSM_ENTRY_PROB = 50_000n;     // 5% per NORMAL candle

const W_DOJI = 30n;
const W_HAMMER = 20n;
const W_SHOOTING_STAR = 20n;
const W_BULLISH_ENGULFING = 15n;
const W_BEARISH_ENGULFING = 10n;
// W_THREE_WHITE_SOLDIERS = 5 (tail of the rarity distribution)
const W_TOTAL = 100n;

const FSM_BASE = 100_000;
const FSM_STRIDE = 16;
const SHAPER_BASE = 200_000;
const SHAPER_STRIDE = 32;

const C_U = 5_000n;             // 0.005 * price * vr
const U_FLOOR = 400_000n;       // $0.40
const MOM_LEGACY_U_MUL = 250_000n;   // 0.25 * U

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

/**
 * Walk state carried across segments — checkpointed by `record_segment`.
 *
 * `patternId` + `candlesRemaining` encode the pattern FSM (doc 17 §15.2):
 * `patternId === PATTERN_NONE` is NORMAL; any other value (1..6) is
 * FORMING{patternId} with `candlesRemaining` shaped candles still to come.
 * Move stores these as `u8`; here they are `bigint` so the conformance fold
 * is uniform — all carried state is one `bigint` array.
 */
export interface WalkState {
  price: bigint;
  momentum: Signed;
  volRegime: bigint;
  home: bigint;
  patternId: bigint;
  candlesRemaining: bigint;
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

// ── Pattern FSM + shapers (doc 17 §15.2–§15.3) ──────────────────────────────
//
// Mirror of seeded_path.move — FSM transitions, the rarity-weighted draw and
// the six hero shapers. Every magnitude here lives in the disjoint keystream
// ranges `FSM_BASE` / `SHAPER_BASE` so the entropy budgets never collide
// with `step()`'s tick draws.

/** Per-candle unit scale `U = max(price * 0.005 * vr, $0.40)` (micro-USD). */
function unitU(price: bigint, vr: bigint): bigint {
  const raw = (price * C_U * vr) / (ONE * ONE);
  return raw < U_FLOOR ? U_FLOOR : raw;
}

/** A draw in [lo, hi] from one keystream word. */
function rngRange(key: Uint8Array, idx: number, lo: bigint, hi: bigint): bigint {
  const span = hi - lo + 1n;
  return lo + (keystreamWord(key, idx) % span);
}

/** Map a rarity-weighted pick (in [0, W_TOTAL)) to (patternId, candleCount). */
function patternFromWeight(pick: bigint): { pid: bigint; n: bigint } {
  let acc = W_DOJI;
  if (pick < acc) return { pid: BigInt(PATTERN_DOJI), n: 1n };
  acc += W_HAMMER;
  if (pick < acc) return { pid: BigInt(PATTERN_HAMMER), n: 1n };
  acc += W_SHOOTING_STAR;
  if (pick < acc) return { pid: BigInt(PATTERN_SHOOTING_STAR), n: 1n };
  acc += W_BULLISH_ENGULFING;
  if (pick < acc) return { pid: BigInt(PATTERN_BULLISH_ENGULFING), n: 2n };
  acc += W_BEARISH_ENGULFING;
  if (pick < acc) return { pid: BigInt(PATTERN_BEARISH_ENGULFING), n: 2n };
  return { pid: BigInt(PATTERN_THREE_WHITE_SOLDIERS), n: 3n };
}

/** In NORMAL, possibly arm the FSM for the next candle. */
function fsmMaybeArm(st: WalkState, key: Uint8Array, ci: number): void {
  const arm = draw(key, FSM_BASE + ci * FSM_STRIDE);
  if (arm >= FSM_ENTRY_PROB) return;
  const pick = draw(key, FSM_BASE + ci * FSM_STRIDE + 1) % W_TOTAL;
  const { pid, n } = patternFromWeight(pick);
  st.patternId = pid;
  st.candlesRemaining = n;
}

/** Total candles a pattern produces — agrees with `patternFromWeight`. */
function patternTotalCandles(pid: bigint): bigint {
  if (pid === BigInt(PATTERN_DOJI)) return 1n;
  if (pid === BigInt(PATTERN_HAMMER)) return 1n;
  if (pid === BigInt(PATTERN_SHOOTING_STAR)) return 1n;
  if (pid === BigInt(PATTERN_BULLISH_ENGULFING)) return 2n;
  if (pid === BigInt(PATTERN_BEARISH_ENGULFING)) return 2n;
  return 3n; // PATTERN_THREE_WHITE_SOLDIERS
}

/** Build a Candle from open/close and wick magnitudes. */
function ohlc(open: bigint, close: bigint, lowerWick: bigint, upperWick: bigint): Candle {
  const bodyLo = open < close ? open : close;
  const bodyHi = open > close ? open : close;
  const low = lowerWick >= bodyLo ? MIN_PRICE : bodyLo - lowerWick;
  const high = bodyHi + upperWick;
  return { open, high, low, close };
}

/** Apply a signed delta to price, floored at MIN_PRICE. */
const addSigned = (p: bigint, delta: Signed): bigint => sApply(p, delta);

// ── Hero shapers — byte-identical mirrors of seeded_path.move ──────────────

function shapeDoji(st: WalkState, key: Uint8Array, sbase: number): Candle {
  const u = unitU(st.price, st.volRegime);
  const open = st.price;
  const body = rngRange(key, sbase, (u * 5n) / 100n, (u * 20n) / 100n);
  const dirUp = (draw(key, sbase + 1) & 1n) === 0n;
  const wickLo = rngRange(key, sbase + 2, (u * 30n) / 100n, (u * 80n) / 100n);
  const wickHi = rngRange(key, sbase + 3, (u * 30n) / 100n, (u * 80n) / 100n);
  const delta = sNew(!dirUp, body);
  const close = addSigned(open, delta);
  st.momentum = sZero();
  st.price = close;
  return ohlc(open, close, wickLo, wickHi);
}

function shapeHammer(st: WalkState, key: Uint8Array, sbase: number): Candle {
  const u = unitU(st.price, st.volRegime);
  const open = st.price;
  const body = rngRange(key, sbase, (u * 30n) / 100n, (u * 80n) / 100n);
  const wickLo = rngRange(key, sbase + 1, (body * 250n) / 100n, (body * 400n) / 100n);
  const wickHi = rngRange(key, sbase + 2, 0n, (body * 15n) / 100n);
  const close = addSigned(open, sPos(body));
  st.momentum = sPos((u * MOM_LEGACY_U_MUL) / ONE);
  st.price = close;
  return ohlc(open, close, wickLo, wickHi);
}

function shapeShootingStar(st: WalkState, key: Uint8Array, sbase: number): Candle {
  const u = unitU(st.price, st.volRegime);
  const open = st.price;
  const body = rngRange(key, sbase, (u * 30n) / 100n, (u * 80n) / 100n);
  const wickHi = rngRange(key, sbase + 1, (body * 250n) / 100n, (body * 400n) / 100n);
  const wickLo = rngRange(key, sbase + 2, 0n, (body * 15n) / 100n);
  const close = addSigned(open, sNew(true, body));
  st.momentum = sNew(true, (u * MOM_LEGACY_U_MUL) / ONE);
  st.price = close;
  return ohlc(open, close, wickLo, wickHi);
}

function shapeBullishEngulfing(
  st: WalkState,
  key: Uint8Array,
  sbase: number,
  stepIdx: bigint,
): Candle {
  const u = unitU(st.price, st.volRegime);
  if (stepIdx === 0n) {
    const open = st.price;
    const body1 = rngRange(key, sbase, (u * 30n) / 100n, (u * 80n) / 100n);
    const wickLo = rngRange(key, sbase + 1, 0n, (u * 30n) / 100n);
    const wickHi = rngRange(key, sbase + 2, 0n, (u * 30n) / 100n);
    const close = addSigned(open, sNew(true, body1));
    st.price = close;
    return ohlc(open, close, wickLo, wickHi);
  }
  // stepIdx === 1n
  const open = st.price;
  const body1 = rngRange(key, sbase - SHAPER_STRIDE, (u * 30n) / 100n, (u * 80n) / 100n);
  const body2 = rngRange(
    key,
    sbase,
    body1 + (u * 50n) / 100n,
    body1 + (u * 250n) / 100n,
  );
  const wickLo = rngRange(key, sbase + 1, 0n, (u * 30n) / 100n);
  const wickHi = rngRange(key, sbase + 2, 0n, (u * 30n) / 100n);
  const close = addSigned(open, sPos(body2));
  st.momentum = sPos((u * MOM_LEGACY_U_MUL) / ONE);
  st.price = close;
  return ohlc(open, close, wickLo, wickHi);
}

function shapeBearishEngulfing(
  st: WalkState,
  key: Uint8Array,
  sbase: number,
  stepIdx: bigint,
): Candle {
  const u = unitU(st.price, st.volRegime);
  if (stepIdx === 0n) {
    const open = st.price;
    const body1 = rngRange(key, sbase, (u * 30n) / 100n, (u * 80n) / 100n);
    const wickLo = rngRange(key, sbase + 1, 0n, (u * 30n) / 100n);
    const wickHi = rngRange(key, sbase + 2, 0n, (u * 30n) / 100n);
    const close = addSigned(open, sPos(body1));
    st.price = close;
    return ohlc(open, close, wickLo, wickHi);
  }
  const open = st.price;
  const body1 = rngRange(key, sbase - SHAPER_STRIDE, (u * 30n) / 100n, (u * 80n) / 100n);
  const body2 = rngRange(
    key,
    sbase,
    body1 + (u * 50n) / 100n,
    body1 + (u * 250n) / 100n,
  );
  const wickLo = rngRange(key, sbase + 1, 0n, (u * 30n) / 100n);
  const wickHi = rngRange(key, sbase + 2, 0n, (u * 30n) / 100n);
  const close = addSigned(open, sNew(true, body2));
  st.momentum = sNew(true, (u * MOM_LEGACY_U_MUL) / ONE);
  st.price = close;
  return ohlc(open, close, wickLo, wickHi);
}

/** Recompute TWS body for a given sbase / stepIdx — mirror of Move helper. */
function threeSoldiersBodyAt(
  key: Uint8Array,
  sbase: number,
  u: bigint,
  stepIdx: bigint,
): bigint {
  if (stepIdx === 0n) {
    return rngRange(key, sbase, (u * 40n) / 100n, (u * 70n) / 100n);
  }
  if (stepIdx === 1n) {
    const priorBody = rngRange(
      key,
      sbase - SHAPER_STRIDE,
      (u * 40n) / 100n,
      (u * 70n) / 100n,
    );
    return rngRange(
      key,
      sbase,
      priorBody + (u * 20n) / 100n,
      priorBody + (u * 50n) / 100n,
    );
  }
  const priorBody = threeSoldiersBodyAt(key, sbase - SHAPER_STRIDE, u, 1n);
  return rngRange(
    key,
    sbase,
    priorBody + (u * 20n) / 100n,
    priorBody + (u * 50n) / 100n,
  );
}

function shapeThreeWhiteSoldiers(
  st: WalkState,
  key: Uint8Array,
  sbase: number,
  stepIdx: bigint,
): Candle {
  const u = unitU(st.price, st.volRegime);
  const wickLo = rngRange(key, sbase + 1, 0n, (u * 15n) / 100n);
  const wickHi = rngRange(key, sbase + 2, 0n, (u * 25n) / 100n);
  let open: bigint;
  let body: bigint;
  if (stepIdx === 0n) {
    body = rngRange(key, sbase, (u * 40n) / 100n, (u * 70n) / 100n);
    open = st.price;
  } else if (stepIdx === 1n) {
    const priorBody = rngRange(
      key,
      sbase - SHAPER_STRIDE,
      (u * 40n) / 100n,
      (u * 70n) / 100n,
    );
    const halfPb = priorBody / 2n;
    open = halfPb >= st.price ? MIN_PRICE : st.price - halfPb;
    body = rngRange(
      key,
      sbase,
      priorBody + (u * 20n) / 100n,
      priorBody + (u * 50n) / 100n,
    );
  } else {
    const priorBody = threeSoldiersBodyAt(key, sbase - SHAPER_STRIDE, u, 1n);
    const halfPb = priorBody / 2n;
    open = halfPb >= st.price ? MIN_PRICE : st.price - halfPb;
    body = rngRange(
      key,
      sbase,
      priorBody + (u * 20n) / 100n,
      priorBody + (u * 50n) / 100n,
    );
  }
  const close = addSigned(open, sPos(body));
  st.momentum = sPos((u * MOM_LEGACY_U_MUL) / ONE);
  st.price = close;
  return ohlc(open, close, wickLo, wickHi);
}

/** Dispatch one FORMING candle to the right shaper, decrement the FSM. */
function shapeDispatch(st: WalkState, key: Uint8Array, ci: number): Candle {
  const pid = st.patternId;
  const cr = st.candlesRemaining;
  const stepIdx = patternTotalCandles(pid) - cr;
  const sbase = SHAPER_BASE + ci * SHAPER_STRIDE;
  let c: Candle;
  if (pid === BigInt(PATTERN_DOJI)) c = shapeDoji(st, key, sbase);
  else if (pid === BigInt(PATTERN_HAMMER)) c = shapeHammer(st, key, sbase);
  else if (pid === BigInt(PATTERN_SHOOTING_STAR)) c = shapeShootingStar(st, key, sbase);
  else if (pid === BigInt(PATTERN_BULLISH_ENGULFING))
    c = shapeBullishEngulfing(st, key, sbase, stepIdx);
  else if (pid === BigInt(PATTERN_BEARISH_ENGULFING))
    c = shapeBearishEngulfing(st, key, sbase, stepIdx);
  else c = shapeThreeWhiteSoldiers(st, key, sbase, stepIdx);
  st.candlesRemaining = cr - 1n;
  if (st.candlesRemaining === 0n) st.patternId = BigInt(PATTERN_NONE);
  return c;
}

/**
 * Expand one segment: 6 candles from the carried walk state and a 32-byte
 * segment_key. PURE and deterministic — the cross-language conformance
 * contract with Move `expand_segment`. The input `state` is not mutated.
 *
 * Per-candle dispatch (doc 17 §15.2):
 *   * FSM in FORMING: shapeDispatch produces one OHLC; `step()` does not run.
 *   * FSM in NORMAL : run `step()` 6 times then `fsmMaybeArm` decides whether
 *     the NEXT candle starts a pattern.
 */
export function expandSegment(state: WalkState, key: Uint8Array): SegmentResult {
  const st: WalkState = {
    price: state.price,
    momentum: { neg: state.momentum.neg, mag: state.momentum.mag },
    volRegime: state.volRegime,
    home: state.home,
    patternId: state.patternId,
    candlesRemaining: state.candlesRemaining,
  };
  const candles: Candle[] = [];
  let segMin = st.price;
  let segMax = st.price;
  for (let ci = 0; ci < CANDLES_PER_SEGMENT; ci++) {
    let c: Candle;
    if (st.patternId !== BigInt(PATTERN_NONE)) {
      c = shapeDispatch(st, key, ci);
    } else {
      const open = st.price;
      let high = open;
      let low = open;
      for (let ti = 0; ti < TICKS_PER_CANDLE; ti++) {
        const base = (ci * TICKS_PER_CANDLE + ti) * DRAWS_PER_TICK;
        step(st, key, base);
        if (st.price > high) high = st.price;
        if (st.price < low) low = st.price;
      }
      fsmMaybeArm(st, key, ci);
      c = { open, high, low, close: st.price };
    }
    if (c.low < segMin) segMin = c.low;
    if (c.high > segMax) segMax = c.high;
    candles.push(c);
  }
  return { candles, newState: st, min: segMin, max: segMax };
}

// ── Constructors mirroring the Move API ─────────────────────────────────────

/** A fresh walk state — zero momentum, FSM in NORMAL. */
export const newState = (
  price: bigint,
  volRegime: bigint,
  home: bigint,
): WalkState => ({
  price,
  momentum: sZero(),
  volRegime,
  home,
  patternId: BigInt(PATTERN_NONE),
  candlesRemaining: 0n,
});

/**
 * Build a WalkState with an explicit momentum — used by the conformance test.
 * FSM defaults to NORMAL; use `stateWithPattern` to force a starting FSM.
 */
export const stateWith = (
  price: bigint,
  momNeg: boolean,
  momMag: bigint,
  volRegime: bigint,
  home: bigint,
): WalkState => ({
  price,
  momentum: sNew(momNeg, momMag),
  volRegime,
  home,
  patternId: BigInt(PATTERN_NONE),
  candlesRemaining: 0n,
});

/**
 * Build a WalkState with an explicit momentum + an explicit FSM seed — used
 * by the §15.5 generation-guard test to force the FSM into FORMING{p}.
 */
export const stateWithPattern = (
  price: bigint,
  momNeg: boolean,
  momMag: bigint,
  volRegime: bigint,
  home: bigint,
  patternId: bigint,
  candlesRemaining: bigint,
): WalkState => ({
  price,
  momentum: sNew(momNeg, momMag),
  volRegime,
  home,
  patternId,
  candlesRemaining,
});
