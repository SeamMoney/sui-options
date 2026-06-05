import React from 'react';

const yAxisLabels = [
  ['$1,400', 130],
  ['$1,200', 171],
  ['$1,000', 213],
  ['$800', 255],
  ['$600', 297],
  ['$400', 339],
  ['$200', 382],
  ['$0', 424],
  ['-$200', 466],
  ['-$400', 508],
  ['-$600', 550],
  ['-$800', 592],
  ['-$1,000', 633],
  ['-$1,200', 675],
  ['-$1,400', 717],
  ['-$1,600', 759],
];

const xAxisLabels = [
  ['11', 309.5],
  ['$213', 380.5],
  ['$215', 460.5],
  ['$217', 540.5],
  ['$219', 620.5],
  ['$221', 699],
  ['$223', 780.5],
  ['$225', 860.5],
  ['$227', 940.5],
  ['$229', 1020],
  ['$231', 1099],
  ['$233', 1180],
  ['$235', 1260],
  ['$237', 1340],
  ['$239', 1420],
];

function SearchIcon({ x, y }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke="var(--header-icon)" strokeWidth="3" strokeLinecap="round" fill="none">
      <circle cx="9" cy="9" r="8" />
      <line x1="15" y1="15" x2="23" y2="23" />
    </g>
  );
}

function SlidersIcon({ x, y }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke="var(--muted-strong)" strokeWidth="2" strokeLinecap="round">
      <line x1="0" y1="4" x2="21" y2="4" />
      <line x1="0" y1="11" x2="21" y2="11" />
      <line x1="0" y1="18" x2="21" y2="18" />
      <rect x="13" y="1" width="5" height="6" rx="1" fill="var(--muted-strong)" stroke="none" />
      <rect x="5" y="8" width="5" height="6" rx="1" fill="var(--muted-strong)" stroke="none" />
      <rect x="15" y="15" width="5" height="6" rx="1" fill="var(--muted-strong)" stroke="none" />
    </g>
  );
}

function InfoIcon({ x, y }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle cx="10" cy="10" r="9" stroke="var(--muted-strong)" strokeWidth="2.4" fill="none" />
      <text x="10" y="14" textAnchor="middle" className="info-i">i</text>
    </g>
  );
}

function Greek({ label, value, x, y }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <text className="greek-label" x="0" y="0" dominantBaseline="middle">{label}</text>
      <text className="greek-value" x="0" y="36" dominantBaseline="middle">{value}</text>
    </g>
  );
}

function Header() {
  return (
    <g aria-label="Header">
      <rect x="2" y="7" width="1548" height="65" fill="var(--header-bg)" />
      <line x1="2" y1="72" x2="1550" y2="72" stroke="var(--border)" />
      <line x1="68" y1="7" x2="68" y2="72" stroke="var(--border)" />
      <line x1="185" y1="7" x2="185" y2="72" stroke="var(--border)" />

      <rect x="26" y="30" width="18" height="18" rx="3" fill="var(--purple)" />
      <SearchIcon x={82} y={28} />
      <text x="115" y="45" className="header-symbol">NVDA</text>
      <text x="201" y="44" className="header-price">$218.10</text>
      <text x="282" y="44" className="header-down">▼ $1.34 (0.61%)</text>

      <text x="658" y="45" textAnchor="middle" className="tab-text">Chain</text>
      <rect x="708" y="22" width="196" height="35" rx="6" fill="var(--active-tab)" />
      <text x="806" y="45" textAnchor="middle" className="tab-active">Simulated Returns</text>

      <SlidersIcon x={1461} y={27} />
      <rect x="1488" y="25" width="24" height="24" rx="4" fill="var(--badge-bg)" />
      <text x="1500" y="43" textAnchor="middle" className="badge-text">1</text>
    </g>
  );
}

function Sidebar() {
  return (
    <g aria-label="Estimated P and L panel">
      <text x="25" y="124" className="title-text">Estimated P&amp;L</text>
      <InfoIcon x={243} y={105} />
      <text x="25" y="164" className="pnl-amount">▼ $36.11</text>
      <text x="25" y="193" className="pnl-percent">▼ 2.74%</text>
      <Greek label="Delta" value="0.5385" x={25} y={247} />
      <Greek label="Theta" value="-0.1752" x={163} y={247} />
      <Greek label="Gamma" value="0.0127" x={25} y={337} />
      <Greek label="Vega" value="0.2795" x={163} y={337} />
    </g>
  );
}

