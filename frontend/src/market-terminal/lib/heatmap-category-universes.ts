import tickersJson from "../../data/tickers.json";

export type HeatmapCategoryType = "sector" | "industry";

export interface HeatmapCategoryOption {
  value: string;
  label: string;
  count: number;
  symbols: string[];
  limited: boolean;
}

const MAX_CATEGORY_HEATMAP_SYMBOLS = 100;

interface TickerCompany {
  symbol?: string;
  sector?: string;
  industry?: string;
  enabled?: boolean;
  sp500_weight?: number;
}

interface CategoryMember {
  symbol: string;
  weight: number;
}

function normalizeCategory(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSymbol(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function isValidSymbol(symbol: string): boolean {
  return /^[A-Z0-9.-]{1,12}$/.test(symbol);
}

function buildCategoryOptions(type: HeatmapCategoryType): HeatmapCategoryOption[] {
  const byCategory = new Map<string, Map<string, CategoryMember>>();
  const companies = tickersJson.companies as TickerCompany[];

  for (const company of companies) {
    if (company.enabled === false) continue;

    const symbol = normalizeSymbol(company.symbol);
    if (!isValidSymbol(symbol)) continue;

    const category = normalizeCategory(type === "sector" ? company.sector : company.industry);
    if (!category) continue;

    const members = byCategory.get(category) ?? new Map<string, CategoryMember>();
    members.set(symbol, {
      symbol,
      weight: typeof company.sp500_weight === "number" ? company.sp500_weight : 0,
    });
    byCategory.set(category, members);
  }

  return Array.from(byCategory.entries())
    .map(([label, members]) => {
      const sortedMembers = Array.from(members.values()).sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight;
        return a.symbol.localeCompare(b.symbol);
      });
      const symbols = sortedMembers.slice(0, MAX_CATEGORY_HEATMAP_SYMBOLS).map((member) => member.symbol);
      return {
        value: label,
        label,
        count: sortedMembers.length,
        symbols,
        limited: sortedMembers.length > symbols.length,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export const HEATMAP_SECTOR_OPTIONS = buildCategoryOptions("sector");
export const HEATMAP_INDUSTRY_OPTIONS = buildCategoryOptions("industry");

export function getHeatmapCategoryOptions(type: HeatmapCategoryType): HeatmapCategoryOption[] {
  return type === "sector" ? HEATMAP_SECTOR_OPTIONS : HEATMAP_INDUSTRY_OPTIONS;
}

export function inferHeatmapCategoryValue(
  type: HeatmapCategoryType,
  symbols: readonly string[] | null | undefined,
): string {
  if (!symbols?.length) return "";
  const normalized = symbols.map((symbol) => symbol.toUpperCase()).join(",");
  return getHeatmapCategoryOptions(type).find((option) => option.symbols.join(",") === normalized)?.value ?? "";
}
