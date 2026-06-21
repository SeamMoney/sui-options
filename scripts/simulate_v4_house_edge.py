#!/usr/bin/env python3
"""
v4.25d house-edge simulator for the TUSD touch-either market.

Imports the byte-identical `seeded_path::expand_segment` walk from
the existing Phase B7 simulator (scripts/simulate_segment_protocol.py)
so the price path matches what the on-chain `record_segment_v4` would
generate.

Models the v4 touch-either lifecycle:
  - Round = 75 segments
  - Barriers = spot_at_roll ± 10% (BARRIER_OFFSET_BPS = 1000)
  - Touch EITHER side → jackpot = stake × duration × multiplier
  - Cashout before touch → refund of remaining_segments × stake × (1 - cashout_spread)
  - Round expires no touch → 0 payout, full escrow forfeit

For each user strategy, runs N=20k rounds, reports:
  - touch_rate (% of rounds where price touched ±10%)
  - avg user net per round (+ = user wins, - = house wins)
  - house_edge = -user_net / total_stake

The point: at multiplier 1.75x with ±10% barriers and the walk's
configured vol (~1% per sqrt sec), is the house actually getting an
edge? Where's the break-even?

Run:
    python3 scripts/simulate_v4_house_edge.py
    python3 scripts/simulate_v4_house_edge.py --rounds 50000
"""

from __future__ import annotations
import argparse
import os
import random
import statistics
import sys

# Import the on-chain-faithful walk from the existing simulator.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from simulate_segment_protocol import (  # noqa: E402
    expand_segment,
    fresh_walk,
    HOME_PRICE,
)

# ── LIVE TUSD market params (read directly from deployments/testnet.json) ──
ROUND_DURATION = 75
BARRIER_OFFSET_BPS = 1000      # ±10% from spot_at_roll
MULTIPLIER_BPS = 17_500        # 1.75× on touch
CASHOUT_SPREAD_BPS = 200       # 2% fee on cashout refund
STAKE_PER_SEGMENT = 100_000    # $0.10 (frontend default DEFAULT_STAKE_PER_SEGMENT_MICROUSD)


def simulate_strategy(strategy: str, n_rounds: int, rng_seed: int = 42) -> dict:
    """Simulate one user strategy across n_rounds independent rounds.

    Strategies:
      - 'hold_full'      : open at segment 0, hold to expiry (or touch)
      - 'cashout_at_N'   : open at segment 0, release at segment N (if no touch yet)
      - 'wait_then_hold' : skip first 20 segments, then open, hold to expiry
    """
    # random.Random, NOT secrets.SystemRandom: SystemRandom.seed() is a silent
    # no-op (so the --seed flag never actually made this reproducible) and its
    # OS-CSPRNG draw per segment is ~100x slower than a PRNG. A Monte Carlo
    # only needs uniform draws; this is fast AND honors --seed.
    rng = random.Random(rng_seed)

    cashout_at = None
    if strategy.startswith("cashout_at_"):
        cashout_at = int(strategy[len("cashout_at_"):])

    wait_segments = 0
    if strategy.startswith("wait_"):
        # "wait_20_then_hold" → skip first 20, then open, hold
        parts = strategy.split("_")
        wait_segments = int(parts[1])

    total_net = 0.0
    total_stake = 0.0
    touches = 0
    cashouts = 0
    expires = 0
    per_round_net = []

    for _ in range(n_rounds):
        state = fresh_walk(home=HOME_PRICE)
        spot_at_roll = state.price
        upper = spot_at_roll + spot_at_roll * BARRIER_OFFSET_BPS // 10_000
        lower = spot_at_roll - spot_at_roll * BARRIER_OFFSET_BPS // 10_000

        # Pre-roll wait segments (drift before user opens)
        for _ in range(wait_segments):
            key = rng.randbytes(32)
            state, _smin, _smax = expand_segment(state, key)

        # User opens here. Cost = stake × (remaining segments in round)
        open_segment = wait_segments
        ride_duration = ROUND_DURATION - open_segment

        touched = False
        cashed_out = False
        net = 0.0
        # Iterate segments while user holds
        for s_offset in range(ride_duration):
            key = rng.randbytes(32)
            state, seg_min, seg_max = expand_segment(state, key)
            if seg_max >= upper or seg_min <= lower:
                # TOUCH — jackpot. Round-cap is ignored (max_payout_per_round
                # only matters at aggregate exposure, not per-ride here).
                touched = True
                jackpot = STAKE_PER_SEGMENT * ride_duration * MULTIPLIER_BPS / 10_000
                net = jackpot - ride_duration * STAKE_PER_SEGMENT
                touches += 1
                break

            # User decides to cashout at segment N?
            if cashout_at is not None and s_offset + 1 >= cashout_at:
                cashed_out = True
                held = s_offset + 1
                remaining = ride_duration - held
                # User paid for `ride_duration` segments at open. Gets back
                # `remaining × stake × (1 - cashout_spread)`. Net loss:
                #   loss = stake × held + stake × remaining × cashout_spread
                fee_per_seg = STAKE_PER_SEGMENT * CASHOUT_SPREAD_BPS / 10_000
                net = -(held * STAKE_PER_SEGMENT) - (remaining * fee_per_seg)
                cashouts += 1
                break

        if not touched and not cashed_out:
            # Round expired, no touch, full escrow forfeit.
            net = -(ride_duration * STAKE_PER_SEGMENT)
            expires += 1

        total_net += net
        total_stake += ride_duration * STAKE_PER_SEGMENT
        per_round_net.append(net)

    house_edge = -total_net / total_stake if total_stake else 0.0
    return {
        "strategy": strategy,
        "n_rounds": n_rounds,
        "touch_rate": touches / n_rounds,
        "cashout_rate": cashouts / n_rounds,
        "expire_rate": expires / n_rounds,
        "total_net": total_net,
        "avg_net_per_round": total_net / n_rounds,
        "stdev_per_round": statistics.stdev(per_round_net) if n_rounds > 1 else 0,
        "house_edge": house_edge,
    }


