'use client';

import { Pine3DPane } from '@/components/widgets/Pine3DPane';

export default function Pine3DPreviewPage() {
  return (
    <main style={{ minHeight: '100vh', background: '#07080d', padding: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14, height: 'calc(100vh - 36px)' }}>
        <Pine3DPane variant="surface" title="Pine3D Surface" />
        <div style={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 14, minHeight: 0 }}>
          <Pine3DPane variant="trail" />
          <Pine3DPane variant="bars" />
        </div>
      </div>
    </main>
  );
}
