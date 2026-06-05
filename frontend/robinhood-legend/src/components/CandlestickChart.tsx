'use client';

export function CandlestickChart() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        minHeight: 420,
        background: '#c3beb6',
        overflow: 'hidden',
      }}
    >
      <img
        src="https://s3.tradingview.com/a/a2dCFt1c.png?v=1779125482"
        alt="VARIS Zones TradingView publication preview"
        draggable={false}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          objectPosition: 'center',
          userSelect: 'none',
        }}
      />
    </div>
  );
}
