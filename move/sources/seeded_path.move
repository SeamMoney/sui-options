// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/// seeded_path — the deterministic, provably-fair price walk for the
/// random-walk arcade ("degen mode").
/// Design: docs/design/v2/17_provably_fair_arcade.md (§7 Phase A, §15).
///
/// `expand_segment(state, key)` is a PURE deterministic function: given the
/// carried walk state and a 32-byte `segment_key`, it returns 6 candles, the
/// new walk state, and the segment's (min, max) price extremes. It runs here
/// in Move (for `record_segment` + settlement) and BYTE-IDENTICALLY in
/// TypeScript (`@wick/sdk` -> `seededPath.ts`, for the chart and `/verify`).
/// `tests/seeded_path_conformance.move` is the generative differential test
/// that proves the two implementations agree (doc 17 §8 — spine test 1).
///
/// FAIRNESS: the ONLY thing that differs from the legacy `random_walk_driver`
/// is the entropy SOURCE — a `segment_key` drawn from `sui::random` *after*
/// every player decision for the segment is locked (commit-before-roll). The
/// SHAPING — momentum, volatility regimes, fat tails, mean reversion — is a
/// verbatim integer transcription of the hand-tuned `useRideGesture` float
/// walk. Do not redesign the shaping (doc 17 §7, A1).
///
/// ── Fixed-point contract (identical in Move and TypeScript) ───────────────
///  price, home      u64    micro-USD              (1_000_000 = $1.00)
///  vol_regime       u64    1e6 fixed-point        clamped to [0.25 .. 3.60]
///  momentum         Signed raw micro-USD          (a small price delta)
///  coefficient `c`  stored as round(c * 1e6)
///  uniform draw     u64    in [0, 1_000_000)
///  hash             blake2b256
///  keystream word   blake2b256(key || le8(n)), low 8 bytes read little-endian
///  division         integer, truncating          (all operands non-negative)
///  intermediates    u128   (bounded well below 2^128 for any sane price)
#[allow(deprecated_usage)]
module wick::seeded_path;

use sui::bcs;
use sui::hash::blake2b256;

// ── Fixed-point scales ──────────────────────────────────────────────────────
const ONE: u128 = 1_000_000;          // coefficient / vol_regime scale
const HALF: u64 = 500_000;            // 0.5 at draw scale — recentres a draw
const DRAW_DEN: u64 = 1_000_000;      // uniform draw in [0, DRAW_DEN)
const E18: u128 = 1_000_000_000_000_000_000;
const MIN_PRICE: u64 = 1;             // price floor (micro-USD)

// ── Segment shape ───────────────────────────────────────────────────────────
const CANDLES_PER_SEGMENT: u64 = 6;
const TICKS_PER_CANDLE: u64 = 6;
const DRAWS_PER_TICK: u64 = 7;        // fixed stride -> keystream index = k*7+i

// ── Walk coefficients — round(c * 1e6) of the useRideGesture float walk ─────
const VR_MIN: u64 = 250_000;          // vol_regime clamp  0.25
const VR_MAX: u64 = 3_600_000;        //                   3.60
const C_VR_JITTER: u128 = 300_000;    // 0.30   per-tick vol_regime jitter
const C_VR_JUMP_PROB: u64 = 40_000;   // 0.04   chance of a regime jump
const C_VR_JUMP: u128 = 3_000_000;    // 3.00   regime-jump magnitude
const C_VR_REVERT: u128 = 45_000;     // 0.045  vol_regime mean-revert to 1.0
const C_MOM_JITTER: u128 = 2_600;     // 0.0026 momentum jitter
const C_MOM_DECAY: u128 = 820_000;    // 0.82   momentum decay
const C_MOM_CAP: u128 = 13_000;       // 0.013  momentum clamp (x price)
const C_REVERT: u128 = 7_000;         // 0.007  price mean-revert toward home
const C_VOL: u128 = 6_000;            // 0.006  base per-tick noise (x price)
const VOL_FLOOR: u128 = 400_000;      // $0.40  per-tick noise floor
const C_FAT_PROB: u64 = 70_000;       // 0.07   chance of a fat-tail tick
const C_FAT_BASE: u128 = 2_500_000;   // 2.50   fat-tail multiplier base/span
const C_MAX_DELTA: u128 = 60_000;     // 0.06   per-tick delta clamp (x price)

// ── Pattern FSM (doc 17 §15.2) ──────────────────────────────────────────────
//
// `pattern_id == PATTERN_NONE` is NORMAL — every candle goes through `step()`
// and the FSM draws a per-candle entropy slot deciding whether to enter
// FORMING. `pattern_id != PATTERN_NONE` is FORMING{p} — the next
// `candles_remaining` candles come from `shape_<p>()` instead of `step()`,
// and the FSM resumes NORMAL when `candles_remaining` decrements to 0. Each
// shaper produces an OHLC that PROVABLY satisfies its predicate with margin
// (doc 17 §15.3 "+0.5U insight") and updates the carried `price` + a small
// `momentum` legacy.
//
// Pattern IDs (used by `shape_*` dispatch and the predicate guard tests):
const PATTERN_NONE: u8 = 0;
const PATTERN_DOJI: u8 = 1;
const PATTERN_HAMMER: u8 = 2;
const PATTERN_SHOOTING_STAR: u8 = 3;
const PATTERN_BULLISH_ENGULFING: u8 = 4;
const PATTERN_BEARISH_ENGULFING: u8 = 5;
const PATTERN_THREE_WHITE_SOLDIERS: u8 = 6;

// Per-candle FSM entry probability — small, so patterns stay surprising. Draw
// is `< FSM_ENTRY_PROB` against DRAW_DEN (5_000_000 / 1e6 = 5%).
const FSM_ENTRY_PROB: u64 = 50_000;          // 0.05 chance per NORMAL candle

