import React, { useMemo, useState } from 'react';

const chainRowsTop = [
  { strike: '$221', volume: '595', oi: '1,973', cop: '31.98%', delta: '0.5131', gamma: '0.0123', theta: '-0.1702', ask: '$12.25' },
  { strike: '$220', volume: '28,904', oi: '69,506', cop: '32.55%', delta: '0.5254', gamma: '0.0123', theta: '-0.1702', ask: '$12.70' },
  { strike: '$219', volume: '1,431', oi: '2,414', cop: '33.12%', delta: '0.5378', gamma: '0.0123', theta: '-0.1700', ask: '$13.20', selected: true },
];

const chainRowsBottom = [
  { strike: '$218', volume: '1,066', oi: '5,650', cop: '33.67%', delta: '0.5501', gamma: '0.0122', theta: '-0.1698', ask: '$13.70' },
  { strike: '$217', volume: '1,476', oi: '9,648', cop: '34.21%', delta: '0.5624', gamma: '0.0121', theta: '-0.1693', ask: '$14.65' },
  { strike: '$216', volume: '700', oi: '3,811', cop: '34.73%', delta: '0.5743', gamma: '0.0120', theta: '-0.1688', ask: '$15.30' },
];

const ticker = {
  symbol: 'NVDA',
  price: '$218.11',
  move: '$1.33 (0.61%)',
};

function App() {
  const [view, setView] = useState('chain');

  const ticket = view === 'chain'
    ? {
        title: 'NVDA 6/18 $219 Call',
        limit: '$13.20',
        mark: 'Mark $13.15 • Ask $13.20',
        cost: '$1,320.04',
      }
    : {
        title: 'NVDA 6/18 $219 Call',
        limit: '$13.20',
        mark: 'Mark $13.15 • Ask $13.20',
        cost: '$1,320.04',
      };

  return (
    <div className="terminal">
      <TopRibbon />
      <div className="terminal-grid">
        <main className="workspace">
          <SymbolHeader view={view} onViewChange={setView} />
          {view === 'chain' ? <OptionChain /> : <SimulatedReturns />}
        </main>
        <OrderTicket ticket={ticket} />
      </div>
    </div>
  );
}

function TopRibbon() {
  return (
    <div className="top-ribbon">
      <nav className="periods" aria-label="Chart periods">
        {['1D', '1W', '1M', '3M', 'YTD', '1Y', '5Y', 'All'].map((item) => (
          <button key={item} className={item === '1D' ? 'period-active' : ''}>{item}</button>
        ))}
      </nav>
      <div className="interval-picker">
        <span>Interval:</span>
        <strong>1D</strong>
        <span className="sort-arrows">◆</span>
      </div>
      <div className="auto-scale">
        <span className="lock-icon" aria-hidden="true" />
        <span>Auto-scale</span>
      </div>
    </div>
  );
}

function SymbolHeader({ view, onViewChange }) {
  return (
    <div className="symbol-header">
      <div className="symbol-left">
        <div className="swatch" />
        <div className="symbol-search" aria-hidden="true" />
        <strong className="symbol">NVDA</strong>
        <span className="quote-price">{ticker.price}</span>
        <span className="quote-down">▼ {ticker.move}</span>
      </div>
      <div className="view-tabs">
        <button className={view === 'chain' ? 'view-active' : ''} onClick={() => onViewChange('chain')}>Chain</button>
        <button className={view === 'returns' ? 'view-active' : ''} onClick={() => onViewChange('returns')}>Simulated Returns</button>
      </div>
      <div className="header-actions">
        <span className="sliders-icon" aria-hidden="true" />
        <span className="count-badge">1</span>
        <span className="kebab">⋮</span>
      </div>
    </div>
  );
}

function OptionChain() {
  return (
    <section className="chain-view">
      <div className="chain-toolbar">
        <Segmented options={['Buy', 'Sell']} active="Buy" />
        <Segmented options={['Call', 'Put']} active="Call" />
        <button className="date-select">
          <span>Exp Jun 18 (38D)</span>
          <span className="expiry-metric">48.69% (±31.38)</span>
          <span className="caret-stack">▴<br />▾</span>
        </button>
      </div>

      <div className="chain-table-wrap">
        <table className="chain-table">
          <thead>
            <tr>
              <th className="strike-col">Strike <span>↓</span></th>
              <th>Volume</th>
              <th>Open interest</th>
              <th>COP</th>
              <th>Delta</th>
              <th>Gamma</th>
              <th>Theta</th>
              <th className="ask-col">Ask</th>
            </tr>
          </thead>
          <tbody>
            {chainRowsTop.map((row) => (
              <React.Fragment key={row.strike}>
                <ChainRow row={row} />
                {row.selected && <ExpandedStats />}
              </React.Fragment>
            ))}
            <tr className="price-marker-row">
              <td colSpan="8"><span>$218.11</span></td>
            </tr>
            {chainRowsBottom.map((row) => <ChainRow key={row.strike} row={row} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Segmented({ options, active }) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button key={option} className={option === active ? 'selected' : ''}>{option}</button>
      ))}
    </div>
  );
}

