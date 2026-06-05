'use client';

import { ClustersVolumeProfileChart } from '@/components/widgets/ClustersVolumeProfileChart';

export default function ClustersVolumeProfilePreviewPage() {
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#131722', color: '#d1d4dc', padding: 0 }}>
      <div style={{ height: '100%', overflow: 'hidden' }}>
        <ClustersVolumeProfileChart />
      </div>
    </div>
  );
}
