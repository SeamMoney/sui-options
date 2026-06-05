import React from 'react';

const axisLabels = [
  ['$1,400', 130], ['$1,200', 170], ['$1,000', 211], ['$800', 252], ['$600', 293], ['$400', 334], ['$200', 375], ['$0', 416],
  ['-$200', 456], ['-$400', 497], ['-$600', 538], ['-$800', 579], ['-$1,000', 620], ['-$1,200', 661], ['-$1,400', 703], ['-$1,600', 744],
];

const xLabels = [
  ['11', 306], ['$213', 383], ['$215', 461], ['$217', 539], ['$219', 617], ['$221', 695], ['$223', 773], ['$225', 851], ['$227', 929], ['$229', 1007], ['$231', 1085], ['$233', 1163], ['$235', 1241], ['$237', 1319], ['$239', 1397],
];

function SlidersIcon({ x = 0, y = 0 }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke="#a3a3a6" strokeWidth="2" strokeLinecap="round">
      <line x1="0" y1="4" x2="21" y2="4" />
      <line x1="0" y1="11" x2="21" y2="11" />
      <line x1="0" y1="18" x2="21" y2="18" />
      <rect x="13" y="1" width="5" height="6" rx="1" fill="#a3a3a6" stroke="none" />
      <rect x="5" y="8" width="5" height="6" rx="1" fill="#a3a3a6" stroke="none" />
      <rect x="15" y="15" width="5" height="6" rx="1" fill="#a3a3a6" stroke="none" />
    </g>
  );
}

function SearchIcon({ x, y }) {
  return (
    <g transform={`translate(${x} ${y})`} stroke="#bfc0c4" strokeWidth="3" strokeLinecap="round" fill="none">
      <circle cx="9" cy="9" r="8" />
      <line x1="15" y1="15" x2="23" y2="23" />
    </g>
  );
}

function InfoIcon({ x, y }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle cx="10" cy="10" r="9" stroke="#adadb2" strokeWidth="2.4" fill="none" />
      <text x="10" y="14" textAnchor="middle" className="info-i">i</text>
    </g>
  );
}

function Greek({ label, value, x, y }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <text className="greek-label" x="0" y="0">{label}</text>
      <text className="greek-value" x="0" y="38">{value}</text>
    </g>
  );
}

