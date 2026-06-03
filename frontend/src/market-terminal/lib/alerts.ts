import { createContext, useContext, useReducer, useRef, useEffect, useCallback, type ReactNode, createElement } from 'react';
import type { ActiveIndicator } from '../chart/types';
import { indicatorRegistry } from '../chart/indicators/registry';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PriceCondition = 'crosses_above' | 'crosses_below';
export type IndicatorCondition = 'crosses_above' | 'crosses_below' | 'rises_above' | 'falls_below';

export interface PriceAlert {
  id: string;
  type: 'price';
  symbol: string;
  label?: string;
  condition: PriceCondition;
  price: number;
  status: 'active' | 'fired';
  createdAt: number;
  triggeredAt?: number;
  triggeredValue?: number;
  triggeredBarTime?: number;
}

export interface IndicatorAlert {
  id: string;
  type: 'indicator';
  symbol: string;
  label?: string;
  indicatorId: string;
  indicatorName: string;
  outputKey: string;
  condition: IndicatorCondition;
  targetValue: number;
  status: 'active' | 'fired';
  createdAt: number;
  triggeredAt?: number;
  triggeredValue?: number;
  triggeredBarTime?: number;
}

export type ChartAlert = PriceAlert | IndicatorAlert;

export interface FiredAlertNotification {
  id: string;
  alertId: string;
  alertType: ChartAlert['type'];
  label: string;
  triggeredValue: number;
  symbol: string;
  timestamp: number;
  dismissed: boolean;
}

// ─── Sound ───────────────────────────────────────────────────────────────────

function playAlertSound(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => { ctx.close(); };
    ctx.resume().catch(() => {});
  } catch {
    // AudioContext may be blocked before user interaction — silently ignore
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'diq:alerts';

function loadAlerts(): ChartAlert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ChartAlert[];
  } catch {
    return [];
  }
}

