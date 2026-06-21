/**
 * @sui-options/pro-options — framework-agnostic options engine for Pro Mode.
 *
 * Black-Scholes pricing + Greeks + payoff curves, the option position lifecycle
 * (open / mark / sell-to-close / settle), and deterministic synthetic price
 * paths for round-based synthetic-market options trading.
 *
 * Design: docs/design/v2/28_pro_options_mode_v5.md
 */
export * from "./types.js";
export * from "./black-scholes.js";
export * from "./option.js";
export * from "./path.js";
export * from "./round.js";
export * from "./engine.js";
export * from "./presets.js";
export * from "./host.js";
//# sourceMappingURL=index.js.map