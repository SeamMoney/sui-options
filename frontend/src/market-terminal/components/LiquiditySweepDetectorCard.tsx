import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { GripVertical, Search, Settings, X } from "lucide-react";
import ComponentLinkMenu from "./ComponentLinkMenu";
import CustomSelect from "./CustomSelect";
import SymbolSearchModal from "./SymbolSearchModal";
import { LOGO_SYMBOLS } from "../lib/logo-symbols";
import { useWatchlistData } from "../lib/use-market-data";
import { useSidecarPort } from "../lib/tws";
import { linkBus } from "../lib/link-bus";

const MAX_SYMBOLS = 10;
const POLL_INTERVAL_MS = 30_000;
const TIMEFRAME_OPTIONS = ["1m", "2m", "5m", "10m", "15m", "30m", "1h", "4h", "1d", "1w", "1M"] as const;
const LOOKBACK_OPTIONS = [1, 2, 3, 5, 8] as const;
const TIMEFRAME_SELECT_OPTIONS = TIMEFRAME_OPTIONS.map((option) => ({
  value: option,
  label: option.toUpperCase(),
}));
const LOOKBACK_SELECT_OPTIONS = LOOKBACK_OPTIONS.map((option) => ({
  value: String(option),
  label: `${option} bars`,
}));

type DetectorTimeframe = (typeof TIMEFRAME_OPTIONS)[number];

interface LiquiditySweepStatus {
  direction: "bull" | "bear" | null;
  eventTs: number | null;
  ageBars: number | null;
  ageMinutes: number | null;
  source: string | null;
}

interface LiquiditySweepDetectorCardProps {
  linkChannel: number | null;
  onSetLinkChannel: (channel: number | null) => void;
  onClose: () => void;
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
}

function readSymbols(config: Record<string, unknown>): string[] {
  const raw = config.symbols;
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((value) => (typeof value === "string" ? value.trim().toUpperCase() : ""))
        .filter(Boolean),
    ),
  ).slice(0, MAX_SYMBOLS);
}

function readTimeframe(config: Record<string, unknown>): DetectorTimeframe {
  const raw = typeof config.timeframe === "string" ? config.timeframe : "15m";
  return (TIMEFRAME_OPTIONS as readonly string[]).includes(raw) ? (raw as DetectorTimeframe) : "15m";
}

function readLookbackBars(config: Record<string, unknown>): number {
  const raw = config.lookbackBars;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 3;
  const normalized = Math.round(raw);
  return normalized >= 1 ? Math.min(normalized, 10) : 3;
}

function readShowExpandedInstructions(config: Record<string, unknown>): boolean {
  const raw = config.showExpandedInstructions;
  if (typeof raw !== "boolean") return true;
  return raw;
}

function readShowInfoColumn(config: Record<string, unknown>): boolean {
  const raw = config.showInfoColumn;
  if (typeof raw !== "boolean") return true;
  return raw;
}

function sourceLabel(source: string | null): string {
  if (source === "today") return "DH/DL";
  if (source === "prevDay") return "PDH/PDL";
  if (source === "prevWeek") return "PWH/PWL";
  if (source === "prevMonth") return "PMH/PML";
  return "Sweep";
}

function sweepBlurb(direction: "bull" | "bear" | null, source: string | null, ageBars: number | null): string {
  if (!direction) return "No active sweep in lookback window";

  const levelDesc =
    source === "today"
      ? "today's intraday low/high"
      : source === "prevDay"
        ? "the prior day's high/low (PDH/PDL)"
        : source === "prevWeek"
          ? "the prior week's high/low (PWH/PWL)"
          : source === "prevMonth"
            ? "the prior month's high/low (PMH/PML)"
            : "a key level";

  const ageNote = ageBars != null && ageBars > 0
    ? ` ${ageBars} bar${ageBars === 1 ? "" : "s"} ago`
    : " on the most recent bar";

  if (direction === "bull") {
    return `Price dipped below ${levelDesc}${ageNote}, sweeping sell-side liquidity, then closed back above — signaling a potential bullish reversal as stops were hunted.`;
  } else {
    return `Price spiked above ${levelDesc}${ageNote}, sweeping buy-side liquidity, then closed back below — signaling a potential bearish reversal as stops were hunted.`;
  }
}

