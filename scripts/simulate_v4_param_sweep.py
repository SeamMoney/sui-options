#!/usr/bin/env python3
"""
Parameter sweep for the V4 TUSD market. Shows house edge across
different (barrier_offset_bps, multiplier_bps) combinations so we can
pick a sustainable config.

User strategy: hold_full (the worst case for the house — touch wins
strongly favor the user when held to expiry).
"""
from __future__ import annotations
import os, sys, random
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from simulate_segment_protocol import expand_segment, fresh_walk, HOME_PRICE  # noqa

ROUND_DURATION = 75
STAKE_PER_SEGMENT = 100_000

def measure(barrier_bps: int, mult_bps: int, n_rounds: int) -> dict:
    # Seeded PRNG: the old `secrets.SystemRandom().seed(42)` was a double no-op
    # (it seeds a throwaway object, and SystemRandom ignores seeds anyway) — so
    # this sweep was neither reproducible nor fast. random.Random honors the
    # seed and skips the per-segment OS-CSPRNG syscall.
    rng = random.Random(42)
    total_net = 0.0
    total_stake = 0.0
    touches = 0
    for _ in range(n_rounds):
        state = fresh_walk(home=HOME_PRICE)
        spot = state.price
        upper = spot + spot * barrier_bps // 10_000
        lower = spot - spot * barrier_bps // 10_000
        touched = False
        for _ in range(ROUND_DURATION):
            key = rng.randbytes(32)
            state, smin, smax = expand_segment(state, key)
            if smax >= upper or smin <= lower:
                touched = True; break
        stake = ROUND_DURATION * STAKE_PER_SEGMENT
        if touched:
            jackpot = stake * mult_bps / 10_000
            net = jackpot - stake
            touches += 1
        else:
            net = -stake
        total_net += net
        total_stake += stake
    return {
        "barrier_bps": barrier_bps,
        "mult_bps": mult_bps,
        "touch_rate": touches / n_rounds,
        "house_edge": -total_net / total_stake,
        "jackpot_x": mult_bps / 10_000,
        "barrier_pct": barrier_bps / 100,
    }

def main():
    n = 5_000
    print(f"V4 param sweep — hold_full strategy, {n:,} rounds per config\n")
    print(f"  ROUND_DURATION = {ROUND_DURATION} segments")
    print(f"  Target: house edge in [+2%, +10%] range\n")
    print(f"  {'barrier':<10}{'mult':<8}{'touch%':<10}{'house edge':>12}  notes")
    print("  " + "─" * 60)

    # Sweep wider/tighter barriers × lower/higher multipliers.
    configs = [
        # (barrier_bps, mult_bps, label)
        (1000, 17_500, "CURRENT (broken)"),
        (1000, 12_000, "↓ mult"),
        (1000, 11_000, "↓↓ mult"),
        (500, 20_000, "Phase B7 (±5%, 2×)"),
        (500, 18_000, "tight + lower mult"),
        (700, 15_000, "balanced"),
        (700, 13_000, "balanced + lower mult"),
        (1500, 25_000, "wide + high mult"),
        (1500, 17_500, "wide + current mult"),
        (300, 25_000, "very tight + high"),
    ]

    for bps, mult, label in configs:
        r = measure(bps, mult, n)
        sign = "+" if r["house_edge"] > 0 else ""
        marker = ""
        if 0.02 <= r["house_edge"] <= 0.10:
            marker = " ★ SUSTAINABLE"
        elif r["house_edge"] > 0.10:
            marker = " (too greedy — users will quit)"
        elif r["house_edge"] < 0:
            marker = " (user wins — protocol bleeds)"
        print(f"  ±{r['barrier_pct']:>4.1f}%   "
              f"{r['jackpot_x']:>4.2f}×  "
              f"{r['touch_rate']:>7.1%}    "
              f"{sign}{r['house_edge']:>9.2%}  "
              f"{label}{marker}")

if __name__ == "__main__":
    main()
