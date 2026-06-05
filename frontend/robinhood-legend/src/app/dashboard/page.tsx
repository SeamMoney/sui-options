'use client';

/**
 * Robinhood-Legend dashboard — the real widget components, untouched, wrapped in
 * proper Legend window chrome: a top tab bar + a tight edge-to-edge 3×2 grid
 * with framed panes. Only the FRAME is ours; the panes are verbatim.
 *
 * Layout (matches the Legend reference):
 *   ┌────────────┬───────────────┬────────────┐
 *   │ instrument │     chart     │ order book │
 *   ├────────────┼───────────────┼────────────┤
 *   │ recent     │ options chain │ positions  │
 *   └────────────┴───────────────┴────────────┘
 */

import { CandleVisionScannerChart } from '@/components/widgets/CandleVisionScannerChart';
import { OptionsChainWidget } from '@/components/widgets/OptionsChainWidget';
import { OrderBook } from '@/components/widgets/OrderBook';
import { InstrumentDetail } from '@/components/widgets/InstrumentDetail';
import { PositionsTable } from '@/components/widgets/PositionsTable';
import { PixelRecentOrders } from '@/components/widgets/PixelRecentOrders';

const SYMBOL = 'NVDA';
const SPOT = 219.8;
const CHANGE_PCT = 2.14;
const CHANGE_DOLLAR = 4.6;

const PANE_BG = '#0b0b0d';
const GUTTER = '#000';
const BORDER = '#1c1c1f';

const pane: React.CSSProperties = {
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden',
  background: PANE_BG,
  border: `1px solid ${BORDER}`,
};

function Tab({ label, active }: { label: string; active?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 12px',
        borderRadius: 7,
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        color: active ? '#f4f4f5' : '#8a8a90',
        background: active ? 'rgba(255,255,255,.06)' : 'transparent',
        whiteSpace: 'nowrap',
        cursor: 'default',
      }}
    >
      {label}
    </span>
  );
}

function TopBar() {
  return (
    <div
      style={{
        height: 46,
        flex: '0 0 46px',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 12px',
        background: '#0a0a0c',
        borderBottom: `1px solid ${BORDER}`,
        color: '#f4f4f5',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <span style={{ width: 22, height: 22, borderRadius: 6, background: '#8a63f5', marginRight: 8, flex: '0 0 auto' }} />
      <Tab label="▦ Stock trading" active />
      <Tab label="≣ Advanced options" />
      <Tab label="◔ Chart spotlight" />
      <Tab label="⤧ Options trading" />
      <Tab label="+" />
      <span style={{ flex: 1 }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 14px', borderRadius: 999, background: 'rgba(255,255,255,.05)', fontSize: 13, color: '#cfcfd4' }}>
        ☾ Focus <span style={{ width: 6, height: 6, borderRadius: 999, background: '#1ed760' }} />
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ padding: '5px 12px', borderRadius: 7, fontSize: 13, color: '#cfcfd4', background: 'rgba(255,255,255,.05)' }}>＋ Add widget</span>
      <span style={{ padding: '5px 12px', borderRadius: 7, fontSize: 13, color: '#cfcfd4', background: 'rgba(255,255,255,.05)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>Individual ⇅</span>
      <span style={{ color: '#6a6a70', fontSize: 16, marginLeft: 6 }}>☆ ⌂ ⤢</span>
    </div>
  );
}

export default function LegendDashboardPage() {
  return (
    <main
      className="rh-bw-ds--theme--glass--dark--regular--base"
      style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', background: GUTTER, color: '#fff', overflow: 'hidden' }}
    >
      <TopBar />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(300px, 1.05fr) minmax(0, 2.4fr) minmax(330px, 1.5fr)',
          gridTemplateRows: 'minmax(520px, 1.35fr) minmax(260px, 1fr)',
          gridTemplateAreas: `
            "instrument chart      orderbook"
            "recent     chain      positions"
          `,
          gap: 4,
          background: GUTTER,
        }}
      >
        <section style={{ ...pane, gridArea: 'instrument' }}>
          <InstrumentDetail symbol={SYMBOL} name="NVIDIA" price={SPOT} changeDollar={CHANGE_DOLLAR} changePct={CHANGE_PCT} />
        </section>

        <section style={{ ...pane, gridArea: 'chart', position: 'relative' }}>
          <CandleVisionScannerChart />
        </section>

        <section style={{ ...pane, gridArea: 'orderbook' }}>
          <OrderBook symbol={SYMBOL} lastPrice={SPOT} changePct={CHANGE_PCT} rowCount={21} />
        </section>

        <section style={{ ...pane, gridArea: 'recent' }}>
          <PixelRecentOrders />
        </section>

        <section style={{ ...pane, gridArea: 'chain' }}>
          <OptionsChainWidget symbol={SYMBOL} spot={SPOT} delta={CHANGE_DOLLAR} pctChange={CHANGE_PCT} />
        </section>

        <section style={{ ...pane, gridArea: 'positions' }}>
          <PositionsTable />
        </section>
      </div>
    </main>
  );
}