// Rarity weights (sum = 100). Common patterns weighted high, legendary low —
// "rare patterns are rare by construction" (doc 17 §15.2).
const W_DOJI: u64 = 30;
const W_HAMMER: u64 = 20;
const W_SHOOTING_STAR: u64 = 20;
const W_BULLISH_ENGULFING: u64 = 15;
const W_BEARISH_ENGULFING: u64 = 10;
const W_THREE_WHITE_SOLDIERS: u64 = 5;
const W_TOTAL: u64 = 100;                    // = sum of the W_* above

// Disjoint keystream regions per segment — `step()` draws live in [0, 252);
// FSM and shaper draws live far above to guarantee they never collide. Each
// candle gets up to 16 FSM and 32 shaper draws — far more than any one
// shaper needs (doji uses 4, three_white_soldiers uses 12).
const FSM_BASE: u64 = 100_000;
const FSM_STRIDE: u64 = 16;
const SHAPER_BASE: u64 = 200_000;
const SHAPER_STRIDE: u64 = 32;

// Hero-pattern unit `U` — a price scale tied to current `vol_regime` so the
// shaped candle is proportioned to the chart. `U = max(price * 0.005 * vr,
// 0.40)` mirrors the per-tick `vol` floor in `step()`. Stored as u128 in
// micro-USD; arithmetic is integer fixed-point.
const C_U: u128 = 5_000;                     // 0.005 (x price, x vr)
const U_FLOOR: u128 = 400_000;               // $0.40 unit floor

// Momentum legacy each shaper leaves on exit (a small directional bias for
// the next NORMAL candles; Monte-Carlo-validated per doc 17 §15.9). Scaled
// by `U` so the legacy is proportional to the pattern's own magnitude.
const MOM_LEGACY_U_MUL: u128 = 250_000;      // 0.25 (legacy = 0.25 * U)

// ── Types ───────────────────────────────────────────────────────────────────

/// Sign-magnitude integer. `mag == 0` is canonically non-negative.
public struct Signed has copy, drop, store {
    neg: bool,
    mag: u128,
}

/// One OHLC candle, prices in micro-USD.
public struct Candle has copy, drop, store {
    open: u64,
    high: u64,
    low: u64,
    close: u64,
}

/// The walk state carried across segments — checkpointed by `record_segment`
/// so trends and volatility clusters span a whole ride, not one 0.4s segment.
///
/// `pattern_id` + `candles_remaining` encode the pattern FSM (doc 17 §15.2):
/// when `pattern_id == PATTERN_NONE` the walk is in NORMAL; otherwise it is
/// FORMING{pattern_id} with `candles_remaining` candles left to shape. The
/// FSM state is part of the carried walk state so a multi-candle pattern can
/// span a segment boundary cleanly.
public struct WalkState has copy, drop, store {
    price: u64,
    momentum: Signed,
    vol_regime: u64,
    home: u64,
    pattern_id: u8,
    candles_remaining: u8,
}

// ── Signed arithmetic ───────────────────────────────────────────────────────

public fun s_zero(): Signed { Signed { neg: false, mag: 0 } }

/// Canonical constructor: zero is always non-negative.
public fun s_new(neg: bool, mag: u128): Signed {
    Signed { neg: neg && mag != 0, mag }
}

fun s_pos(mag: u128): Signed { Signed { neg: false, mag } }

public fun s_is_neg(s: &Signed): bool { s.neg }
public fun s_mag(s: &Signed): u128 { s.mag }

/// a + b
public fun s_add(a: Signed, b: Signed): Signed {
    if (a.neg == b.neg) {
        s_new(a.neg, a.mag + b.mag)
    } else if (a.mag >= b.mag) {
        s_new(a.neg, a.mag - b.mag)
    } else {
        s_new(b.neg, b.mag - a.mag)
    }
}

/// a - b
public fun s_sub(a: Signed, b: Signed): Signed {
    s_add(a, s_new(!b.neg, b.mag))
}

/// (a.mag * mul / div) carrying a's sign.
public fun s_mul_div(a: Signed, mul: u128, div: u128): Signed {
    s_new(a.neg, a.mag * mul / div)
}

/// Clamp |a| to at most `max_mag`.
public fun s_clamp_mag(a: Signed, max_mag: u128): Signed {
    if (a.mag > max_mag) s_new(a.neg, max_mag) else a
}

/// `price + delta`, floored at MIN_PRICE — never underflows.
fun s_apply(price: u64, delta: Signed): u64 {
    if (!delta.neg) {
        price + (delta.mag as u64)
    } else {
        let d = (delta.mag as u64);
        if (d >= price) {
            MIN_PRICE
        } else {
            let r = price - d;
            if (r < MIN_PRICE) MIN_PRICE else r
        }
    }
}

/// A draw `d` in [0, 1e6) recentred to the signed value `d - 0.5` (scale 1e6).
fun centered(d: u64): Signed {
    if (d >= HALF) {
        s_pos(((d - HALF) as u128))
    } else {
        s_new(true, ((HALF - d) as u128))
    }
}

/// Clamp a Signed into [lo, hi] and narrow to u64 (a negative value -> lo).
fun clamp_to_u64(s: Signed, lo: u64, hi: u64): u64 {
    if (s.neg) {
        lo
    } else {
        let m = (s.mag as u64);
        if (m < lo) lo else if (m > hi) hi else m
    }
}

// ── Entropy layer ───────────────────────────────────────────────────────────

/// One 64-bit keystream word — `blake2b256(key || le8(n))`, low 8 bytes read
/// little-endian. This is the deterministic expansion of the on-chain
/// `segment_key` into an unbounded uniform stream (doc 17 §7).
public fun keystream_word(key: &vector<u8>, n: u64): u64 {
    let mut input = *key;
    vector::append(&mut input, bcs::to_bytes(&n));   // BCS u64 = 8 bytes LE
    let digest = blake2b256(&input);
    let mut word: u64 = 0;
    let mut i: u64 = 0;
    while (i < 8) {
        let b = (*vector::borrow(&digest, i) as u64);
        word = word | (b << ((8 * i) as u8));
        i = i + 1;
    };
    word
}

/// A uniform draw in [0, 1_000_000).
public fun draw(key: &vector<u8>, n: u64): u64 {
    keystream_word(key, n) % DRAW_DEN
}

// ── The walk ────────────────────────────────────────────────────────────────

