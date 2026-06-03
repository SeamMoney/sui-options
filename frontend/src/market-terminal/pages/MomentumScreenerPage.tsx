import { useState, useEffect, useRef, memo, type FC } from "react";
import { useSidecarPort } from "../lib/tws";
import {
  useScreenerData,
  refreshScreener,
  type ScreenerRow,
  type TfData,
} from "../lib/use-screener-data";
import { LOGO_SYMBOLS } from "../lib/logo-symbols";

// ── Symbol logo ───────────────────────────────────────────────────────

const SymbolLogo = memo(function SymbolLogo({ symbol }: { symbol: string }) {
  const [failed, setFailed] = useState(false);
  const upper = symbol.toUpperCase();
  if (failed || !LOGO_SYMBOLS.has(upper)) {
    return (
      <div style={{ width: 20, height: 20, borderRadius: "50%", background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, fontWeight: 700, color: "rgba(255,255,255,0.35)", flexShrink: 0, fontFamily: "JetBrains Mono, monospace" }}>
        {upper.slice(0, 2)}
      </div>
    );
  }
  return (
    <img
      src={`/dailyiq-brand-resources/logosvg/${upper}.svg`}
      alt={upper}
      onError={() => setFailed(true)}
      style={{ width: 20, height: 20, borderRadius: "50%", objectFit: "contain", flexShrink: 0 }}
    />
  );
});

// ── Constants ─────────────────────────────────────────────────────────

const TF_ORDER = ["1", "5", "10", "15", "30", "60", "240", "D", "W"];
const TF_LABELS: Record<string, string> = {
  "1": "1m", "5": "5m", "10": "10m", "15": "15m", "30": "30m",
  "60": "1h", "240": "4h", "D": "1D", "W": "1W",
};

type FilterType = "all" | "bullish" | "bearish" | "alerts";

// ── Color helpers ─────────────────────────────────────────────────────

function decisionColor(d: string) {
  const u = d.toUpperCase();
  if (u === "STRONG UP")    return "#00C853";
  if (u === "LONG")         return "#4ADE80";
  if (u === "STRONG DOWN")  return "#FF3D71";
  if (u === "SHORT")        return "#F87171";
  if (u.startsWith("REDUCE")) return "#F59E0B";
  return "#4B5563";
}

function trendColor(t: string) {
  const u = t.toUpperCase();
  if (u === "BULLISH" || u === "STRONG UP") return "#00C853";
  if (u === "BEARISH" || u === "STRONG DOWN") return "#FF3D71";
  return "#F59E0B";
}

function signalColor(val: string) {
  const v = val.toUpperCase();
  if (v.includes("↑") && (v.includes("BULL") || v.includes("CROSS") || v.includes("SBM") || v.includes("STRONG UP"))) return "#00C853";
  if (v.includes("↓") && (v.includes("BEAR") || v.includes("UNDER") || v.includes("SSM") || v.includes("STRONG DOWN"))) return "#FF3D71";
  if (v === "BULLISH" || v === "HIGH" || v.includes("CROSS ↑")) return "#00C853";
  if (v === "BEARISH" || v.includes("UNDER ↓")) return "#FF3D71";
  if (v.includes("↑")) return "#00C853";
  if (v.includes("↓")) return "#FF3D71";
  if (v === "MEDIUM" || v === "CHOP" || v.includes("MIXED") || v === "NEUTRAL") return "#F59E0B";
  return "#6B7280";
}

function plColor(pct: string | number) {
  const n = parseFloat(String(pct));
  if (isNaN(n)) return "#6B7280";
  return n > 0 ? "#00C853" : n < 0 ? "#FF3D71" : "#6B7280";
}

function ratioColor(ratio: string) {
  const parts = ratio.split("/");
  if (parts.length !== 2) return "#6B7280";
  const l = parseInt(parts[0]), r = parseInt(parts[1]);
  if (isNaN(l) || isNaN(r)) return "#6B7280";
  if (l > r) return "#00C853";
  if (r > l) return "#FF3D71";
  return "#F59E0B";
}

