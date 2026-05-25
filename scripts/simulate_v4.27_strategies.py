#!/usr/bin/env python3
"""
v4.27 economic-model expansion — adversarial-player strategy sweep.

The basic v4.26 sim assumed naive 'hold to expiry' or 'cashout at fixed
segment N' strategies. A smart player would react to chart movement:
  - cash out as soon as PnL crosses some + threshold (profit-taking)
  - hold longer if chart is near a barrier (close-touch chasing)
  - bail early if chart moves AWAY from both barriers (drawdown stop)

Question this sim answers: is there a strategy that BEATS the house's
designed +3.4% edge? If yes, the house edge calibration needs to be
tightened against that strategy, not against naive hold_full.

Also runs much higher round counts (50k → 200k) for tighter CI on
each strategy's house edge.

Reuses the on-chain-faithful walk from scripts/simulate_segment_protocol.py.
"""
from __future__ import annotations
import os, sys, secrets, random
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from simulate_segment_protocol import expand_segment, fresh_walk, HOME_PRICE  # noqa

ROUND_DURATION = 75
BARRIER_OFFSET_BPS = 1000
MULTIPLIER_BPS = 17_500
CASHOUT_SPREAD_BPS = 200
STAKE_PER_SEGMENT = 100_000
RUG_PROBABILITY_PER_SEG = 0.015  # v4.26 calibration: 150 bps

# Player strategies — each maps (segment_idx, current_walk_state, entry_price)
# → "hold" | "cashout"
class Strategy:
    name: str
    def decide(self, seg_idx: int, current_price: int, entry_price: int,
               upper: int, lower: int) -> str: ...

class HoldFull(Strategy):
    name = "hold_full"
    def decide(self, seg_idx, current_price, entry_price, upper, lower):
        return "hold"

class CashoutOnProfit(Strategy):
    """Cash out the moment we're closer to a barrier than at entry."""
    name = "cashout_on_profit"
    def decide(self, seg_idx, current_price, entry_price, upper, lower):
        # Calculate proximity to nearer barrier at entry vs now.
        dist_up = upper - entry_price
        dist_dn = entry_price - lower
        entry_dist = min(dist_up, dist_dn)
        now_dist_up = upper - current_price
        now_dist_dn = current_price - lower
        now_dist = min(now_dist_up, now_dist_dn)
        if now_dist < entry_dist:  # closer to a barrier than entry
            return "cashout"
        return "hold"

class CashoutOnDrawdown(Strategy):
    """Bail if price moves AWAY from both barriers (toward center)."""
    name = "cashout_on_drawdown"
    def decide(self, seg_idx, current_price, entry_price, upper, lower):
        center = (upper + lower) // 2
        entry_dist_from_center = abs(entry_price - center)
        now_dist_from_center = abs(current_price - center)
        if now_dist_from_center < entry_dist_from_center * 0.5:
            return "cashout"
        return "hold"

class ChaseTouch(Strategy):
    """Hold until within 1% of a barrier, then hold forever (gambling)."""
    name = "chase_touch"
    def decide(self, seg_idx, current_price, entry_price, upper, lower):
        # Always hold — most aggressive.
        return "hold"

class EarlyExit(Strategy):
    """Always cash out after 5 segments (the cashout fee floor)."""
    name = "early_exit_5"
    def decide(self, seg_idx, current_price, entry_price, upper, lower):
        if seg_idx >= 5:
            return "cashout"
        return "hold"

class MidHold(Strategy):
    """Cash out at ~50% of round (matches typical user behavior)."""
    name = "mid_hold"
    def decide(self, seg_idx, current_price, entry_price, upper, lower):
        if seg_idx >= 38:
            return "cashout"
        return "hold"