/// One walk step — folds a single sub-price into the path. Mutates
/// price / momentum / vol_regime in `st`. `base` is the keystream counter of
/// this step's first draw; a step always consumes exactly 7 draws.
///
/// Verbatim transcription of `useRideGesture.nextPrice()`:
///   1. update the volatility regime (jitter, rare jump, revert, clamp)
///   2. update momentum (regime-scaled jitter, decay, clamp)
///   3. delta = momentum + revert-to-home + fat-tailed noise; clamp; apply
fun step(st: &mut WalkState, key: &vector<u8>, base: u64) {
    let d0 = draw(key, base);
    let d1 = draw(key, base + 1);
    let d2 = draw(key, base + 2);
    let d3 = draw(key, base + 3);
    let d4 = draw(key, base + 4);
    let d5 = draw(key, base + 5);
    let d6 = draw(key, base + 6);

    // 1 ── Volatility regime — clusters quiet vs wild stretches ──────────────
    let mut vr = s_pos((st.vol_regime as u128));
    vr = s_add(vr, s_mul_div(centered(d0), C_VR_JITTER, ONE));      // +-0.30
    if (d1 < C_VR_JUMP_PROB) {                                      // rare jump
        vr = s_add(vr, s_mul_div(centered(d2), C_VR_JUMP, ONE));
    };
    let to_one = s_sub(s_pos(ONE), vr);                             // (1 - vr)
    vr = s_add(vr, s_mul_div(to_one, C_VR_REVERT, ONE));            // revert
    st.vol_regime = clamp_to_u64(vr, VR_MIN, VR_MAX);

    let price = (st.price as u128);
    let vr_u = (st.vol_regime as u128);

    // 2 ── Momentum — a trend term, regime-scaled, fast-decaying ─────────────
    // jitter = (d3 - 0.5) * price * 0.0026 * vol_regime
    let cj = centered(d3);
    let jitter = s_new(cj.neg, cj.mag * price * C_MOM_JITTER * vr_u / E18);
    let mut mom = s_add(st.momentum, jitter);
    mom = s_mul_div(mom, C_MOM_DECAY, ONE);                         // decay 0.82
    let mcap = price * C_MOM_CAP / ONE;                            // +- price*0.013
    st.momentum = s_clamp_mag(mom, mcap);

    // 3 ── Per-tick delta = momentum + revert + fat-tailed noise ─────────────
    let revert = s_mul_div(
        s_sub(s_pos((st.home as u128)), s_pos(price)),              // home - price
        C_REVERT, ONE,
    );
    let mut vol = price * C_VOL / ONE;                             // price * 0.006
    if (vol < VOL_FLOOR) vol = VOL_FLOOR;
    vol = vol * vr_u / ONE;                                        // * vol_regime
    if (d4 < C_FAT_PROB) {                                          // fat tail
        let fat = C_FAT_BASE + ((d5 as u128) * C_FAT_BASE / ONE);   // 2.5 + d5*2.5
        vol = vol * fat / ONE;
    };
    let noise = s_mul_div(centered(d6), vol, ONE);                 // (d6 - 0.5) * vol
    let mut delta = s_add(s_add(st.momentum, revert), noise);
    delta = s_clamp_mag(delta, price * C_MAX_DELTA / ONE);         // +- price*0.06
    st.price = s_apply(st.price, delta);
}

// ── Pattern FSM + shapers ───────────────────────────────────────────────────
//
// At each candle boundary, the FSM in `expand_segment` either:
//   * NORMAL: run `step()` 6 times for an organic candle, then `fsm_maybe_arm`
//     decides (from a per-candle keystream draw) whether to enter FORMING{p};
//   * FORMING{p}: dispatch to `shape_<p>()` which returns one OHLC and
//     decrements `candles_remaining`. The candle is built directly — `step()`
//     does NOT run during a FORMING candle (its 42 tick draws are unused at
//     those indices, harmless since draws are pure functions of the key).
//
// All FSM and shaper draws live in disjoint keystream ranges (`FSM_BASE`,
// `SHAPER_BASE`) far above `step()`'s indices, so the entropy budgets never
// overlap. Every shaper produces predicate-satisfying OHLC WITH MARGIN
// (doc 17 §15.3 "+0.5U"), so the §15.5 detector-consistency guarantee holds
// even for the strictest reasonable predicate.

/// Compute the per-candle pattern unit `U` from current price and vol_regime.
/// `U = max(price * 0.005 * vr, $0.40)` — the pattern is proportioned to the
/// chart's current liveliness.
fun unit_u(price: u128, vr: u128): u128 {
    let raw = price * C_U * vr / (ONE * ONE);
    if (raw < U_FLOOR) U_FLOOR else raw
}

/// A draw in `[lo, hi]` inclusive, derived from one keystream word — used by
/// shapers to draw magnitudes inside guaranteed-safe ranges.
fun rng_range(key: &vector<u8>, idx: u64, lo: u128, hi: u128): u128 {
    let span = hi - lo + 1;
    let w = (keystream_word(key, idx) as u128);
    lo + (w % span)
}

/// In NORMAL state, decide whether this candle starts a new pattern. Two
/// draws: a Bernoulli for arming, a discrete draw weighted by rarity for
/// which pattern. Mutates `st.pattern_id` / `st.candles_remaining` in place.
fun fsm_maybe_arm(st: &mut WalkState, key: &vector<u8>, ci: u64) {
    let arm = draw(key, FSM_BASE + ci * FSM_STRIDE);
    if (arm >= FSM_ENTRY_PROB) return;
    let pick = (draw(key, FSM_BASE + ci * FSM_STRIDE + 1) % W_TOTAL);
    let (pid, n) = pattern_from_weight(pick);
    st.pattern_id = pid;
    st.candles_remaining = n;
}

