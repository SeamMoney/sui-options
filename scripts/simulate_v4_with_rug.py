#!/usr/bin/env python3
"""
V4 house-edge simulator with a 'rug pull' / market-halt event added.

Inspired by /Users/maxmohammadi/cash-trading-game/price_simulator.py
which uses BASE_RUG_CHANCE = 0.0001 per candle + a 0.5x-2x scaling
multiplier capped at 1% per candle. When the rug fires and the player
is holding, they lose 75% of stake.

For Wick v4 (touch-either), the equivalent: per-segment rug chance.
When rug fires while a ride is open, the ride force-settles as
EXPIRED_LOSS — user loses entire escrow. Chart keeps moving (high vol
preserved); rug is a separate event layered on top.

Sweeps rug_chance to find the value that produces a healthy ~3-8%
house edge with the current ±10% / 1.75x configuration.

SCOPE — this sweep models the `hold_full` strategy ONLY: a user who always
holds for the touch jackpot and NEVER cashes out. That is the most
house-adverse strategy, so the edge here is a WORST CASE. The realistic edge
(users take the Bachelier cashout before expiry, forfeiting some upside) is
modelled by `simulate_v4_house_edge.py` and doc 26, which is what the live
`rug_chance_bps = 150` (1.5%/seg) was calibrated against (+3.4% there). Under
pure hold_full the same 1.5% leaves a small NEGATIVE edge — that's why this
sweep's own "★ TARGET" only lights up at 2.0-2.5%. Read the two together:
1.5% is sustainable for the realistic mix; you'd want ~2% only if every user
held to touch every round.
"""
from __future__ import annotations
import os, sys, random
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from simulate_segment_protocol import expand_segment, fresh_walk, HOME_PRICE  # noqa

ROUND_DURATION = 75
BARRIER_OFFSET_BPS = 1000   # ±10% (KEEP — user wants chart to move a lot)
MULTIPLIER_BPS = 17_500     # 1.75×  (KEEP — current setting)
STAKE_PER_SEGMENT = 100_000

def simulate(rug_per_segment: float, n_rounds: int) -> dict:
    # A seedable PRNG, NOT secrets.SystemRandom: (1) SystemRandom.seed() is a
    # silent no-op, so the old "seed(42)" never made this reproducible, and
    # (2) SystemRandom reads the OS CSPRNG on every draw (a syscall per
    # segment) — ~100x slower, which is why a full 5k-round sweep never
    # finished. A plain Monte Carlo only needs uniform draws; random.Random
    # gives identical expected rates, fast and reproducible.
    rng = random.Random(42)
    total_net = 0.0
    total_stake = 0.0
    touches = 0
    rugs = 0
    expires = 0
    for _ in range(n_rounds):
        state = fresh_walk(home=HOME_PRICE)
        spot = state.price
        upper = spot + spot * BARRIER_OFFSET_BPS // 10_000
        lower = spot - spot * BARRIER_OFFSET_BPS // 10_000
        outcome = None
        for _ in range(ROUND_DURATION):
            # Rug check BEFORE the segment's price expansion. If rug
            # fires, ride dies first (user can't escape via touch in the
            # same segment). This is the most adverse interpretation for
            # the user — but matches what the user described ("massive
            # red candle once in a while").
            if rng.random() < rug_per_segment:
                outcome = "rug"
                rugs += 1
                break
            key = rng.randbytes(32)
            state, smin, smax = expand_segment(state, key)
            if smax >= upper or smin <= lower:
                outcome = "touch"
                touches += 1
                break
        if outcome is None:
            outcome = "expire"
            expires += 1
        stake = ROUND_DURATION * STAKE_PER_SEGMENT
        if outcome == "touch":
            jackpot = stake * MULTIPLIER_BPS / 10_000
            net = jackpot - stake
        else:  # rug OR expire → full escrow loss
            net = -stake
        total_net += net
        total_stake += stake
    return {
        "rug_p": rug_per_segment,
        "touch_rate": touches / n_rounds,
        "rug_rate": rugs / n_rounds,
        "expire_rate": expires / n_rounds,
        "house_edge": -total_net / total_stake,
    }

def main():
    import argparse
    ap = argparse.ArgumentParser(
        description="V4.26 rug-pull house-edge sweep (hold_full strategy).",
    )
    # Default sized so the full 9-config sweep finishes in well under a minute
    # on a laptop (each round runs the byte-identical seeded walk for up to 75
    # segments). Bump --rounds for a tighter estimate; the seed is fixed so a
    # given --rounds is reproducible run-to-run.
    ap.add_argument("--rounds", type=int, default=1200,
                    help="Monte Carlo rounds per rug config (default 1200).")
    args = ap.parse_args()
    n = args.rounds
    print(f"V4 + rug-pull mechanism — hold_full, {n:,} rounds per config")
    print(f"  ±10% barriers, 1.75× multiplier, 75 segments\n")
    print(f"  {'rug%/seg':<12}{'touch%':<10}{'rug%':<10}{'expire%':<10}{'house edge':>14}  notes")
    print("  " + "─" * 70)

    # Sweep rug probability per segment from 0% to 5%.
    configs = [0.000, 0.005, 0.010, 0.015, 0.020, 0.025, 0.030, 0.040, 0.050]
    for p in configs:
        r = simulate(p, n)
        sign = "+" if r["house_edge"] > 0 else ""
        marker = ""
        if 0.03 <= r["house_edge"] <= 0.08:
            marker = " ★ TARGET (3-8% edge)"
        elif r["house_edge"] > 0.10:
            marker = " (too greedy)"
        elif r["house_edge"] < 0:
            marker = " (hold_full worst case — see note)"
        if abs(p - 0.015) < 1e-9:
            marker += "  ← LIVE rug_chance_bps=150"
        print(f"  {p*100:>5.2f}%      "
              f"{r['touch_rate']:>7.1%}   "
              f"{r['rug_rate']:>6.1%}   "
              f"{r['expire_rate']:>7.1%}   "
              f"{sign}{r['house_edge']:>10.2%}  "
              f"{marker}")
    print()
    print("NOTE — this sweep is the hold_full WORST CASE (user never cashes out).")
    print("  The live rug_chance_bps=150 (1.5%/seg) is calibrated against the")
    print("  cashout-inclusive model in simulate_v4_house_edge.py + doc 26")
    print("  (+3.4% there). Under pure hold_full, 1.5% sits slightly negative —")
    print("  which is why '★ TARGET' only lights at ~2%. Both models are valid.")
    print()
    print("Mechanism for v4 'rug':")
    print("  - Each on-chain record_segment_v4 call rolls a deterministic")
    print("    dice (from segment key + a chain-known bias). If RUG fires:")
    print("       → all active rides settle as EXPIRED_LOSS")
    print("       → chart visually shows a 'MARKET HALT' or red flash")
    print("       → next segment normal again")
    print("  - User keeps high vol + frequent wins between rugs.")
    print("  - Honest = the rug roll is on-chain, provably fair.")
    print("  - chart still moves the same — vol unchanged.")

if __name__ == "__main__":
    main()
