# Trade Decision Overlay Visual Spec

## Context

The current Candle Vision screen is a dark, full-viewport `lightweight-charts` candlestick surface with a right-side ranked signal panel, streaming candles, replay spotlighting, and a canvas overlay for detected pattern events.

The existing overlay already uses:

- Active detection boxes that fade into collapsed pins.
- Confidence rails, corner brackets, scanlines, and anchor pings for vision/setup events.
- Collision limits for boxes and labels.
- Family filters, replay, hover descriptions, and spotlight state.

The buy/sell decision layer should not compete with those pattern annotations. It should sit above them as a quant-style synthesis layer: one current directional decision, one trade plan, and a small number of supporting/refuting labels.

## Direction

The visual language should feel like an execution cockpit, not a prediction sticker. The overlay should answer:

- What is the current decision: buy, sell, wait, or invalidated?
- Where is the entry region?
- Where is the stop?
- Where are target zones?
- Which observations confirmed the decision?
- Which observations denied or weakened it?
- How did the decision evolve during replay?

Use the existing theme foundation:

- Background: `#0d111a`
- Bullish: `#21d07a`
- Bearish: `#ff5263`
- Neutral/wait: `#f5c542`
- Compression/info: `#38bdf8`
- Setup/context: `#a78bfa`
- Text: `#e5e7eb`
- Muted text: `#8b94a7`

Add one stricter decision palette:

- Buy decision: `#35e987`
- Sell decision: `#ff4d61`
- Wait decision: `#f5c542`
- Invalidated/denied: `#94a3b8`
- Risk/stop: `#ff7a45`
- Target: `#3dd6ff`

## Layer Stack

Render the decision overlay after candles and before the existing pattern overlay labels where possible, or as a dedicated canvas layer above the pattern overlay with stricter density rules.

Recommended visual priority:

1. Crosshair and chart native price/time labels.
2. Active decision ribbon and entry/stop/target zones.
3. Spotlighted pattern event.
4. Confirmation/denial labels.
5. Existing pattern boxes and pins.
6. Historical/replay ghost states.

The decision layer should reserve chart real estate instead of filling every detected pattern. Keep all decision labels away from the right panel by respecting the current `labelRightInsetPx` behavior.

## Decision Ribbon

Place a compact ribbon across the active decision window, anchored to the latest decision candle range rather than the entire chart. It should read as a trade state lane.

Ribbon geometry:

- Horizontal span: from decision `startIndex` to either current latest candle or decision expiry.
- Vertical position: just above the high for sell decisions, just below the low for buy decisions, and centered near recent VWAP/mid for wait decisions.
- Height: 18-24 px.
- Corner radius: 4 px.
- Fill alpha: 0.12 active, 0.06 historical ghost.
- Stroke alpha: 0.72 active, 0.24 historical ghost.

Ribbon contents:

- Left capsule: `BUY`, `SELL`, `WAIT`, or `VOID`.
- Score: integer confidence, for example `82`.
- State: `FORMING`, `CONFIRMED`, `DENIED`, `EXPIRED`.
- Time-to-live tick marks if the decision has an expiry window.

Behavior:

- Buy ribbon grows from left to right with a green leading scan edge.
- Sell ribbon grows from left to right with a red leading scan edge.
- Wait ribbon pulses once, then becomes a thin amber rail.
- Denied ribbon desaturates to gray and gets a diagonal slash hatch.

Do not use large centered text over candles. The ribbon is a lane, not a banner.

## Entry, Stop, And Target Zones

Decision zones should look like measured risk bands, not boxes around patterns.

Entry zone:

- Draw as a translucent horizontal band between `entryLow` and `entryHigh`.
- Use decision color fill at 0.08 alpha.
- Use a 1 px top and bottom boundary.
- Add a small right-edge tag: `ENTRY`.
- If price is inside the zone, brighten the boundary alpha and add a small current-price notch.

Stop zone:

- Draw as a risk band from stop price to the nearest edge of the entry zone.
- Use risk orange/red fill at 0.07 alpha.
- Boundary line should be dashed: `[5, 5]`.
- Right-edge tag: `STOP`.
- If stop is hit, flash once, convert decision state to `DENIED`, and collapse the entry/target zones.

Target zones:

- Support up to three targets: `T1`, `T2`, `T3`.
- Draw each target as a thin horizontal rail with a faint fill extending back to the entry span.
- Use target cyan for rails, with alpha decreasing by distance:
  - `T1`: 0.72 stroke
  - `T2`: 0.52 stroke
  - `T3`: 0.38 stroke
- Tags sit on the right side and include R multiple when available: `T1 1.4R`.
- When a target is reached, fill the tag and leave a small check marker.

Zone labels must be right-edge tags, not floating labels over candles. They should share the existing compact tag style: dark fill, colored stroke, 10-11 px bold tabular text.

## Confirmation And Denial Labels

The decision layer should show only the most useful evidence, split into confirmation and denial.

Confirmation label:

- Color: decision color.
- Shape: compact pill with a 3 px left rail.
- Placement: near the event anchor, but outside candle bodies when possible.
- Text format: short evidence label plus weight, for example `Breakout +18`.

Denial label:

- Color: invalidated gray or risk orange depending on severity.
- Shape: compact pill with diagonal hatch or small minus marker.
- Text format: `Failed reclaim -14`, `Low volume -9`, or `Stop risk -22`.

Density rules:

- Show max 3 confirmation labels.
- Show max 2 denial labels.
- Confirmation and denial labels should never overlap the decision ribbon.
- If labels collide, keep the highest absolute contribution by score.
- Evidence labels older than the active decision window collapse into tiny ticks on the ribbon.

Use verbs that describe evidence, not advice:

