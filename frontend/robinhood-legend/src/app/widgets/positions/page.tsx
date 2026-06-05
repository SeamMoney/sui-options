'use client';
import { PositionsTable } from '@/components/widgets/PositionsTable';

export default function PositionsPreviewPage() {
  return (
    <div className="rh-bw-ds--theme--glass--dark--regular--base" style={{ width: '100vw', height: '100vh', background: '#000', color: '#fff', padding: 24 }}>
      <div style={{ height: '100%', border: '1px solid #29292b', borderRadius: 8, overflow: 'hidden' }}>
        <PositionsTable />
      </div>
    </div>
  );
}