function saveAlerts(alerts: ChartAlert[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  } catch {}
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

interface AlertsState {
  alerts: ChartAlert[];
  notifications: FiredAlertNotification[];
}

type AlertsAction =
  | { type: 'ADD'; alert: ChartAlert }
  | { type: 'REMOVE'; id: string }
  | { type: 'UPDATE'; alert: ChartAlert }
  | { type: 'FIRE'; alertId: string; triggeredValue: number; triggeredBarTime: number }
  | { type: 'DISMISS'; notifId: string };

function reducer(state: AlertsState, action: AlertsAction): AlertsState {
  switch (action.type) {
    case 'ADD':
      return { ...state, alerts: [...state.alerts, action.alert] };
    case 'REMOVE':
      return { ...state, alerts: state.alerts.filter(a => a.id !== action.id) };
    case 'UPDATE':
      return { ...state, alerts: state.alerts.map(a => a.id === action.alert.id ? action.alert : a) };
    case 'FIRE': {
      const alert = state.alerts.find(a => a.id === action.alertId);
      if (!alert) return state;
      const triggeredAt = Date.now();
      const notif: FiredAlertNotification = {
        id: crypto.randomUUID(),
        alertId: alert.id,
        alertType: alert.type,
        label: alert.label ?? (alert.type === 'price' ? `${alert.symbol} price ${alert.condition === 'crosses_above' ? '↑' : '↓'} ${alert.price.toFixed(2)}` : `${alert.symbol} ${alert.indicatorName} alert`),
        triggeredValue: action.triggeredValue,
        symbol: alert.symbol,
        timestamp: triggeredAt,
        dismissed: false,
      };
      return {
        alerts: state.alerts.map(a => a.id === action.alertId ? {
          ...a,
          status: 'fired' as const,
          triggeredAt,
          triggeredValue: action.triggeredValue,
          triggeredBarTime: action.triggeredBarTime,
        } : a),
        notifications: [...state.notifications, notif],
      };
    }
    case 'DISMISS':
      return {
        alerts: state.alerts.filter((alert) => {
          const notification = state.notifications.find((n) => n.id === action.notifId);
          return notification ? alert.id !== notification.alertId : true;
        }),
        notifications: state.notifications.filter((notification) => notification.id !== action.notifId),
      };
    default:
      return state;
  }
}

// ─── Context ─────────────────────────────────────────────────────────────────

interface AlertsContextValue {
  alerts: ChartAlert[];
  notifications: FiredAlertNotification[];
  addAlert: (alert: ChartAlert) => void;
  removeAlert: (id: string) => void;
  updateAlert: (alert: ChartAlert) => void;
  dismissNotification: (id: string) => void;
  evaluateAlerts: (symbol: string, latestClose: number, prevClose: number | null, latestBarTime: number, activeIndicators: ActiveIndicator[]) => void;
}

const AlertsContext = createContext<AlertsContextValue | null>(null);

export function AlertProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    alerts: loadAlerts(),
    notifications: [],
  }));

  useEffect(() => {
    saveAlerts(state.alerts);
  }, [state.alerts]);

  useEffect(() => {
    const hasActivePriceNotifications = state.notifications.some(
      (notification) => !notification.dismissed && notification.alertType === 'price',
    );
    if (!hasActivePriceNotifications) return;

    const intervalId = window.setInterval(() => {
      playAlertSound();
    }, 1400);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [state.notifications]);

  const addAlert = useCallback((alert: ChartAlert) => dispatch({ type: 'ADD', alert }), []);
  const removeAlert = useCallback((id: string) => dispatch({ type: 'REMOVE', id }), []);
  const updateAlert = useCallback((alert: ChartAlert) => dispatch({ type: 'UPDATE', alert }), []);
  const dismissNotification = useCallback((id: string) => dispatch({ type: 'DISMISS', notifId: id }), []);

  const evaluateAlerts = useCallback((
    symbol: string,
    latestClose: number,
    prevClose: number | null,
    latestBarTime: number,
    activeIndicators: ActiveIndicator[],
  ) => {
    if (prevClose === null) return;

    const relevant = state.alerts.filter(a => a.status === 'active' && a.symbol === symbol);

    for (const alert of relevant) {
      if (alert.type === 'price') {
        const triggered =
          (alert.condition === 'crosses_above' && prevClose < alert.price && latestClose >= alert.price) ||
          (alert.condition === 'crosses_below' && prevClose > alert.price && latestClose <= alert.price);
        if (triggered) {
          dispatch({ type: 'FIRE', alertId: alert.id, triggeredValue: latestClose, triggeredBarTime: latestBarTime });
          playAlertSound();
        }
      } else {
        const ind = activeIndicators.find(i => i.id === alert.indicatorId);
        if (!ind) continue;
        const meta = indicatorRegistry[ind.name];
        const outputIndex = meta?.outputs.findIndex(o => o.key === alert.outputKey) ?? -1;
        if (outputIndex < 0 || !ind.data[outputIndex] || ind.data[outputIndex].length < 2) continue;
        const series = ind.data[outputIndex];
        const curr = series[series.length - 1];
        const prev = series[series.length - 2];
        if (!isFinite(prev) || !isFinite(curr)) continue;
        const triggered =
          (alert.condition === 'crosses_above' && prev < alert.targetValue && curr >= alert.targetValue) ||
          (alert.condition === 'crosses_below' && prev > alert.targetValue && curr <= alert.targetValue) ||
          (alert.condition === 'rises_above' && curr > alert.targetValue) ||
          (alert.condition === 'falls_below' && curr < alert.targetValue);
        if (triggered) {
          dispatch({ type: 'FIRE', alertId: alert.id, triggeredValue: curr, triggeredBarTime: latestBarTime });
          playAlertSound();
        }
      }
    }
  }, [state.alerts]);

  const value: AlertsContextValue = {
    alerts: state.alerts,
    notifications: state.notifications,
    addAlert,
    removeAlert,
    updateAlert,
    dismissNotification,
    evaluateAlerts,
  };

  return createElement(AlertsContext.Provider, { value }, children);
}

export function useAlerts(): AlertsContextValue {
  const ctx = useContext(AlertsContext);
  if (!ctx) throw new Error('useAlerts must be used inside AlertProvider');
  return ctx;
}

// ─── Alert evaluator hook ─────────────────────────────────────────────────────

export function useAlertEvaluator(
  bars: { close: number; time: number }[],
  symbol: string,
  activeIndicators: ActiveIndicator[],
): void {
  const { evaluateAlerts } = useAlerts();
  const prevCloseRef = useRef<number | null>(null);
  const prevSymbolRef = useRef<string>(symbol);

  useEffect(() => {
    if (prevSymbolRef.current !== symbol) {
      prevCloseRef.current = null;
      prevSymbolRef.current = symbol;
    }
  }, [symbol]);

  useEffect(() => {
    if (bars.length < 1) return;
    const latestBar = bars[bars.length - 1];
    const latestClose = latestBar.close;
    const prevClose = prevCloseRef.current;
    evaluateAlerts(symbol, latestClose, prevClose, latestBar.time, activeIndicators);
    prevCloseRef.current = latestClose;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, symbol]);
}
