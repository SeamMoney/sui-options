import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ETF_LIST, type HeatmapGroupPayload, type HeatmapGroupType, type HeatmapGroup } from "../lib/heatmap-groups";
import CustomSelect from "./CustomSelect";
import ScrollArea from "./ScrollArea";
import {
  getHeatmapCategoryOptions,
  inferHeatmapCategoryValue,
  type HeatmapCategoryType,
} from "../lib/heatmap-category-universes";

interface HeatmapGroupEditorProps {
  /** If provided, we're editing an existing group. Null = creating new. */
  group: HeatmapGroup | null;
  onSave: (payload: HeatmapGroupPayload) => Promise<void>;
  onClose: () => void;
}

const TYPE_LABELS: { type: HeatmapGroupType; label: string; desc: string }[] = [
  { type: "sp500", label: "S&P 500", desc: "All 500 companies, sized by index weight" },
  { type: "watchlist", label: "Watchlist", desc: "Your current watchlist symbols" },
  { type: "etf", label: "ETF Holdings", desc: "Top holdings of a specific ETF" },
  { type: "sector", label: "Sector", desc: "Pick a tickers.json sector universe" },
  { type: "custom", label: "Custom", desc: "Pick any symbols you want to track" },
];

function isCategoryGroupType(value: HeatmapGroupType): value is HeatmapCategoryType {
  return value === "sector" || value === "industry";
}

