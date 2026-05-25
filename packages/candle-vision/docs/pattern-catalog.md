# Pattern Catalog Overview

The catalog is a stable list of known candle-vision patterns. It lets UI surfaces, docs, filters, and renderers describe the same pattern universe even when only a subset has live detector logic.

## Families

| Family | Category | Purpose |
| --- | --- | --- |
| `candlestick` | `candlestick` | Single and multi-candle Japanese candlestick structures. |
| `vision-candle` | `vision-candle` | Shape and sequence detectors tuned for candle overlay UX. |
| `chart-setup` | `chart-pattern` or `technical-indicator` | Multi-bar chart structures and indicator-derived setup definitions. |

## Support State

Registry definitions expose `support: 'supported' | 'planned'`.

```ts
import { CANDLE_PATTERN_REGISTRY } from '@sui-options/candle-vision';

const supported = CANDLE_PATTERN_REGISTRY.supported();
const planned = CANDLE_PATTERN_REGISTRY.planned();
```

Use `supported()` for live scanner controls and `all()` for educational catalogs.

## Built-In Catalog Groups

### Candlestick

Includes doji variants, hammer variants, spinning tops, marubozu variants, engulfing, harami, piercing line, dark cloud cover, morning star, evening star, three white soldiers, three black crows, and additional multi-candle continuation or reversal definitions.

```ts
const candlesticks = CANDLE_PATTERN_REGISTRY.byFamily('candlestick');
```

### Vision Candle

Vision-candle events are optimized for overlay readability:

| Kind | Meaning |
| --- | --- |
| `vision-rejection` | Dominant wick rejection with range or volume context. |
| `vision-momentum` | Aligned directional bodies with monotonic closes. |
| `vision-compression` | Small mixed candles with contracting range. |

```ts
const visionPatterns = CANDLE_PATTERN_REGISTRY.byFamily('vision-candle');
```

### Chart Setup And Technical Indicator

Chart setup definitions include support and resistance retests, range breaks, double tops and bottoms, head and shoulders structures, triangles, wedges, flags, channels, cup and handle, moving average crosses, RSI, MACD, Bollinger, volume, ATR, and VWAP signals.

```ts
const chartPatterns = CANDLE_PATTERN_REGISTRY.byCategory('chart-pattern');
const indicatorPatterns = CANDLE_PATTERN_REGISTRY.byCategory('technical-indicator');
```

## Metadata For UI

Use family and category metadata for tabs, filters, colors, and descriptions.

```ts
const family = CANDLE_PATTERN_REGISTRY.familyMetadata('vision-candle');
const category = CANDLE_PATTERN_REGISTRY.categoryMetadata('technical-indicator');
```

Definitions also include `minBars` and `tags`, which are useful for UI hints and scanner prerequisites.

```ts
const hammer = CANDLE_PATTERN_REGISTRY.get('hammer');

console.log(hammer?.minBars);
console.log(hammer?.tags);
```

## Showcase Events

`createPatternShowcaseEvents` turns catalog entries into synthetic events over a supplied candle array. This is useful for pattern galleries and renderer QA.

```ts
import {
  CANDLE_VISION_PATTERN_CATALOG,
  createPatternShowcaseEvents,
} from '@sui-options/candle-vision';

const showcase = createPatternShowcaseEvents(candles, CANDLE_VISION_PATTERN_CATALOG);
```

Showcase events are deterministic display fixtures. Do not mix them with live scanner output unless the UI clearly labels them as examples.
