# Indicator Integration Map

Scope: current frontend chart and indicator routes/components that should receive Candle Vision later. This was mapped from `frontend/src/App.tsx`, `frontend/src/routes`, and `frontend/src/components/charts`, with route-owned chart wrappers checked where the route delegates rendering outside `components/charts`.

Do not treat this as an implementation plan for source edits. It is a routing/data/rendering map for the later `VisionLayer` and `TradeDecisionLayer` work.

## Route Surface Summary

| Route | Current component | Chart/indicator surface | Renderer | Current data source | Candle Vision priority |
| --- | --- | --- | --- | --- | --- |
| `/candle-vision` | `frontend/src/routes/CandleVision.tsx` | Scanner demo with pattern overlay, signal panels, hover/spotlight/replay | `lightweight-charts` + `@sui-options/candle-vision/overlay-lightweight-charts` | Synthetic `CandleInput[]` generated and streamed in-route | 1 - canonical reference surface |
| `/pro` | `MainApp` in `frontend/src/App.tsx` -> `PriceChart` | Market OHLC chart plus barrier line | Custom SVG/visx primitives in `frontend/src/components/charts` | `MarketSnapshot` from `useLiveMarkets` or `STUB_MARKETS`; OHLC currently synthesized from `underlyingPrice` | 2 - main reusable SVG integration |
| `/` and fallback paths, including `/ride` | `frontend/src/routes/Ride.tsx` | Gameplay chart; v4 if deployed, v3 fallback otherwise | p5 canvas through `RideChartV4`/`RideChart` and `useRideGestureV4`/`useRideGesture` | On-chain segment event ring expanded through `@wick/sdk` seeded path into render candles | 3 - gameplay integration after layer API stabilizes |
| `/ride-test` | `frontend/src/routes/RideTest.tsx` | No chart renderer; transaction/test logs only | Plain React UI | Testnet deployment fields, wallet, `wickRide` tx helpers, polled `RidePosition` | No VisionLayer target unless a debug chart is added later |

## Components And Data Needs

### `frontend/src/routes/CandleVision.tsx`

- Current role: self-contained Candle Vision scanner route.
- Renderer: `lightweight-charts` candlestick series created with `createChart`, plus `createLightweightChartsPatternOverlay`.
- Candle shape: `CandleInput` from `@sui-options/candle-vision`, then adapted to `CandlestickData<UTCTimestamp>` via `toSeriesData`.
- Signal pipeline:
  - `detectUnifiedCandlePatterns(candles, SCAN_OPTIONS)`
  - `rankPatternSignals(raw, candles.length - 1)`
  - `selectDiverseSignals(...)`
  - `selectChartOverlayEvents(...)`
  - overlay receives `candles` and selected `CandlePatternEvent[]`.
- Current controls/state: active family filter, show-all toggle, hover state, spotlight/replay, scan stats.
- Later integration:
  - Keep this as the reference renderer for Candle Vision event semantics.
  - Extract only after the API shape is stable: `candles`, `events`, `activeFamily`, `spotlightId`, `onHoverEvent`.
  - `VisionLayer` can map almost directly to the current lightweight overlay handle.
  - `TradeDecisionLayer` should consume ranked events and current/last candle state, not the overlay DOM state.

### `frontend/src/components/market/PriceChart.tsx`

- Current route owner: `/pro` via `MainApp` in `frontend/src/App.tsx`.
- Renderer: `CandlestickChart` SVG container with `Grid`, `XAxis`, `YAxis`, `Candlestick`, and local `BarrierLine`.
- Candle shape: `OHLCDataPoint` from `frontend/src/components/charts/candlestick-chart.tsx`:
  - `date: Date`
  - `open: number`
  - `high: number`
  - `low: number`
  - `close: number`
- Current data source: `syntheticOHLC(market, SPECS[interval])`; last close is forced to `market.underlyingPrice`.
- Market data needed for a real Vision integration:
  - asset/market identity from `MarketSnapshot`
  - timeframe/interval
  - historical OHLCV, not only synthetic OHLC
  - barrier price from `market.barrier`
  - current spot from `market.underlyingPrice`
  - optional expiry/window fields if decisions should account for option lifecycle
