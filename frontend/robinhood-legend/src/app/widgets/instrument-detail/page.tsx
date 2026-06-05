'use client';
import { InstrumentDetail } from '@/components/widgets/InstrumentDetail';

export default function InstrumentDetailPreviewPage() {
  return (
    <div className="rh-bw-ds--theme--glass--dark--regular--base" style={{ width: '100vw', height: '100vh', background: '#000', color: '#fff', padding: 24 }}>
      <div style={{ width: 460, height: '100%', border: '1px solid #29292b', borderRadius: 8, overflow: 'hidden' }}>
        <InstrumentDetail
          symbol="NVDA"
          name="NVIDIA"
          price={219.80}
          changeDollar={4.60}
          changePct={2.14}
        />
      </div>
    </div>
  );
}
