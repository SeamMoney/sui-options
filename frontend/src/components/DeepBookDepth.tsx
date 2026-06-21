/**
 * DeepBookDepth — a live order-book depth ladder straight from the on-chain
 * DeepBook v3 CLOB. This is the most direct "real DeepBook integration" proof:
 * the actual resting bids/asks (price + size) Wick Pro's mark is read from,
 * not a synthetic feed. Self-contained (polls fetchDeepBookDepth); pair with
 * useDeepBookMark / LiveOptionQuote on /coach or the Wick Pro desk.
 */
import { useEffect, useRef, useState } from "react";
import {
  fetchDeepBookDepth,
  fetchDeepBookTicker,
  fetchDeepBookTrades,
  deepBookPoolExplorerUrl,
  type DeepBookDepth as Depth,
  type DeepBookTrade,
  type DeepBookPoolName,
  DEEPBOOK_POOLS,
} from "@/lib/deepbook";

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtAge(nowMs: number, tsMs: number): string {
  const s = Math.max(0, Math.round((nowMs - tsMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

export interface DeepBookDepthProps {
  readonly pool?: DeepBookPoolName;
  /** Levels per side (default 5). */
  readonly levels?: number;
  readonly pollMs?: number;
}

function fmtSize(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1) return n.toFixed(0);
  return n.toFixed(2);
}

export function DeepBookDepth({
  pool = "SUI_USDC",
  levels = 5,
  pollMs = 1_200,
}: DeepBookDepthProps) {
  const [depth, setDepth] = useState<Depth | null>(null);
  const [live, setLive] = useState(false);
  const [vol24h, setVol24h] = useState<number | null>(null);
  const [fills, setFills] = useState<DeepBookTrade[]>([]);
  const last = useRef<Depth | null>(null);

  // 24h quote volume — proves the pool is a real, active market (fetched once
  // per asset; volume moves slowly, no need to poll it).
  useEffect(() => {
    const controller = new AbortController();
    setVol24h(null);
    fetchDeepBookTicker(DEEPBOOK_POOLS[pool].name, controller.signal)
      .then((t) => setVol24h(t.quoteVolume))
      .catch(() => {});
    return () => controller.abort();
  }, [pool]);

  // Recent fills — live on-chain executions (the tape). Together with the
  // resting book above, this is the full "real DeepBook market" picture. Polled
  // slower than the book since individual trades are sparser.
  useEffect(() => {
    const poolName = DEEPBOOK_POOLS[pool].name;
    let cancelled = false;
    const controller = new AbortController();
    setFills([]);
    const tick = () =>
      fetchDeepBookTrades(poolName, 3, controller.signal)
        .then((t) => {
          if (!cancelled) setFills(t.slice(-3).reverse());
        })
        .catch(() => {});
    void tick();
    const id = window.setInterval(tick, 3_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [pool]);

  useEffect(() => {
    const poolName = DEEPBOOK_POOLS[pool].name;
    let cancelled = false;
    const controller = new AbortController();
    setLive(Boolean(last.current));

    const tick = async () => {
      try {
        const d = await fetchDeepBookDepth(poolName, levels, controller.signal);
        if (cancelled) return;
        last.current = d;
        setDepth(d);
        setLive(true);
      } catch {
        if (!cancelled && !controller.signal.aborted) setLive(false);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [pool, levels, pollMs]);

  const fmtPrice = (p: number) =>
    p >= 100 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toFixed(5);

  // Scale size bars to the largest level shown.
  const maxSize = depth
    ? Math.max(
        1,
        ...depth.bids.map((l) => l.size),
        ...depth.asks.map((l) => l.size),
      )
    : 1;

  const Row = ({
    price,
    size,
    side,
  }: {
    price: number;
    size: number;
    side: "bid" | "ask";
  }) => {
    const pct = Math.min(100, (size / maxSize) * 100);
    const color = side === "bid" ? "16,185,129" : "244,63,94";
    return (
      <div className="relative flex items-center justify-between px-2 py-[3px] font-mono text-[11px] tabular-nums">
        <div
          className="absolute inset-y-0 right-0"
          style={{ width: `${pct}%`, background: `rgba(${color},0.13)` }}
          aria-hidden
        />
        <span
          className="relative"
          style={{ color: `rgb(${color})` }}
        >
          {fmtPrice(price)}
        </span>
        <span className="relative text-white/45">{fmtSize(size)}</span>
      </div>
    );
  };

  const spread =
    depth && depth.bids[0] && depth.asks[0]
      ? depth.asks[0].price - depth.bids[0].price
      : null;
  const mid =
    depth && depth.bids[0] && depth.asks[0]
      ? (depth.asks[0].price + depth.bids[0].price) / 2
      : null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 font-sans">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <a
          href={deepBookPoolExplorerUrl(pool)}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] uppercase tracking-[0.18em] text-white/35 underline decoration-white/15 underline-offset-2 hover:text-white/60"
        >
          DeepBook book · {DEEPBOOK_POOLS[pool].label}/USDC ↗
        </a>
        {vol24h != null && (
          <span className="text-[9px] tabular-nums text-white/30">
            {fmtUsd(vol24h)} 24h
          </span>
        )}
        <span className="flex items-center gap-1 text-[9px] uppercase tracking-[0.14em] text-white/35">
          <span
            className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400" : "bg-white/30"}`}
            aria-hidden
          />
          {live ? "live" : "…"}
        </span>
      </div>
      {/* asks (best at the bottom, nearest the mid) */}
      <div className="flex flex-col-reverse">
        {(depth?.asks ?? []).map((l, i) => (
          <Row key={`a${i}`} price={l.price} size={l.size} side="ask" />
        ))}
      </div>
      <div className="my-0.5 flex items-center justify-between border-y border-white/5 px-2 py-1 font-mono text-[11px] tabular-nums text-white/55">
        <span>{mid != null ? fmtPrice(mid) : "—"}</span>
        {spread != null && mid != null && (
          <span className="text-white/30">
            spread {((spread / mid) * 10_000).toFixed(1)} bps
          </span>
        )}
      </div>
      <div className="flex flex-col">
        {(depth?.bids ?? []).map((l, i) => (
          <Row key={`b${i}`} price={l.price} size={l.size} side="bid" />
        ))}
      </div>

      {/* Recent fills — live on-chain executions (the tape). */}
      {fills.length > 0 && (
        <div className="mt-1.5 border-t border-white/5 pt-1">
          <div className="px-2 pb-0.5 text-[8px] uppercase tracking-[0.16em] text-white/25">
            recent fills
          </div>
          {fills.map((f, i) => (
            <div
              key={`f${i}`}
              className="flex items-center justify-between px-2 py-[2px] font-mono text-[10px] tabular-nums"
            >
              <span style={{ color: f.side === "buy" ? "rgb(16,185,129)" : "rgb(244,63,94)" }}>
                {f.side === "buy" ? "▲" : "▼"} {fmtPrice(f.price)}
              </span>
              <span className="text-white/40">{fmtSize(f.size)}</span>
              <span className="text-white/25">{fmtAge(Date.now(), f.tsMs)} ago</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default DeepBookDepth;
