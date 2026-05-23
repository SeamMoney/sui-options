#!/usr/bin/env python3
"""Monte Carlo simulator for the round-based shared-barrier segment market.

Implements the doc 19 / doc 18 segment-market design and validates the
Phase B7 economics:

  (a) Per-tier multiplier calibration — symmetric ±5 % barriers + 2x
      multiplier => positive vault edge per round.
  (b) Open-window selection — a bot that opens at the last possible
      segment of the open window (segment_into_round = OPEN_WINDOW-1) and
      picks the closer barrier should NOT have a profitable edge, because
      spot drifts only marginally in ~5 s.
  (c) Per-barrier cap pile-on — with the per-barrier max-payout cap, the
      vault's worst-case liability per round per market is bounded by
      `MAX_PAYOUT_PER_BARRIER × 2` (one per side).

This script ports the integer fixed-point math from
`move/sources/seeded_path.move` so the underlying walk is exactly the one
the on-chain `record_segment` would generate — every constant lifted
verbatim. Python `int` is used everywhere for u64/u128 emulation.

Outputs go to stdout (and an optional JSON file) so the report writer can
quote the numerical findings directly.

Run:
    python3 scripts/simulate_segment_protocol.py
    python3 scripts/simulate_segment_protocol.py --rounds 50000 --seed 17
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import struct
import sys
from dataclasses import dataclass, field

try:
    import numpy as np
    _HAVE_NUMPY = True
except ImportError:
    _HAVE_NUMPY = False

# =========================================================================
# Fixed-point constants — VERBATIM transcription of seeded_path.move §1
# Do not rename. Any drift here breaks cross-implementation determinism.
# =========================================================================

ONE = 1_000_000               # vol_regime / coefficient scale
HALF = 500_000                # 0.5 at the draw scale
DRAW_DEN = 1_000_000          # uniform draw in [0, DRAW_DEN)
E18 = 1_000_000_000_000_000_000
MIN_PRICE = 1                 # u64 floor

CANDLES_PER_SEGMENT = 6
TICKS_PER_CANDLE = 6
DRAWS_PER_TICK = 7            # keystream stride per step

# Walk coefficients — exactly the values in seeded_path.move
VR_MIN = 250_000
VR_MAX = 3_600_000
C_VR_JITTER = 300_000
C_VR_JUMP_PROB = 40_000
C_VR_JUMP = 3_000_000
C_VR_REVERT = 45_000
C_MOM_JITTER = 2_600
C_MOM_DECAY = 820_000
C_MOM_CAP = 13_000
C_REVERT = 7_000
C_VOL = 6_000
VOL_FLOOR = 400_000
C_FAT_PROB = 70_000
C_FAT_BASE = 2_500_000
C_MAX_DELTA = 60_000

U64_MAX = (1 << 64) - 1

# =========================================================================
# Segment-market constants — doc 19 §4 defaults
# =========================================================================

DEFAULT_SEGMENT_MS = 400
ROUND_DURATION_SEGMENTS = 75           # 30 s
OPEN_WINDOW_SEGMENTS = 13              # ~5.2 s
BARRIER_OFFSET_BPS = 500               # ±5 %
MULTIPLIER_BPS = 20_000                # 2x
BPS = 10_000

# Provisional 10 % of seed treasury per-barrier cap. The simulator works in
# arbitrary collateral units; the per-barrier cap is a u64.
SEED_TREASURY = 1_000_000_000          # 1.0 (in micro-USD-ish units)
MAX_PAYOUT_PER_BARRIER = SEED_TREASURY // 10  # 10 %

# Deadband is set to the protocol's default arcade value.
DEADBAND_BPS = 20

# Stake range — same scale as the seed treasury units.
MIN_STAKE_PER_SEGMENT = 100             # tiny per-segment trickle
MAX_STAKE_PER_SEGMENT = 10_000          # rider-side cap
DEFAULT_STAKE_PER_SEGMENT = 1_000       # default for uniform rider profile

# Starting price for the simulated walk — micro-USD.
HOME_PRICE = 1_000_000_000              # $1 000.00


# =========================================================================
# Signed sign-magnitude arithmetic — port of seeded_path.move §"Signed arithmetic"
# Move semantics: zero is canonically non-negative; mag is u128.
# Python `int` is arbitrary-precision; we mask via `& ((1<<128)-1)` only when
# the source explicitly relies on u128 truncation (it doesn't).
# =========================================================================

@dataclass
class Signed:
    neg: bool
    mag: int                            # treated as u128

    def __post_init__(self) -> None:
        # Canonical form: zero is positive.
        if self.mag == 0:
            self.neg = False


def s_zero() -> Signed:
    return Signed(False, 0)


def s_pos(mag: int) -> Signed:
    return Signed(False, mag)


def s_new(neg: bool, mag: int) -> Signed:
    return Signed(neg and mag != 0, mag)


def s_add(a: Signed, b: Signed) -> Signed:
    if a.neg == b.neg:
        return s_new(a.neg, a.mag + b.mag)
    if a.mag >= b.mag:
        return s_new(a.neg, a.mag - b.mag)
    return s_new(b.neg, b.mag - a.mag)


def s_sub(a: Signed, b: Signed) -> Signed:
    return s_add(a, s_new(not b.neg, b.mag))


def s_mul_div(a: Signed, mul: int, div: int) -> Signed:
    # Truncating integer division — same as Move.
    return s_new(a.neg, a.mag * mul // div)


def s_clamp_mag(a: Signed, max_mag: int) -> Signed:
    if a.mag > max_mag:
        return s_new(a.neg, max_mag)
    return a


def s_apply(price: int, delta: Signed) -> int:
    """`price + delta`, floored at MIN_PRICE."""
    if not delta.neg:
        return price + delta.mag
    d = delta.mag
    if d >= price:
        return MIN_PRICE
    r = price - d
    return MIN_PRICE if r < MIN_PRICE else r


def centered(d: int) -> Signed:
    """Re-centre a draw in [0, DRAW_DEN) to the signed value (d - 0.5)."""
    if d >= HALF:
        return s_pos(d - HALF)
    return s_new(True, HALF - d)


def clamp_to_u64(s: Signed, lo: int, hi: int) -> int:
    if s.neg:
        return lo
    m = s.mag
    if m < lo:
        return lo
    if m > hi:
        return hi
    return m


# =========================================================================
# Entropy layer — port of `keystream_word` from seeded_path.move
# blake2b256(key || le8(n)), low 8 bytes read little-endian.
#
# Two modes:
#  - "exact": call blake2b once per draw, byte-identical to the Move
#    on-chain function. Used for the determinism selftest and any time
#    bit-equivalence to the Move output is needed.
#  - "fast": use a stdlib RNG to draw uniforms directly. The simulator
#    is validating distributional properties (mean edge, percentiles,
#    cap behaviour) so any properly-uniform RNG gives statistically
#    identical results to the exact path. Used for the 10k-round sweeps.
# =========================================================================

def keystream_word(key: bytes, n: int) -> int:
    """Exact-mode keystream word — Move-identical."""
    # Move's bcs::to_bytes(&n) for a u64 is 8 little-endian bytes.
    digest = hashlib.blake2b(key + struct.pack("<Q", n), digest_size=32).digest()
    # Low 8 bytes interpreted LE.
    return struct.unpack("<Q", digest[:8])[0]


def draw_uniform(key: bytes, n: int) -> int:
    """Exact-mode uniform — calls blake2b. Use ONLY for selftest +
    reproducibility checks."""
    return keystream_word(key, n) % DRAW_DEN


# Per-segment fast-mode key cache — we still PASS a key around (so the
# scenarios look like the Move runtime) but the draws come from a
# per-key RNG seeded with the key bytes. Using numpy for the bulk
# uniform sample if available (much faster than Python's randrange).

_FAST_RNG_CACHE: dict[bytes, object] = {}
_FAST_RNG_CACHE_MAX = 256


def _fast_rng_for_key(key: bytes):
    rng = _FAST_RNG_CACHE.get(key)
    if rng is not None:
        return rng
    if len(_FAST_RNG_CACHE) >= _FAST_RNG_CACHE_MAX:
        _FAST_RNG_CACHE.clear()
    seed_int = int.from_bytes(key, "little")
    if _HAVE_NUMPY:
        # numpy 64-bit seed accepts a small int (mod 2**32).
        rng = np.random.default_rng(seed_int & ((1 << 64) - 1))
    else:
        rng = random.Random(seed_int)
    _FAST_RNG_CACHE[key] = rng
    return rng


def draw_uniform_fast_batch(key: bytes, n_draws: int) -> list[int]:
    """Pre-compute `n_draws` uniform draws in [0, DRAW_DEN). Distributional
    equivalence is what matters."""
    rng = _fast_rng_for_key(key)
    if _HAVE_NUMPY:
        # numpy.integers is much faster than Python randrange.
        return rng.integers(0, DRAW_DEN, size=n_draws, dtype=np.int64).tolist()
    return [rng.randrange(DRAW_DEN) for _ in range(n_draws)]


# =========================================================================
# WalkState + step() + expand_segment() — port of seeded_path.move §"The walk"
# =========================================================================

@dataclass
class WalkState:
    price: int
    momentum: Signed = field(default_factory=s_zero)
    vol_regime: int = ONE
    home: int = HOME_PRICE
    # Fast path: signed-int momentum. Kept in sync with `momentum` (Signed)
    # for back-compat with selftests. `expand_segment` reads/writes this.
    momentum_int: int = 0

    def __post_init__(self) -> None:
        # If caller set `momentum` (Signed), mirror into momentum_int.
        if self.momentum is not None and self.momentum_int == 0:
            self.momentum_int = -self.momentum.mag if self.momentum.neg else self.momentum.mag


USE_FAST_DRAWS = True


def expand_segment(state: WalkState, key: bytes) -> tuple[WalkState, int, int]:
    """Run one segment: 6 candles, 6 ticks/candle, 7 draws/tick. Returns
    the new walk state plus segment (min, max) extremes.

    Optimised: replaces the Signed sign-magnitude wrappers with plain
    Python ints (Python ints are arbitrary precision so this is
    semantically equivalent). For draws, uses the fast RNG path by
    default — `USE_FAST_DRAWS = False` switches to the exact blake2b
    keystream for the determinism selftest.
    """
    price = state.price
    momentum = state.momentum_int        # signed Python int
    vol_regime = state.vol_regime
    home = state.home
    seg_min = price
    seg_max = price

    n_ticks = CANDLES_PER_SEGMENT * TICKS_PER_CANDLE  # 36
    n_draws = n_ticks * DRAWS_PER_TICK                # 252

    if USE_FAST_DRAWS:
        draws = draw_uniform_fast_batch(key, n_draws)
    else:
        # Exact mode — must match Move byte-for-byte.
        draws = [draw_uniform(key, n) for n in range(n_draws)]

    _CENTER = HALF

    for ti in range(n_ticks):
        base = ti * DRAWS_PER_TICK
        d0 = draws[base]
        d1 = draws[base + 1]
        d2 = draws[base + 2]
        d3 = draws[base + 3]
        d4 = draws[base + 4]
        d5 = draws[base + 5]
        d6 = draws[base + 6]

        # 1 — Volatility regime.
        cd0 = d0 - _CENTER
        # Truncating multiply-divide on a signed int — inline for speed.
        if cd0 >= 0:
            vr_jit = (cd0 * C_VR_JITTER) // ONE
        else:
            vr_jit = -((-cd0 * C_VR_JITTER) // ONE)
        vr = vol_regime + vr_jit
        if d1 < C_VR_JUMP_PROB:
            cd2 = d2 - _CENTER
            if cd2 >= 0:
                vr_jmp = (cd2 * C_VR_JUMP) // ONE
            else:
                vr_jmp = -((-cd2 * C_VR_JUMP) // ONE)
            vr = vr + vr_jmp
        to_one = ONE - vr
        if to_one >= 0:
            vr_rev = (to_one * C_VR_REVERT) // ONE
        else:
            vr_rev = -((-to_one * C_VR_REVERT) // ONE)
        vr = vr + vr_rev
        if vr < VR_MIN:
            vol_regime = VR_MIN
        elif vr > VR_MAX:
            vol_regime = VR_MAX
        else:
            vol_regime = vr

        # 2 — Momentum.
        cd3 = d3 - _CENTER
        if cd3 >= 0:
            jitter = (cd3 * price * C_MOM_JITTER * vol_regime) // E18
        else:
            jitter = -((-cd3 * price * C_MOM_JITTER * vol_regime) // E18)
        mom_pre = momentum + jitter
        if mom_pre >= 0:
            momentum = (mom_pre * C_MOM_DECAY) // ONE
        else:
            momentum = -((-mom_pre * C_MOM_DECAY) // ONE)
        mcap = (price * C_MOM_CAP) // ONE
        if momentum > mcap:
            momentum = mcap
        elif momentum < -mcap:
            momentum = -mcap

        # 3 — Per-tick delta = momentum + revert + fat-tailed noise.
        diff = home - price
        if diff >= 0:
            revert = (diff * C_REVERT) // ONE
        else:
            revert = -((-diff * C_REVERT) // ONE)
        vol = (price * C_VOL) // ONE
        if vol < VOL_FLOOR:
            vol = VOL_FLOOR
        vol = (vol * vol_regime) // ONE
        if d4 < C_FAT_PROB:
            fat = C_FAT_BASE + (d5 * C_FAT_BASE) // ONE
            vol = (vol * fat) // ONE
        cd6 = d6 - _CENTER
        if cd6 >= 0:
            noise = (cd6 * vol) // ONE
        else:
            noise = -((-cd6 * vol) // ONE)
        delta = momentum + revert + noise
        dcap = (price * C_MAX_DELTA) // ONE
        if delta > dcap:
            delta = dcap
        elif delta < -dcap:
            delta = -dcap

        new_price = price + delta
        if new_price < MIN_PRICE:
            new_price = MIN_PRICE
        price = new_price
        if price > seg_max:
            seg_max = price
        if price < seg_min:
            seg_min = price

    new_state = WalkState(price=price, momentum=s_zero(), vol_regime=vol_regime,
                          home=home)
    new_state.momentum_int = momentum
    new_state.momentum = Signed(momentum < 0, abs(momentum))
    return new_state, seg_min, seg_max


def _trunc_mul_div(x: int, mul: int, div: int) -> int:
    """Move-compatible truncating multiply-divide for signed ints.

    The Move source does:
        s_mul_div(a, mul, div) = s_new(a.neg, a.mag * mul / div)
    which truncates the magnitude (positive division) and re-applies the
    sign. Python's `//` on negatives floors instead of truncating, so we
    emulate by working on the magnitude.
    """
    if x >= 0:
        return (x * mul) // div
    return -((-x * mul) // div)


def fresh_walk(home: int = HOME_PRICE) -> WalkState:
    return WalkState(price=home, momentum=s_zero(), vol_regime=ONE, home=home)


# =========================================================================
# Deadband helpers — port of path_observation::apply_deadband_*
# =========================================================================

def add_deadband_up(trigger: int, barrier: int, deadband_bps: int) -> int:
    if deadband_bps == 0:
        return trigger
    margin = barrier * deadband_bps // BPS
    scaled = trigger + margin
    return min(scaled, U64_MAX)


def sub_deadband_down(trigger: int, barrier: int, deadband_bps: int) -> int:
    if deadband_bps == 0:
        return trigger
    margin = barrier * deadband_bps // BPS
    return max(0, trigger - margin)


# =========================================================================
# Per-segment record stored on chain (just the extremes — that's all
# `scan_for_touch` reads).
# =========================================================================

@dataclass
class Segment:
    idx: int
    smin: int
    smax: int
    state_after: WalkState              # for inspection / future use


# =========================================================================
# Round bookkeeping — per doc 19
# =========================================================================

UPPER = 0
LOWER = 1


@dataclass
class RoundState:
    round_index: int
    started_at_segment: int
    upper_barrier: int
    lower_barrier: int

    # Per-barrier trackers — populated by opens, drained by closes.
    upper_agg_stake: int = 0
    lower_agg_stake: int = 0
    upper_agg_max_payout: int = 0
    lower_agg_max_payout: int = 0
    upper_rider_count: int = 0
    lower_rider_count: int = 0


# =========================================================================
# Settlement outcomes
# =========================================================================

SETTLE_TOUCH_WIN = 1
SETTLE_CASHOUT = 2
SETTLE_EXPIRED_LOSS = 3
SETTLE_ABORTED_REFUND = 4

SETTLE_NAME = {
    SETTLE_TOUCH_WIN: "touch_win",
    SETTLE_CASHOUT: "cashout",
    SETTLE_EXPIRED_LOSS: "expired_loss",
    SETTLE_ABORTED_REFUND: "aborted_refund",
}


@dataclass
class Ride:
    rid: str
    round_index: int
    entry_segment_index: int
    barrier_index: int                  # UPPER=0 / LOWER=1
    stake_per_segment: int
    escrowed: int                       # >= stake_per_segment × ROUND_DURATION_SEGMENTS
    multiplier_bps: int

    closed: bool = False
    settlement_kind: int = 0
    stake_paid: int = 0
    payout: int = 0                     # vault -> user (positive net wager outcome)
    refund: int = 0                     # escrow remainder returned unchanged


# =========================================================================
# scan_for_touch — port of segment_market.move §7
# =========================================================================

def scan_for_touch(segments: list[Segment], from_idx: int, to_idx: int,
                   barrier: int, direction_above: bool,
                   deadband_bps: int = DEADBAND_BPS) -> bool:
    """Inclusive lower bound, exclusive upper bound — segments[from_idx..to_idx]."""
    if direction_above:
        eff = add_deadband_up(barrier, barrier, deadband_bps)
    else:
        eff = sub_deadband_down(barrier, barrier, deadband_bps)
    for k in range(from_idx, to_idx):
        if k >= len(segments):
            break
        seg = segments[k]
        if direction_above:
            if seg.smax >= eff:
                return True
        else:
            if seg.smin <= eff:
                return True
    return False


# =========================================================================
# Round driver — runs ONE round (75 segments) and settles all rides
# =========================================================================

@dataclass
class RiderOpen:
    """An intent to open at a specific segment_into_round and pick a barrier."""
    segment_into_round: int
    chooser: callable                   # (segments_so_far, round_state) -> barrier_index
    stake_per_segment: int = DEFAULT_STAKE_PER_SEGMENT
    label: str = "uniform"


@dataclass
class RoundResult:
    round_index: int
    upper_barrier: int
    lower_barrier: int
    starting_spot: int
    ending_spot: int

    rides: list[Ride] = field(default_factory=list)

    # Vault flows for this round.
    vault_in: int = 0                   # forfeit stake + escrow consumed
    vault_out: int = 0                  # touch payouts + cashouts
    max_liability: int = 0              # max simultaneous obligation in this round

    rejected_opens: int = 0             # opens that hit the per-barrier cap

    # Segment ledger — exposed for selection diagnostics (scenario b).
    segments: list[Segment] = field(default_factory=list)

    @property
    def vault_pnl(self) -> int:
        return self.vault_in - self.vault_out


def random_keys(rng: random.Random, count: int) -> list[bytes]:
    return [rng.getrandbits(256).to_bytes(32, "little") for _ in range(count)]


def precompute_round(walk_in: WalkState, rng: random.Random
                     ) -> tuple[list[Segment], WalkState]:
    """Generate all ROUND_DURATION_SEGMENTS for the round in advance,
    using fresh random keys (drawn from `rng`, simulating sui::random).
    Returns the segment list and the walk state after the last segment."""
    keys = random_keys(rng, ROUND_DURATION_SEGMENTS)
    segs: list[Segment] = []
    st = walk_in
    for k in range(ROUND_DURATION_SEGMENTS):
        new_st, smin, smax = expand_segment(st, keys[k])
        segs.append(Segment(idx=k, smin=smin, smax=smax, state_after=new_st))
        st = new_st
    return segs, st


def simulate_round(walk_in: WalkState, rng: random.Random,
                   rider_intents: list[RiderOpen]) -> tuple[RoundResult, WalkState]:
    """Run one round end-to-end.

    The simulator's round mechanics mirror doc 19:
      - Barriers are computed from spot at round-start (== `walk_in.price`).
      - The full segment ledger is pre-rolled.
      - Rider intents are applied IN ORDER of `segment_into_round`. Opens
        outside the open window or exceeding the per-barrier cap are rejected.
      - At round end, EVERY open ride is settled: touch_win OR expired_loss
        (no voluntary cashout in this v1 model — every rider holds the
        round). This is the worst-case stress for the vault (max payout
        liability per barrier).
    """
    starting_spot = walk_in.price

    # Round 0 starts at segment 0. For this simulator we model every round
    # as a self-contained 75-segment slice; the walk state carries across.
    upper_b = starting_spot + (starting_spot * BARRIER_OFFSET_BPS) // BPS
    lower = (starting_spot * BARRIER_OFFSET_BPS) // BPS
    lower_b = max(1, starting_spot - lower)
    rs = RoundState(round_index=0, started_at_segment=0,
                    upper_barrier=upper_b, lower_barrier=lower_b)

    segments, walk_out = precompute_round(walk_in, rng)
    ending_spot = walk_out.price

    result = RoundResult(
        round_index=0,
        upper_barrier=upper_b,
        lower_barrier=lower_b,
        starting_spot=starting_spot,
        ending_spot=ending_spot,
    )

    # Apply rider intents at their requested segment-into-round.
    rider_intents = sorted(rider_intents, key=lambda r: r.segment_into_round)
    open_rides: list[Ride] = []
    rid_counter = 0
    for intent in rider_intents:
        seg_in = intent.segment_into_round
        if seg_in >= OPEN_WINDOW_SEGMENTS:
            result.rejected_opens += 1
            continue
        chosen = intent.chooser(segments[:seg_in], rs)
        assert chosen in (UPPER, LOWER), f"bad barrier index {chosen}"

        stake_per = max(MIN_STAKE_PER_SEGMENT,
                        min(MAX_STAKE_PER_SEGMENT, intent.stake_per_segment))
        escrowed = stake_per * ROUND_DURATION_SEGMENTS
        per_open_max_payout = escrowed * MULTIPLIER_BPS // BPS

        if chosen == UPPER:
            new_agg = rs.upper_agg_max_payout + per_open_max_payout
            if new_agg > MAX_PAYOUT_PER_BARRIER:
                result.rejected_opens += 1
                continue
            rs.upper_agg_stake += escrowed
            rs.upper_agg_max_payout = new_agg
            rs.upper_rider_count += 1
        else:
            new_agg = rs.lower_agg_max_payout + per_open_max_payout
            if new_agg > MAX_PAYOUT_PER_BARRIER:
                result.rejected_opens += 1
                continue
            rs.lower_agg_stake += escrowed
            rs.lower_agg_max_payout = new_agg
            rs.lower_rider_count += 1

        ride = Ride(
            rid=f"r{rid_counter}",
            round_index=0,
            entry_segment_index=seg_in,
            barrier_index=chosen,
            stake_per_segment=stake_per,
            escrowed=escrowed,
            multiplier_bps=MULTIPLIER_BPS,
        )
        rid_counter += 1
        open_rides.append(ride)

    # Worst-case liability is the sum of (max_payout) on each barrier — i.e.
    # everyone wins simultaneously (one full pile-on per barrier).
    result.max_liability = max(rs.upper_agg_max_payout, rs.lower_agg_max_payout)
    # The vault has TWO barriers; total simultaneous liability is the sum.
    # The cap design guarantees this is <= 2 × MAX_PAYOUT_PER_BARRIER.
    total_liability = rs.upper_agg_max_payout + rs.lower_agg_max_payout

    # Settle every ride at the round boundary. Stake is per-segment ×
    # segments held. Everyone holds to the end (worst case for vault), so
    # `segments_held = round_duration - entry_segment_index`.
    for ride in open_rides:
        segments_held = ROUND_DURATION_SEGMENTS - ride.entry_segment_index
        stake_paid = min(segments_held * ride.stake_per_segment, ride.escrowed)

        barrier = rs.upper_barrier if ride.barrier_index == UPPER else rs.lower_barrier
        direction_above = (ride.barrier_index == UPPER)
        touched = scan_for_touch(
            segments,
            ride.entry_segment_index,
            ROUND_DURATION_SEGMENTS,
            barrier,
            direction_above,
        )

        ride.closed = True
        ride.stake_paid = stake_paid

        if touched:
            ride.settlement_kind = SETTLE_TOUCH_WIN
            payout = stake_paid * ride.multiplier_bps // BPS
            ride.payout = payout
            ride.refund = ride.escrowed - stake_paid
            # Vault perspective:
            #   - takes stake_paid (the loser side / locked stake),
            #   - returns payout (the leveraged win).
            #   - escrow remainder is just user funds bouncing back; no PnL.
            result.vault_in += stake_paid
            result.vault_out += payout
        else:
            ride.settlement_kind = SETTLE_EXPIRED_LOSS
            ride.payout = 0
            ride.refund = ride.escrowed - stake_paid
            result.vault_in += stake_paid  # forfeit -> vault

        result.rides.append(ride)

    # Stash the worst-case liability metric (used by scenario c).
    result.max_liability = total_liability
    result.segments = segments
    return result, walk_out


# =========================================================================
# Scenario (a) — per-tier multiplier calibration
# =========================================================================

def _settle_one_round_with_multiplier(walk_in: WalkState, rng: random.Random,
                                      n_riders: int, mult_bps: int,
                                      barrier_offset_bps: int = BARRIER_OFFSET_BPS,
                                      ) -> tuple[RoundResult, WalkState]:
    """Variant of `simulate_round` parameterised by multiplier and barrier
    offset, for the multiplier-tier sweep."""
    starting_spot = walk_in.price
    upper_b = starting_spot + (starting_spot * barrier_offset_bps) // BPS
    lower = (starting_spot * barrier_offset_bps) // BPS
    lower_b = max(1, starting_spot - lower)
    rs = RoundState(round_index=0, started_at_segment=0,
                    upper_barrier=upper_b, lower_barrier=lower_b)

    segments, walk_out = precompute_round(walk_in, rng)
    result = RoundResult(round_index=0, upper_barrier=upper_b, lower_barrier=lower_b,
                         starting_spot=starting_spot, ending_spot=walk_out.price)

    open_rides: list[Ride] = []
    for i in range(n_riders):
        seg_in = rng.randrange(OPEN_WINDOW_SEGMENTS)
        chosen = rng.randrange(2)
        stake_per = DEFAULT_STAKE_PER_SEGMENT
        escrowed = stake_per * ROUND_DURATION_SEGMENTS
        per_open_max_payout = escrowed * mult_bps // BPS
        if chosen == UPPER:
            if rs.upper_agg_max_payout + per_open_max_payout > MAX_PAYOUT_PER_BARRIER:
                result.rejected_opens += 1
                continue
            rs.upper_agg_max_payout += per_open_max_payout
            rs.upper_agg_stake += escrowed
        else:
            if rs.lower_agg_max_payout + per_open_max_payout > MAX_PAYOUT_PER_BARRIER:
                result.rejected_opens += 1
                continue
            rs.lower_agg_max_payout += per_open_max_payout
            rs.lower_agg_stake += escrowed
        open_rides.append(Ride(
            rid=f"r{i}", round_index=0, entry_segment_index=seg_in,
            barrier_index=chosen, stake_per_segment=stake_per,
            escrowed=escrowed, multiplier_bps=mult_bps,
        ))

    for ride in open_rides:
        segments_held = ROUND_DURATION_SEGMENTS - ride.entry_segment_index
        stake_paid = min(segments_held * ride.stake_per_segment, ride.escrowed)
        barrier = rs.upper_barrier if ride.barrier_index == UPPER else rs.lower_barrier
        direction_above = (ride.barrier_index == UPPER)
        touched = scan_for_touch(segments, ride.entry_segment_index,
                                 ROUND_DURATION_SEGMENTS, barrier, direction_above)
        ride.closed = True
        ride.stake_paid = stake_paid
        if touched:
            ride.settlement_kind = SETTLE_TOUCH_WIN
            payout = stake_paid * ride.multiplier_bps // BPS
            ride.payout = payout
            ride.refund = ride.escrowed - stake_paid
            result.vault_in += stake_paid
            result.vault_out += payout
        else:
            ride.settlement_kind = SETTLE_EXPIRED_LOSS
            ride.payout = 0
            ride.refund = ride.escrowed - stake_paid
            result.vault_in += stake_paid
        result.rides.append(ride)
    return result, walk_out


def scenario_a_calibration(seed: int, n_rounds: int, riders_per_round: int
                           ) -> dict:
    """Each round: a fixed number of riders open uniformly at random within
    the open window, picking each barrier 50/50. Realised house edge per
    dollar staked is the headline.

    Also runs a multiplier-tier sweep over {1.05×, 1.10×, 1.20×, 1.50×,
    1.80×, 2.00×, 2.50×, 3.00×, 5.00×} so the report can recommend a
    multiplier that yields a defensible positive edge.
    """
    rng = random.Random(seed)
    walk = fresh_walk()

    edges: list[float] = []                  # vault_pnl / total_stake_paid
    pnls: list[int] = []
    touch_counts = 0
    expired_counts = 0
    rounds_with_loss = 0
    rounds_with_gain = 0

    for _ in range(n_rounds):
        intents: list[RiderOpen] = []
        for _ in range(riders_per_round):
            seg_in = rng.randrange(OPEN_WINDOW_SEGMENTS)
            barrier_choice = rng.randrange(2)
            intents.append(RiderOpen(
                segment_into_round=seg_in,
                chooser=lambda segs, rs, b=barrier_choice: b,
                stake_per_segment=DEFAULT_STAKE_PER_SEGMENT,
                label="uniform",
            ))
        result, walk = simulate_round(walk, rng, intents)

        # Per-round metrics
        total_stake = sum(r.stake_paid for r in result.rides) or 1
        edges.append(result.vault_pnl / total_stake)
        pnls.append(result.vault_pnl)
        for r in result.rides:
            if r.settlement_kind == SETTLE_TOUCH_WIN:
                touch_counts += 1
            elif r.settlement_kind == SETTLE_EXPIRED_LOSS:
                expired_counts += 1
        if result.vault_pnl < 0:
            rounds_with_loss += 1
        elif result.vault_pnl > 0:
            rounds_with_gain += 1

    edges.sort()
    pnls.sort()
    n_rides = touch_counts + expired_counts
    realised_p_touch = (touch_counts / n_rides) if n_rides else 0.0

    # ---- Multiplier-tier sweep ----
    # Sweep is for tier orientation, not for percentile precision; cap at
    # 2 000 rounds per tier to keep total runtime manageable.
    sweep_rounds = min(2_000, max(500, n_rounds // 5))
    tier_results: list[dict] = []
    for mult_bps in (10_500, 11_000, 12_000, 15_000,
                     18_000, 20_000, 25_000, 30_000, 50_000):
        sweep_rng = random.Random(seed + mult_bps)
        sweep_walk = fresh_walk()
        sweep_edges: list[float] = []
        sweep_touch = 0
        sweep_rides = 0
        for _ in range(sweep_rounds):
            r, sweep_walk = _settle_one_round_with_multiplier(
                sweep_walk, sweep_rng, riders_per_round, mult_bps,
            )
            total = sum(rd.stake_paid for rd in r.rides) or 1
            sweep_edges.append(r.vault_pnl / total)
            for rd in r.rides:
                if rd.settlement_kind == SETTLE_TOUCH_WIN:
                    sweep_touch += 1
                if rd.settlement_kind in (SETTLE_TOUCH_WIN, SETTLE_EXPIRED_LOSS):
                    sweep_rides += 1
        sweep_edges.sort()
        n = max(1, len(sweep_edges))
        p_touch_t = sweep_touch / max(1, sweep_rides)
        tier_results.append({
            "multiplier_bps": mult_bps,
            "realised_p_touch": p_touch_t,
            "mean_edge": sum(sweep_edges) / n,
            "median_edge": sweep_edges[n // 2],
            "edge_p05": sweep_edges[int(n * 0.05)],
            "fair_value_edge_check": 1.0 - (mult_bps / BPS) * p_touch_t,
        })

    return {
        "scenario": "a_calibration",
        "n_rounds": n_rounds,
        "riders_per_round": riders_per_round,
        "n_rides": n_rides,
        "realised_p_touch": realised_p_touch,
        "mean_edge_per_dollar": sum(edges) / len(edges),
        "median_edge": edges[len(edges) // 2],
        "edge_p05": edges[int(len(edges) * 0.05)],
        "edge_p95": edges[int(len(edges) * 0.95)],
        "mean_pnl_per_round": sum(pnls) / len(pnls),
        "pnl_min": min(pnls),
        "pnl_max": max(pnls),
        "rounds_with_vault_loss": rounds_with_loss,
        "rounds_with_vault_gain": rounds_with_gain,
        "loss_frequency": rounds_with_loss / n_rounds,
        "fair_value_edge": 1.0 - (MULTIPLIER_BPS / BPS) * realised_p_touch,
        # Reference: expected edge under symmetry-of-barrier assumption is
        #     E[edge] = 1 - M × P_touch (for a single-side picker; both sides
        #               share that formula given symmetric barriers).
        "tier_sweep_rounds": sweep_rounds,
        "tier_sweep": tier_results,
    }


# =========================================================================
# Joint (offset × multiplier) sweep — B7 follow-up
#
# Earlier B7 work showed:
#   - Doc 19 §4 defaults (±5 % × 2×) yield edge ≈ −70 % (catastrophic bleed).
#   - A 1-D sweep of multiplier alone at ±5 % flagged 1.10× as the only safe
#     tier — but that recommendation is over-corrected. 1.10× kills the
#     "fun money" feel (closer to a grind than a coin-flip).
#   - The full joint surface was never measured.
#
# This sweep measures the 5×5 grid (BARRIER_OFFSET_BPS × MULTIPLIER_BPS)
# and finds the cell(s) that satisfy the trifecta:
#   1. vault edge ∈ [5 %, 15 %] — defensible, not extractive
#   2. multiplier ≥ 1.5× — meaningful "Coin-flip" or "Lottery" payout feel
#   3. P(touch) ∈ [30 %, 65 %] — game feels alive, not boring or trivial
# =========================================================================

def joint_sweep_cell(seed: int, n_rounds: int, riders_per_round: int,
                     barrier_offset_bps: int, mult_bps: int) -> dict:
    """Run `n_rounds` of `riders_per_round` uniform openers at the given
    (offset, multiplier) and return per-cell economics."""
    rng = random.Random(seed)
    walk = fresh_walk()

    edges: list[float] = []                      # vault_pnl / total_stake_paid
    pnls: list[int] = []
    touch_count = 0
    expired_count = 0
    payouts_per_round: list[int] = []
    stake_paid_per_round: list[int] = []

    for _ in range(n_rounds):
        result, walk = _settle_one_round_with_multiplier(
            walk, rng, riders_per_round, mult_bps,
            barrier_offset_bps=barrier_offset_bps,
        )
        total_stake = sum(r.stake_paid for r in result.rides) or 1
        edges.append(result.vault_pnl / total_stake)
        pnls.append(result.vault_pnl)
        round_payout = 0
        round_stake = 0
        for r in result.rides:
            round_stake += r.stake_paid
            if r.settlement_kind == SETTLE_TOUCH_WIN:
                touch_count += 1
                round_payout += r.payout
            elif r.settlement_kind == SETTLE_EXPIRED_LOSS:
                expired_count += 1
        payouts_per_round.append(round_payout)
        stake_paid_per_round.append(round_stake)

    edges.sort()
    pnls.sort()
    n_rides = touch_count + expired_count
    p_touch = touch_count / max(1, n_rides)

    return {
        "barrier_offset_bps": barrier_offset_bps,
        "multiplier_bps": mult_bps,
        "n_rounds": n_rounds,
        "n_rides": n_rides,
        "realised_p_touch": p_touch,
        "mean_edge_per_dollar": sum(edges) / max(1, len(edges)),
        "edge_p05": edges[int(len(edges) * 0.05)] if edges else 0.0,
        "edge_p95": edges[int(len(edges) * 0.95)] if edges else 0.0,
        "mean_pnl_per_round": sum(pnls) / max(1, len(pnls)),
        "mean_payout_per_round": sum(payouts_per_round) / max(1, len(payouts_per_round)),
        "mean_stake_paid_per_round": (sum(stake_paid_per_round)
                                       / max(1, len(stake_paid_per_round))),
        "fair_value_edge_check": 1.0 - (mult_bps / BPS) * p_touch,
    }


# Grid per the B7 follow-up brief.
JOINT_SWEEP_OFFSETS = (500, 750, 1000, 1500, 2000)
JOINT_SWEEP_MULTIPLIERS = (11_000, 13_000, 15_000, 17_500, 20_000)


def scenario_joint_sweep(seed: int, n_rounds: int, riders_per_round: int,
                         offsets: tuple[int, ...] = JOINT_SWEEP_OFFSETS,
                         multipliers: tuple[int, ...] = JOINT_SWEEP_MULTIPLIERS,
                         ) -> dict:
    """Run the full 5 × 5 grid and return a structured result for the
    report writer + a sweet-spot recommendation."""
    cells: list[dict] = []
    cell_idx = 0
    for offset in offsets:
        for mult in multipliers:
            cell_seed = seed + cell_idx
            cells.append(joint_sweep_cell(
                seed=cell_seed, n_rounds=n_rounds,
                riders_per_round=riders_per_round,
                barrier_offset_bps=offset, mult_bps=mult,
            ))
            cell_idx += 1

    # Sweet-spot filter — all three must hold.
    def in_zone(cell: dict) -> bool:
        edge = cell["mean_edge_per_dollar"]
        m = cell["multiplier_bps"] / BPS
        p = cell["realised_p_touch"]
        return (0.05 <= edge <= 0.15
                and m >= 1.5
                and 0.30 <= p <= 0.65)

    sweet_cells = [c for c in cells if in_zone(c)]

    # Closest-to-zone fallback ranking (Manhattan distance from the box).
    def distance_to_zone(cell: dict) -> float:
        edge = cell["mean_edge_per_dollar"]
        m = cell["multiplier_bps"] / BPS
        p = cell["realised_p_touch"]
        d_edge = max(0.0, 0.05 - edge) + max(0.0, edge - 0.15)
        d_m = max(0.0, 1.5 - m)
        d_p = max(0.0, 0.30 - p) + max(0.0, p - 0.65)
        return d_edge + d_m + d_p

    cells_by_distance = sorted(cells, key=distance_to_zone)

    return {
        "scenario": "joint_offset_x_multiplier_sweep",
        "n_rounds_per_cell": n_rounds,
        "riders_per_round": riders_per_round,
        "offsets_bps": list(offsets),
        "multipliers_bps": list(multipliers),
        "cells": cells,
        "sweet_cells": sweet_cells,
        "closest_to_zone_if_empty": cells_by_distance[:3],
    }


def print_joint_sweep(result: dict) -> None:
    offsets = result["offsets_bps"]
    mults = result["multipliers_bps"]
    cells_by_key = {(c["barrier_offset_bps"], c["multiplier_bps"]): c
                    for c in result["cells"]}

    # ---- Vault edge matrix ----
    print("\n  EDGE matrix  (mean vault edge per $ staked, "
          f"{result['n_rounds_per_cell']:,} rounds × "
          f"{result['riders_per_round']} riders/round per cell):")
    print(f"    rows = barrier ± offset (bps), cols = multiplier (×)")
    header = "    offset \\ mult".ljust(20) + "".join(
        f"{m / BPS:>10.2f}×" for m in mults)
    print(header)
    for offset in offsets:
        row = f"    ±{offset:>4d} bps".ljust(20)
        for m in mults:
            cell = cells_by_key[(offset, m)]
            row += f"{format_pct(cell['mean_edge_per_dollar']):>11s}"
        print(row)

    # ---- Realised P(touch) matrix ----
    print("\n  P(TOUCH) matrix  (realised per ride):")
    header = "    offset \\ mult".ljust(20) + "".join(
        f"{m / BPS:>10.2f}×" for m in mults)
    print(header)
    for offset in offsets:
        row = f"    ±{offset:>4d} bps".ljust(20)
        for m in mults:
            cell = cells_by_key[(offset, m)]
            row += f"{format_pct(cell['realised_p_touch']):>11s}"
        print(row)

    # ---- Mean payout / stake matrix (size of round flows) ----
    print("\n  MEAN PAYOUT matrix  (mean vault payout per round, raw units):")
    header = "    offset \\ mult".ljust(20) + "".join(
        f"{m / BPS:>11.2f}×" for m in mults)
    print(header)
    for offset in offsets:
        row = f"    ±{offset:>4d} bps".ljust(20)
        for m in mults:
            cell = cells_by_key[(offset, m)]
            row += f"{cell['mean_payout_per_round']:>12,.0f}"
        print(row)

    print("\n  MEAN STAKE_PAID matrix  (mean stake paid per round, raw units):")
    header = "    offset \\ mult".ljust(20) + "".join(
        f"{m / BPS:>11.2f}×" for m in mults)
    print(header)
    for offset in offsets:
        row = f"    ±{offset:>4d} bps".ljust(20)
        for m in mults:
            cell = cells_by_key[(offset, m)]
            row += f"{cell['mean_stake_paid_per_round']:>12,.0f}"
        print(row)

    # ---- Sweet-spot recommendation ----
    print("\n  Sweet-spot filter:")
    print("    edge ∈ [5%, 15%]   AND   multiplier ≥ 1.5×   AND   "
          "P(touch) ∈ [30%, 65%]")
    sweet = result["sweet_cells"]
    if sweet:
        print(f"  → {len(sweet)} cell(s) satisfy all three constraints:")
        for c in sweet:
            print(f"      ±{c['barrier_offset_bps']:>4d} bps × "
                  f"{c['multiplier_bps'] / BPS:.2f}×   "
                  f"edge={format_pct(c['mean_edge_per_dollar'])}   "
                  f"P(touch)={format_pct(c['realised_p_touch'])}   "
                  f"mean payout/round={c['mean_payout_per_round']:,.0f}")
    else:
        print("  → NO cell satisfies all three constraints.")
        print("    Closest-to-zone cells (Manhattan distance, smaller = closer):")
        for c in result["closest_to_zone_if_empty"]:
            print(f"      ±{c['barrier_offset_bps']:>4d} bps × "
                  f"{c['multiplier_bps'] / BPS:.2f}×   "
                  f"edge={format_pct(c['mean_edge_per_dollar'])}   "
                  f"P(touch)={format_pct(c['realised_p_touch'])}")


# =========================================================================
# Scenario (b) — open-window selection bot
# =========================================================================

def bot_choose_closer_barrier(segs_so_far: list[Segment],
                              rs: RoundState) -> int:
    """Strategy: at the latest visible segment, look at current spot and
    pick the closer of the two barriers (smaller `|spot - barrier|`)."""
    if not segs_so_far:
        # No information yet — coin-flip.
        return UPPER if (rs.upper_barrier - rs.lower_barrier) % 2 == 0 else LOWER
    # Use the latest segment's max/min midpoint as the current spot estimate.
    last = segs_so_far[-1]
    current_spot = (last.smax + last.smin) // 2
    dist_up = rs.upper_barrier - current_spot
    dist_dn = current_spot - rs.lower_barrier
    return UPPER if dist_up <= dist_dn else LOWER


def scenario_b_selection_bot(seed: int, n_rounds: int) -> dict:
    """Two parallel rider populations on the SAME walk:

      - "uniform" baseline: opens at segment 0, picks a 50/50 barrier.
      - "late-bot": opens at the LAST possible segment of the open window
        and picks the *closer* barrier given the visible segments so far.

    The bot's edge over the uniform baseline isolates selection. The raw
    bot edge could be dominated by walk volatility — what matters for the
    protocol is whether opening late + picking the close barrier confers
    information NOT available to a uniform opener.

    Also measures spot drift during the open window (the "headroom" a bot
    has to pick its winning barrier).
    """
    rng = random.Random(seed)
    walk = fresh_walk()

    bot_edges: list[float] = []
    uniform_edges: list[float] = []
    bot_touched: list[int] = []
    uniform_touched: list[int] = []
    pnls: list[int] = []
    spot_drifts_open_window_bps: list[float] = []
    spot_drifts_round_bps: list[float] = []
    bot_matched_winning_barrier: list[int] = []   # bot picked the touched barrier (if any)
    uniform_matched_winning_barrier: list[int] = []

    for _ in range(n_rounds):
        intents = [
            # Uniform baseline (opens at segment 0)
            RiderOpen(
                segment_into_round=0,
                chooser=lambda segs, rs: rng.randrange(2),
                stake_per_segment=DEFAULT_STAKE_PER_SEGMENT,
                label="uniform",
            ),
            # Late selection bot (opens at last open-window segment)
            RiderOpen(
                segment_into_round=OPEN_WINDOW_SEGMENTS - 1,
                chooser=bot_choose_closer_barrier,
                stake_per_segment=DEFAULT_STAKE_PER_SEGMENT,
                label="selection_bot",
            ),
        ]
        result, walk = simulate_round(walk, rng, intents)
        if len(result.rides) < 2:
            continue

        uniform_ride = next((r for r in result.rides
                             if r.entry_segment_index == 0), None)
        bot_ride = next((r for r in result.rides
                         if r.entry_segment_index == OPEN_WINDOW_SEGMENTS - 1), None)
        if uniform_ride is None or bot_ride is None:
            continue

        def ride_edge(r: Ride) -> float:
            stake = r.stake_paid or 1
            # User edge = (payout + refund - escrowed) / stake_paid
            # = (vault out from this ride - stake forfeit) / stake_paid
            user_net = r.payout - r.stake_paid     # net wager outcome
            return user_net / stake

        bot_edges.append(ride_edge(bot_ride))
        uniform_edges.append(ride_edge(uniform_ride))

        if bot_ride.settlement_kind == SETTLE_TOUCH_WIN:
            bot_touched.append(1)
            bot_matched_winning_barrier.append(1)
        else:
            bot_touched.append(0)
        if uniform_ride.settlement_kind == SETTLE_TOUCH_WIN:
            uniform_touched.append(1)
            uniform_matched_winning_barrier.append(1)
        else:
            uniform_touched.append(0)

        # Open-window drift: spot at last open-window segment vs spot at
        # round start. This is the *information* a bot has that a uniform
        # opener doesn't.
        # (the spot tracked by the simulator is the walk price after
        # each segment, so segments[OPEN_WINDOW_SEGMENTS-1].state_after.price
        # is what the bot sees at its open.)
        bot_visible_spot = result.segments[OPEN_WINDOW_SEGMENTS - 1].state_after.price
        ow_drift_bps = abs(bot_visible_spot - result.starting_spot) * BPS / result.starting_spot
        spot_drifts_open_window_bps.append(ow_drift_bps)
        drift_round_bps = abs(result.ending_spot - result.starting_spot) * BPS / result.starting_spot
        spot_drifts_round_bps.append(drift_round_bps)

    bot_edges.sort()
    uniform_edges.sort()
    spot_drifts_round_bps.sort()
    spot_drifts_open_window_bps.sort()
    n = max(1, len(bot_edges))

    bot_mean = sum(bot_edges) / n
    uniform_mean = sum(uniform_edges) / n
    selection_advantage = bot_mean - uniform_mean

    bot_p_touch = sum(bot_touched) / max(1, len(bot_touched))
    uniform_p_touch = sum(uniform_touched) / max(1, len(uniform_touched))

    return {
        "scenario": "b_selection_bot",
        "n_rounds": n_rounds,
        "n_rides": len(bot_edges),
        # Headline metric: bot edge - uniform-baseline edge.
        "selection_advantage_per_dollar": selection_advantage,
        "bot_mean_edge": bot_mean,
        "uniform_mean_edge": uniform_mean,
        "bot_p_touch": bot_p_touch,
        "uniform_p_touch": uniform_p_touch,
        "p_touch_advantage": bot_p_touch - uniform_p_touch,
        "bot_edge_p05": bot_edges[int(n * 0.05)],
        "bot_edge_p95": bot_edges[int(n * 0.95)],
        "bot_edge_p99": bot_edges[int(n * 0.99)],
        "mean_spot_drift_bps_round": sum(spot_drifts_round_bps) / len(spot_drifts_round_bps),
        "p95_spot_drift_bps_round": spot_drifts_round_bps[int(len(spot_drifts_round_bps) * 0.95)],
        "p99_spot_drift_bps_round": spot_drifts_round_bps[int(len(spot_drifts_round_bps) * 0.99)],
        # The "information advantage" — drift visible to the bot when it picks.
        "mean_spot_drift_bps_open_window": (sum(spot_drifts_open_window_bps)
                                            / len(spot_drifts_open_window_bps)),
        "p95_spot_drift_bps_open_window": spot_drifts_open_window_bps[
            int(len(spot_drifts_open_window_bps) * 0.95)],
        "p99_spot_drift_bps_open_window": spot_drifts_open_window_bps[
            int(len(spot_drifts_open_window_bps) * 0.99)],
        # The open-window length matters — quote it for the threat model.
        "open_window_seconds": OPEN_WINDOW_SEGMENTS * DEFAULT_SEGMENT_MS / 1000,
        "barrier_offset_bps": BARRIER_OFFSET_BPS,
    }


# =========================================================================
# Scenario (c) — per-barrier cap pile-on
# =========================================================================

def scenario_c_cap_pile_on(seed: int, n_rounds: int) -> dict:
    """Every rider opens on the UPPER barrier with maximum stake — the
    worst pile-on. The per-barrier cap should bound the vault's max
    liability per round to MAX_PAYOUT_PER_BARRIER (for the chosen barrier)
    and 2 × MAX_PAYOUT_PER_BARRIER if a symmetric pile-on happens on both.
    """
    rng = random.Random(seed)
    walk = fresh_walk()

    # Worst-stake rider: max stake per segment, max segments / round
    # → per-rider max payout = max_stake × duration × multiplier_bps / BPS.
    per_rider_max_payout = (MAX_STAKE_PER_SEGMENT
                            * ROUND_DURATION_SEGMENTS
                            * MULTIPLIER_BPS // BPS)
    # Number of riders required to saturate the cap.
    riders_to_saturate = (MAX_PAYOUT_PER_BARRIER + per_rider_max_payout - 1) // per_rider_max_payout
    # Try to oversubscribe by 2× — half should be rejected.
    riders_per_round = riders_to_saturate * 2

    per_barrier_obligations: list[int] = []
    total_obligations: list[int] = []
    rejections_per_round: list[int] = []
    cap_violations = 0
    realised_payouts_per_round: list[int] = []

    for _ in range(n_rounds):
        intents: list[RiderOpen] = []
        # Half the riders on UPPER, half on LOWER — pile-on on both sides
        # tests the full 2× cap envelope.
        for i in range(riders_per_round):
            chosen = UPPER if (i % 2 == 0) else LOWER
            intents.append(RiderOpen(
                segment_into_round=0,
                chooser=lambda segs, rs, b=chosen: b,
                stake_per_segment=MAX_STAKE_PER_SEGMENT,
                label="cap_piler",
            ))

        result, walk = simulate_round(walk, rng, intents)
        # max_payout_per_barrier observed = max of the two side aggregates.
        upper_agg = sum((r.escrowed * r.multiplier_bps // BPS)
                        for r in result.rides if r.barrier_index == UPPER)
        lower_agg = sum((r.escrowed * r.multiplier_bps // BPS)
                        for r in result.rides if r.barrier_index == LOWER)
        per_barrier_obligations.append(max(upper_agg, lower_agg))
        total_obligations.append(upper_agg + lower_agg)
        rejections_per_round.append(result.rejected_opens)
        realised_payouts_per_round.append(result.vault_out)
        if upper_agg > MAX_PAYOUT_PER_BARRIER or lower_agg > MAX_PAYOUT_PER_BARRIER:
            cap_violations += 1

    per_barrier_obligations.sort()
    total_obligations.sort()
    realised_payouts_per_round.sort()
    n = len(per_barrier_obligations)

    return {
        "scenario": "c_cap_pile_on",
        "n_rounds": n_rounds,
        "riders_per_round": riders_per_round,
        "per_rider_max_payout": per_rider_max_payout,
        "riders_required_to_saturate": riders_to_saturate,
        "cap_max_payout_per_barrier": MAX_PAYOUT_PER_BARRIER,
        "max_per_barrier_obligation_observed": per_barrier_obligations[-1],
        "mean_per_barrier_obligation": sum(per_barrier_obligations) / n,
        "max_total_obligation_observed": total_obligations[-1],
        "ratio_max_obligation_vs_cap": per_barrier_obligations[-1] / MAX_PAYOUT_PER_BARRIER,
        "cap_violations": cap_violations,                # MUST be zero
        "mean_rejected_opens_per_round": sum(rejections_per_round) / n,
        "max_realised_vault_payout_per_round": realised_payouts_per_round[-1],
        "mean_realised_vault_payout_per_round": sum(realised_payouts_per_round) / n,
    }


# =========================================================================
# Aux: sanity self-test against seeded_path conformance vector
# =========================================================================

def selftest_walk_determinism() -> None:
    """Same key + same starting state ⇒ same extremes IN EXACT MODE.
    Re-derives the basic Move test `expand_segment_deterministic`.
    Fast mode caches an RNG per key so consecutive calls draw fresh
    values; that's fine for distributional sampling but not for this
    selftest, which is the cross-impl determinism check."""
    global USE_FAST_DRAWS
    _save = USE_FAST_DRAWS
    USE_FAST_DRAWS = False
    try:
        key = bytes.fromhex("deadbeef" + "00" * 28)
        st = fresh_walk(500_000_000)
        st.vol_regime = 1_500_000
        st.home = 500_000_000
        _, lo1, hi1 = expand_segment(st, key)
        _, lo2, hi2 = expand_segment(st, key)
        assert lo1 == lo2 and hi1 == hi2, (
            f"walk is non-deterministic: ({lo1},{hi1}) vs ({lo2},{hi2})")
        assert MIN_PRICE <= lo1 <= hi1, "extremes invalid"
    finally:
        USE_FAST_DRAWS = _save


def selftest_walk_basic_shape() -> None:
    """The walk should occasionally move the price away from home — i.e.
    seg_max > seg_min strictly for almost every segment with a non-zero
    key. Run in whatever mode is current."""
    rng = random.Random(7)
    st = fresh_walk()
    moves = 0
    for _ in range(50):
        key = rng.getrandbits(256).to_bytes(32, "little")
        st, lo, hi = expand_segment(st, key)
        if hi > lo:
            moves += 1
    assert moves > 30, f"walk barely moves ({moves}/50) — math is broken"


def selftest_fast_mode_distribution() -> None:
    """In fast mode the walk should still produce a reasonable spread of
    per-round returns. This is the floor-level sanity test that the
    fast-RNG draws give us comparable distributional behaviour."""
    rng = random.Random(3)
    walk = fresh_walk()
    starts: list[int] = []
    ends: list[int] = []
    for _ in range(100):
        start_price = walk.price
        for _ in range(ROUND_DURATION_SEGMENTS):
            key = rng.getrandbits(256).to_bytes(32, "little")
            walk, _, _ = expand_segment(walk, key)
        starts.append(start_price)
        ends.append(walk.price)
    returns = [(e - s) / s for s, e in zip(starts, ends)]
    mean_return = sum(returns) / len(returns)
    var = sum((r - mean_return) ** 2 for r in returns) / len(returns)
    stdev = math.sqrt(var)
    # The native walk shows ~6% per-round stdev. Tolerate a wide band
    # because we only sample 100 rounds here.
    assert 0.02 < stdev < 0.15, f"unexpected per-round stdev: {stdev:.3f}"


# =========================================================================
# CLI
# =========================================================================

def format_pct(x: float) -> str:
    return f"{x * 100:+.3f}%"


def format_bps(x: float) -> str:
    return f"{x:+.1f}bps"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rounds", type=int, default=10_000,
                   help="Rounds per scenario (default 10000)")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--riders-per-round", type=int, default=8,
                   help="Riders per round for scenario (a)")
    p.add_argument("--json-out", type=str, default=None,
                   help="Optional JSON dump")
    p.add_argument("--joint-sweep-rounds", type=int, default=5_000,
                   help="Rounds per cell for the joint (offset × multiplier) "
                        "sweep (default 5000)")
    p.add_argument("--skip-joint-sweep", action="store_true",
                   help="Skip the 5×5 joint sweep (saves ~30s)")
    args = p.parse_args(argv)

    print("=" * 78)
    print("Wick Markets segment-protocol Monte Carlo — doc 19 validation")
    print(f"  rounds: {args.rounds:,}    seed: {args.seed}    "
          f"segment_ms: {DEFAULT_SEGMENT_MS}")
    print(f"  round duration: {ROUND_DURATION_SEGMENTS} segments "
          f"({ROUND_DURATION_SEGMENTS * DEFAULT_SEGMENT_MS / 1000:.1f}s)")
    print(f"  open window: {OPEN_WINDOW_SEGMENTS} segments "
          f"({OPEN_WINDOW_SEGMENTS * DEFAULT_SEGMENT_MS / 1000:.2f}s)")
    print(f"  barriers: ±{BARRIER_OFFSET_BPS / 100:.1f}% from spot")
    print(f"  multiplier: {MULTIPLIER_BPS / BPS:.1f}x")
    print(f"  max payout per barrier: {MAX_PAYOUT_PER_BARRIER:,}")
    print(f"  (seed treasury: {SEED_TREASURY:,}; cap = "
          f"{100 * MAX_PAYOUT_PER_BARRIER / SEED_TREASURY:.0f}% of seed)")
    print("=" * 78)

    print("\n[self-test] walk determinism + shape + fast-mode dist ...")
    selftest_walk_determinism()
    selftest_walk_basic_shape()
    selftest_fast_mode_distribution()
    print(f"  OK  (mode: {'fast' if USE_FAST_DRAWS else 'exact'})")

    results: dict[str, dict] = {}

    # ---- Scenario (a) ----
    print("\n[scenario a] per-tier multiplier calibration "
          f"(uniform riders, 2× multiplier, ±5 % barriers)")
    a = scenario_a_calibration(seed=args.seed, n_rounds=args.rounds,
                               riders_per_round=args.riders_per_round)
    results["a"] = a
    print(f"  rides (touch_win + expired_loss): {a['n_rides']:,}")
    print(f"  realised P(touch) per ride:        {format_pct(a['realised_p_touch'])}")
    print(f"  mean vault edge per $ staked:      {format_pct(a['mean_edge_per_dollar'])}")
    print(f"  median edge per $:                 {format_pct(a['median_edge'])}")
    print(f"  edge percentiles (5 / 95):         "
          f"{format_pct(a['edge_p05'])} / {format_pct(a['edge_p95'])}")
    print(f"  mean vault PnL per round:          {a['mean_pnl_per_round']:+,.1f}")
    print(f"  vault-loss rounds: {a['rounds_with_vault_loss']:,} "
          f"/ vault-gain rounds: {a['rounds_with_vault_gain']:,}    "
          f"loss frequency: {format_pct(a['loss_frequency'])}")
    print(f"  fair-value edge under P(touch)={format_pct(a['realised_p_touch'])} "
          f"and M=2.0: {format_pct(a['fair_value_edge'])}")
    interp_a = ("PASS (edge positive — ship)" if a['mean_edge_per_dollar'] > 0
                else "FAIL (negative edge — recalibrate)")
    print(f"  interpretation: {interp_a}")

    # Tier sweep — find the smallest multiplier that yields positive edge.
    print(f"\n  multiplier-tier sweep ({a['tier_sweep_rounds']} rounds per tier):")
    print(f"    {'mult':>7s}  {'P(touch)':>10s}  {'mean edge':>11s}  "
          f"{'edge p05':>11s}  {'fair-value':>11s}")
    safe_tier = None
    for tier in a['tier_sweep']:
        mult_str = f"{tier['multiplier_bps'] / BPS:.2f}x"
        fv = tier['fair_value_edge_check']
        print(f"    {mult_str:>7s}  {format_pct(tier['realised_p_touch']):>10s}  "
              f"{format_pct(tier['mean_edge']):>11s}  "
              f"{format_pct(tier['edge_p05']):>11s}  "
              f"{format_pct(fv):>11s}")
        if safe_tier is None and tier['mean_edge'] > 0.05:
            safe_tier = tier
    if safe_tier:
        print(f"  → recommended ≥5% edge tier: "
              f"{safe_tier['multiplier_bps'] / BPS:.2f}× "
              f"(mean edge {format_pct(safe_tier['mean_edge'])})")
    else:
        print("  → no tier in the sweep produced ≥5% positive edge — "
              "consider narrower barriers")

    # ---- Scenario (b) ----
    print(f"\n[scenario b] open-window selection bot "
          f"(opens at segment {OPEN_WINDOW_SEGMENTS - 1}, picks closer barrier)")
    b = scenario_b_selection_bot(seed=args.seed + 1, n_rounds=args.rounds)
    results["b"] = b
    print(f"  rides each: {b['n_rides']:,}")
    print(f"  bot   P(touch): {format_pct(b['bot_p_touch'])}    "
          f"uniform P(touch): {format_pct(b['uniform_p_touch'])}    "
          f"Δ: {format_pct(b['p_touch_advantage'])}")
    print(f"  bot     mean edge / $ : {format_pct(b['bot_mean_edge'])}")
    print(f"  uniform mean edge / $ : {format_pct(b['uniform_mean_edge'])}")
    print(f"  ***  SELECTION ADVANTAGE (bot - uniform): "
          f"{format_pct(b['selection_advantage_per_dollar'])}  ***")
    print(f"  bot edge percentiles (5/95/99): "
          f"{format_pct(b['bot_edge_p05'])} / "
          f"{format_pct(b['bot_edge_p95'])} / "
          f"{format_pct(b['bot_edge_p99'])}")
    print(f"  spot drift inside open window "
          f"({b['open_window_seconds']:.2f}s):")
    print(f"     mean {b['mean_spot_drift_bps_open_window']:.1f} bps    "
          f"p95 {b['p95_spot_drift_bps_open_window']:.1f} bps    "
          f"p99 {b['p99_spot_drift_bps_open_window']:.1f} bps    "
          f"(barriers are at {BARRIER_OFFSET_BPS} bps)")
    print(f"  spot drift over full round: "
          f"mean {b['mean_spot_drift_bps_round']:.1f}    "
          f"p95 {b['p95_spot_drift_bps_round']:.1f}    "
          f"p99 {b['p99_spot_drift_bps_round']:.1f} bps")
    interp_b = ("PASS (selection delta non-positive — open-window mechanic closes selection)"
                if b['selection_advantage_per_dollar'] <= 0
                else f"ATTENTION (bot has +{b['selection_advantage_per_dollar']*100:.2f}% "
                     f"edge over baseline — review open window)")
    print(f"  interpretation: {interp_b}")

    # ---- Scenario (c) ----
    print(f"\n[scenario c] per-barrier cap pile-on "
          f"(every rider takes MAX stake; both barriers pile on)")
    c = scenario_c_cap_pile_on(seed=args.seed + 2, n_rounds=min(2_000, args.rounds))
    results["c"] = c
    print(f"  riders per round:                  {c['riders_per_round']}")
    print(f"  per-rider max payout:              {c['per_rider_max_payout']:,}")
    print(f"  riders required to saturate cap:   {c['riders_required_to_saturate']}")
    print(f"  cap_max_payout_per_barrier:        {c['cap_max_payout_per_barrier']:,}")
    print(f"  observed max obligation / barrier: {c['max_per_barrier_obligation_observed']:,}")
    print(f"  ratio of observed vs cap:          {c['ratio_max_obligation_vs_cap']:.4f}")
    print(f"  observed max TOTAL obligation:     {c['max_total_obligation_observed']:,}")
    print(f"  cap violations across all rounds:  {c['cap_violations']:,}    "
          f"(must be zero)")
    print(f"  mean rejected opens per round:     {c['mean_rejected_opens_per_round']:.1f}")
    print(f"  max realised vault payout / round: {c['max_realised_vault_payout_per_round']:,}")
    print(f"  mean realised vault payout / round: "
          f"{c['mean_realised_vault_payout_per_round']:,.1f}")
    interp_c = ("PASS (cap hard ceiling honoured)"
                if c['cap_violations'] == 0
                and c['max_per_barrier_obligation_observed'] <= MAX_PAYOUT_PER_BARRIER
                else "FAIL (cap was breached)")
    print(f"  interpretation: {interp_c}")

    # ---- Joint (offset × multiplier) sweep — B7 follow-up ----
    if not args.skip_joint_sweep:
        print(f"\n[joint sweep] (barrier_offset × multiplier) — "
              f"5 × 5 grid, {args.joint_sweep_rounds:,} rounds/cell, "
              f"{args.riders_per_round} riders/round")
        joint = scenario_joint_sweep(
            seed=args.seed + 100,
            n_rounds=args.joint_sweep_rounds,
            riders_per_round=args.riders_per_round,
        )
        results["joint_sweep"] = joint
        print_joint_sweep(joint)
    else:
        joint = None

    # ---- Summary ----
    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    print(f"(a) mean vault edge:  {format_pct(a['mean_edge_per_dollar'])}   "
          f"(loss freq {format_pct(a['loss_frequency'])})")
    print(f"(b) bot vs uniform selection delta:  "
          f"{format_pct(b['selection_advantage_per_dollar'])}   "
          f"(open-window drift mean {b['mean_spot_drift_bps_open_window']:.1f} bps, "
          f"vs barriers at {BARRIER_OFFSET_BPS} bps)")
    print(f"(c) max barrier obl.: {c['max_per_barrier_obligation_observed']:,} / "
          f"{MAX_PAYOUT_PER_BARRIER:,}    "
          f"({c['ratio_max_obligation_vs_cap'] * 100:.2f}% of cap)")
    if joint is not None:
        if joint["sweet_cells"]:
            head = joint["sweet_cells"][0]
            print(f"(joint) sweet spot found: "
                  f"±{head['barrier_offset_bps']} bps × "
                  f"{head['multiplier_bps'] / BPS:.2f}×   "
                  f"edge={format_pct(head['mean_edge_per_dollar'])}   "
                  f"P(touch)={format_pct(head['realised_p_touch'])}   "
                  f"({len(joint['sweet_cells'])} cell(s) in zone)")
        else:
            head = joint["closest_to_zone_if_empty"][0]
            print(f"(joint) no cell in [5%,15%] × ≥1.5× × [30%,65%].   "
                  f"closest: ±{head['barrier_offset_bps']} × "
                  f"{head['multiplier_bps'] / BPS:.2f}×   "
                  f"edge={format_pct(head['mean_edge_per_dollar'])}   "
                  f"P(touch)={format_pct(head['realised_p_touch'])}")
    print("=" * 78)

    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(results, f, indent=2, default=str)
        print(f"\nWrote raw results to {args.json_out}")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