function adviceColor(a: string) {
  const v = a.toUpperCase();
  if (v.includes("STRONG UP") || v.includes("INCREASING")) return "#00C853";
  if (v.includes("STRONG DOWN")) return "#FF3D71";
  if (v.includes("SLOWING - SHORT") || v.includes("SLOWING - LONG")) return "#F59E0B";
  if (v.includes("STILL ACTIVE")) return "#6B7280";
  return "#4B5563";
}

// ── Skeleton ──────────────────────────────────────────────────────────

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr style={{ height: 32 }}>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} style={{ padding: "0 8px" }}>
          <div style={{ height: 9, borderRadius: 3, width: `${40 + (i * 17) % 50}%`, background: "linear-gradient(90deg,#1C2128 25%,#252D38 50%,#1C2128 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.4s infinite" }} />
        </td>
      ))}
    </tr>
  );
}

// ── Timeframe sub-row ─────────────────────────────────────────────────

const TF_SUB_COLS = [
  { label: "TF",      w: 36  },
  { label: "Trend",   w: 76  },
  { label: "Strength",w: 76  },
  { label: "Chop",    w: 96  },
  { label: "RSI",     w: 84  },
  { label: "MACD",    w: 84  },
  { label: "EMA5/20", w: 84  },
  { label: "Vol Mom", w: 96  },
];

