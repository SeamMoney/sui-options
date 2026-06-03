/**
 * Market presets — each synthetic market's "personality" plus the round/engine
 * knobs to build a RoundEngine from it. Personality = sigma + accelerated clock
 * (yearsPerSecond) + rug + spread. See docs/design/v2/28–29.
 */
import type { RoundEngineConfig } from "./engine";
import type { RoundConfig } from "./round";

export interface MarketPreset {
  id: string;
  label: string;
  blurb: string;
  startPrice: number;
  sigmaAnnual: number;
  driftAnnual: number;
  /** Accelerated clock: BS years per real second. */
  yearsPerSecond: number;
  rugChanceBps: number;
  rugDownPct: number;
  /** House spread (vig), basis points. */
  spreadBps: number;
}

export const MARKET_PRESETS: MarketPreset[] = [
  {
    id: "calm",
    label: "Calm",
    blurb: "Low vol, gentle drift. Read the trend, no surprises.",
    startPrice: 100,
    sigmaAnnual: 0.4,
    driftAnnual: 0,
    yearsPerSecond: 0.0012,
    rugChanceBps: 0,
    rugDownPct: 0,
    spreadBps: 120,
  },
  {
    id: "volatile",
    label: "Volatile",
    blurb: "High vol with rug risk. Big swings, fast P&L.",
    startPrice: 100,
    sigmaAnnual: 0.9,
    driftAnnual: 0,
    yearsPerSecond: 0.002,
    rugChanceBps: 80,
    rugDownPct: 0.05,
    spreadBps: 150,
  },
  {
    id: "trending",
    label: "Trending",
    blurb: "Persistent upward drift. Momentum favors calls.",
    startPrice: 100,
    sigmaAnnual: 0.6,
    driftAnnual: 1.5,
    yearsPerSecond: 0.0016,
    rugChanceBps: 40,
    rugDownPct: 0.04,
    spreadBps: 140,
  },
  {
    id: "choppy",
    label: "Choppy",
    blurb: "Whippy, directionless. Punishes over-commitment.",
    startPrice: 100,
    sigmaAnnual: 0.7,
    driftAnnual: 0,
    yearsPerSecond: 0.0018,
    rugChanceBps: 60,
    rugDownPct: 0.04,
    spreadBps: 150,
  },
];

export function presetById(id: string): MarketPreset | undefined {
  return MARKET_PRESETS.find((p) => p.id === id);
}

export interface BuildRoundOpts {
  preset: MarketPreset;
  seed: number;
  startedAtMs: number;
  lobbyMs?: number;
  liveMs?: number;
  settleMs?: number;
  steps?: number;
  stepMs?: number;
}

/** Build a RoundEngineConfig from a preset + per-round seed/timing. */
export function roundConfigFromPreset(opts: BuildRoundOpts): RoundEngineConfig {
  const { preset, seed, startedAtMs } = opts;
  const round: RoundConfig = {
    startedAtMs,
    lobbyMs: opts.lobbyMs ?? 60_000,
    liveMs: opts.liveMs ?? 90_000,
    settleMs: opts.settleMs ?? 5_000,
  };
  return {
    market: {
      id: preset.id,
      label: preset.label,
      startPrice: preset.startPrice,
      sigmaAnnual: preset.sigmaAnnual,
      driftAnnual: preset.driftAnnual,
      rugChanceBps: preset.rugChanceBps,
      rugDownPct: preset.rugDownPct,
    },
    round,
    seed,
    steps: opts.steps ?? 90,
    stepMs: opts.stepMs ?? 1000,
    spreadBps: preset.spreadBps,
    yearsPerSecond: preset.yearsPerSecond,
  };
}