export default function HeatmapGroupEditor({ group, onSave, onClose }: HeatmapGroupEditorProps) {
  const [name, setName] = useState(group?.name ?? "");
  const [type, setType] = useState<HeatmapGroupType>(group?.type ?? "custom");
  const [etfSearch, setEtfSearch] = useState(group?.etfSymbol ?? "");
  const [etfSelected, setEtfSelected] = useState(group?.etfSymbol ?? "");
  const [etfDropdownOpen, setEtfDropdownOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(() =>
    group && isCategoryGroupType(group.type)
      ? inferHeatmapCategoryValue(group.type, group.symbols)
      : "",
  );
  const [customInput, setCustomInput] = useState("");
  const [customSymbols, setCustomSymbols] = useState<string[]>(group?.symbols ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const etfRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close ETF dropdown on outside click
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (etfRef.current && !etfRef.current.contains(e.target as Node)) {
        setEtfDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const filteredEtfs = ETF_LIST.filter(
    (e) =>
      e.symbol.includes(etfSearch.toUpperCase()) ||
      e.name.toLowerCase().includes(etfSearch.toLowerCase()),
  ).slice(0, 60);

  const categoryOptions = useMemo(
    () => (isCategoryGroupType(type) ? getHeatmapCategoryOptions(type) : []),
    [type],
  );
  const selectedCategoryOption = categoryOptions.find((option) => option.value === selectedCategory) ?? null;

  useEffect(() => {
    if (!isCategoryGroupType(type) || selectedCategoryOption) return;
    setSelectedCategory(categoryOptions[0]?.value ?? "");
  }, [categoryOptions, selectedCategoryOption, type]);

  const addCustomSymbol = useCallback(() => {
    const sym = customInput.trim().toUpperCase();
    if (!sym || customSymbols.includes(sym) || customSymbols.length >= 100) return;
    if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) return;
    setCustomSymbols((prev) => [...prev, sym]);
    setCustomInput("");
  }, [customInput, customSymbols]);

  const removeCustomSymbol = useCallback((sym: string) => {
    setCustomSymbols((prev) => prev.filter((s) => s !== sym));
  }, []);

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (type === "etf" && !etfSelected) {
      setError("Select an ETF.");
      return;
    }
    if (type === "custom" && customSymbols.length === 0) {
      setError("Add at least one symbol.");
      return;
    }
    if (isCategoryGroupType(type) && !selectedCategoryOption) {
      setError(`Select a ${type}.`);
      return;
    }

    const categorySymbols = isCategoryGroupType(type) ? selectedCategoryOption?.symbols : null;

    const payload: HeatmapGroupPayload = {
      name: trimmedName,
      type,
      etf_symbol: type === "etf" ? etfSelected : null,
      symbols: type === "custom"
        ? customSymbols
        : isCategoryGroupType(type)
          ? categorySymbols
          : null,
    };

    setSaving(true);
    setError(null);
    try {
      await onSave(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const content = (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex w-[440px] flex-col border border-white/[0.10] bg-[#161B22] shadow-2xl">
        {/* Header */}
        <div className="flex h-9 items-center justify-between border-b border-white/[0.08] bg-[#0d0f13] px-4">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-white/70">
            {group ? "Edit Group" : "New Heatmap Group"}
          </span>
          <button
            onClick={onClose}
            className="flex h-5 w-5 items-center justify-center rounded-sm text-white/50 hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">
              Group Name
            </label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); }}
              placeholder="e.g. Semis, My Watchlist, SOXL Holdings…"
              className="h-8 border border-white/[0.10] bg-[#0d0f13] px-2.5 font-sans text-[12px] text-white placeholder-white/20 outline-none focus:border-[#1A56DB]"
            />
          </div>

          {/* Type selector */}
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">
              Universe Type
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {TYPE_LABELS.map(({ type: t, label, desc }) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`flex flex-col items-start gap-0.5 border px-2.5 py-2 text-left transition-colors duration-75 ${
                    type === t
                      ? "border-[#1A56DB] bg-[#1A56DB]/10 text-white"
                      : "border-white/[0.08] bg-[#0d0f13] text-white/55 hover:border-white/[0.15] hover:text-white/80"
                  }`}
                >
                  <span className="font-sans text-[11px] font-semibold">{label}</span>
                  <span className="font-sans text-[9px] text-white/40">{desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ETF selector */}
          {type === "etf" && (
            <div className="flex flex-col gap-1.5" ref={etfRef}>
              <label className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">
                ETF Symbol
              </label>
              <div className="relative">
                <input
                  value={etfSearch}
                  onChange={(e) => {
                    setEtfSearch(e.target.value);
                    setEtfDropdownOpen(true);
                    if (!e.target.value) setEtfSelected("");
                  }}
                  onFocus={() => setEtfDropdownOpen(true)}
                  placeholder="Search ETF (e.g. SOXL, QQQ, SMH…)"
                  className="h-8 w-full border border-white/[0.10] bg-[#0d0f13] px-2.5 font-mono text-[11px] text-white placeholder-white/20 outline-none focus:border-[#1A56DB]"
                />
                {etfSelected && (
                  <div className="mt-1 font-mono text-[10px] text-[#1A56DB]">
                    Selected: <span className="font-semibold">{etfSelected}</span>
                    {" — "}
                    <span className="text-white/50">{ETF_LIST.find((e) => e.symbol === etfSelected)?.name}</span>
                  </div>
                )}
                {etfDropdownOpen && filteredEtfs.length > 0 && (
                  <ScrollArea
                    className="absolute left-0 right-0 top-full z-20 border border-white/[0.10] bg-[#131720] shadow-lg"
                    viewportClassName="max-h-48 pr-2"
                  >
                    {filteredEtfs.map((e) => (
                      <button
                        key={e.symbol}
                        className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-white/[0.06] ${
                          etfSelected === e.symbol ? "bg-[#1A56DB]/10" : ""
                        }`}
                        onClick={() => {
                          setEtfSelected(e.symbol);
                          setEtfSearch(e.symbol);
                          setEtfDropdownOpen(false);
                        }}
                      >
                        <span className="font-mono text-[11px] font-semibold text-white">{e.symbol}</span>
                        <span className="truncate font-sans text-[10px] text-white/45">{e.name}</span>
                      </button>
                    ))}
                  </ScrollArea>
                )}
              </div>
            </div>
          )}

          {/* Sector / industry selector */}
          {isCategoryGroupType(type) && (
            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">
                {type === "sector" ? "Sector" : "Industry"} Universe
              </label>
              <CustomSelect
                value={selectedCategory}
                onChange={(next) => {
                  setSelectedCategory(next);
                  if (!name.trim()) setName(next);
                }}
                options={categoryOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                  description: `${Math.min(option.symbols.length, option.count)} of ${option.count} symbols${option.limited ? " (top 100 by index weight)" : ""}`,
                }))}
                placeholder={`Select ${type}`}
                panelWidth={360}
                triggerClassName="border-white/[0.10] bg-[#0d0f13] font-sans text-[12px]"
                panelClassName="bg-[#131720]"
              />
              {selectedCategoryOption && (
                <div className="border border-white/[0.06] bg-[#0d0f13] px-3 py-2">
                  <p className="font-sans text-[11px] text-white/45">
                    {selectedCategoryOption.symbols.length} symbols from <span className="text-white/65">{selectedCategoryOption.label}</span>
                    {selectedCategoryOption.limited ? " (capped to the top 100 by tickers.json weight)." : "."}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {selectedCategoryOption.symbols.slice(0, 24).map((symbol) => (
                      <span
                        key={symbol}
                        className="border border-white/[0.08] bg-black/20 px-1.5 py-0.5 font-mono text-[9px] text-white/62"
                      >
                        {symbol}
                      </span>
                    ))}
                    {selectedCategoryOption.symbols.length > 24 && (
                      <span className="px-1.5 py-0.5 font-mono text-[9px] text-white/35">
                        +{selectedCategoryOption.symbols.length - 24} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Custom symbols */}
          {type === "custom" && (
            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">
                Symbols{" "}
                <span className="text-white/25">({customSymbols.length}/100)</span>
              </label>
              <div className="flex gap-1.5">
                <input
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addCustomSymbol();
                    }
                  }}
                  placeholder="Type symbol + Enter"
                  className="h-8 flex-1 border border-white/[0.10] bg-[#0d0f13] px-2.5 font-mono text-[11px] text-white placeholder-white/20 outline-none focus:border-[#1A56DB]"
                />
                <button
                  onClick={addCustomSymbol}
                  className="h-8 border border-white/[0.08] bg-[#0d0f13] px-3 font-mono text-[10px] text-white/60 hover:border-[#1A56DB] hover:text-white"
                >
                  Add
                </button>
              </div>
              {customSymbols.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {customSymbols.map((sym) => (
                    <span
                      key={sym}
                      className="flex items-center gap-1 border border-white/[0.10] bg-[#0d0f13] px-2 py-0.5 font-mono text-[10px] text-white/80"
                    >
                      {sym}
                      <button
                        onClick={() => removeCustomSymbol(sym)}
                        className="text-white/35 hover:text-red"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* S&P 500 / Watchlist info */}
          {(type === "sp500" || type === "watchlist") && (
            <div className="border border-white/[0.06] bg-[#0d0f13] px-3 py-2 font-sans text-[11px] text-white/45">
              {type === "sp500"
                ? "Shows all S&P 500 constituents, sized by index weight."
                : "Dynamically uses your current watchlist. The heatmap updates as you add or remove symbols from your watchlist."}
            </div>
          )}

          {error && (
            <p className="font-sans text-[11px] text-red">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] px-4 py-3">
          <button
            onClick={onClose}
            className="h-7 border border-white/[0.08] px-4 font-mono text-[10px] text-white/55 hover:border-white/[0.15] hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="h-7 border border-[#1A56DB] bg-[#1A56DB]/20 px-4 font-mono text-[10px] text-[#6a9fff] hover:bg-[#1A56DB]/30 disabled:opacity-50"
          >
            {saving ? "Saving…" : group ? "Save Changes" : "Create Group"}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return content;
  return createPortal(content, document.body);
}
