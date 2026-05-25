# Trade Decision Layer Task Board

## Goal

Turn Candle Vision from a pattern detector into a live decision layer that can confirm, deny, watch, or invalidate buy/sell setups from real-time candles.

## Current Slice

| ID | Task | Owner | Status | Notes |
| --- | --- | --- | --- | --- |
| TD-001 | Model/API notes | Agent Averroes | Done | `docs/trade-decision-layer-notes.md` |
| TD-002 | Visual spec | Agent Socrates | Done | `docs/trade-decision-visual-spec.md` |
| TD-003 | Regression plan | Agent Aquinas | Done | `docs/trade-decision-test-plan.md` |
| TD-004 | Indicator integration map | Agent Pasteur | Done | `docs/indicator-integration-map.md` |
| TD-005 | Package trade-decision engine | Codex | Done | `packages/candle-vision/src/trade-decision.ts` |
| TD-006 | Package regression assertions | Codex | Done | Extended `packages/candle-vision/test/release-regression.ts` |
| TD-007 | Candle Vision decision panel | Codex | Done | Live verdict above ranked signals |
| TD-008 | Local route verification | Codex | Done | Build/test/typecheck passed; browser smoke screenshot at `/tmp/candle-vision-trade-decision-v2.png` |
| TD-009 | Hold-to-trade interaction | Codex | Done | Long/short selector; hold space or chart/pad to open, release to close; keyup/blur/pointercancel hardened |
| TD-010 | TA line derivation + overlay policy | Codex | Done | Package `deriveTaLines()` remains available, but Candle Vision no longer draws shifting TA lines; only the live P&L line renders |
| TD-011 | Larger-pattern visibility pass | Codex | Done | Longer structure lookback, chart-setup quotas, and large-span ranking boost |
| TD-012 | Simulated micro-scalp bot | Codex | Done | `packages/candle-vision/src/micro-bot.ts`; forming -> confirmed -> 5-10s paper entry/exit loop with target/stop/flip/time exits |
| TD-013 | Micro-bot backtester | Codex | Done | `packages/candle-vision/src/micro-backtest.ts`; replays candles, emits trades, equity curve, win rate, PnL, max drawdown |
| TD-014 | Candle Vision bot panel | Codex | Done | Route renders scalp-bot order-flow panel, active position overlay, P&L, countdown, last exit; browser smoke screenshot `/tmp/candle-vision-micro-bot-trading.png` |
| TD-015 | Strategy calibration layer | Codex | Done | `calibrateMicroBot()` compares built-in scalp presets and ranks them by expectancy, win rate, profit factor, activity, and drawdown |
| TD-016 | Strategy Lab UI | Codex | Done | Candle Vision bot panel shows best preset, backtest P&L, win rate, expectancy, drawdown, and top preset rows from current candle history |

## Next Slices

| ID | Task | Status | Notes |
| --- | --- | --- | --- |
| TD-101 | Draw entry/stop/target rails on lightweight-charts | Paused | User wants only the live P&L line on this route; decision rails can return as opt-in package layers |
| TD-102 | Extract reusable `VisionLayer`/`DecisionLayer` React components | Planned | Needed before indicator pages share the system |
| TD-103 | Wire Wick Pressure Zones with decision layer | Planned | Best first indicator because candle signals naturally match wick zones |
| TD-104 | Wire Volume Profile with confluence boosts | Planned | Boost signals near HVN/LVN/POC |
| TD-105 | Add decision replay timeline | Planned | Sequence evidence -> verdict -> entry/stop/targets |
| TD-106 | Bot calibration dashboard | Planned | Tune thresholds against backtest summaries; show expectancy by pattern/setup family |
| TD-107 | Walk-forward replay mode | Planned | Split history into train/test windows and animate bot decisions without lookahead |
| TD-108 | Indicator-page bot overlays | Planned | Reuse micro-bot + vision overlays on Wick Pressure, Probability Grid, Volume Profile, VARIS, Pine3D pages |

## Implementation Contract

- Patterns are evidence.
- Trade decisions are verdicts.
- Every verdict must include reasons and denial reasons.
- Default chart mode should show one current verdict, not every raw detection.
- Visual clutter must fail closed: collapse or hide before covering candles.