/// Map a uniform [0, W_TOTAL) pick to (pattern_id, candle_count) by rarity.
/// Keep this ordered with the W_* constants — table-stable for the TS twin.
fun pattern_from_weight(pick: u64): (u8, u8) {
    let mut acc = W_DOJI;
    if (pick < acc) return (PATTERN_DOJI, 1);
    acc = acc + W_HAMMER;
    if (pick < acc) return (PATTERN_HAMMER, 1);
    acc = acc + W_SHOOTING_STAR;
    if (pick < acc) return (PATTERN_SHOOTING_STAR, 1);
    acc = acc + W_BULLISH_ENGULFING;
    if (pick < acc) return (PATTERN_BULLISH_ENGULFING, 2);
    acc = acc + W_BEARISH_ENGULFING;
    if (pick < acc) return (PATTERN_BEARISH_ENGULFING, 2);
    // W_THREE_WHITE_SOLDIERS — the tail; referenced to keep the rarity table
    // honest (the next W_* added must update both the dispatch and W_TOTAL).
    let _ = W_THREE_WHITE_SOLDIERS;
    (PATTERN_THREE_WHITE_SOLDIERS, 3)
}

/// Dispatch one FORMING candle to the right shaper. The shaper:
///   * draws its entropy from the disjoint SHAPER_* region;
///   * returns an OHLC satisfying its predicate with `+0.5U`-style margin;
///   * updates `st.price` to the candle's close and `st.momentum` legacy;
///   * decrements `st.candles_remaining`; if 0, resets the FSM to NORMAL.
fun shape_dispatch(st: &mut WalkState, key: &vector<u8>, ci: u64): Candle {
    let pid = st.pattern_id;
    let cr = st.candles_remaining;
    // The shaper-call index within the pattern (0 == first candle of the
    // pattern, 1 == second, …). Computed from `candles_remaining` so the
    // index is stable across segment boundaries.
    let step_idx = pattern_total_candles(pid) - cr;
    let sbase = SHAPER_BASE + ci * SHAPER_STRIDE;
    let c =
        if (pid == PATTERN_DOJI)                   shape_doji(st, key, sbase)
        else if (pid == PATTERN_HAMMER)            shape_hammer(st, key, sbase)
        else if (pid == PATTERN_SHOOTING_STAR)     shape_shooting_star(st, key, sbase)
        else if (pid == PATTERN_BULLISH_ENGULFING) shape_bullish_engulfing(st, key, sbase, step_idx)
        else if (pid == PATTERN_BEARISH_ENGULFING) shape_bearish_engulfing(st, key, sbase, step_idx)
        else                                       shape_three_white_soldiers(st, key, sbase, step_idx);
    // Decrement FSM; reset on completion.
    st.candles_remaining = cr - 1;
    if (st.candles_remaining == 0) st.pattern_id = PATTERN_NONE;
    c
}

/// Total candles each pattern produces — must agree with `pattern_from_weight`.
fun pattern_total_candles(pid: u8): u8 {
    if (pid == PATTERN_DOJI) 1
    else if (pid == PATTERN_HAMMER) 1
    else if (pid == PATTERN_SHOOTING_STAR) 1
    else if (pid == PATTERN_BULLISH_ENGULFING) 2
    else if (pid == PATTERN_BEARISH_ENGULFING) 2
    else 3   // PATTERN_THREE_WHITE_SOLDIERS
}

/// Build an OHLC from open/close/lower-wick/upper-wick magnitudes. Wicks are
/// added BEYOND the body so the resulting high/low strictly satisfy
/// `low <= min(open,close)` and `high >= max(open,close)`.
fun ohlc(open: u64, close: u64, lower_wick: u128, upper_wick: u128): Candle {
    let body_lo = if (open < close) open else close;
    let body_hi = if (open > close) open else close;
    let low = if (lower_wick >= (body_lo as u128)) MIN_PRICE
              else ((body_lo as u128) - lower_wick) as u64;
    let high = ((body_hi as u128) + upper_wick) as u64;
    Candle { open, high, low, close }
}

/// Apply a signed delta to a u64 price, floored at MIN_PRICE. Same semantics
/// as `s_apply` but used by shapers for explicit close-price computation.
fun add_signed(p: u64, delta: Signed): u64 { s_apply(p, delta) }

// ── Hero shapers (doc 17 §15.3 template) ────────────────────────────────────
// Each shaper consumes a small disjoint slice of keystream draws starting at
// `sbase`. Magnitudes are drawn from ranges that GUARANTEE the predicate
// holds with margin — see the inline comment above each shaper for the
// predicate it satisfies. Continuity: each shaper's `open = st.price`.

/// Doji: tiny body, balanced wicks. Predicate: `|close - open| <= 0.30 * U`.
/// Shaper bounds: `|body| in [0.05U, 0.20U]` — well under 0.30U.
fun shape_doji(st: &mut WalkState, key: &vector<u8>, sbase: u64): Candle {
    let price = (st.price as u128);
    let vr = (st.vol_regime as u128);
    let u = unit_u(price, vr);
    let open = st.price;
    let body = rng_range(key, sbase, u * 5 / 100, u * 20 / 100);   // [0.05U, 0.20U]
    let dir_up = (draw(key, sbase + 1) & 1) == 0;
    let wick_lo = rng_range(key, sbase + 2, u * 30 / 100, u * 80 / 100);   // [0.30U, 0.80U]
    let wick_hi = rng_range(key, sbase + 3, u * 30 / 100, u * 80 / 100);
    let delta = s_new(!dir_up, body);
    let close = add_signed(open, delta);
    // Tiny momentum legacy — doji is indecision; legacy is zero.
    st.momentum = s_zero();
    st.price = close;
    ohlc(open, close, wick_lo, wick_hi)
}

