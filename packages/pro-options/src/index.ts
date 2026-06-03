/**
 * @sui-options/pro-options — framework-agnostic options engine for Pro Mode.
 *
 * Black-Scholes pricing + Greeks + payoff curves, the option position lifecycle
 * (open / mark / sell-to-close / settle), and deterministic synthetic price
 * paths for round-based synthetic-market options trading.
 *
 * Design: docs/design/v2/28_pro_options_mode_v5.md
 */
export * from "./types";
export * from "./black-scholes";
export * from "./option";
export * from "./path";
export * from "./round";
export * from "./engine";
export * from "./presets";
export * from "./host";
