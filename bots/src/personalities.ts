import type { Side } from "@wick/sdk";
import type { MarketSnapshot } from "@wick/sdk";

export type PersonalityName = "bull" | "bear" | "contrarian" | "drunk";

export interface Personality {
  name: PersonalityName;
  /** Some bots create markets, others don't. */
  creates: boolean;
  /** What direction to use when creating a fresh market (TOUCH ABOVE / TOUCH BELOW). */
  createDirection: "ABOVE" | "BELOW" | "RANDOM";
  /** Pick a side for a given market. */
  pickSide(market: MarketSnapshot): Side;
}

const bull: Personality = {
  name: "bull",
  creates: true,
  createDirection: "ABOVE",
  pickSide: () => "TOUCH",
};

const bear: Personality = {
  name: "bear",
  creates: true,
  createDirection: "BELOW",
  pickSide: () => "NO_TOUCH",
};

/**
 * Contrarian fades the popular side. When TOUCH reserve is small (= demand
 * is high, = price is high, = market thinks TOUCH is likely), the contrarian
 * buys NO_TOUCH, and vice versa. Falls back to a coin flip on a fresh market
 * with equal reserves.
 */
const contrarian: Personality = {
  name: "contrarian",
  creates: false,
  createDirection: "RANDOM",
  pickSide: (m) => {
    if (m.touchReserve === m.noTouchReserve) return Math.random() < 0.5 ? "TOUCH" : "NO_TOUCH";
    return m.touchReserve < m.noTouchReserve ? "NO_TOUCH" : "TOUCH";
  },
};

const drunk: Personality = {
  name: "drunk",
  creates: false,
  createDirection: "RANDOM",
  pickSide: () => (Math.random() < 0.5 ? "TOUCH" : "NO_TOUCH"),
};

export const PERSONALITIES: Personality[] = [bull, bear, contrarian, drunk];

export function personalityFor(name: PersonalityName): Personality {
  const p = PERSONALITIES.find((p) => p.name === name);
  if (!p) throw new Error(`unknown personality ${name}`);
  return p;
}