- Later integration:
  - Add a Candle Vision adapter from `OHLCDataPoint[]` to `CandleInput[]`; volume can be `0` or real volume when available.
  - Add `VisionLayer` as a child of `CandlestickChart` so it can read `xScale`, `yScale`, `innerWidth`, `innerHeight`, and `xAccessor` from `ChartProvider`.
  - Add `TradeDecisionLayer` outside the SVG drawing group or as a sibling panel/annotation component because it needs market/trade context as well as ranked signals.

### `frontend/src/components/charts/candlestick-chart.tsx`

- Current role: generic SVG chart shell.
- Renderer: SVG with visx scales, `ParentSize`, `ChartProvider`, pointer/touch interaction from `useChartInteraction`.
- Data requirements: records with date-like `xDataKey`, numeric `open/high/low/close`.
- Exposed render context:
  - `data`, `xScale`, `yScale`
  - chart dimensions and margins
  - `columnWidth`, `bandWidth`
  - tooltip/selection state
  - `xAccessor`, `dateLabels`
  - hovered candle index
- Later integration:
  - This is the right insertion point for reusable SVG `VisionLayer`.
  - Layer should be a normal child component rendered after `Candlestick` when overlays must appear above candles, or before `Candlestick` for boxes/background zones.
  - Avoid coupling the layer to `PriceChart`; use chart context plus explicit `events` props.

### `frontend/src/components/charts/candlestick.tsx`

- Current role: draws each OHLC candle as SVG `motion` rects/lines.
- Renderer: SVG groups and `motion/react`.
- Data needs: `open/high/low/close`, date via chart `xAccessor`, scales, `bandWidth`, `columnWidth`.
- Existing indicator affordance: body pattern props and hover fade:
  - `bodyPatternPositive`
  - `bodyPatternNegative`
  - `insideStrokeWidth`
  - `hoveredCandleIndex`
- Later integration:
  - Use `VisionLayer` for pattern boxes/pins/labels instead of adding pattern-specific logic to `Candlestick`.
  - Keep candle styling props for simple per-candle highlighting only if the event has already been resolved upstream.

### `frontend/src/components/charts/chart-context.tsx`

- Current role: shared chart context and theme CSS variable references.
- Renderer: none directly.
- Data needs: already carries all scale/dimension/interaction state needed by SVG overlays.
- Later integration:
  - If `VisionLayer` needs candle pixel bounds repeatedly, add derived helpers here later, but only when implementation needs it.
  - Current context is enough for first SVG overlay pass.

### `frontend/src/components/charts/grid.tsx`, `x-axis.tsx`, `y-axis.tsx`

- Current role: chart decoration and labels.
- Renderer: SVG for grid, React portals for axes.
- Data needs: chart scales, dimensions, margins.
- Later integration:
  - No direct Candle Vision logic.
  - `VisionLayer` must account for portal-rendered axes and chart margins so labels do not collide with y-axis/edge labels.

### `frontend/src/components/charts/use-chart-interaction.ts`

- Current role: mouse/touch tooltip and selection state.
- Renderer: none directly.
- Data needs: `xScale`, `yScale`, data, line configs, `xAccessor`, bisector, margins.
- Later integration:
  - Reuse tooltip/hover index for event hover where possible.
  - `VisionLayer` should avoid taking over pointer handlers unless it is only reading events or forwarding pointer events back to chart interaction.

### `frontend/src/components/charts/tooltip/*`

- Current role: crosshair, tooltip box, date ticker, dots.
- Renderer: SVG overlay and React portals into chart container.
- Data needs: `tooltipData`, `lines`, dimensions, `xAccessor`, optional custom rows/content.
- Later integration:
  - Good place to show Candle Vision event detail when the hovered candle intersects one or more events.
  - Do not make the tooltip the source of truth for decisions; it should render derived event context only.

### `frontend/src/routes/Ride.tsx`, `frontend/src/components/RideChart.tsx`, `frontend/src/components/RideChartV4.tsx`

- Current route owner: `/` and any non-special fallback path; comments also preserve old `/ride` behavior.
- Renderer:
  - React route shell overlays gameplay UI.
  - `RideChart` and `RideChartV4` mount fixed p5 canvases.
  - Real drawing occurs in `useRideGesture` and `useRideGestureV4`.
