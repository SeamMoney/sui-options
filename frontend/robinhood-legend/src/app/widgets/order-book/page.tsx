'use client';
import { useState } from 'react';
import { PixelOrderBook } from '@/components/widgets/PixelOrderBook';

export default function OrderBookPreviewPage() {
  const [pending, setPending] = useState<{ side: 'buy' | 'sell'; type: 'limit' | 'stop' | 'market'; price: number } | null>(null);
  return (
    <div
      className="rh-bw-ds--theme--glass--dark--regular--base"
      style={{ width: '100vw', height: '100vh', display: 'flex', padding: 0, background: '#000', color: '#fff' }}
    >
      <div style={{ width: 520, height: '100%', background: '#000' }}>
        <PixelOrderBook
          symbol="AMD"
          lastPrice={219.8}
          changePct={2.14}
          priceStep={0.25}
          rowCount={41}
          pendingOrder={pending}
          showInfoBanner={false}
          onTrade={(side) => console.log('trade:', side)}
          onLadderClick={(price, side) => setPending({ side, type: 'limit', price })}
        />
      </div>
    </div>
  );
}