/// Hammer: small bullish body near top, long lower wick.
/// Predicate (continuous TA-style): `lower_wick >= 2 * body && upper_wick <=
/// 0.3 * body && close >= open`. Shaper bounds:
///   `body in [0.3U, 0.8U]`,  `lower_wick in [2.5*body, 4.0*body]`,
///   `upper_wick in [0, 0.15*body]`  — strictly > 2*body and < 0.3*body.
fun shape_hammer(st: &mut WalkState, key: &vector<u8>, sbase: u64): Candle {
    let price = (st.price as u128);
    let vr = (st.vol_regime as u128);
    let u = unit_u(price, vr);
    let open = st.price;
    let body = rng_range(key, sbase, u * 30 / 100, u * 80 / 100);
    let wick_lo = rng_range(key, sbase + 1, body * 250 / 100, body * 400 / 100);
    let wick_hi = rng_range(key, sbase + 2, 0, body * 15 / 100);
    let close = add_signed(open, s_pos(body));   // bullish body
    // Bullish legacy — hammer flags a likely reversal up.
    st.momentum = s_pos(u * MOM_LEGACY_U_MUL / ONE);
    st.price = close;
    ohlc(open, close, wick_lo, wick_hi)
}

/// Shooting Star: small bearish body near bottom, long upper wick.
/// Predicate: `upper_wick >= 2 * body && lower_wick <= 0.3 * body && close
/// <= open`. Symmetric bounds to hammer.
fun shape_shooting_star(st: &mut WalkState, key: &vector<u8>, sbase: u64): Candle {
    let price = (st.price as u128);
    let vr = (st.vol_regime as u128);
    let u = unit_u(price, vr);
    let open = st.price;
    let body = rng_range(key, sbase, u * 30 / 100, u * 80 / 100);
    let wick_hi = rng_range(key, sbase + 1, body * 250 / 100, body * 400 / 100);
    let wick_lo = rng_range(key, sbase + 2, 0, body * 15 / 100);
    let close = add_signed(open, s_new(true, body));   // bearish body
    // Bearish legacy.
    st.momentum = s_new(true, u * MOM_LEGACY_U_MUL / ONE);
    st.price = close;
    ohlc(open, close, wick_lo, wick_hi)
}

/// Bullish engulfing — the template (doc 17 §15.3).
///   Candle 1 (step_idx=0): small bearish. body1 in [0.3U, 0.8U],
///     wicks in [0, 0.3U]. close1 = open - body1.
///   Candle 2 (step_idx=1): bullish, body2 in [body1 + 0.5U, body1 + 2.5U].
///     open2 = close1, close2 = open2 + body2. Because body2 > body1 by >=
///     0.5U, close2 > P (= open1) and open2 <= close1 — engulfing holds with
///     margin for every entropy draw.
///   Predicate: `close2 > open1 && open2 <= close1 && body2 > body1`.
fun shape_bullish_engulfing(
    st: &mut WalkState,
    key: &vector<u8>,
    sbase: u64,
    step_idx: u8,
): Candle {
    let price = (st.price as u128);
    let vr = (st.vol_regime as u128);
    let u = unit_u(price, vr);
    if (step_idx == 0) {
        let open = st.price;
        let body1 = rng_range(key, sbase, u * 30 / 100, u * 80 / 100);
        let wick_lo = rng_range(key, sbase + 1, 0, u * 30 / 100);
        let wick_hi = rng_range(key, sbase + 2, 0, u * 30 / 100);
        let close = add_signed(open, s_new(true, body1));   // bearish
        // No momentum legacy mid-pattern; leave momentum alone.
        st.price = close;
        ohlc(open, close, wick_lo, wick_hi)
    } else {
        // step_idx == 1 — engulfing bullish candle.
        let open = st.price;
        // Recover body1 deterministically from the same draw as candle 1.
        let body1 = rng_range(key, sbase - SHAPER_STRIDE, u * 30 / 100, u * 80 / 100);
        let body2 = rng_range(key, sbase, body1 + u * 50 / 100, body1 + u * 250 / 100);
        let wick_lo = rng_range(key, sbase + 1, 0, u * 30 / 100);
        let wick_hi = rng_range(key, sbase + 2, 0, u * 30 / 100);
        let close = add_signed(open, s_pos(body2));
        st.momentum = s_pos(u * MOM_LEGACY_U_MUL / ONE);   // bullish legacy
        st.price = close;
        ohlc(open, close, wick_lo, wick_hi)
    }
}

/// Bearish engulfing — mirror of bullish.
///   Candle 1 (small bullish). Candle 2 (big bearish, body2 > body1).
///   Predicate: `close2 < open1 && open2 >= close1 && body2 > body1`.
fun shape_bearish_engulfing(
    st: &mut WalkState,
    key: &vector<u8>,
    sbase: u64,
    step_idx: u8,
): Candle {
    let price = (st.price as u128);
    let vr = (st.vol_regime as u128);
    let u = unit_u(price, vr);
    if (step_idx == 0) {
        let open = st.price;
        let body1 = rng_range(key, sbase, u * 30 / 100, u * 80 / 100);
        let wick_lo = rng_range(key, sbase + 1, 0, u * 30 / 100);
        let wick_hi = rng_range(key, sbase + 2, 0, u * 30 / 100);
        let close = add_signed(open, s_pos(body1));   // bullish
        st.price = close;
        ohlc(open, close, wick_lo, wick_hi)
    } else {
        let open = st.price;
        let body1 = rng_range(key, sbase - SHAPER_STRIDE, u * 30 / 100, u * 80 / 100);
        let body2 = rng_range(key, sbase, body1 + u * 50 / 100, body1 + u * 250 / 100);
        let wick_lo = rng_range(key, sbase + 1, 0, u * 30 / 100);
        let wick_hi = rng_range(key, sbase + 2, 0, u * 30 / 100);
        let close = add_signed(open, s_new(true, body2));
        st.momentum = s_new(true, u * MOM_LEGACY_U_MUL / ONE);   // bearish legacy
        st.price = close;
        ohlc(open, close, wick_lo, wick_hi)
    }
}