- Data shape:
  - v3 receives `RoundInfo`, `SegmentInput[]`, picked barrier, phase, multiplier, stake, callbacks.
  - v4 receives `RoundInfoV4`, `SegmentInputV4[]`, phase, multiplier, stake, callbacks.
  - Hooks expand segment keys through `@wick/sdk` `expandSegment` into local `RenderCandle` objects with `open/high/low/close`, `animation`, `isLive`, and existing SDK pattern cue fields.
- Existing indicators:
  - v3/v4 draw grid, candles, barriers, live price labels, PnL line.
  - v4 also draws laser trace.
  - Both hooks already carry `armedPattern` and `postHocPatterns` per render candle and draw pattern tooltips.
- Later integration:
  - Do not start here. The p5 hooks have their own render loop, animation state, and gameplay input handling.
  - First define renderer-agnostic Candle Vision outputs from candle arrays.
  - Then add a p5-specific `VisionLayer` adapter that can draw into the existing p5 frame after candles and before price/PnL lines.
  - `TradeDecisionLayer` for Ride should be explicitly gameplay-aware: it needs current phase, active position, nearest barrier/touch rules, stake/multiplier, and segment age, not just chart patterns.

## Suggested Integration Order

1. Stabilize Candle Vision data contracts on `/candle-vision`.
   - Keep `CandleInput[]` and `CandlePatternEvent[]` as the canonical scanner input/output.
   - Separate scan/rank/select from the lightweight-charts overlay so renderer adapters can share it.

2. Add reusable SVG `VisionLayer` for `frontend/src/components/charts`.
   - Target `CandlestickChart` first.
   - Inputs: `events`, optional `activeFamily`, optional `spotlightId`, optional hover callback.
   - Reads scales and dimensions from `useChart`.
   - Renders boxes, pins, labels, and event hover affordances in SVG.

3. Wire `/pro` `PriceChart`.
   - Replace or augment synthetic candles with real OHLC history when available.
   - Convert `OHLCDataPoint[]` to `CandleInput[]`.
   - Run scan/rank/select in `PriceChart` or a small hook.
   - Render `VisionLayer` inside `CandlestickChart`.
   - Add `TradeDecisionLayer` after Vision events exist, using `MarketSnapshot`, barrier, selected interval, spot, and ranked signals.

4. Back-port the renderer-agnostic scan pipeline into Ride.
   - Convert local `RenderCandle[]` in `useRideGesture`/`useRideGestureV4` to Candle Vision input.
   - Keep the scanner outside low-level p5 drawing where possible; pass selected events into the p5 draw loop through refs.
   - Preserve existing SDK `armedPattern`/`postHocPatterns` until Candle Vision fully replaces or reconciles them.

5. Add p5 `VisionLayer` adapter for Ride.
   - Draw after `drawCandles()`.
   - Draw before price labels, price line, laser trace/PnL line when the event should sit behind gameplay-critical state.
   - For any event that affects active trade messaging, feed `TradeDecisionLayer` separately rather than reading canvas draw state.

6. Add `TradeDecisionLayer` per surface.
   - `/pro`: market-analysis decisions, barrier/spot context, selected interval.
   - `/ride` v4: touch-either decision context, nearest barrier, segment age, active phase, stake/multiplier.
   - `/ride` v3: picked barrier/open-window context, current round, active phase, stake/multiplier.
   - `/candle-vision`: optional demo decision panel only after production surfaces agree on data contract.

## Open Data Gaps

- `/pro` still synthesizes OHLC from current market snapshots. Candle Vision needs real historical OHLCV for meaningful production signals.
- The reusable SVG chart has no explicit event-to-pixel helper yet. The existing context has enough data, but implementation should centralize event box positioning once more than one overlay needs it.
- Ride p5 hooks keep render candles inside the p5 closure. Later integration will need a small bridge or ref-based scanner input without recreating the p5 instance.
- There are two pattern systems today: SDK `armedPattern`/`postHocPatterns` in Ride, and `@sui-options/candle-vision` events in `/candle-vision`. The later work should define whether Candle Vision supersedes, wraps, or coexists with SDK cues.
