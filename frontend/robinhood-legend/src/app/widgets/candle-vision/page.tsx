'use client';

import { CandleVisionScannerChart } from '@/components/widgets/CandleVisionScannerChart';

export default function CandleVisionPreviewPage() {
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0d111a', color: '#e5e7eb', padding: 0 }}>
      <div style={{ height: '100%', overflow: 'hidden' }}>
        <CandleVisionScannerChart />
      </div>
    </div>
  );
}