/// Three White Soldiers — three consecutive bullish candles, each opening
/// inside the prior body and closing strictly above the prior close.
///   Predicate (continuous TA-style): for k in 1..2,
///     `close_k > open_k && close_k > close_{k-1} && open_k > open_{k-1} &&
///      open_k <= close_{k-1}`.
///
/// Shaper bounds — designed so the predicate holds with margin every time:
///   * candle 0: body_0 in [0.4U, 0.7U].
///   * candle k>0: open_k = prior_close - prior_body/2 = prior_open +
///       prior_body/2 (deterministic, in the open-inside-prior-body window).
///       body_k drawn from [prior_body + 0.2U, prior_body + 0.5U] — strictly
///       larger than the prior body, so close_k > prior_close by >= 0.2U
///       (since body_k - prior_body/2 >= prior_body/2 + 0.2U > 0).
///
/// To compute prior_body deterministically the shaper recomputes the same
/// `rng_range` at `sbase - SHAPER_STRIDE` (candle 1) or back-derives it from
/// the carried state (candle 2). The carried `st.momentum` (set on the prior
/// candle to the bullish legacy) carries no body info, so we instead store
/// the prior body's body inside the recovered draw at `sbase - SHAPER_STRIDE`
/// (candle 1) or `sbase - 2*SHAPER_STRIDE` (candle 2) — both byte-identical.
fun shape_three_white_soldiers(
    st: &mut WalkState,
    key: &vector<u8>,
    sbase: u64,
    step_idx: u8,
): Candle {
    let price = (st.price as u128);
    let vr = (st.vol_regime as u128);
    let u = unit_u(price, vr);
    let wick_lo = rng_range(key, sbase + 1, 0, u * 15 / 100);
    let wick_hi = rng_range(key, sbase + 2, 0, u * 25 / 100);
    let (open, body) = if (step_idx == 0) {
        let b0 = rng_range(key, sbase, u * 40 / 100, u * 70 / 100);
        (st.price, b0)
    } else if (step_idx == 1) {
        let prior_body = rng_range(
            key, sbase - SHAPER_STRIDE, u * 40 / 100, u * 70 / 100,
        );
        // open_k = prior_close - prior_body/2 = prior_open + prior_body/2.
        let half_pb = prior_body / 2;
        let open_k = if ((half_pb as u64) >= st.price) MIN_PRICE
                     else st.price - (half_pb as u64);
        let b1 = rng_range(key, sbase, prior_body + u * 20 / 100, prior_body + u * 50 / 100);
        (open_k, b1)
    } else {
        // step_idx == 2 — same construction, prior_body recomputed via its
        // sbase one stride back.
        let prior_body = three_soldiers_body_at(key, sbase - SHAPER_STRIDE, u, 1);
        let half_pb = prior_body / 2;
        let open_k = if ((half_pb as u64) >= st.price) MIN_PRICE
                     else st.price - (half_pb as u64);
        let b2 = rng_range(key, sbase, prior_body + u * 20 / 100, prior_body + u * 50 / 100);
        (open_k, b2)
    };
    let close = add_signed(open, s_pos(body));
    st.momentum = s_pos(u * MOM_LEGACY_U_MUL / ONE);   // strong bullish legacy
    st.price = close;
    ohlc(open, close, wick_lo, wick_hi)
}

/// Recompute the body drawn by shape_three_white_soldiers at the given
/// `sbase` and `step_idx`. Used by step_idx=2 to derive the previous (step
/// 1) body, which itself depends on step 0's body — recurse via step_idx.
fun three_soldiers_body_at(
    key: &vector<u8>,
    sbase: u64,
    u: u128,
    step_idx: u8,
): u128 {
    if (step_idx == 0) {
        rng_range(key, sbase, u * 40 / 100, u * 70 / 100)
    } else if (step_idx == 1) {
        let prior_body = rng_range(
            key, sbase - SHAPER_STRIDE, u * 40 / 100, u * 70 / 100,
        );
        rng_range(key, sbase, prior_body + u * 20 / 100, prior_body + u * 50 / 100)
    } else {
        let prior_body = three_soldiers_body_at(key, sbase - SHAPER_STRIDE, u, 1);
        rng_range(key, sbase, prior_body + u * 20 / 100, prior_body + u * 50 / 100)
    }
}

/// Expand one segment: 6 candles from the carried walk state and a 32-byte
/// `segment_key`. Returns (candles, new walk state, segment min, segment max).
/// PURE and deterministic — the cross-language conformance contract.
///
/// Per-candle dispatch (doc 17 §15.2):
///   * FSM in FORMING: shape_dispatch produces one OHLC; `step()` does not run.
///   * FSM in NORMAL : run `step()` 6 times, build the OHLC from observed
///     prices, then `fsm_maybe_arm` decides whether to enter FORMING for the
///     NEXT candle.
public fun expand_segment(
    state: WalkState,
    key: vector<u8>,
): (vector<Candle>, WalkState, u64, u64) {
    let mut st = state;
    let mut candles = vector<Candle>[];
    let mut seg_min = st.price;
    let mut seg_max = st.price;
    let mut ci: u64 = 0;
    while (ci < CANDLES_PER_SEGMENT) {
        let c = if (st.pattern_id != PATTERN_NONE) {
            shape_dispatch(&mut st, &key, ci)
        } else {
            // NORMAL candle — organic walk.
            let open = st.price;
            let mut high = open;
            let mut low = open;
            let mut ti: u64 = 0;
            while (ti < TICKS_PER_CANDLE) {
                let base = (ci * TICKS_PER_CANDLE + ti) * DRAWS_PER_TICK;
                step(&mut st, &key, base);
                if (st.price > high) high = st.price;
                if (st.price < low) low = st.price;
                ti = ti + 1;
            };
            // Decide whether the *next* candle starts a pattern.
            fsm_maybe_arm(&mut st, &key, ci);
            Candle { open, high, low, close: st.price }
        };
        if (c.low < seg_min) seg_min = c.low;
        if (c.high > seg_max) seg_max = c.high;
        vector::push_back(&mut candles, c);
        ci = ci + 1;
    };
    (candles, st, seg_min, seg_max)
}

// ── Constructors and accessors ──────────────────────────────────────────────

/// A fresh walk state — zero momentum, FSM in NORMAL.
public fun new_state(price: u64, vol_regime: u64, home: u64): WalkState {
    WalkState {
        price,
        momentum: s_zero(),
        vol_regime,
        home,
        pattern_id: PATTERN_NONE,
        candles_remaining: 0,
    }
}

