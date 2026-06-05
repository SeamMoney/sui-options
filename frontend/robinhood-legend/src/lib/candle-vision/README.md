# Candle Vision

Candle Vision is the frontend pattern scanner used by the chart widgets.

## Product Contract

- `supported` is the number of pattern definitions the scanner knows about.
- `detectedRaw` is every detector match in the current candle window.
- `visible` is the ranked, non-overlapping subset drawn on the chart.
- `watchlist` is the forming subset that should be watched but not treated as confirmed.

Do not use one count for all four concepts. The chart should stay readable even when the raw detector finds many matches.

## Detector Layers

1. Candlestick rules: TA-Lib-style candle geometry.
2. Vision rules: normalized candle-window shape matching.
3. Chart structures: swing highs/lows, channels, triangles, flags, breakouts.
4. TA setups: moving averages, RSI, MACD, Bollinger, ATR, VWAP, volume.

## Visual Rules

- Keep candles readable first.
- Draw only ranked visible signals by default.
- Use dashed outlines for forming patterns and solid outlines for confirmed patterns.
- Animate only opacity, transform, and stroke-dash style properties.
- Keep labels collision-aware and outside the candle body when possible.

## Fixture Check

Run:

```bash
node scripts/candle-vision-fixture-check.mjs
```

The check guards against over-detection on random/choppy data and verifies that known synthetic patterns are still found.
