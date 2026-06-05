'use client';
import { CandlestickChart } from '@/components/widgets/CandlestickChart';

export default function CandlestickChartPreviewPage() {
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#fff', color: '#111', padding: 0 }}>
      <div style={{ height: '100%', overflow: 'hidden' }}>
        <CandlestickChart symbol="NVDA" lastPrice={219.80} changeDollar={4.60} changePct={2.14} />
      </div>
    </div>
  );
}
