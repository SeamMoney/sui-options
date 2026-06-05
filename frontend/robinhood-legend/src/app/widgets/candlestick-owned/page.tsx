'use client';

import { TradingViewVarisChart } from '@/components/TradingViewVarisChart';

export default function CandlestickOwnedRendererPage() {
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#fff', color: '#111', padding: 0 }}>
      <div style={{ height: '100%', overflow: 'hidden' }}>
        <TradingViewVarisChart />
      </div>
    </div>
  );
}