function App() {
  return (
    <main className="screen-wrap" aria-label="NVDA options simulated returns screen">
      <svg className="screen-svg" viewBox="0 0 1556 1026" preserveAspectRatio="xMidYMid meet" role="img">
        <defs>
          <linearGradient id="greenArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0a8215" stopOpacity="0.40" />
            <stop offset="1" stopColor="#0a8215" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="orangeArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8d3617" stopOpacity="0.35" />
            <stop offset="1" stopColor="#8d3617" stopOpacity="0.03" />
          </linearGradient>
          <filter id="softGlow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="0.55" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* black browser/page edge */}
        <rect x="0" y="0" width="1556" height="1026" fill="#030303" />
        <rect x="2" y="7" width="1548" height="1010" rx="0" fill="#111111" />
        <rect x="2" y="7" width="1548" height="65" fill="#1b1b1c" />
        <line x1="2" y1="72" x2="1550" y2="72" stroke="#303032" strokeWidth="1" />
        <line x1="68" y1="7" x2="68" y2="72" stroke="#333335" />
        <line x1="185" y1="7" x2="185" y2="72" stroke="#333335" />
        <line x1="1549" y1="7" x2="1549" y2="1017" stroke="#000" strokeWidth="8" />
        <line x1="0" y1="1018" x2="1556" y2="1018" stroke="#1b0f28" strokeWidth="3" />

        {/* header left */}
        <rect x="31" y="30" width="17" height="17" rx="3" fill="#8d68ef" />
        <SearchIcon x={81} y={27} />
        <text x="115" y="45" className="header-symbol">NVDA</text>
        <text x="196" y="44" className="header-price">$218.10</text>
        <text x="265" y="44" className="header-down">▼ $1.34 (0.61%)</text>

        {/* centered tabs */}
        <text x="637" y="45" textAnchor="middle" className="tab-text">Chain</text>
        <rect x="689" y="21" width="195" height="35" rx="6" fill="#49494c" />
        <text x="787" y="45" textAnchor="middle" className="tab-active">Simulated Returns</text>

        {/* header actions */}
        <SlidersIcon x={1424} y={27} />
        <rect x="1455" y="24" width="24" height="24" rx="4" fill="#3a3a3c" />
        <text x="1467" y="42" textAnchor="middle" className="badge-text">1</text>

        {/* left summary panel */}
        <text x="25" y="124" className="title-text">Estimated P&amp;L</text>
        <InfoIcon x={243} y={105} />
        <text x="25" y="164" className="orange big-pnl">▼ $36.11</text>
        <text x="25" y="193" className="orange pct-text">▼ 2.74%</text>
        <Greek label="Delta" value="0.5385" x={25} y={246} />
        <Greek label="Theta" value="-0.1752" x={163} y={246} />
        <Greek label="Gamma" value="0.0127" x={25} y={333} />
        <Greek label="Vega" value="0.2795" x={163} y={333} />

        {/* chart */}
        <line x1="293" y1="424" x2="1400" y2="424" stroke="#29292b" strokeWidth="2" opacity="0.85" />

        <path d="M303 512 C420 484 535 455 646 424 L303 424 Z" fill="url(#orangeArea)" />
        <path d="M646 424 C805 378 1000 313 1429 151 L1429 424 L646 424 Z" fill="url(#greenArea)" />

        <path d="M303 512 C420 484 535 455 646 424" fill="none" stroke="#ff5000" strokeWidth="3.1" strokeLinecap="round" filter="url(#softGlow)" />
        <path d="M646 424 C805 378 1000 313 1429 151" fill="none" stroke="#00d20c" strokeWidth="3.1" strokeLinecap="round" filter="url(#softGlow)" />

        <path d="M303 701 C410 700 522 700 618 700" fill="none" stroke="#ff5000" strokeWidth="2.2" strokeDasharray="1 6" strokeLinecap="round" opacity="0.95" />
        <path d="M618 700 C770 620 935 520 1128 424" fill="none" stroke="#ff5000" strokeWidth="2.2" strokeDasharray="1 6" strokeLinecap="round" opacity="0.95" />
        <path d="M1128 424 C1220 374 1323 319 1429 269" fill="none" stroke="#00d20c" strokeWidth="2.2" strokeDasharray="1 6" strokeLinecap="round" opacity="0.95" />

        <line x1="619" y1="113" x2="619" y2="788" stroke="#b7b7bb" strokeWidth="2" opacity="0.55" />
        <circle cx="619" cy="424" r="4.2" fill="#ff5000" stroke="#ffffff" strokeWidth="2.3" />
        <text x="602" y="111" textAnchor="middle" className="marker-label">$218.95 (+0.39%)</text>

        {axisLabels.map(([label, y]) => (
          <text key={label} x="1413" y={y} className="axis-label">{label}</text>
        ))}

        {xLabels.map(([label, x]) => (
          <text key={label} x={x} y="807" textAnchor="middle" className="x-label">{label}</text>
        ))}

        {/* controls */}
        <text x="25" y="886" className="control-label">Time</text>
        <text x="79" y="886" className="control-value">May 11, 19:19 (37 DTE)</text>
        <rect x="25" y="909" width="699" height="13" fill="#3d3d3f" />
        <rect x="25" y="909" width="9" height="13" fill="#333335" />
        <rect x="25" y="902" width="10" height="26" rx="5" fill="#f5f5f6" />
        <text x="25" y="951" className="foot-label">Now</text>
        <text x="672" y="951" className="foot-label">Jun 18</text>

        <text x="779" y="886" className="control-label">IV</text>
        <text x="809" y="886" className="control-value">51%</text>
        <rect x="779" y="909" width="699" height="13" fill="#3d3d3f" />
        <rect x="990" y="909" width="133" height="13" fill="#4a4a4d" opacity="0.5" />
        <rect x="1123" y="909" width="31" height="13" fill="#555558" opacity="0.45" />
        <rect x="1076" y="902" width="10" height="26" rx="5" fill="#f5f5f6" />
        <text x="779" y="951" className="foot-label">0%</text>
        <text x="1000" y="951" className="foot-label" textAnchor="middle">52W L</text>
        <text x="1133" y="951" className="foot-label" textAnchor="middle">52W H</text>
        <text x="1478" y="951" className="foot-label" textAnchor="end">118%</text>
      </svg>
    </main>
  );
}

export default App;