/// Build a WalkState with an explicit momentum — used by the conformance test.
/// FSM defaults to NORMAL; use `state_with_pattern` to force a starting FSM.
public fun state_with(
    price: u64,
    mom_neg: bool,
    mom_mag: u128,
    vol_regime: u64,
    home: u64,
): WalkState {
    WalkState {
        price,
        momentum: s_new(mom_neg, mom_mag),
        vol_regime,
        home,
        pattern_id: PATTERN_NONE,
        candles_remaining: 0,
    }
}

/// Build a WalkState with an explicit momentum + an explicit FSM seed — used
/// by the §15.5 generation-guard test to force the FSM into FORMING{p} so the
/// shaped candles can be inspected.
public fun state_with_pattern(
    price: u64,
    mom_neg: bool,
    mom_mag: u128,
    vol_regime: u64,
    home: u64,
    pattern_id: u8,
    candles_remaining: u8,
): WalkState {
    WalkState {
        price,
        momentum: s_new(mom_neg, mom_mag),
        vol_regime,
        home,
        pattern_id,
        candles_remaining,
    }
}

public fun state_price(s: &WalkState): u64 { s.price }
public fun state_vol_regime(s: &WalkState): u64 { s.vol_regime }
public fun state_home(s: &WalkState): u64 { s.home }

/// v4.31 — surgical setter so `wick::segment_market_v4` can shift the
/// mean-reversion target per segment to introduce regime drift. The
/// walk's C_REVERT pulls `price` toward `home` each tick; shifting
/// `home` upward by Xbps/segment makes the chart trend up over the
/// round. Adding a NEW public function is COMPATIBLE under Sui's
/// upgrade rules; no struct fields change, no signature changes.
public fun set_home(s: &mut WalkState, new_home: u64) { s.home = new_home; }

public fun state_momentum_neg(s: &WalkState): bool { s.momentum.neg }
public fun state_momentum_mag(s: &WalkState): u128 { s.momentum.mag }
public fun state_pattern_id(s: &WalkState): u8 { s.pattern_id }
public fun state_candles_remaining(s: &WalkState): u8 { s.candles_remaining }

// Public pattern-ID constants — re-exported for the §15.5 guard test and the
// TS twin to reference symbolically.
public fun pattern_none(): u8 { PATTERN_NONE }
public fun pattern_doji(): u8 { PATTERN_DOJI }
public fun pattern_hammer(): u8 { PATTERN_HAMMER }
public fun pattern_shooting_star(): u8 { PATTERN_SHOOTING_STAR }
public fun pattern_bullish_engulfing(): u8 { PATTERN_BULLISH_ENGULFING }
public fun pattern_bearish_engulfing(): u8 { PATTERN_BEARISH_ENGULFING }
public fun pattern_three_white_soldiers(): u8 { PATTERN_THREE_WHITE_SOLDIERS }

public fun candle_open(c: &Candle): u64 { c.open }
public fun candle_high(c: &Candle): u64 { c.high }
public fun candle_low(c: &Candle): u64 { c.low }
public fun candle_close(c: &Candle): u64 { c.close }

public fun candles_per_segment(): u64 { CANDLES_PER_SEGMENT }
public fun ticks_per_candle(): u64 { TICKS_PER_CANDLE }
public fun draws_per_tick(): u64 { DRAWS_PER_TICK }

// ── Internal tests — invariants only (cross-language equality is proven by
//    the generated tests/seeded_path_conformance.move) ──────────────────────

#[test]
fun expand_segment_shape() {
    let st = new_state(1_000_000_000, 1_000_000, 1_000_000_000);   // $1000
    let key = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    let (candles, new_st, smin, smax) = expand_segment(st, key);
    assert!(vector::length(&candles) == 6, 0);
    assert!(smin <= smax, 1);
    assert!(new_st.price >= MIN_PRICE, 2);
    assert!(new_st.vol_regime >= VR_MIN && new_st.vol_regime <= VR_MAX, 3);
    let mut i = 0;
    while (i < 6) {
        let c = vector::borrow(&candles, i);
        assert!(c.low <= c.open && c.open <= c.high, 4);
        assert!(c.low <= c.close && c.close <= c.high, 5);
        assert!(c.low >= smin && c.high <= smax, 6);
        i = i + 1;
    };
}

#[test]
fun expand_segment_deterministic() {
    let st = new_state(500_000_000, 1_500_000, 500_000_000);
    let key = x"deadbeef00000000000000000000000000000000000000000000000000000000";
    let (c1, s1, lo1, hi1) = expand_segment(st, key);
    let (c2, s2, lo2, hi2) = expand_segment(st, key);
    assert!(lo1 == lo2 && hi1 == hi2, 0);
    assert!(s1.price == s2.price && s1.vol_regime == s2.vol_regime, 1);
    assert!(vector::borrow(&c1, 5).close == vector::borrow(&c2, 5).close, 2);
}

#[test]
fun keystream_distinct() {
    let key = x"0000000000000000000000000000000000000000000000000000000000000000";
    assert!(keystream_word(&key, 0) != keystream_word(&key, 1), 0);
    assert!(draw(&key, 7) < DRAW_DEN, 1);
}

#[test]
fun signed_arithmetic() {
    let a = s_add(s_pos(5), s_new(true, 3));        // 5 + (-3) = 2
    assert!(!a.neg && a.mag == 2, 0);
    let b = s_sub(s_pos(3), s_pos(5));              // 3 - 5 = -2
    assert!(b.neg && b.mag == 2, 1);
    let z = s_new(true, 0);                         // -0 canonicalises to +0
    assert!(!z.neg && z.mag == 0, 2);
    let c = s_clamp_mag(s_new(true, 100), 30);      // |-100| clamped to 30
    assert!(c.neg && c.mag == 30, 3);
    assert!(s_apply(100, s_new(true, 250)) == MIN_PRICE, 4);   // floored, no underflow
}

// ── Pattern FSM guard tests (doc 17 §15.5) ──────────────────────────────────
//
// For each hero pattern, force the FSM into FORMING{p} and assert the
// produced candle(s) satisfy the pattern's predicate WITH MARGIN. These are
// the six predicates Agent A owns — Agent C ships the full 54-pattern
// detection catalog separately. The guarantee proven here is the §15.5
// "generation guard": shape_<p>() outputs the pattern, every time.

