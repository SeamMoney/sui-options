'use client';

import { WickPressureZonesChart } from '@/components/widgets/WickPressureZonesChart';

export default function WickPressureZonesPreviewPage() {
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#131722', color: '#d1d4dc', padding: 0 }}>
      <div style={{ height: '100%', overflow: 'hidden' }}>
        <WickPressureZonesChart />
      </div>
    </div>
  );
}