function ChainRow({ row }) {
  return (
    <tr className={row.selected ? 'selected-row' : ''}>
      <td className="strike-cell"><span className={row.selected ? 'chev open' : 'chev'} /> <strong>{row.strike}</strong></td>
      <td>{row.volume}</td>
      <td>{row.oi}</td>
      <td>{row.cop}</td>
      <td>{row.delta}</td>
      <td>{row.gamma}</td>
      <td>{row.theta}</td>
      <td className="ask-cell"><button>{row.ask}</button></td>
    </tr>
  );
}

function ExpandedStats() {
  const statRows = [
    ['Bid', '$13.05'], ['Mark', '$13.13'], ['High', '$15.30'], ['Last Trade', '$13.14'], ['Volume', '1,431'],
    ['Ask', '$13.20'], ['Prev Close', '$11.03'], ['Low', '$10.65'], ['IV', '45.84%'], ['Open Interest', '2,414'],
  ];
  const greekRows = [
    ['Delta', '0.5378'], ['Gamma', '0.0123'], ['Theta', '-0.17'], ['Vega', '0.2809'], ['Rho', '0.1087'],
  ];

  return (
    <tr className="expanded-row">
      <td colSpan="8">
        <div className="expanded-content">
          <h3>Stats</h3>
          <div className="divider" />
          <div className="metric-grid wide">
            {statRows.map(([label, value]) => (
              <div className="metric" key={`${label}-${value}`}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <h3 className="greek-title">The Greeks</h3>
          <div className="divider" />
          <div className="metric-grid greeks">
            {greekRows.map(([label, value]) => (
              <div className="metric" key={`${label}-${value}`}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </div>
      </td>
    </tr>
  );
}

function SimulatedReturns() {
  const [spot, setSpot] = useState(233.25);
  const stats = useMemo(() => getSimStats(spot), [spot]);
  const positive = stats.pnl >= 0;

  return (
    <section className="returns-view">
      <div className="returns-main">
        <aside className="returns-sidebar">
          <h1>Estimated P&amp;L <span className="info-dot">i</span></h1>
          <div className={positive ? 'pl green' : 'pl orange'}>{positive ? '▲' : '▼'} {currency(stats.pnl)}</div>
          <div className={positive ? 'pct green' : 'pct orange'}>{positive ? '▲' : '▼'} {Math.abs(stats.percent).toFixed(2)}%</div>
          <div className="greek-summary">
            <div><span>Delta</span><strong>{stats.delta.toFixed(4)}</strong></div>
            <div><span>Theta</span><strong>{stats.theta.toFixed(4)}</strong></div>
            <div><span>Gamma</span><strong>{stats.gamma.toFixed(4)}</strong></div>
            <div><span>Vega</span><strong>{stats.vega.toFixed(4)}</strong></div>
          </div>
        </aside>
        <ReturnChart spot={spot} stats={stats} onSpotChange={setSpot} />
      </div>
      <div className="sim-controls">
        <div className="time-control">
          <div className="control-label"><span>Time</span><strong>May 11, 19:19 (37 DTE)</strong></div>
          <div className="slider-track"><span className="thumb start" /></div>
          <div className="range-labels"><span>Now</span><span>Jun 18</span></div>
        </div>
        <div className="iv-control">
          <div className="control-label"><span>IV</span><strong>51%</strong></div>
          <div className="slider-track iv"><span className="mid-range" /><span className="thumb iv-thumb" /></div>
          <div className="range-labels"><span>0%</span><span>52W L</span><span>52W H</span><span>118%</span></div>
        </div>
      </div>
    </section>
  );
}

function getSimStats(spot) {
  const clamped = Math.max(211, Math.min(239, spot));
  const pnl = (clamped - 220.0) * 64.7;
  const percent = pnl / 1320.04 * 100;
  const t = (clamped - 213.35) / (233.25 - 213.35);
  const safeT = Math.max(0, Math.min(1, t));
  return {
    pnl,
    percent,
    delta: 0.4662 + safeT * (0.7053 - 0.4662),
    theta: -0.1696 + safeT * (0.0029),
    gamma: 0.0130 + safeT * (-0.0026),
    vega: 0.2727 + safeT * (-0.0140),
  };
}

function currency(value) {
  const abs = Math.abs(value);
  return `$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ReturnChart({ spot, stats, onSpotChange }) {
  const min = 211;
  const max = 239;
  const x = (spot - min) / (max - min) * 1000;
  const zeroY = 276;
  const scale = 0.132;
  const y = Math.max(54, Math.min(520, zeroY - stats.pnl * scale));
  const markerLabel = `${spot.toFixed(2)} (${spot >= 218.11 ? '+' : ''}${(((spot - 218.11) / 218.11) * 100).toFixed(2)}%)`;
  const positive = stats.pnl >= 0;
  const chartPathOrange = 'M 0 369 C 112 338 225 305 370 276';
  const chartPathGreen = 'M 370 276 C 560 218 746 154 985 68';
  const fillGreen = 'M 370 276 C 560 218 746 154 985 68 L 985 276 L 370 276 Z';
  const fillOrange = 'M 0 369 C 112 338 225 305 370 276 L 0 276 Z';

  const handleMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    onSpotChange(min + ratio * (max - min));
  };

  return (
    <div className="chart-shell" onPointerMove={handleMove}>
      <svg className="return-chart" viewBox="0 0 1100 560" preserveAspectRatio="none" aria-label="Options simulated return chart">
        <defs>
          <linearGradient id="greenFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(0,200,5,.34)" />
            <stop offset="1" stopColor="rgba(0,200,5,.02)" />
          </linearGradient>
          <linearGradient id="orangeFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(255,80,0,.24)" />
            <stop offset="1" stopColor="rgba(255,80,0,.02)" />
          </linearGradient>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <line x1="0" x2="1000" y1="276" y2="276" className="zero-line" />
        <path d={fillOrange} fill="url(#orangeFill)" />
        <path d={fillGreen} fill="url(#greenFill)" />
        <path d="M 0 501 C 145 500 240 500 315 498 C 480 407 680 300 985 151" className="dotted-line" />
        <path d={chartPathOrange} className="payoff orange-stroke" />
        <path d={chartPathGreen} className="payoff green-stroke" filter="url(#glow)" />
        <line x1={x} y1="40" x2={x} y2="538" className="marker-line" />
        <circle cx={x} cy={y} r="5.8" className={positive ? 'marker-dot green-dot' : 'marker-dot orange-dot'} />
        <text x={Math.min(955, Math.max(94, x - 5))} y={Math.max(32, y - 55)} className="marker-text" textAnchor="middle">
          ${markerLabel}
        </text>
        <text x="1080" y="64" className="axis-label">$1,400</text>
        <text x="1080" y="111" className="axis-label">$1,200</text>
        <text x="1080" y="158" className="axis-label">$1,000</text>
        <text x="1080" y="205" className="axis-label">$800</text>
        <text x="1080" y="252" className="axis-label">$600</text>
        <text x="1080" y="299" className="axis-label">$400</text>
        <text x="1080" y="346" className="axis-label">$200</text>
        <text x="1080" y="393" className="axis-label">$0</text>
        <text x="1080" y="440" className="axis-label">-$200</text>
        <text x="1080" y="487" className="axis-label">-$400</text>
        <text x="1080" y="534" className="axis-label">-$600</text>
      </svg>
      <div className="x-axis">
        {['11', '$213', '$215', '$217', '$219', '$221', '$223', '$225', '$227', '$229', '$231', '$233', '$235', '$237', '$239'].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function OrderTicket({ ticket }) {
  return (
    <aside className="ticket-panel">
      <div className="ticket-card">
        <div className="ticket-drag" aria-hidden="true">⠿</div>
        <button className="ticket-close" aria-label="Close">×</button>
        <h2>{ticket.title}</h2>
        <div className="buy-sell-toggle">
          <button className="active">Buy to open</button>
          <button>Sell to open</button>
        </div>
        <FieldRow label="Order type">
          <button className="select-field">Limit <span className="dual-caret">▴<br />▾</span></button>
        </FieldRow>
        <FieldRow label="Quantity">
          <div className="input-field active-field"><span>1</span><Stepper /></div>
        </FieldRow>
        <p className="ticket-warning">You don’t have enough buying power to place this order. <u>Deposit funds</u></p>
        <FieldRow label={<><span>Limit price</span><small>{ticket.mark}</small></>}>
          <div className="input-field"><span>{ticket.limit}</span><Stepper /></div>
        </FieldRow>
        <FieldRow label="Time in force">
          <button className="select-field">Good for day <span className="dual-caret">▴<br />▾</span></button>
        </FieldRow>
        <div className="estimated-cost">
          <div>
            <strong>Estimated cost</strong>
            <span>$2.00 buying power</span>
            <span>$0.04 est regulatory fee</span>
          </div>
          <strong>{ticket.cost}</strong>
        </div>
        <div className="ticket-actions">
          <button>Cancel</button>
          <button disabled>Buy NVDA Call</button>
        </div>
      </div>
    </aside>
  );
}

function FieldRow({ label, children }) {
  return (
    <div className="field-row">
      <label>{label}</label>
      {children}
    </div>
  );
}

function Stepper() {
  return (
    <span className="stepper" aria-hidden="true">
      <span>+</span>
      <span>−</span>
    </span>
  );
}

export default App;
