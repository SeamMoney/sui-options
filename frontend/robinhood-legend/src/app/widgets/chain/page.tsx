'use client';
import { OptionsChainWidget } from '@/components/widgets/OptionsChainWidget';

export default function ChainPreviewPage() {
  return (
    <div
      className="rh-bw-ds--theme--glass--dark--regular--base"
      style={{ width: '100vw', height: '100vh', display: 'flex', padding: 24, gap: 24, background: '#000' }}
    >
      <div style={{ width: 540, height: '100%' }}>
        <OptionsChainWidget
          symbol="TSLA"
          spot={444.17}
          delta={15.82}
          pctChange={3.69}
          onAskClick={(row, side, kind) => {
            // Hook this to the order-form flyout later. For now log.
            // eslint-disable-next-line no-console
            console.log('[chain] open order form for', side, kind, row);
          }}
        />
      </div>
      <div style={{ flex: 1, color: '#888', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.6 }}>
        <h2 style={{ color: '#fff', fontSize: 14, margin: '0 0 12px' }}>OptionsChainWidget · standalone</h2>
        <p>Pure React implementation; not driven by captured state graph.</p>
        <ul style={{ paddingInlineStart: 16 }}>
          <li>Toggle Buy/Sell — recolors Ask pills (green ↔ orange)</li>
          <li>Toggle Call/Put — regenerates chain data (deltas flip sign for puts)</li>
          <li>Click row body — expand option detail Stats + Greeks</li>
          <li>Hover row — purple-tinted background</li>
          <li>Hover Ask pill — solid green/orange fill</li>
          <li>Click Ask pill — fires onAskClick (currently logs to console)</li>
          <li>Click expiration — opens dropdown of expirations</li>
        </ul>
        <p style={{ marginTop: 16 }}>Data is mock-generated each render based on spot + kind. To wire real data, replace generateChain() with a fetch.</p>
      </div>
    </div>
  );
}
