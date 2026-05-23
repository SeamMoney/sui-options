# 21. Tappr-Inspired Wick UI Port

Date: 2026-05-23

## Goal

Bring the Wick Markets trading surface closer to Tappr's fast, arcade-like layout while preserving Wick's trust boundary:

- Wick settlement remains on Sui Move.
- Wick trading still uses the existing `Market` / `Position` flow and `buildBuyTx`.
- The visual chart is a UI layer only. It does not become a settlement source.

Tappr was used as a product and interaction reference, not as copied source code.

## Imported Ideas

The port adopts these Tappr UI patterns:

- Top brand/nav bar with a compact live/testnet status chip.
- Asset strip above the chart instead of the old left market rail.
- Large rounded chart stage with dark grid, blue line, area fill, spot marker, and barrier band.
- Right rail with balance, market stats, recent taps, and leaderboard-style placeholders.
- Stake-per-tap control below the chart with fixed stake buttons.
- Big single action button that keeps the chosen side and payout preview visible.

## Wick-Specific Differences

The UI intentionally does not copy Tappr's settlement or data assumptions:

- Tappr's demo price feed and fake settlement engine are not used.
- Wick keeps Sui wallet / Dynamic wallet integration.
- Wick keeps the existing CPMM-style touch/no-touch trade logic.
- Wick keeps existing live market and portfolio query hooks.
- Leaderboard and recent taps are visual placeholders until the F2 indexer/API lands.

## Files Added

- `frontend/src/components/market/TapprPriceStage.tsx`
  - SVG chart stage inspired by Tappr's line/area chart.
  - Shows Wick spot, barrier, and touch band.
  - Uses deterministic synthetic display history until oracle history/indexer data is available.

- `frontend/src/components/market/TapprTradePanel.tsx`
  - Tappr-style stake selector and side/action panel.
  - Reuses Wick's existing `buildBuyTx` path.
  - Keeps wallet balance, gas headroom, and coin-size checks.

- `frontend/src/components/FastRideStage.tsx`
  - SVG ride chart experiment for `/ride`.
  - Fed by Wick `SegmentRecorded` events expanded through `seededPath.expandSegment`.
  - Preserves the existing ride open/close/cranker callbacks.

## Files Changed

- `frontend/src/App.tsx`
  - Replaced the root trading shell with a Tappr-like layout.
  - Kept portfolio routing in the same app.

- `frontend/src/routes/Ride.tsx`
  - Swapped the p5 ride chart wrapper for `FastRideStage`.
  - Added a desktop right rail for ride balance, live PnL, barrier flow, and recent settlements.

- `frontend/src/index.css`
  - Added Wick grid background utility.
  - Compact dApp Kit connect button styling for the Tappr-like header.

## QA Notes

Ran:

- `cd frontend && npm run typecheck`

Local visual QA:

- `http://127.0.0.1:5173/`
- `http://127.0.0.1:5173/ride`

Local environment note: this machine is running an x64 Node binary on an arm64 Mac environment. To start Vite locally, optional native packages for x64 were installed with `--no-save` for local QA only.

## Follow-Ups

- Replace synthetic root chart history with indexed oracle/candle history once F2 lands.
- Wire right-rail recent taps and leaderboard to the F2 API.
- Tune mobile root layout after wallet-button behavior is tested with Dynamic enabled in production.
