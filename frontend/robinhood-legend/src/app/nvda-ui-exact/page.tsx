'use client';
import { SimulatedReturns } from '@/components/widgets/SimulatedReturns';

// Was the static SVG mockup (App.jsx, kept on disk for reference). Swapped for
// the interactive SimulatedReturns component — scrub the curve, DTE/IV sliders
// reshape it live, P&L crosshair follows the cursor.
export default function NvdaUiExactPage() {
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        // Dark-grey gradient panel (matches the official Simulated Returns pics) —
        // a clear grey, lighter toward the top, NOT near-black.
        background: 'radial-gradient(140% 100% at 50% 0%, #26262b 0%, #1a1a1e 50%, #131316 100%)',
      }}
    >
      <SimulatedReturns
        symbol="NVDA"
        spot={219.8}
        strike={220}
        kind="call"
        premium={5.25}
        quantity={1}
        dte={14}
        iv={0.45}
      />
    </div>
  );
}
