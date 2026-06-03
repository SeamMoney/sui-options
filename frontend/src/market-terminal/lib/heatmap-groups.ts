export type HeatmapGroupType = "sp500" | "watchlist" | "etf" | "custom" | "sector" | "industry";

export interface HeatmapGroup {
  id: number;
  name: string;
  type: HeatmapGroupType;
  etfSymbol?: string | null;
  symbols?: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface HeatmapGroupPayload {
  name: string;
  type: HeatmapGroupType;
  etf_symbol?: string | null;
  symbols?: string[] | null;
}

const SYMBOL_LIST_GROUP_TYPES = new Set<HeatmapGroupType>(["custom", "sector", "industry"]);

export function isSymbolListHeatmapGroup(group: HeatmapGroup | null): boolean {
  return Boolean(group && SYMBOL_LIST_GROUP_TYPES.has(group.type) && group.symbols?.length);
}

// ── API functions ──────────────────────────────────────────────────────────────

export async function fetchHeatmapGroups(port: number): Promise<HeatmapGroup[]> {
  const res = await fetch(`http://127.0.0.1:${port}/heatmap/groups`);
  if (!res.ok) throw new Error("Failed to fetch heatmap groups");
  const data = await res.json();
  return data.groups as HeatmapGroup[];
}

export async function createHeatmapGroup(port: number, payload: HeatmapGroupPayload): Promise<HeatmapGroup> {
  const res = await fetch(`http://127.0.0.1:${port}/heatmap/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail ?? "Failed to create group");
  }
  return res.json();
}

export async function updateHeatmapGroup(
  port: number,
  id: number,
  payload: HeatmapGroupPayload,
): Promise<HeatmapGroup> {
  const res = await fetch(`http://127.0.0.1:${port}/heatmap/groups/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail ?? "Failed to update group");
  }
  return res.json();
}

export async function deleteHeatmapGroup(port: number, id: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/heatmap/groups/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete group");
}

// ── URL resolver ───────────────────────────────────────────────────────────────

/** Returns the backend URL to poll for this group's heatmap data. */
export function resolveHeatmapUrl(
  port: number,
  group: HeatmapGroup | null,
  watchlistSymbols: string[],
): string {
  if (!group || group.type === "sp500") {
    return `http://127.0.0.1:${port}/heatmap/sp500`;
  }
  if (group.type === "watchlist") {
    const syms = watchlistSymbols.join(",");
    return `http://127.0.0.1:${port}/heatmap/custom?symbols=${encodeURIComponent(syms)}`;
  }
  if (group.type === "etf" && group.etfSymbol) {
    return `http://127.0.0.1:${port}/heatmap/etf/${encodeURIComponent(group.etfSymbol)}`;
  }
  if (SYMBOL_LIST_GROUP_TYPES.has(group.type) && group.symbols?.length) {
    const syms = group.symbols.join(",");
    return `http://127.0.0.1:${port}/heatmap/custom?symbols=${encodeURIComponent(syms)}`;
  }
  // Fallback to sp500
  return `http://127.0.0.1:${port}/heatmap/sp500`;
}

// ── Static ETF list (symbol + name for all 154 ETFs in data/etfs.json) ─────────

export const ETF_LIST: { symbol: string; name: string }[] = [
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust" },
  { symbol: "IVV", name: "iShares Core S&P 500 ETF" },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF" },
  { symbol: "VTI", name: "Vanguard Total Stock Market ETF" },
  { symbol: "ITOT", name: "iShares Core S&P Total U.S. Stock Market ETF" },
  { symbol: "QQQ", name: "Invesco QQQ Trust" },
  { symbol: "IWM", name: "iShares Russell 2000 ETF" },
  { symbol: "DIA", name: "SPDR Dow Jones Industrial Average ETF Trust" },
  { symbol: "SCHB", name: "Schwab U.S. Broad Market ETF" },
  { symbol: "VXUS", name: "Vanguard Total International Stock ETF" },
  { symbol: "VEA", name: "Vanguard FTSE Developed Markets ETF" },
  { symbol: "VWO", name: "Vanguard FTSE Emerging Markets ETF" },
  { symbol: "EFA", name: "iShares MSCI EAFE ETF" },
  { symbol: "EEM", name: "iShares MSCI Emerging Markets ETF" },
  { symbol: "XLK", name: "Technology Select Sector SPDR Fund" },
  { symbol: "XLF", name: "Financial Select Sector SPDR Fund" },
  { symbol: "XLE", name: "Energy Select Sector SPDR Fund" },
  { symbol: "XLV", name: "Health Care Select Sector SPDR Fund" },
  { symbol: "XLY", name: "Consumer Discretionary Select Sector SPDR Fund" },
  { symbol: "XLP", name: "Consumer Staples Select Sector SPDR Fund" },
  { symbol: "XLI", name: "Industrial Select Sector SPDR Fund" },
  { symbol: "XLB", name: "Materials Select Sector SPDR Fund" },
  { symbol: "XLU", name: "Utilities Select Sector SPDR Fund" },
  { symbol: "XLRE", name: "Real Estate Select Sector SPDR Fund" },
  { symbol: "SMH", name: "VanEck Semiconductor ETF" },
  { symbol: "SOXX", name: "iShares Semiconductor ETF" },
  { symbol: "IGV", name: "iShares Expanded Tech-Software Sector ETF" },
  { symbol: "ARKK", name: "ARK Innovation ETF" },
  { symbol: "VUG", name: "Vanguard Growth ETF" },
  { symbol: "VTV", name: "Vanguard Value ETF" },
  { symbol: "MTUM", name: "iShares MSCI USA Momentum Factor ETF" },
  { symbol: "QUAL", name: "iShares MSCI USA Quality Factor ETF" },
  { symbol: "USMV", name: "iShares MSCI USA Min Vol Factor ETF" },
  { symbol: "SCHD", name: "Schwab U.S. Dividend Equity ETF" },
  { symbol: "DGRO", name: "iShares Core Dividend Growth ETF" },
  { symbol: "USO", name: "United States Oil Fund, LP" },
  { symbol: "UNG", name: "United States Natural Gas Fund, LP" },
  { symbol: "TQQQ", name: "ProShares UltraPro QQQ" },
  { symbol: "SQQQ", name: "ProShares UltraPro Short QQQ" },
  { symbol: "SPXL", name: "Direxion Daily S&P 500 Bull 3X Shares" },
  { symbol: "SPXS", name: "Direxion Daily S&P 500 Bear 3X Shares" },
  { symbol: "SOXL", name: "Direxion Daily Semiconductor Bull 3X Shares" },
  { symbol: "SOXS", name: "Direxion Daily Semiconductor Bear 3X Shares" },
  { symbol: "FNGU", name: "MicroSectors FANG+ Index 3X Leveraged ETN" },
  { symbol: "FNGD", name: "MicroSectors FANG+ Index -3X Inverse Leveraged ETN" },
  { symbol: "NVDU", name: "GraniteShares 2x Long NVDA Daily ETF" },
  { symbol: "AVL", name: "GraniteShares 2x Long AVGO Daily ETF" },
  { symbol: "AVS", name: "GraniteShares 2x Short AVGO Daily ETF" },
  { symbol: "NVDQ", name: "GraniteShares 2x Short NVDA Daily ETF" },
  { symbol: "GGLL", name: "GraniteShares 2x Long GOOGL Daily ETF" },
  { symbol: "GGLS", name: "GraniteShares 2x Short GOOGL Daily ETF" },
  { symbol: "NFXL", name: "GraniteShares 2x Long NFLX Daily ETF" },
  { symbol: "NFXS", name: "GraniteShares 2x Short NFLX Daily ETF" },
  { symbol: "MSFU", name: "GraniteShares 2x Long MSFT Daily ETF" },
  { symbol: "MSFD", name: "GraniteShares 2x Short MSFT Daily ETF" },
  { symbol: "CRWL", name: "GraniteShares 2x Long CRWD Daily ETF" },
  { symbol: "NOWL", name: "GraniteShares 2x Long NOW Daily ETF" },
  { symbol: "SHPU", name: "GraniteShares 2x Long SHOP Daily ETF" },
  { symbol: "SHPD", name: "GraniteShares 2x Short SHOP Daily ETF" },
  { symbol: "HOOG", name: "GraniteShares 2x Long HOOD Daily ETF" },
  { symbol: "HIMZ", name: "GraniteShares 2x Long HIMS Daily ETF" },
  { symbol: "PLTU", name: "GraniteShares 2x Long PLTR Daily ETF" },
  { symbol: "PLTD", name: "GraniteShares 2x Short PLTR Daily ETF" },
  { symbol: "TSLL", name: "Direxion Daily TSLA Bull 2X Shares" },
  { symbol: "TSLQ", name: "AXS TSLA Bear Daily ETF" },
  { symbol: "UVXY", name: "ProShares Ultra VIX Short-Term Futures ETF (1.5x)" },
  { symbol: "VXX", name: "iPath Series B S&P 500 VIX Short-Term Futures ETN" },
  { symbol: "IBIT", name: "iShares Bitcoin Trust" },
  { symbol: "GLD", name: "SPDR Gold Shares" },
  { symbol: "SLV", name: "iShares Silver Trust" },
  { symbol: "AGQ", name: "ProShares Ultra Silver" },
  { symbol: "BND", name: "Vanguard Total Bond Market ETF" },
  { symbol: "AGG", name: "iShares Core U.S. Aggregate Bond ETF" },
  { symbol: "SHY", name: "iShares 1-3 Year Treasury Bond ETF" },
  { symbol: "IEF", name: "iShares 7-10 Year Treasury Bond ETF" },
  { symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF" },
  { symbol: "TIP", name: "iShares TIPS Bond ETF" },
  { symbol: "LQD", name: "iShares iBoxx $ Investment Grade Corporate Bond ETF" },
  { symbol: "HYG", name: "iShares iBoxx $ High Yield Corporate Bond ETF" },
  { symbol: "JEPI", name: "JPMorgan Equity Premium Income ETF" },
  { symbol: "JEPQ", name: "JPMorgan Nasdaq Equity Premium Income ETF" },
  { symbol: "UPRO", name: "ProShares UltraPro S&P 500" },
  { symbol: "SPXU", name: "ProShares UltraPro Short S&P 500" },
  { symbol: "VYM", name: "Vanguard High Dividend Yield ETF" },
  { symbol: "IWF", name: "iShares Russell 1000 Growth ETF" },
  { symbol: "IWD", name: "iShares Russell 1000 Value ETF" },
  { symbol: "VB", name: "Vanguard Small-Cap ETF" },
  { symbol: "VO", name: "Vanguard Mid-Cap ETF" },
  { symbol: "VBR", name: "Vanguard Small-Cap Value ETF" },
  { symbol: "VT", name: "Vanguard Total World Stock ETF" },
  { symbol: "VEU", name: "Vanguard FTSE All-World ex-US ETF" },
  { symbol: "IEMG", name: "iShares Core MSCI Emerging Markets ETF" },
  { symbol: "IYR", name: "iShares U.S. Real Estate ETF" },
  { symbol: "UGL", name: "ProShares Ultra Gold" },
  { symbol: "UCO", name: "ProShares Ultra Bloomberg Crude Oil" },
  { symbol: "BOIL", name: "ProShares Ultra Bloomberg Natural Gas" },
  { symbol: "KOLD", name: "ProShares UltraShort Bloomberg Natural Gas" },
  { symbol: "ARKG", name: "ARK Genomic Revolution ETF" },
  { symbol: "XBI", name: "SPDR S&P Biotech ETF" },
  { symbol: "XME", name: "SPDR S&P Metals & Mining ETF" },
  { symbol: "XOP", name: "SPDR S&P Oil & Gas Exploration & Production ETF" },
  { symbol: "ICLN", name: "iShares Global Clean Energy ETF" },
  { symbol: "TAN", name: "Invesco Solar ETF" },
  { symbol: "BITO", name: "ProShares Bitcoin Strategy ETF" },
  { symbol: "FBTC", name: "Fidelity Wise Origin Bitcoin Fund" },
  { symbol: "MUU", name: "ProShares Ultra Micron Technology" },
  { symbol: "AMUU", name: "ProShares Ultra AMD" },
  { symbol: "TSMG", name: "GraniteShares 2x Long TSM Daily ETF" },
  { symbol: "STSM", name: "GraniteShares 2x Short TSM Daily ETF" },
  { symbol: "LINT", name: "Direxion Daily INTC Bull 2X ETF" },
  { symbol: "INTW", name: "GraniteShares 2x Long INTC Daily ETF" },
  { symbol: "AAPU", name: "Direxion Daily AAPL Bull 2X Share" },
  { symbol: "AAPD", name: "Direxion Daily AAPL Bear 1X Shares" },
  { symbol: "AMZU", name: "Direxion Daily AMZN Bull 2X Shares" },
  { symbol: "AMZD", name: "Direxion Daily AMZN Bear 1X Shares" },
  { symbol: "METU", name: "Direxion Daily META Bull 2X Shares" },
  { symbol: "METD", name: "Direxion Daily META Bear 1X Shares" },
  { symbol: "NVDD", name: "Direxion Daily NVDA Bear 1X Shares" },
  { symbol: "AMDD", name: "Direxion Daily AMD Bear 1X Shares" },
  { symbol: "BOEU", name: "Direxion Daily BA Bull 2X Shares" },
  { symbol: "BOED", name: "Direxion Daily BA Bear 1X Shares" },
  { symbol: "CONX", name: "Direxion Daily COIN Bull 2X ETF" },
  { symbol: "CSCL", name: "Direxion Daily CSCO Bull 2X ETF" },
  { symbol: "CSCS", name: "Direxion Daily CSCO Bear 1X ETF" },
  { symbol: "MUD", name: "Direxion Daily MU Bear 1X Shares" },
  { symbol: "TSXU", name: "Direxion Daily Semiconductors Top 5 Bull 2X ETF" },
  { symbol: "TSXD", name: "Direxion Daily Semiconductors Top 5 Bear 2X ETF" },
  { symbol: "FRDU", name: "Direxion Daily F Bull 2X ETF" },
  { symbol: "FRDD", name: "Direxion Daily F Bear 1X ETF" },
  { symbol: "HODU", name: "Direxion Daily HOOD Bull 2X ETF" },
  { symbol: "ELIL", name: "Direxion Daily LLY Bull 2X Shares" },
  { symbol: "ELIS", name: "Direxion Daily LLY Bear 1X Shares" },
  { symbol: "LMTL", name: "Direxion Daily LMT Bull 2X ETF" },
  { symbol: "LMTS", name: "Direxion Daily LMT Bear 1X ETF" },
  { symbol: "ORCU", name: "Direxion Daily ORCL Bull 2X ETF" },
  { symbol: "ORCS", name: "Direxion Daily ORCL Bear 1X ETF" },
  { symbol: "QCMU", name: "Direxion Daily QCOM Bull 2X ETF" },
  { symbol: "QCMD", name: "Direxion Daily QCOM Bear 1X ETF" },
  { symbol: "TSLS", name: "Direxion Daily TSLA Bear 1X Shares" },
  { symbol: "TSMX", name: "Direxion Daily TSM Bull 2X Shares" },
  { symbol: "TSMZ", name: "Direxion Daily TSM Bear 1X Shares" },
  { symbol: "XOMX", name: "Direxion Daily XOM Bull 2X Shares" },
  { symbol: "XOMZ", name: "Direxion Daily XOM Bear 1X Shares" },
  { symbol: "PALU", name: "Direxion Daily PANW Bull 2X Shares" },
  { symbol: "PALD", name: "Direxion Daily PANW Bear 1X Shares" },
  { symbol: "TBXU", name: "Direxion Daily Biotech Top 5 Bull 2X ETF" },
  { symbol: "TEXU", name: "Direxion Daily Energy Top 5 Bull 2X ETF" },
  { symbol: "TTXU", name: "Direxion Daily Technology Top 5 Bull 2X ETF" },
  { symbol: "TTXD", name: "Direxion Daily Technology Top 5 Bear 2X ETF" },
  { symbol: "DFEN", name: "Direxion Daily Aerospace & Defense Bull 3X Shares" },
  { symbol: "WANT", name: "Direxion Daily Consumer Discretionary Bull 3X Shares" },
  { symbol: "LRCU", name: "Tradr 2X Long LRCX Daily ETF" },
  { symbol: "KLAG", name: "2x Long KLAC Daily ETF" },
  { symbol: "MVLL", name: "GraniteShares 2x Long MRVL Daily ETF" },
];