def fmt_dollars(raw: float) -> str:
    """Raw micro-USD → human dollar string."""
    return f"${raw / 1_000_000:+.4f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=20_000)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    print("─" * 72)
    print(f"V4 TUSD market — house-edge Monte Carlo, {args.rounds:,} rounds each")
    print("─" * 72)
    print(f"  ROUND_DURATION       = {ROUND_DURATION} segments (~30s @ 400ms/seg)")
    print(f"  BARRIER_OFFSET       = ±{BARRIER_OFFSET_BPS/100:.1f}%")
    print(f"  MULTIPLIER           = {MULTIPLIER_BPS/10_000:.2f}× on touch")
    print(f"  CASHOUT_SPREAD       = {CASHOUT_SPREAD_BPS/100:.2f}%")
    print(f"  STAKE_PER_SEGMENT    = ${STAKE_PER_SEGMENT/1_000_000:.2f} (frontend default)")
    print(f"  FULL-RIDE ESCROW     = ${STAKE_PER_SEGMENT * ROUND_DURATION/1_000_000:.2f}")
    print(f"  JACKPOT ON TOUCH     = ${STAKE_PER_SEGMENT * ROUND_DURATION * MULTIPLIER_BPS/10_000/1_000_000:.2f}")
    print(f"  BREAK-EVEN TOUCH P   = {ROUND_DURATION / (ROUND_DURATION * MULTIPLIER_BPS / 10_000):.1%}")
    print()

    strategies = [
        "hold_full",
        "cashout_at_5",   # the "panic / quick test" strategy
        "cashout_at_15",  # midway
        "cashout_at_30",  # late
    ]

    print(f"{'strategy':<18}{'touch%':>9}{'cash%':>9}{'expire%':>9}"
          f"{'avg net/round':>18}{'house edge':>14}")
    print("─" * 72)
    for strat in strategies:
        r = simulate_strategy(strat, args.rounds, args.seed)
        print(
            f"{r['strategy']:<18}"
            f"{r['touch_rate']:>8.1%} "
            f"{r['cashout_rate']:>8.1%} "
            f"{r['expire_rate']:>8.1%} "
            f"  {fmt_dollars(r['avg_net_per_round']):>14}"
            f"{r['house_edge']:>13.2%}"
        )
    print("─" * 72)
    print()
    print("INTERPRETATION:")
    print("  house edge = -E[user_net] / E[stake]")
    print("  positive = house wins on average (user loses)")
    print("  negative = user wins on average (house loses → unsustainable)")
    print()
    print(f"  Break-even touch probability = {ROUND_DURATION/(ROUND_DURATION * MULTIPLIER_BPS / 10_000):.1%}")
    print("  If observed touch% is BELOW break-even with hold_full,")
    print("  the multiplier is too LOW or barriers too WIDE → house wins.")
    print("  If touch% is ABOVE break-even, the user has positive edge")
    print("  and the protocol bleeds money on hold-to-expiry rides.")


if __name__ == "__main__":
    main()