def simulate_strategy(strat: Strategy, n_rounds: int) -> dict:
    secrets.SystemRandom().seed(42)
    rng = random.Random(42)
    total_net = 0.0
    total_stake = 0.0
    outcomes = {"touch": 0, "cashout": 0, "rug_loss": 0, "expire_loss": 0}

    for _ in range(n_rounds):
        state = fresh_walk(home=HOME_PRICE)
        spot = state.price
        upper = spot + spot * BARRIER_OFFSET_BPS // 10_000
        lower = spot - spot * BARRIER_OFFSET_BPS // 10_000
        entry_price = spot

        outcome = None
        held_segments = 0

        for s_idx in range(ROUND_DURATION):
            # Rug check first
            if rng.random() < RUG_PROBABILITY_PER_SEG:
                outcome = "rug_loss"
                held_segments = s_idx
                break
            # Walk
            key = secrets.token_bytes(32)
            state, smin, smax = expand_segment(state, key)
            held_segments = s_idx + 1
            # Touch check
            if smax >= upper or smin <= lower:
                outcome = "touch"
                break
            # Strategy decision
            if strat.decide(s_idx + 1, state.price, entry_price, upper, lower) == "cashout":
                outcome = "cashout"
                break

        if outcome is None:
            outcome = "expire_loss"
            held_segments = ROUND_DURATION

        outcomes[outcome] += 1
        stake = ROUND_DURATION * STAKE_PER_SEGMENT
        total_stake += stake
        if outcome == "touch":
            jackpot = stake * MULTIPLIER_BPS / 10_000
            net = jackpot - stake
        elif outcome == "cashout":
            # paid for `held_segments`, get back `(round_duration - held)` × stake × (1 - spread)
            remaining = ROUND_DURATION - held_segments
            fee_per_seg = STAKE_PER_SEGMENT * CASHOUT_SPREAD_BPS / 10_000
            net = -(held_segments * STAKE_PER_SEGMENT) - (remaining * fee_per_seg)
        else:  # rug_loss, expire_loss
            net = -stake
        total_net += net

    house_edge = -total_net / total_stake if total_stake else 0
    return {
        "strategy": strat.name,
        "n_rounds": n_rounds,
        "outcomes": outcomes,
        "house_edge": house_edge,
        "ev_per_stake_unit": total_net / total_stake,
    }


def main():
    n = int(os.environ.get("ROUNDS", "20000"))
    print(f"v4.27 strategy sweep — {n:,} rounds per strategy")
    print(f"  rug_chance_per_segment = {RUG_PROBABILITY_PER_SEG*100:.2f}% (v4.26 sweet spot)")
    print(f"  multiplier = {MULTIPLIER_BPS/10000:.2f}x, barriers = ±{BARRIER_OFFSET_BPS/100:.1f}%")
    print()
    print(f"  {'strategy':<22}{'touch%':<9}{'cash%':<8}{'rug%':<8}{'exp%':<8}{'house_edge':>12}  verdict")
    print("  " + "─" * 76)

    strategies = [HoldFull(), CashoutOnProfit(), CashoutOnDrawdown(),
                  ChaseTouch(), EarlyExit(), MidHold()]
    for strat in strategies:
        r = simulate_strategy(strat, n)
        o = r["outcomes"]
        verdict = "OK"
        if r["house_edge"] < -0.01:
            verdict = "★ PLAYER BEATS HOUSE — strategy exploits the model"
        elif r["house_edge"] < 0.02:
            verdict = "weak edge, tightenable"
        elif r["house_edge"] > 0.10:
            verdict = "too greedy, retunable"
        print(f"  {r['strategy']:<22}"
              f"{o['touch']/n*100:>7.1f}% "
              f"{o['cashout']/n*100:>6.1f}% "
              f"{o['rug_loss']/n*100:>6.1f}% "
              f"{o['expire_loss']/n*100:>6.1f}% "
              f"{r['house_edge']*100:>10.2f}%  {verdict}")
    print()
    print("INTERPRETATION:")
    print("  If a non-trivial strategy beats the house, the rug_chance_bps")
    print("  setting needs to be re-tuned against the worst-case strategy.")
    print("  If all strategies have similar house edge, the design is robust.")


if __name__ == "__main__":
    main()