function Chart() {
  return (
    <g aria-label="Simulated returns chart">
      <line x1="303" y1="424" x2="1430" y2="424" stroke="var(--zero-line)" strokeWidth="2" opacity="0.86" />

      <path d="M303 512 C420 484 535 455 646 424 L303 424 Z" fill="url(#orangeArea)" />
      <path d="M646 424 C805 378 1000 313 1430 151 L1430 424 L646 424 Z" fill="url(#greenArea)" />

      <path d="M303 512 C420 484 535 455 646 424" fill="none" stroke="var(--chart-orange)" strokeWidth="3.1" strokeLinecap="round" filter="url(#lineSoftness)" />
      <path d="M646 424 C805 378 1000 313 1430 151" fill="none" stroke="var(--chart-green)" strokeWidth="3.1" strokeLinecap="round" filter="url(#lineSoftness)" />

      <path d="M303 701 C410 700 522 700 618 700" fill="none" stroke="var(--chart-orange)" strokeWidth="2.2" strokeDasharray="1 6" strokeLinecap="round" opacity="0.96" />
      <path d="M618 700 C770 620 935 520 1128 424" fill="none" stroke="var(--chart-orange)" strokeWidth="2.2" strokeDasharray="1 6" strokeLinecap="round" opacity="0.96" />
      <path d="M1128 424 C1220 374 1323 319 1430 269" fill="none" stroke="var(--chart-green)" strokeWidth="2.2" strokeDasharray="1 6" strokeLinecap="round" opacity="0.92" />

      <line x1="619" y1="120" x2="619" y2="810" stroke="var(--marker-line)" strokeWidth="2" opacity="0.45" />
      <circle cx="619" cy="431" r="4.5" fill="var(--chart-orange)" stroke="#ffffff" strokeWidth="2.2" />
      <text x="619" y="111" textAnchor="middle" className="marker-label">$218.95 (+0.39%)</text>

      {yAxisLabels.map(([label, y]) => (
        <text key={label} x="1443" y={y} className="axis-label" dominantBaseline="middle">{label}</text>
      ))}

      {xAxisLabels.map(([label, x]) => (
        <text key={label} x={x} y="827" textAnchor="middle" dominantBaseline="middle" className="x-label">{label}</text>
      ))}
    </g>
  );
}

function SliderControls() {
  return (
    <g aria-label="Simulation controls">
      <text x="25" y="915" className="control-label">Time</text>
      <text x="79" y="915" className="control-value">May 11, 19:19 (37 DTE)</text>

      <rect x="25" y="940" width="716" height="12" fill="var(--slider-track)" />
      <rect x="25" y="933" width="10" height="24" rx="5" fill="var(--slider-thumb)" />
      <text x="25" y="975" className="foot-label" dominantBaseline="middle">Now</text>
      <text x="741" y="975" className="foot-label" textAnchor="end" dominantBaseline="middle">Jun 18</text>

      <text x="803" y="915" className="control-label">IV</text>
      <text x="832" y="915" className="control-value">51%</text>

      <rect x="802" y="940" width="716" height="12" fill="var(--slider-track)" />
      <rect x="990" y="940" width="124" height="12" fill="var(--slider-fill)" opacity="0.48" />
      <rect x="1105" y="933" width="10" height="24" rx="5" fill="var(--slider-thumb)" />
      <text x="802" y="975" className="foot-label" dominantBaseline="middle">0%</text>
      <text x="1018" y="975" className="foot-label" textAnchor="middle" dominantBaseline="middle">52W L</text>
      <text x="1159" y="975" className="foot-label" textAnchor="middle" dominantBaseline="middle">52W H</text>
      <text x="1517" y="975" className="foot-label" textAnchor="end" dominantBaseline="middle">118%</text>
    </g>
  );
}

function App() {
  return (
    <main className="screen-wrap" aria-label="NVDA options simulated returns screen">
      <svg className="screen-svg" viewBox="0 0 1556 1026" preserveAspectRatio="xMidYMid meet" role="img">
        <defs>
          <linearGradient id="greenArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--chart-green)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--chart-green)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="orangeArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--chart-orange)" stopOpacity="0.31" />
            <stop offset="1" stopColor="var(--chart-orange)" stopOpacity="0.025" />
          </linearGradient>
          <filter id="lineSoftness" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="0.38" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="bottomGlow" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#25102e" />
            <stop offset="0.45" stopColor="#17121d" />
            <stop offset="1" stopColor="#25112f" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width="1556" height="1026" fill="var(--outside-bg)" />
        <rect x="2" y="7" width="1548" height="1010" fill="var(--app-bg)" />
        <Header />
        <Sidebar />
        <Chart />
        <SliderControls />

        <rect x="1550" y="7" width="6" height="1010" fill="#000000" opacity="0.86" />
        <rect x="0" y="1017" width="1556" height="1" fill="#000000" />
        <rect x="0" y="1018" width="1556" height="8" fill="url(#bottomGlow)" opacity="0.9" />
      </svg>
    </main>
  );
}

export default App;
