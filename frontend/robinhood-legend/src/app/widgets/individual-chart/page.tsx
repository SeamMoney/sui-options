'use client';
import { IndividualChart } from '@/components/widgets/IndividualChart';

export default function IndividualChartPreviewPage() {
  return (
    <div className="rh-bw-ds--theme--glass--dark--regular--base" style={{ width: '100vw', height: '100vh', background: '#000', color: '#fff', padding: 24, display: 'flex', gap: 24 }}>
      <div style={{ width: 420, height: '100%', border: '1px solid #29292b', borderRadius: 8, overflow: 'hidden' }}>
        <IndividualChart accountName="Individual" value={72.00} changeDollar={14.96} changePct={26.23} />
      </div>
      <div style={{ width: 420, height: '100%', border: '1px solid #29292b', borderRadius: 8, overflow: 'hidden' }}>
        <IndividualChart accountName="Individual (loss demo)" value={48.04} changeDollar={-3.21} changePct={-6.27} />
      </div>
    </div>
  );
}