- Good: `Momentum +16`, `Higher low +12`, `Compression break +18`.
- Avoid: `Guaranteed`, `Must buy`, `Safe entry`, `No risk`.

## Replay Behavior

Replay should tell the decision story in phases. It should reuse the current replay/spotlight pattern but sequence decision artifacts before detailed pattern artifacts.

Replay sequence:

1. Past candles dim to 70% and pattern pins remain visible.
2. Evidence ticks appear in chronological order.
3. Confirmation labels promote into the decision ribbon.
4. Entry zone expands horizontally from the trigger candle.
5. Stop zone drops/rises into place.
6. Targets draw from nearest to farthest.
7. Final decision state locks for 900-1400 ms.
8. Historical state collapses to a ghost ribbon and small outcome stamp.

Timing:

- Evidence tick: 180 ms.
- Ribbon intro: 260-360 ms.
- Entry/stop/target zone intro: 220 ms each.
- Outcome flash: 300 ms.
- Reduced motion: skip sweeps and use opacity transitions only.

Historical replay states:

- Confirmed winner: ghost ribbon with small `+R` outcome stamp.
- Denied/stopped: gray ribbon with risk edge and `VOID` or `STOP`.
- Expired/no trade: amber ghost ribbon with `EXPIRED`.

Do not replay every detected pattern box. Replay only evidence that contributed to the decision, then optionally spotlight the strongest source pattern.

## Modes

### Focus Mode

Purpose: current actionable decision.

Show:

- Latest decision ribbon.
- Entry/stop/target zones for the active decision.
- Max 3 confirmation labels and max 1 denial label.
- Existing pattern overlay reduced to pins unless spotlighted.

Hide:

- Non-contributing pattern labels.
- Historical ghost decisions except the most recent outcome.
- Low-confidence evidence.

Use this as the default mode.

### Scan Mode

Purpose: browse multiple recent opportunities.

Show:

- Up to 5 decision ribbons in the visible chart range.
- Active decision zones only for the hovered/spotlighted decision.
- Historical outcomes as compact stamps: `+1.6R`, `STOP`, `NO FILL`, `EXPIRED`.
- Existing pattern overlay follows current family filters.

Behavior:

- Hovering a ribbon promotes its zones and evidence labels.
- Right panel rows can spotlight a decision the same way signal rows currently spotlight events.
- Non-hovered ribbons use 35-45% opacity.

### Debug Mode

Purpose: inspect why a decision was produced.

Show:

- Full evidence ledger beside the right panel or in a collapsible debug drawer.
- Raw weighted inputs: pattern, family, direction, confidence, recency, contribution.
- Decision thresholds: buy score, sell score, denial score, minimum edge, expiry.
- All zone source prices: entry, stop, target calculation basis.
- Rejected alternatives in muted rows.

Chart overlay:

- Show all evidence anchors as small numbered dots.
- Connect numbered dots to the debug ledger on hover.
- Use thin lines and low alpha to avoid chart takeover.

Debug mode can be visually busier because it is not the trading default.

## Clutter Avoidance

The decision layer must reduce information, not add another noisy overlay.

Hard limits:

- One fully expanded decision at a time.
- One active entry zone, one active stop zone, max three target rails.
- Max 5 visible decision ribbons in scan mode.
- Max 5 total evidence labels in focus mode.
- Max 2 right-edge zone tags per price cluster; combine if tags are within 14 px.

Collision strategy:

- Reserve right-side tag lane before rendering pattern labels.
- Place zone tags first, then ribbon labels, then evidence labels, then pattern labels.
- If an evidence label collides with a zone tag, collapse it into a tick on the ribbon.
- If multiple target tags collide, stack vertically with 3 px gaps or combine into `T1/T2`.
- Never place labels over the latest price label or crosshair price label.

Opacity strategy:

- Existing pattern boxes drop to 45-60% alpha when a decision is active.
- Non-contributing pattern pins remain visible at normal alpha.
- Historical decision artifacts use 20-35% alpha.
- A stopped/denied decision should desaturate rather than continue glowing red or green.

Spatial strategy:

- Use horizontal price bands for trade plan.
- Use the ribbon for decision status.
- Use tiny anchor labels only for evidence.
- Avoid floating callouts in the middle of dense candle regions.

Text strategy:

- Keep chart labels short: 12 characters preferred, 18 max.
- Put detailed rationale in the side panel or debug drawer.
- Use numeric score deltas for evidence labels instead of long descriptions.

## Data Model Sketch

The renderer can consume a derived decision object separate from raw pattern events.

```ts
type TradeDecision = {
  id: string;
  direction: "buy" | "sell" | "wait";
  status: "forming" | "confirmed" | "denied" | "expired";
  startIndex: number;
  triggerIndex: number;
  expiresIndex?: number;
  confidence: number;
  score: number;
  entry?: { low: number; high: number };
  stop?: { price: number; reason: string };
  targets?: Array<{ price: number; label: "T1" | "T2" | "T3"; r?: number; reached?: boolean }>;
  evidence: Array<{
    eventId?: string;
    index: number;
    price: number;
    label: string;
    contribution: number;
    kind: "confirm" | "deny";
  }>;
  outcome?: "winner" | "stopped" | "no-fill" | "expired";
  realizedR?: number;
};
```

This keeps the decision renderer independent from `CandlePatternEvent` while still allowing evidence labels to spotlight source events.

## Prototype Acceptance Criteria

- In focus mode, a user can identify decision, entry, stop, and first target within two seconds.
- Existing pattern detections remain available but visually subordinate.
- Replay communicates why the decision formed without replaying every scanner event.
- Dense signal periods collapse into one ribbon, zones, and evidence ticks rather than many boxes.
- Debug mode exposes enough weighted inputs to validate the decision logic.
- Reduced-motion users get equivalent state changes without scanline sweeps or pulsing.

