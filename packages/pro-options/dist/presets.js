export const MARKET_PRESETS = [
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
export function presetById(id) {
    return MARKET_PRESETS.find((p) => p.id === id);
}
/** Build a RoundEngineConfig from a preset + per-round seed/timing. */
export function roundConfigFromPreset(opts) {
    const { preset, seed, startedAtMs } = opts;
    const round = {
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
//# sourceMappingURL=presets.js.map