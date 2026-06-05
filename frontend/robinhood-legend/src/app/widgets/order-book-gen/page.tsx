'use client';
import { PixelOrderBookGen } from '@/components/widgets/PixelOrderBookGen';

// Preview route for the auto-generated PixelOrderBookGen component. The
// component itself is produced by `node cloner/src/pixel_clone.mjs
// cloner/configs/robinhood-legend-orderbook.json` and is intentionally
// kept separate from the hand-tuned PixelOrderBook (which adds canvas
// drawing + simulated feed on top of the same captured DOM).
export default function OrderBookGenPreviewPage() {
  return (
    <div
      className="rh-bw-ds--theme--glass--dark--regular--base"
      style={{ width: '100vw', height: '100vh', display: 'flex', padding: 0, background: '#000', color: '#fff' }}
    >
      <div style={{ width: 520, height: '100%', background: '#000' }}>
        <PixelOrderBookGen
          onBuy={() => console.log('gen: buy')}
          onSell={() => console.log('gen: sell')}
          onQtyIncrement={() => console.log('gen: qty+')}
          onQtyDecrement={() => console.log('gen: qty-')}
          onOverlayClick={() => console.log('gen: overlay')}
        />
      </div>
    </div>
  );
}
