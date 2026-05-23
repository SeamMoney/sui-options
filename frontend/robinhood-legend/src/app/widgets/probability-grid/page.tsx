'use client';

import { ProbabilityGridChart } from '@/components/widgets/ProbabilityGridChart';

export default function ProbabilityGridPreviewPage() {
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#131722', color: '#d1d4dc', padding: 0 }}>
      <div style={{ height: '100%', overflow: 'hidden' }}>
        <ProbabilityGridChart />
      </div>
    </div>
  );
}
