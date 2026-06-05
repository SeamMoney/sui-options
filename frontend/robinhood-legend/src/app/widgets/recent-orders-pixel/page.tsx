'use client';
import { PixelRecentOrders } from '@/components/widgets/PixelRecentOrders';
export default function Page() {
  return (
    <div className="rh-bw-ds--theme--glass--dark--regular--base" style={{ width: '100vw', height: '100vh', background: '#000' }}>
      <PixelRecentOrders />
    </div>
  );
}