#[test_only]
fun assert_basic_ohlc(c: &Candle) {
    assert!(c.low <= c.open && c.open <= c.high, 100);
    assert!(c.low <= c.close && c.close <= c.high, 101);
}

#[test_only]
/// Run one shaped pattern in isolation and return the candles it produced.
fun shape_one(pid: u8, n: u8): vector<Candle> {
    let st = state_with_pattern(
        1_000_000_000,   // $1000 — typical mid-range price
        false, 0,        // zero momentum
        1_000_000,       // vol_regime = 1.0
        1_000_000_000,   // home = price
        pid, n,
    );
    let key = x"a1b2c3d4e5f6071829304051607182930405160718293040516071829304051a";
    let (candles, _, _, _) = expand_segment(st, key);
    candles
}

#[test]
fun guard_doji_satisfies_predicate() {
    let candles = shape_one(PATTERN_DOJI, 1);
    let c = vector::borrow(&candles, 0);
    assert_basic_ohlc(c);
    // |close - open| < 0.30 * U at the test price ($1000, vr=1.0):
    // U = max(1e9 * 0.005 * 1.0, 4e5) = 5e6 -> 0.30U = 1.5e6.
    // shaper bounds body to 0.20U = 1e6.
    let diff = if (c.close >= c.open) c.close - c.open else c.open - c.close;
    assert!(diff <= 1_500_000, 0);
}

#[test]
fun guard_hammer_satisfies_predicate() {
    let candles = shape_one(PATTERN_HAMMER, 1);
    let c = vector::borrow(&candles, 0);
    assert_basic_ohlc(c);
    // bullish body, lower_wick >= 2 * body, upper_wick <= 0.3 * body.
    assert!(c.close >= c.open, 0);
    let body = c.close - c.open;
    let body_lo = c.open;                  // bullish: open is the body low
    let lower = body_lo - c.low;
    let upper = c.high - c.close;
    assert!(lower >= 2 * body, 1);
    assert!(upper * 10 <= 3 * body, 2);    // upper <= 0.3 * body
}

#[test]
fun guard_shooting_star_satisfies_predicate() {
    let candles = shape_one(PATTERN_SHOOTING_STAR, 1);
    let c = vector::borrow(&candles, 0);
    assert_basic_ohlc(c);
    // bearish body, upper_wick >= 2 * body, lower_wick <= 0.3 * body.
    assert!(c.close <= c.open, 0);
    let body = c.open - c.close;
    let body_hi = c.open;                  // bearish: open is the body high
    let upper = c.high - body_hi;
    let lower = c.close - c.low;
    assert!(upper >= 2 * body, 1);
    assert!(lower * 10 <= 3 * body, 2);
}

#[test]
fun guard_bullish_engulfing_satisfies_predicate() {
    let candles = shape_one(PATTERN_BULLISH_ENGULFING, 2);
    let c1 = vector::borrow(&candles, 0);
    let c2 = vector::borrow(&candles, 1);
    assert_basic_ohlc(c1);
    assert_basic_ohlc(c2);
    // candle 1 bearish, candle 2 bullish; close2 > open1; open2 <= close1;
    // body2 > body1.
    assert!(c1.close < c1.open, 0);
    assert!(c2.close > c2.open, 1);
    assert!(c2.close > c1.open, 2);
    assert!(c2.open <= c1.close, 3);
    let body1 = c1.open - c1.close;
    let body2 = c2.close - c2.open;
    assert!(body2 > body1, 4);
}

#[test]
fun guard_bearish_engulfing_satisfies_predicate() {
    let candles = shape_one(PATTERN_BEARISH_ENGULFING, 2);
    let c1 = vector::borrow(&candles, 0);
    let c2 = vector::borrow(&candles, 1);
    assert_basic_ohlc(c1);
    assert_basic_ohlc(c2);
    // candle 1 bullish, candle 2 bearish; close2 < open1; open2 >= close1;
    // body2 > body1.
    assert!(c1.close > c1.open, 0);
    assert!(c2.close < c2.open, 1);
    assert!(c2.close < c1.open, 2);
    assert!(c2.open >= c1.close, 3);
    let body1 = c1.close - c1.open;
    let body2 = c2.open - c2.close;
    assert!(body2 > body1, 4);
}

#[test]
fun guard_three_white_soldiers_satisfies_predicate() {
    let candles = shape_one(PATTERN_THREE_WHITE_SOLDIERS, 3);
    let c1 = vector::borrow(&candles, 0);
    let c2 = vector::borrow(&candles, 1);
    let c3 = vector::borrow(&candles, 2);
    assert_basic_ohlc(c1);
    assert_basic_ohlc(c2);
    assert_basic_ohlc(c3);
    // All three bullish.
    assert!(c1.close > c1.open, 0);
    assert!(c2.close > c2.open, 1);
    assert!(c3.close > c3.open, 2);
    // Each opens inside prior body and above prior open.
    assert!(c2.open > c1.open && c2.open <= c1.close, 3);
    assert!(c3.open > c2.open && c3.open <= c2.close, 4);
    // Each closes above prior close.
    assert!(c2.close > c1.close, 5);
    assert!(c3.close > c2.close, 6);
}

#[test]
fun fsm_normal_carries_no_pattern_state() {
    // Starting in NORMAL, the FSM may or may not arm during a segment; either
    // way the carried state must remain coherent (pattern_id == NONE or a
    // valid hero ID; candles_remaining only nonzero when forming).
    let st = new_state(1_000_000_000, 1_000_000, 1_000_000_000);
    let key = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    let (_, new_st, _, _) = expand_segment(st, key);
    assert!(
        new_st.pattern_id == PATTERN_NONE
            || (new_st.pattern_id >= 1 && new_st.pattern_id <= 6),
        0,
    );
    if (new_st.pattern_id == PATTERN_NONE) {
        assert!(new_st.candles_remaining == 0, 1);
    } else {
        assert!(new_st.candles_remaining > 0, 2);
    }
}
