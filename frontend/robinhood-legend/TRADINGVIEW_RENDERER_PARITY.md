# TradingView Renderer Parity

Goal: reproduce a TradingView chart page as an owned implementation without pretending a hand-drawn SVG is equivalent to TradingView.

## Hard Truth

There are two different deliverables:

1. **Exact runtime**
   Use TradingView itself through an official embed, iframe, or licensed Charting Library/Advanced Charts path. This is the only credible way to get 100% matching interaction, renderer quirks, font metrics, crosshair behavior, scale behavior, and animation.

2. **Owned renderer**
   Rebuild the behavior in local source using `lightweight-charts` or the licensed TradingView Charting Library, plus local indicator ports. This can become very close, inspectable, and editable, but it must be measured against a TradingView reference.

The current SVG recreation is not acceptable as a final renderer. It is a disposable visual reference only.

## What 100% Means

Do not claim parity unless all of these pass against the TradingView reference at the same viewport:

- Same symbol and exchange: `MNQ1!`, CME.
- Same interval: 5-minute.
- Same visible time range.
- Same OHLCV bars.
- Same chart settings: background, candle style, grid, price scale, time scale, margins, volume pane/overlay behavior.
- Same indicator settings for VARIS Zones.
- Same crosshair position and tooltip output for a fixed pointer coordinate.
- Same wheel zoom response after a deterministic event sequence.
- Same pan response after a deterministic drag sequence.
- Same screenshot diff under a threshold for:
  - default view
  - hovered candle
  - zoomed view
  - panned view
  - resized view

## Architecture

### Reference Oracle

Capture the real TradingView page with a browser harness:

- screenshot PNGs
- canvas size and device pixel ratio
- pointer/wheel event sequence
- visible time range
- right price scale labels
- OHLC legend values
- network OHLCV payloads when available

This is the source of truth. The local renderer is always compared against it.

### Local Renderer

Use one of two engines:

- **Best licensed path:** TradingView Charting Library / Advanced Charts, if available.
- **Best open-source path:** `lightweight-charts` with custom pane/series primitives.

Local modules:

- `data/tradingviewBars.ts`: captured or imported OHLCV bars.
- `indicators/varis.ts`: TypeScript port of the open-source VARIS Pine code.
- `renderers/VarisZonesPrimitive.ts`: canvas renderer for bands, fills, midline, labels.
- `components/TradingViewLikeChart.tsx`: base chart, volume, price scale, time scale, interaction wiring.
- `verify/tradingviewParity.ts`: captures and diffs TradingView reference vs local renderer.

### Indicator Port

The indicator must be ported from Pine source, not eyeballed.

Required outputs:

- inner/outer zone arrays per bar
- red midline array
- current legend values
- label/price marker values
- fill color and opacity rules

### Interaction Port

Parity is not just drawing. The local chart must match:

- wheel zoom granularity
- drag pan sensitivity
- crosshair snapping
- price scale width
- time axis label density
- right-scale last-price tags
- hover legend updates

## Next Work

1. ~~Replace the SVG chart path with a `lightweight-charts` renderer shell.~~
2. ~~Build the TradingView reference capture harness for the VARIS URL.~~
3. ~~Capture the exact reference viewport screenshot and chart metadata.~~
4. Capture/export the exact OHLCV data behind the reference chart.
5. Port VARIS Pine source into TypeScript.
6. Tune the VARIS primitive renderer against the captured Pine output.
7. Add hover/zoom/pan diff gates before claiming parity.

## Current Status

Implemented:

- `src/components/TradingViewVarisChart.tsx` now uses `lightweight-charts`.
- Candles, volume, right price scale, time scale, wheel zoom, drag pan, and crosshair come from Lightweight Charts.
- VARIS bands render as a synchronized canvas primitive attached to the candlestick series.
- The VARIS formula is now based on the extracted Pine source: HLC3 VWAP with a 17:00 session reset and fixed point bands.
- The saved TradingView layout was extracted from the page. It showed this specific chart uses `band1Points = 125.75` and `band2Points = 249.25`, not the Pine defaults of `10` and `20`.
- The local chart now generates a longer multi-session history so zooming/panning no longer exposes an empty indicator region at the original viewport boundary.
- `scripts/capture-tradingview-reference.mjs` captures the real TradingView page.
- `cloner/src/lib/tradingview_extract.mjs` is the reusable cloner-side extractor. It persists `chart-layout.json`, `tradingview-study-summary.json`, `pine-sources.json`, websocket frames, selected response bodies, screenshots, and optional canvas traces.
- `scripts/compare-varis-renderer.mjs` crops the reference chart and diffs it against the local renderer.
- The extractor now emits `tradingview-clone-report.json`. This is the product-facing truth file for TradingView targets: it records symbol, interval, saved bar spacing/right offset, candle styles, websocket method coverage, public vs inaccessible Pine sources, and whether the owned renderer is allowed to claim parity.

Current failure mode from the local screenshots:

- The local chart still uses generated OHLCV bars. VARIS is volume-weighted, so fake bars mean fake zones even when the Pine formula is correct.
- The saved TradingView publication page did not expose historical `timescale_update` bar messages in the current capture. The report correctly marks `historical-ohlcv-bars-not-captured`.
- The reference layout has exact runtime settings (`m_barSpacing = 4.372530488394797`, `m_rightOffset = 7.812002000000007`, candle colors, scale properties). The local renderer now uses the extracted bar spacing/right offset/colors, but that only fixes chart density and styling, not the data.
- VARIS rendering now breaks paths at session resets to avoid the artificial vertical fill/line artifacts that appeared when zooming out.

Latest measurement after switching to extracted Pine/layout settings:

- Reference: `reference/tradingview-varis-deep/default.png`
- Local: `reference/tradingview-varis-deep/local-compare-after-real-varis/local-default.png`
- Diff: `reference/tradingview-varis-deep/local-compare-after-real-varis/diff.png`
- Mismatch: `24.4728%`

Interpretation: the renderer now uses the real public VARIS script and saved layout settings, but it is still not pixel-perfect because the local bars are deterministic fixtures rather than the exact TradingView OHLCV stream and exact visible range.

Extracted source artifacts:

- `reference/tradingview-varis-source-extract/chart-layout.json`
- `reference/tradingview-varis-source-extract/tradingview-study-summary.json`
- `reference/tradingview-varis-source-extract/pine-sources.json`
- `reference/tradingview-varis-source-extract/pine-sources/VARIS_Zones_v1_PUB_42d8453e85bc46f7a65ceebeea1826eb.pine`

Important caveat: the chart layout also references two `USER;...` Pine studies whose source is not public. TradingView returns `User is not allowed to see source code of pine` for those. Their saved inputs/styles are still captured in `tradingview-study-summary.json`.

Latest product report artifact:

- `reference/tradingview-varis-report-check/tradingview-clone-report.json`
- `cloneReadiness.ownedRenderer = "blocked"`
- blockers:
  - `historical-ohlcv-bars-not-captured`
  - `2-private-or-inaccessible-pine-study-source(s)`
  - `tradingview-proprietary-canvas-renderer-not-reimplemented`

## Product Rule

Never label a chart as "TradingView-perfect" unless it passes the parity harness. If it uses an iframe, call it exact-runtime. If it uses local code, call it owned-renderer and report the measured diff.
