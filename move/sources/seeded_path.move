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
public struct WalkState has copy, drop, store {
    price: u64,
    momentum: Signed,
    vol_regime: u64,
    home: u64,
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

/// Expand one segment: 6 candles from the carried walk state and a 32-byte
/// `segment_key`. Returns (candles, new walk state, segment min, segment max).
/// PURE and deterministic — the cross-language conformance contract.
public fun expand_segment(
    state: WalkState,
    key: vector<u8>,
): (vector<Candle>, WalkState, u64, u64) {
    let mut st = state;
    let mut candles = vector::empty<Candle>();
    let mut seg_min = st.price;
    let mut seg_max = st.price;
    let mut ci: u64 = 0;
    while (ci < CANDLES_PER_SEGMENT) {
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
        vector::push_back(&mut candles, Candle { open, high, low, close: st.price });
        if (low < seg_min) seg_min = low;
        if (high > seg_max) seg_max = high;
        ci = ci + 1;
    };
    (candles, st, seg_min, seg_max)
}

// ── Constructors and accessors ──────────────────────────────────────────────

/// A fresh walk state with zero momentum.
public fun new_state(price: u64, vol_regime: u64, home: u64): WalkState {
    WalkState { price, momentum: s_zero(), vol_regime, home }
}

/// Build a WalkState with an explicit momentum — used by the conformance test.
public fun state_with(
    price: u64,
    mom_neg: bool,
    mom_mag: u128,
    vol_regime: u64,
    home: u64,
): WalkState {
    WalkState { price, momentum: s_new(mom_neg, mom_mag), vol_regime, home }
}

public fun state_price(s: &WalkState): u64 { s.price }
public fun state_vol_regime(s: &WalkState): u64 { s.vol_regime }
public fun state_home(s: &WalkState): u64 { s.home }
public fun state_momentum_neg(s: &WalkState): bool { s.momentum.neg }
public fun state_momentum_mag(s: &WalkState): u128 { s.momentum.mag }

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
