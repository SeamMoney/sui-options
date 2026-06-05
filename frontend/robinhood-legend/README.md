# Robinhood Legend Options UI

Self-contained frontend copy of the Robinhood Legend options UI extracted in
`website-cloner/sites/robinhood-legend-options/source-react`.

This lives under the Sui options repo so it can be refactored into reusable
options UI without depending on the website-cloner workspace.

## Run

    cd /Users/maxmohammadi/sui-options/frontend/robinhood-legend
    npm install
    npm run dev   # http://127.0.0.1:8769

Open: http://127.0.0.1:8769/legend/layout/d4ad4b9a-9aba-4a9b-bc88-0b455b796298

No mirror server is required. The Robinhood CSS/font assets are vendored into
`public/cdn.robinhood.com`, chart composites are in `public/chart-fixtures`, and
captured replay states are in `public/captures`.

## What was generated

- `src/app/layout.tsx` — global shell, dark theme, loads tokens + fonts + atomic CSS
- `src/app/legend/layout/[id]/page.tsx` — route per layout
- `src/components/LegendApp.tsx` — page shell with TopNav + widget instances
- `src/components/TopNav.tsx` — header strip (Stock trading / Options trading / …)
- `src/components/widgets/Widget_*.tsx` — one component per captured widget. JSX is the captured DOM, refactor at will.
- `src/components/Icon.tsx` + `icons.json` — every captured SVG icon, by name.
- `src/components/ChartImage.tsx` — drops the captured chart composite PNG into canvasArea slots. Replace with lightweight-charts when ready.
- `public/cdn.robinhood.com` — vendored Robinhood atomic CSS, fonts, and generated assets.
- `public/captures` — captured shell states used by the replay/state graph.

## Next steps

1. Run it and verify the options-chain view locally.
2. Replace `<ChartImage>` with a real candlestick chart (lightweight-charts).
3. Refactor each `Widget_N` into named components with prop interfaces.
4. Add Zustand stores for ticker / layout / order.
5. Wire `<Icon name="Plus16" />` calls instead of inline SVG dumps.
