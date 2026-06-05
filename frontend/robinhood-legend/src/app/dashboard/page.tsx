'use client';

/**
 * The real 6-pane Robinhood-Legend dashboard, assembled from the existing
 * widget components — no modifications to any of them. Each widget is
 * self-contained (generates its own data) and shares the dark Legend theme.
 *
 * Layout (CSS grid areas):
 *   ┌──────────┬──────────────────┬──────────┐
 *   │ detail   │      chart       │  chain   │
 *   ├──────────┼──────────────────┼──────────┤
 *   │ positions│    order book    │  recent  │
 *   └──────────┴──────────────────┴──────────┘
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

const pane: React.CSSProperties = {
  minHeight: 0,
  minWidth: 0,
  overflow: 'hidden',
  borderRadius: 10,
  border: '1px solid #29292b',
  background: '#0a0a0a',
};

export default function LegendDashboardPage() {
  return (
    <main
      className="rh-bw-ds--theme--glass--dark--regular--base"
      style={{
        width: '100vw',
        height: '100vh',
        overflow: 'auto',
        background: '#000',
        color: '#fff',
        padding: 14,
        display: 'grid',
        gridTemplateColumns: '340px minmax(0, 1.7fr) 360px',
        gridTemplateRows: 'minmax(560px, 1.55fr) minmax(280px, 1fr)',
        gridTemplateAreas: `
          "detail    chart      chain"
          "positions orderbook  recent"
        `,
        gap: 12,
      }}
    >
      <section style={{ ...pane, gridArea: 'detail' }}>
        <InstrumentDetail
          symbol={SYMBOL}
          name="NVIDIA"
          price={SPOT}
          changeDollar={CHANGE_DOLLAR}
          changePct={CHANGE_PCT}
        />
      </section>

      <section style={{ ...pane, gridArea: 'chart', position: 'relative' }}>
        <CandleVisionScannerChart />
      </section>

      <section style={{ ...pane, gridArea: 'chain' }}>
        <OptionsChainWidget
          symbol={SYMBOL}
          spot={SPOT}
          delta={CHANGE_DOLLAR}
          pctChange={CHANGE_PCT}
        />
      </section>

      <section style={{ ...pane, gridArea: 'positions' }}>
        <PositionsTable />
      </section>

      <section style={{ ...pane, gridArea: 'orderbook' }}>
        <OrderBook symbol={SYMBOL} lastPrice={SPOT} changePct={CHANGE_PCT} rowCount={21} />
      </section>

      <section style={{ ...pane, gridArea: 'recent' }}>
        <PixelRecentOrders />
      </section>
    </main>
  );
}