function formatAge(eventTs: number | null): string {
  if (eventTs == null) return "No active sweep";
  const elapsedMs = Math.max(0, Date.now() - eventTs);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return "Sweep occurred just now";
  if (elapsedMinutes < 60) return `Sweep occurred ${elapsedMinutes} min ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Sweep occurred ${elapsedHours} hr ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `Sweep occurred ${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
}

/** Compact label for the "Ago" column: "now", "5m", "2h", "3d", or "—" */
function formatAgoShort(eventTs: number | null): string {
  if (eventTs == null) return "—";
  const elapsedMs = Math.max(0, Date.now() - eventTs);
  const mins = Math.floor(elapsedMs / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function SymbolLogo({ symbol }: { symbol: string }) {
  const [failed, setFailed] = useState(false);
  const upper = symbol.toUpperCase();

  if (failed || !LOGO_SYMBOLS.has(upper)) {
    return (
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.05] font-mono text-[8px] font-semibold text-white/55">
        {upper.slice(0, 2)}
      </div>
    );
  }

  return (
    <img
      src={`/dailyiq-brand-resources/logosvg/${upper}.svg`}
      alt={upper}
      className="h-6 w-6 shrink-0 rounded-full object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function buildColTemplate(showInfo: boolean): string {
  return showInfo
    ? "grid-cols-[16px_minmax(0,96px)_minmax(0,1fr)_44px_minmax(88px,108px)]"
    : "grid-cols-[16px_minmax(0,96px)_44px_minmax(88px,108px)]";
}

function LiquiditySweepDetectorCard({
  linkChannel,
  onSetLinkChannel,
  onClose,
  config,
  onConfigChange,
}: LiquiditySweepDetectorCardProps) {
  const sidecarPort = useSidecarPort();
  const symbols = useMemo(() => readSymbols(config), [config]);
  const timeframe = readTimeframe(config);
  const lookbackBars = readLookbackBars(config);
  const showExpandedInstructions = readShowExpandedInstructions(config);
  const showInfoColumn = readShowInfoColumn(config);
  const COL = buildColTemplate(showInfoColumn);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, LiquiditySweepStatus>>({});
  const [loading, setLoading] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // "asc" = most recent first, "desc" = oldest first, null = manual drag order
  const [agoSort, setAgoSort] = useState<"asc" | "desc" | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const { quotes, status: quoteStatus } = useWatchlistData(symbols);
  const scrollRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const pullStateRef = useRef<{
    pointerId: number | null;
    startY: number;
    active: boolean;
  }>({
    pointerId: null,
    startY: 0,
    active: false,
  });

  // Sorted display order; preserves manual drag order when agoSort is null.
  // Symbols with no sweep always fall to the bottom when sorting.
  const displaySymbols = useMemo(() => {
    if (agoSort === null) return symbols;
    return [...symbols].sort((a, b) => {
      const tsA = statuses[a]?.eventTs ?? null;
      const tsB = statuses[b]?.eventTs ?? null;
      if (tsA === null && tsB === null) return 0;
      if (tsA === null) return 1;
      if (tsB === null) return -1;
      // asc = most recent first → higher ts comes first
      return agoSort === "asc" ? tsB - tsA : tsA - tsB;
    });
  }, [symbols, statuses, agoSort]);

  const refreshStatuses = useCallback(async () => {
    if (!sidecarPort || symbols.length === 0) {
      setStatuses({});
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams({
        symbols: symbols.join(","),
        timeframe,
        lookback_bars: String(lookbackBars),
      });
      const res = await fetch(`http://127.0.0.1:${sidecarPort}/technicals/liquidity-sweeps?${query.toString()}`);
      if (!res.ok) return;
      const payload = (await res.json()) as Record<string, LiquiditySweepStatus>;
      setStatuses(payload);
    } catch {
      setStatuses({});
    } finally {
      setLoading(false);
    }
  }, [lookbackBars, sidecarPort, symbols, timeframe]);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | null = null;

    const runRefresh = async () => {
      try {
        await refreshStatuses();
      } catch {
        if (!cancelled) setStatuses({});
      }
    };

    void runRefresh();
    if (sidecarPort && symbols.length > 0) {
      intervalId = window.setInterval(() => {
        void runRefresh();
      }, POLL_INTERVAL_MS);
    }
    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [refreshStatuses, sidecarPort, symbols.length]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [settingsOpen]);

  const resetPullState = useCallback(() => {
    pullStateRef.current = { pointerId: null, startY: 0, active: false };
    setPullDistance(0);
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (loading || symbols.length === 0 || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-reorder-row='true']")) return;
    const scroller = scrollRef.current;
    if (!scroller || scroller.scrollTop > 0) return;
    pullStateRef.current = { pointerId: event.pointerId, startY: event.clientY, active: true };
  }, [loading, symbols.length]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pullState = pullStateRef.current;
    if (!pullState.active || pullState.pointerId !== event.pointerId) return;
    const scroller = scrollRef.current;
    if (!scroller || scroller.scrollTop > 0) {
      resetPullState();
      return;
    }
    const deltaY = event.clientY - pullState.startY;
    if (deltaY <= 0) {
      setPullDistance(0);
      return;
    }
    event.preventDefault();
    setPullDistance(Math.min(80, deltaY * 0.55));
  }, [resetPullState]);

  const handlePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pullState = pullStateRef.current;
    if (!pullState.active || pullState.pointerId !== event.pointerId) return;
    const shouldRefresh = pullDistance >= 52 && !loading;
    resetPullState();
    if (shouldRefresh) {
      void refreshStatuses();
    }
  }, [loading, pullDistance, refreshStatuses, resetPullState]);

  const persistConfig = (patch: Record<string, unknown>) => {
    onConfigChange({ ...config, ...patch });
  };

  const addSymbol = (symbol: string) => {
    const nextSymbol = symbol.trim().toUpperCase();
    if (!nextSymbol || symbols.includes(nextSymbol) || symbols.length >= MAX_SYMBOLS) return;
    persistConfig({ symbols: [...symbols, nextSymbol] });
  };

  const removeSymbol = (symbol: string) => {
    persistConfig({ symbols: symbols.filter((item) => item !== symbol) });
  };

  // Drag-and-drop handlers
  const handleDragStart = (baseIdx: number) => (e: React.DragEvent) => {
    e.stopPropagation();
    dragIndexRef.current = baseIdx;
    // Defer visual state update to prevent WebKit from cancelling the drag on re-render
    setTimeout(() => setDragIndex(baseIdx), 0);
    e.dataTransfer.effectAllowed = "move";
    const dragSymbol = symbols[baseIdx];
    if (dragSymbol) e.dataTransfer.setData("text/plain", dragSymbol);
  };

  const handleDragOver = (displayIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(displayIdx);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (displayIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const fromIdx = dragIndexRef.current;
    dragIndexRef.current = null;
    setDragIndex(null);
    setDragOverIndex(null);
    if (fromIdx === null || fromIdx === displayIdx) return;
    const next = [...symbols];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(displayIdx, 0, moved);
    persistConfig({ symbols: next });
  };

  const handleDragEnd = () => {
    dragIndexRef.current = null;
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const cycleAgoSort = () => {
    setAgoSort((prev) => (prev === null ? "asc" : prev === "asc" ? "desc" : null));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden border border-white/[0.06] bg-panel">
      {/* Title bar */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-white/[0.10] bg-base px-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-white/80">Liquidity Sweeps</span>
          <span className="font-mono text-[11px] text-white/35">{symbols.length}/{MAX_SYMBOLS}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSearchOpen(true)}
            disabled={symbols.length >= MAX_SYMBOLS}
            className="rounded-sm px-1.5 py-0.5 font-mono text-[10px] text-white transition-colors duration-75 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
            title={symbols.length >= MAX_SYMBOLS ? "Max 10 symbols" : "Add symbol"}
          >
            Add
          </button>
          <div ref={settingsRef} className="relative">
            <button
              onClick={() => setSettingsOpen((prev) => !prev)}
              className="flex items-center justify-center rounded-sm transition-colors duration-75 hover:bg-white/[0.06] hover:text-white"
              style={{
                width: 16,
                height: 16,
                borderRadius: 2,
                border: "none",
                cursor: "pointer",
                backgroundColor: settingsOpen ? "rgba(255,255,255,0.06)" : "transparent",
                color: "#FFFFFF",
              }}
              title="Settings"
            >
              <Settings className="h-[13px] w-[13px]" strokeWidth={2} />
            </button>
            {settingsOpen ? (
              <div className="absolute right-0 top-full z-[100] mt-1 w-[210px] rounded-md border border-white/[0.08] bg-[#1C2128] p-2.5 shadow-xl shadow-black/40">
                <div className="mb-2 text-[9px] uppercase tracking-wider text-white/25">Display</div>
                <button
                  onClick={() => persistConfig({ showExpandedInstructions: !showExpandedInstructions })}
                  className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left transition-colors duration-75 hover:bg-white/[0.06]"
                  title="Toggle expanded sweep instructions"
                >
                  <span className="text-[11px] text-white/75">Expanded instructions</span>
                  <span
                    className={`inline-flex h-5 min-w-[36px] items-center rounded-full px-1 transition-colors duration-100 ${
                      showExpandedInstructions ? "bg-blue/30" : "bg-white/[0.14]"
                    }`}
                  >
                    <span
                      className={`h-3.5 w-3.5 rounded-full bg-white transition-transform duration-100 ${
                        showExpandedInstructions ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </span>
                </button>
                <button
                  onClick={() => persistConfig({ showInfoColumn: !showInfoColumn })}
                  className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left transition-colors duration-75 hover:bg-white/[0.06]"
                  title="Toggle info column"
                >
                  <span className="text-[11px] text-white/75">Info column</span>
                  <span
                    className={`inline-flex h-5 min-w-[36px] items-center rounded-full px-1 transition-colors duration-100 ${
                      showInfoColumn ? "bg-blue/30" : "bg-white/[0.14]"
                    }`}
                  >
                    <span
                      className={`h-3.5 w-3.5 rounded-full bg-white transition-transform duration-100 ${
                        showInfoColumn ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <ComponentLinkMenu linkChannel={linkChannel} onSetLinkChannel={onSetLinkChannel} />
          <button
            onClick={onClose}
            className="rounded-sm p-0 text-white transition-colors duration-75 hover:bg-white/[0.06] hover:text-red"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 16,
              height: 16,
              padding: 0,
              border: "none",
              cursor: "pointer",
              backgroundColor: "transparent",
              color: "#FFFFFF",
              borderRadius: 2,
            }}
          >
            <X className="h-[12px] w-[12px]" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-2 py-2">
        <CustomSelect
          value={timeframe}
          onChange={(next) => persistConfig({ timeframe: next })}
          options={TIMEFRAME_SELECT_OPTIONS}
          size="sm"
          triggerClassName="h-7 min-w-[70px] px-2 font-mono text-[10px] text-white/70"
          panelClassName="bg-[#131720]"
          panelWidth={104}
        />
        <CustomSelect
          value={String(lookbackBars)}
          onChange={(next) => persistConfig({ lookbackBars: Number(next) })}
          options={LOOKBACK_SELECT_OPTIONS}
          size="sm"
          triggerClassName="h-7 min-w-[88px] px-2 font-mono text-[10px] text-white/70"
          panelClassName="bg-[#131720]"
          panelWidth={112}
        />
        <div className="min-w-0 font-mono text-[10px] leading-[1.35] text-white/30">
          {loading ? "Refreshing..." : "Latest active sweep in window"}
        </div>
      </div>

      {/* Symbol chips */}
      {symbols.length > 0 ? (
        <div className="flex flex-wrap gap-1 border-b border-white/[0.06] px-2 py-2">
          {symbols.map((symbol) => (
            <button
              key={symbol}
              onClick={() => removeSymbol(symbol)}
              className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-white/65 transition-colors duration-75 hover:bg-white/[0.10] hover:text-white"
              title={`Remove ${symbol}`}
            >
              <span>{symbol}</span>
              <X className="h-2.5 w-2.5" strokeWidth={1.6} />
            </button>
          ))}
        </div>
      ) : null}

      {/* Scroll area */}
      <div
        ref={scrollRef}
        data-no-drag
        className="scrollbar-none min-h-0 flex-1 overflow-auto"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerLeave={handlePointerEnd}
      >
        {/* Pull-to-refresh indicator */}
        <div
          className="flex items-end justify-center overflow-hidden border-b border-white/[0.04] px-3 text-center transition-[height,opacity] duration-150"
          style={{
            height: symbols.length > 0 || pullDistance > 0 ? pullDistance : 0,
            opacity: pullDistance > 0 ? 1 : 0,
          }}
        >
          <span className="pb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/34">
            {loading ? "Refreshing..." : pullDistance >= 52 ? "Release to refresh" : "Pull to refresh"}
          </span>
        </div>

        {symbols.length === 0 ? (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 px-6 text-center">
            <Search className="h-5 w-5 text-white/18" strokeWidth={1.6} />
            <div>
              <p className="font-mono text-[12px] text-white/40">No symbols configured</p>
              <p className="mt-1 text-[11px] text-white/24">Add up to 10 symbols to monitor fresh sweep events.</p>
            </div>
          </div>
        ) : (
          <div style={{ minWidth: "max(100%, max-content)" }}>
            {/* Column headers */}
            <div className={`grid ${COL} items-center gap-3 border-b border-white/[0.06] px-3 py-1.5`}>
              <div />
              <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-white/25">Symbol</div>
              {showInfoColumn ? <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-white/25">Info</div> : null}
              <button
                onClick={cycleAgoSort}
                className={`flex items-center gap-0.5 font-mono text-[9px] uppercase tracking-[0.12em] transition-colors duration-75 ${
                  agoSort !== null ? "text-blue" : "text-white/25 hover:text-white/50"
                }`}
                title={agoSort === null ? "Sort by most recent sweep" : agoSort === "asc" ? "Sort by oldest sweep" : "Clear sort"}
              >
                Ago
                <span className="text-[8px]">
                  {agoSort === "asc" ? " ↑" : agoSort === "desc" ? " ↓" : " ↕"}
                </span>
              </button>
              <div className="text-right font-mono text-[9px] uppercase tracking-[0.12em] text-white/25">Status</div>
            </div>

            {/* Symbol rows */}
            {displaySymbols.map((symbol, displayIdx) => {
              const baseIdx = symbols.indexOf(symbol);
              const sweep = statuses[symbol] ?? {
                direction: null,
                eventTs: null,
                ageBars: null,
                ageMinutes: null,
                source: null,
              };
              const quote = quotes.get(symbol);
              const symbolState = quoteStatus.get(symbol) ?? "pending";
              const isBull = sweep.direction === "bull";
              const badgeClass = isBull
                ? "bg-blue text-white"
                : sweep.direction === "bear"
                  ? "bg-red text-white"
                  : "bg-white/[0.08] text-white/60";
              const agoLabel = formatAgoShort(sweep.eventTs);
              const isDragging = dragIndex === baseIdx;
              const isDragTarget = dragOverIndex === displayIdx && dragIndex !== null && dragIndex !== baseIdx;

              return (
                <div
                  key={symbol}
                  data-no-drag
                  data-reorder-row="true"
                  draggable={agoSort === null}
                  onDragStart={handleDragStart(baseIdx)}
                  onDragOver={handleDragOver(displayIdx)}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop(displayIdx)}
                  onDragEnd={handleDragEnd}
                  className={`grid ${COL} items-start gap-3 border-b px-3 py-2.5 transition-colors duration-75 ${
                    isDragging
                      ? "border-white/[0.04] opacity-40"
                      : isDragTarget
                        ? "border-blue/40 bg-blue/[0.04]"
                        : "border-white/[0.04] hover:bg-white/[0.05]"
                  }`}
                >
                  {/* Drag handle */}
                  <div
                    className={`flex items-center justify-center pt-1 ${
                      agoSort !== null
                        ? "cursor-not-allowed opacity-20"
                        : "cursor-grab text-white/25 hover:text-white/55"
                    }`}
                    title={agoSort !== null ? "Clear Ago sort to reorder" : "Drag to reorder"}
                  >
                    <GripVertical className="h-3 w-3" strokeWidth={1.8} />
                  </div>

                  {/* Symbol + logo */}
                  <button
                    className="flex min-w-0 items-start gap-2 pt-0.5 text-left"
                    onClick={() => { if (linkChannel) linkBus.publish(linkChannel, symbol); }}
                  >
                    <SymbolLogo symbol={symbol} />
                    <div className="min-w-0">
                      <p className="font-mono text-[12px] font-semibold text-white/90">{symbol}</p>
                      <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-white/25">
                        {timeframe.toUpperCase()}
                      </p>
                    </div>
                  </button>

                  {/* Description */}
                  {showInfoColumn ? (
                    <button
                      className="min-w-0 text-left"
                      onClick={() => { if (linkChannel) linkBus.publish(linkChannel, symbol); }}
                    >
                      <p className="truncate text-[12px] text-white/74">
                        {quote?.name ?? (symbolState === "error" ? "Unknown symbol" : "Loading...")}
                      </p>
                      {sweep.direction ? (
                        <>
                          {showExpandedInstructions ? (
                            <>
                              <p className="mt-0.5 font-mono text-[10px] text-white/40">
                                {formatAge(sweep.eventTs)} &bull; {sourceLabel(sweep.source)}
                              </p>
                              <p className="mt-1 whitespace-normal break-words text-[10px] leading-[1.4] text-white/28">
                                {sweepBlurb(sweep.direction, sweep.source, sweep.ageBars)}
                              </p>
                            </>
                          ) : null}
                        </>
                      ) : showExpandedInstructions ? (
                        <p className="mt-1 font-mono text-[10px] leading-[1.35] text-white/28">
                          No active sweep in lookback window
                        </p>
                      ) : null}
                    </button>
                  ) : null}

                  {/* Ago column */}
                  <div className="flex items-start justify-center pt-1">
                    <span className={`font-mono text-[11px] tabular-nums ${
                      sweep.eventTs == null
                        ? "text-white/20"
                        : agoLabel === "now"
                          ? "text-green"
                          : "text-white/55"
                    }`}>
                      {agoLabel}
                    </span>
                  </div>

                  {/* Badge */}
                  <div className="flex justify-end pt-0.5">
                    <span className={`inline-flex min-w-[88px] items-center justify-center rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${badgeClass}`}>
                      {sweep.direction === "bull" ? "Bull Sweep" : sweep.direction === "bear" ? "Bear Sweep" : "No Sweep"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <SymbolSearchModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelectSymbol={addSymbol}
        title="Liquidity Sweep Detector"
        subtitle={`Add up to ${MAX_SYMBOLS} symbols to monitor`}
      />
    </div>
  );
}

export default memo(LiquiditySweepDetectorCard);