function TimeframeBreakdown({ tfMap, colSpan }: { tfMap: Record<string, TfData>; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: "0 0 6px 56px", background: "#0B0F16" }}>
        <div style={{ borderLeft: "2px solid #1A56DB", paddingLeft: 12, paddingTop: 4, paddingBottom: 4 }}>
          <table style={{ borderCollapse: "collapse", tableLayout: "fixed", fontSize: 11, fontFamily: "JetBrains Mono, monospace" }}>
            <thead>
              <tr style={{ height: 24 }}>
                {TF_SUB_COLS.map((c) => (
                  <th key={c.label} style={{ width: c.w, padding: "0 8px", textAlign: "left", color: "#374151", fontWeight: 500, borderBottom: "1px solid #1C2128", whiteSpace: "nowrap" }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TF_ORDER.filter((tf) => tfMap[tf]).map((tf) => {
                const d = tfMap[tf];
                return (
                  <tr key={tf} style={{ height: 26, borderBottom: "1px solid #0D1117" }}>
                    <td style={{ padding: "0 8px", color: "#6B7280", fontWeight: 600 }}>{TF_LABELS[tf]}</td>
                    <td style={{ padding: "0 8px", color: trendColor(d.trend) }}>{d.trend}</td>
                    <td style={{ padding: "0 8px", color: signalColor(d.strength) }}>{d.strength}</td>
                    <td style={{ padding: "0 8px", color: signalColor(d.chop) }}>{d.chop}</td>
                    <td style={{ padding: "0 8px", color: signalColor(d.rsi) }}>{d.rsi}</td>
                    <td style={{ padding: "0 8px", color: signalColor(d.macd) }}>{d.macd}</td>
                    <td style={{ padding: "0 8px", color: signalColor(d.ema520) }}>{d.ema520}</td>
                    <td style={{ padding: "0 8px", color: signalColor(d.volMom) }}>{d.volMom}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </td>
    </tr>
  );
}

// ── Add symbol modal ──────────────────────────────────────────────────

function AddSymbolModal({ onClose, onAdd, customSymbols, onRemove }: {
  onClose: () => void;
  onAdd: (s: string[]) => void;
  customSymbols: string[];
  onRemove: (s: string) => void;
}) {
  const [input, setInput] = useState("");
  function handleAdd() {
    const syms = input.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (syms.length) { onAdd(syms); setInput(""); }
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: "#161B22", border: "1px solid #30363D", borderRadius: 6, padding: 24, width: 420, maxHeight: "70vh", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "#E6EDF3", fontSize: 13, fontWeight: 600 }}>Add Symbols</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 16 }}>✕</button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAdd()} placeholder="TSLA, AMD, COIN ..." autoFocus
            style={{ flex: 1, background: "#0D1117", border: "1px solid #30363D", borderRadius: 4, padding: "6px 10px", color: "#E6EDF3", fontSize: 12, fontFamily: "JetBrains Mono, monospace", outline: "none" }} />
          <button onClick={handleAdd} style={{ background: "#1A56DB", border: "none", borderRadius: 4, padding: "6px 14px", color: "#fff", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Add</button>
        </div>
        {customSymbols.length > 0 && (
          <div style={{ flex: 1, overflowY: "auto" }}>
            <div style={{ color: "#4B5563", fontSize: 11, marginBottom: 8 }}>Custom (× to remove)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {customSymbols.map((sym) => (
                <div key={sym} style={{ display: "flex", alignItems: "center", gap: 4, background: "#1C2128", border: "1px solid #30363D", borderRadius: 4, padding: "2px 8px", fontSize: 11, color: "#E6EDF3", fontFamily: "JetBrains Mono, monospace" }}>
                  {sym}
                  <button onClick={() => onRemove(sym)} style={{ background: "none", border: "none", color: "#FF3D71", cursor: "pointer", fontSize: 12, padding: 0 }}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Th / Td helpers ───────────────────────────────────────────────────

type Align = "left" | "right" | "center";

function th(minW: number, align: Align, extra?: React.CSSProperties): React.CSSProperties {
  return { minWidth: minW, padding: "0 8px", textAlign: align, color: "#374151", fontSize: 11, fontWeight: 500, height: 32, cursor: "pointer", whiteSpace: "nowrap", userSelect: "none", borderBottom: "1px solid #1C2128", boxSizing: "border-box", ...extra };
}
function td(align: Align, extra?: React.CSSProperties): React.CSSProperties {
  return { padding: "0 8px", textAlign: align, height: 32, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", boxSizing: "border-box", ...extra };
}

// ── Main page ─────────────────────────────────────────────────────────

const NUM_COLS = 17; // keep in sync with column count below

const MomentumScreenerPage: FC<{ tabId?: string }> = () => {
  const sidecarPort = useSidecarPort();
  const { data, fetching, lastFetchedAt } = useScreenerData(sidecarPort);
  const firstLoad = data === null;

  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FilterType>("all");
  const [sortKey, setSortKey] = useState<keyof ScreenerRow>("rank");
  const [sortAsc, setSortAsc] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [customSymbols, setCustomSymbols] = useState<string[]>([]);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (lastFetchedAt > 0) setSecondsAgo(Math.floor((Date.now() - lastFetchedAt) / 1000));
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [lastFetchedAt]);

  useEffect(() => {
    if (!sidecarPort) return;
    fetch(`http://127.0.0.1:${sidecarPort}/momentum-screener/symbols`)
      .then((r) => r.json()).then((j) => setCustomSymbols(j.custom ?? [])).catch(() => {});
  }, [sidecarPort]);

  function toggleRow(sym: string) {
    setExpandedRows((prev) => { const n = new Set(prev); n.has(sym) ? n.delete(sym) : n.add(sym); return n; });
  }

  function handleSort(key: keyof ScreenerRow) {
    if (sortKey === key) setSortAsc((a) => !a); else { setSortKey(key); setSortAsc(true); }
  }

  async function handleAddSymbols(syms: string[]) {
    if (!sidecarPort) return;
    await fetch(`http://127.0.0.1:${sidecarPort}/momentum-screener/symbols`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: syms }) });
    const j = await fetch(`http://127.0.0.1:${sidecarPort}/momentum-screener/symbols`).then((r) => r.json());
    setCustomSymbols(j.custom ?? []);
    refreshScreener();
  }

  async function handleRemoveSymbol(sym: string) {
    if (!sidecarPort) return;
    await fetch(`http://127.0.0.1:${sidecarPort}/momentum-screener/symbols/${sym}`, { method: "DELETE" });
    const j = await fetch(`http://127.0.0.1:${sidecarPort}/momentum-screener/symbols`).then((r) => r.json());
    setCustomSymbols(j.custom ?? []);
    refreshScreener();
  }

  const rows = (() => {
    if (!data) return [];
    let list = [...data.ranked];
    if (filter === "bullish") list = list.filter((r) => r.Decision === "STRONG UP" || r.Decision === "LONG");
    else if (filter === "bearish") list = list.filter((r) => r.Decision === "STRONG DOWN" || r.Decision === "SHORT");
    else if (filter === "alerts") list = list.filter((r) => r["Alert Triggered"] && r["Alert Triggered"] !== "-");
    if (sortKey !== "rank") {
      list.sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        const an = parseFloat(String(av)), bn = parseFloat(String(bv));
        const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : String(av ?? "").localeCompare(String(bv ?? ""));
        return sortAsc ? cmp : -cmp;
      });
    }
    return list;
  })();

  function arrow(key: keyof ScreenerRow) {
    return sortKey === key ? (sortAsc ? " ↑" : " ↓") : "";
  }

  const agoLabel = secondsAgo < 5 ? "Just updated" : secondsAgo < 60 ? `${secondsAgo}s ago` : `${Math.floor(secondsAgo / 60)}m ago`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0D1117", color: "#E6EDF3", overflow: "hidden" }}>
      <style>{`
        @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
        .ms-row:hover > td { background: #161B22 !important; }
        .ms-row > td { transition: background 80ms ease-out; }
      `}</style>

      {/* ── Toolbar ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 16px", borderBottom: "1px solid #1C2128", flexShrink: 0, gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.01em" }}>Momentum Screener</span>
          {data && <span style={{ fontSize: 11, color: "#374151" }}>{agoLabel}</span>}
          {fetching && !firstLoad && <span style={{ fontSize: 11, color: "#1A56DB" }}>↻ Refreshing</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          {(["all", "bullish", "bearish", "alerts"] as FilterType[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ background: filter === f ? "#1A56DB" : "transparent", border: `1px solid ${filter === f ? "#1A56DB" : "#21262D"}`, borderRadius: 4, padding: "3px 10px", color: filter === f ? "#fff" : "#6B7280", fontSize: 11, cursor: "pointer", fontWeight: filter === f ? 600 : 400, transition: "all 120ms ease-out" }}>
              {f === "all" ? "All" : f === "bullish" ? "Bullish" : f === "bearish" ? "Bearish" : "Alerts"}
            </button>
          ))}
          <div style={{ width: 1, height: 16, background: "#21262D" }} />
          <button onClick={() => refreshScreener()} disabled={fetching} style={{ background: "transparent", border: "1px solid #21262D", borderRadius: 4, padding: "3px 10px", color: "#6B7280", fontSize: 11, cursor: fetching ? "default" : "pointer", opacity: fetching ? 0.4 : 1 }}>↻ Refresh</button>
          <button onClick={() => setShowAddModal(true)} style={{ background: "transparent", border: "1px solid #21262D", borderRadius: 4, padding: "3px 10px", color: "#6B7280", fontSize: 11, cursor: "pointer" }}>+ Symbol</button>
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed", fontSize: 11, fontFamily: "JetBrains Mono, monospace" }}>
          {/* colgroup: fixed small cols + auto-flex wide cols */}
          <colgroup>
            <col style={{ width: 24  }} /> {/* expand      */}
            <col style={{ width: 34  }} /> {/* rank        */}
            <col />                         {/* symbol flex */}
            <col />                         {/* decision flex */}
            <col style={{ width: 48  }} /> {/* size        */}
            <col style={{ width: 80  }} /> {/* price       */}
            <col style={{ width: 60  }} /> {/* bull        */}
            <col style={{ width: 60  }} /> {/* bear        */}
            <col style={{ width: 68  }} /> {/* p/l %       */}
            <col style={{ width: 80  }} /> {/* outperf     */}
            <col style={{ width: 60  }} /> {/* days        */}
            <col style={{ width: 68  }} /> {/* alert price */}
            <col style={{ width: 64  }} /> {/* ema         */}
            <col style={{ width: 64  }} /> {/* macd        */}
            <col style={{ width: 80  }} /> {/* 1D trend    */}
            <col style={{ width: 80  }} /> {/* 4H trend    */}
            <col />                         {/* advice flex */}
          </colgroup>

          <thead>
            <tr>
              <th style={th(24, "center", { cursor: "default" })} />
              <th style={th(34, "right")} onClick={() => handleSort("rank")}>#{arrow("rank")}</th>
              <th style={th(120, "left")} onClick={() => handleSort("Symbol")}>Symbol{arrow("Symbol")}</th>
              <th style={th(120, "left")} onClick={() => handleSort("Decision")}>Decision{arrow("Decision")}</th>
              <th style={th(48, "center")} onClick={() => handleSort("Position")}>Size{arrow("Position")}</th>
              <th style={th(80, "right")} onClick={() => handleSort("Current Price")}>Price{arrow("Current Price")}</th>
              <th style={th(60, "right")} onClick={() => handleSort("Bull")}>Bull{arrow("Bull")}</th>
              <th style={th(60, "right")} onClick={() => handleSort("Bear")}>Bear{arrow("Bear")}</th>
              <th style={th(68, "right")} onClick={() => handleSort("P/L %")}>P/L %{arrow("P/L %")}</th>
              <th style={th(80, "right")} onClick={() => handleSort("Outperformance %")}>Outperf %{arrow("Outperformance %")}</th>
              <th style={th(60, "right")} onClick={() => handleSort("Days Ago")}>Days{arrow("Days Ago")}</th>
              <th style={th(68, "right")} onClick={() => handleSort("Alert Price")}>Alert $</th>
              <th style={th(64, "center")} onClick={() => handleSort("EMA")}>EMA{arrow("EMA")}</th>
              <th style={th(64, "center")} onClick={() => handleSort("MACD")}>MACD{arrow("MACD")}</th>
              <th style={th(80, "center")}>1D</th>
              <th style={th(80, "center")}>4H</th>
              <th style={th(140, "left")}>Advice</th>
            </tr>
          </thead>

          <tbody>
            {firstLoad && fetching
              ? Array.from({ length: 14 }).map((_, i) => <SkeletonRow key={i} cols={NUM_COLS} />)
              : !data
              ? <tr><td colSpan={NUM_COLS} style={{ padding: "48px 0", textAlign: "center", color: "#374151", fontSize: 12 }}>Waiting for backend…</td></tr>
              : rows.length === 0
              ? <tr><td colSpan={NUM_COLS} style={{ padding: "48px 0", textAlign: "center", color: "#374151", fontSize: 12 }}>No symbols match the current filter.</td></tr>
              : rows.flatMap((row) => {
                  const isExpanded = expandedRows.has(row.Symbol);
                  const tfMap = data?.timeframes?.[row.Symbol] ?? {};
                  const hasTf = Object.keys(tfMap).length > 0;

                  const trend1D = tfMap["D"]?.trend ?? "—";
                  const trend4H = tfMap["240"]?.trend ?? "—";
                  const plStr = String(row["P/L %"] ?? "");
                  const plValid = plStr && plStr !== "-";
                  const outperf = String(row["Outperformance %"] ?? "");
                  const outperfValid = outperf && outperf !== "-";
                  const alertPrice = row["Alert Price"];
                  const alertValid = alertPrice && alertPrice !== "-";
                  const daysAgo = row["Days Ago"];
                  const daysValid = daysAgo !== "-" && daysAgo != null;

                  return [
                    <tr key={row.Symbol} className="ms-row" onClick={() => hasTf && toggleRow(row.Symbol)} style={{ height: 32, cursor: hasTf ? "pointer" : "default", borderBottom: "1px solid #1C2128" }}>

                      {/* expand */}
                      <td style={td("center", { color: "#1A56DB" })}>
                        {hasTf && <span style={{ fontSize: 9 }}>{isExpanded ? "▼" : "▶"}</span>}
                      </td>

                      {/* rank */}
                      <td style={td("right", { color: "#374151" })}>{row.rank}</td>

                      {/* symbol + logo */}
                      <td style={td("left")}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                          <SymbolLogo symbol={row.Symbol} />
                          <span style={{ color: "#E6EDF3", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{row.Symbol}</span>
                        </div>
                      </td>

                      {/* decision badge */}
                      <td style={td("left")}>
                        <span style={{ display: "inline-block", padding: "1px 7px", borderRadius: 3, fontSize: 10, fontWeight: 700, color: decisionColor(row.Decision), background: decisionColor(row.Decision) + "1A", border: `1px solid ${decisionColor(row.Decision)}30`, whiteSpace: "nowrap" }}>
                          {row.Decision}
                        </span>
                      </td>

                      {/* size */}
                      <td style={td("center", { color: "#6B7280" })}>{row.Position}</td>

                      {/* price */}
                      <td style={td("right", { color: "#E6EDF3" })}>
                        {row["Current Price"] != null && row["Current Price"] !== "-" ? `$${Number(row["Current Price"]).toFixed(2)}` : "—"}
                      </td>

                      {/* bull */}
                      <td style={td("right", { color: "#00C853", fontWeight: 600 })}>{row.Bull}</td>

                      {/* bear */}
                      <td style={td("right", { color: "#FF3D71", fontWeight: 600 })}>{row.Bear}</td>

                      {/* p/l % */}
                      <td style={td("right", { color: plValid ? plColor(plStr) : "#374151" })}>
                        {plValid ? plStr : "—"}
                      </td>

                      {/* outperf % */}
                      <td style={td("right", { color: outperfValid ? plColor(outperf) : "#374151" })}>
                        {outperfValid ? outperf : "—"}
                      </td>

                      {/* days ago */}
                      <td style={td("right", { color: daysValid ? "#9CA3AF" : "#374151" })}>
                        {daysValid ? `${daysAgo}d` : "—"}
                      </td>

                      {/* alert price */}
                      <td style={td("right", { color: alertValid ? "#9CA3AF" : "#374151" })}>
                        {alertValid ? `$${Number(alertPrice).toFixed(2)}` : "—"}
                      </td>

                      {/* ema ratio */}
                      <td style={td("center", { color: row.EMA ? ratioColor(row.EMA) : "#374151", fontWeight: 600 })}>
                        {row.EMA || "—"}
                      </td>

                      {/* macd ratio */}
                      <td style={td("center", { color: row.MACD ? ratioColor(row.MACD) : "#374151", fontWeight: 600 })}>
                        {row.MACD || "—"}
                      </td>

                      {/* 1D trend */}
                      <td style={td("center", { color: trend1D !== "—" ? trendColor(trend1D) : "#374151", fontWeight: 500 })}>
                        {trend1D !== "—" ? trend1D.slice(0, 4) : "—"}
                      </td>

                      {/* 4H trend */}
                      <td style={td("center", { color: trend4H !== "—" ? trendColor(trend4H) : "#374151", fontWeight: 500 })}>
                        {trend4H !== "—" ? trend4H.slice(0, 4) : "—"}
                      </td>

                      {/* advice */}
                      <td style={td("left", { color: adviceColor(row["Momentum Advice"] ?? "") })}>
                        {row["Momentum Advice"] && row["Momentum Advice"] !== "-" ? row["Momentum Advice"] : "—"}
                      </td>
                    </tr>,

                    isExpanded && hasTf && <TimeframeBreakdown key={`${row.Symbol}-tf`} tfMap={tfMap} colSpan={NUM_COLS} />,
                  ].filter(Boolean);
                })
            }
          </tbody>
        </table>
      </div>

      {/* ── Footer ── */}
      {data && (
        <div style={{ padding: "5px 16px", borderTop: "1px solid #1C2128", display: "flex", gap: 20, fontSize: 10, color: "#374151", flexShrink: 0, alignItems: "center" }}>
          <span>{data.symbols.length} symbols scanned</span>
          <span style={{ color: "#00C853" }}>{data.ranked.filter((r) => r.Decision === "STRONG UP" || r.Decision === "LONG").length} bullish</span>
          <span style={{ color: "#FF3D71" }}>{data.ranked.filter((r) => r.Decision === "STRONG DOWN" || r.Decision === "SHORT").length} bearish</span>
          <span>{data.ranked.filter((r) => r["Alert Triggered"] && r["Alert Triggered"] !== "-").length} alerts</span>
          <span style={{ marginLeft: "auto" }}>Auto-refresh 60s</span>
        </div>
      )}

      {showAddModal && (
        <AddSymbolModal onClose={() => setShowAddModal(false)} onAdd={handleAddSymbols} customSymbols={customSymbols} onRemove={handleRemoveSymbol} />
      )}
    </div>
  );
};

export default MomentumScreenerPage;
