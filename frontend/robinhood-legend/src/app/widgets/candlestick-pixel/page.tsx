'use client';
import { PixelCandlestickChart } from '@/components/widgets/PixelCandlestickChart';
export default function Page() {
  return (
    <div className="rh-bw-ds--theme--glass--dark--regular--base" style={{ width: '100vw', height: '100vh', background: '#000' }}>
      <PixelCandlestickChart />
    </div>
  );
}
