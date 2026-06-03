/**
 * Background polling store for the Momentum Screener.
 *
 * A module-level singleton starts fetching as soon as a sidecar port is
 * provided and keeps polling every 60 s regardless of whether the page is
 * mounted.  Components subscribe via `useScreenerData()` and receive fresh
 * data the moment they mount if a prior result already exists.
 */

import { useSyncExternalStore, useEffect } from "react";

const POLL_INTERVAL_MS = 60_000;

// ── Store state ───────────────────────────────────────────────────────

export interface ScreenerRow {
  rank: number;
  Symbol: string;
  Decision: string;
  "Momentum Advice": string;
  "Alert Triggered": string;
  "Days Ago": string | number;
  "Alert Price": string | number;
  "Current Price": string | number | null;
  "P/L %": string;
  "P/L Points": string;
  "SPY Return %": string;
  "Outperformance %": string;
  Position: string;
  Bull: number;
  Bear: number;
  EMA: string;
  MACD: string;
  "Rank Score": number;
}

export interface TfData {
  trend: string;
  strength: string;
  chop: string;
  rsi: string;
  macd: string;
  ema520: string;
  volMom: string;
}

export interface ScreenerData {
  ranked: ScreenerRow[];
  timeframes: Record<string, Record<string, TfData>>;
  updatedAt: number;
  symbols: string[];
}

interface StoreState {
  data: ScreenerData | null;
  fetching: boolean;
  lastFetchedAt: number;
  error: string | null;
}

// ── Singleton ─────────────────────────────────────────────────────────

let _state: StoreState = { data: null, fetching: false, lastFetchedAt: 0, error: null };
let _listeners = new Set<() => void>();
let _port: number | null = null;
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _inFlight = false;

function setState(patch: Partial<StoreState>) {
  _state = { ..._state, ...patch };
  _listeners.forEach((fn) => fn());
}

function getSnapshot(): StoreState {
  return _state;
}

function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

async function fetchNow(force = false) {
  if (!_port) return;
  if (_inFlight && !force) return;
  _inFlight = true;
  setState({ fetching: true });
  try {
    const url = `http://127.0.0.1:${_port}/momentum-screener${force ? "?force=true" : ""}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: ScreenerData = await res.json();
    setState({ data, fetching: false, lastFetchedAt: Date.now(), error: null });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setState({ fetching: false, error: msg });
  } finally {
    _inFlight = false;
  }
}

function startPolling(port: number) {
  if (_port === port && _intervalId !== null) return; // already running on this port
  if (_intervalId !== null) clearInterval(_intervalId);
  _port = port;
  // Kick off immediately
  void fetchNow();
  _intervalId = setInterval(() => void fetchNow(), POLL_INTERVAL_MS);
}

/** Called from the hook when the sidecar port is known. */
export function initScreenerPoller(port: number | null) {
  if (!port) return;
  startPolling(port);
}

/** Force an immediate refresh (e.g. manual refresh button). */
export function refreshScreener() {
  void fetchNow(true);
}

// ── React hook ────────────────────────────────────────────────────────

export function useScreenerData(sidecarPort: number | null): StoreState {
  // Wire up the port whenever it changes
  useEffect(() => {
    initScreenerPoller(sidecarPort);
  }, [sidecarPort]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
