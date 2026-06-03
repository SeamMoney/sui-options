/** Simple pub/sub event bus for linking components by channel */
type Listener = (symbol: string) => void;

const listeners = new Map<number, Set<Listener>>();
const latestSymbols = new Map<number, string>();
const KEY_PREFIX = "link-bus:";

function keyFor(channel: number): string {
  return `${KEY_PREFIX}${channel}`;
}

function notify(channel: number, symbol: string): void {
  latestSymbols.set(channel, symbol);
  listeners.get(channel)?.forEach((cb) => cb(symbol));
}

function readPersistedSymbol(channel: number): string | null {
  try {
    const raw = window.localStorage.getItem(keyFor(channel));
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(KEY_PREFIX)) return;
    const channel = Number.parseInt(event.key.slice(KEY_PREFIX.length), 10);
    if (!Number.isFinite(channel) || !event.newValue) return;
    notify(channel, event.newValue);
  });
}

export const linkBus = {
  subscribe(channel: number, callback: Listener): () => void {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(callback);
    const latest = latestSymbols.get(channel) ?? readPersistedSymbol(channel) ?? undefined;
    if (latest) callback(latest);
    return () => {
      listeners.get(channel)?.delete(callback);
    };
  },

  publish(channel: number, symbol: string): void {
    notify(channel, symbol);
    try {
      window.localStorage.setItem(keyFor(channel), symbol);
    } catch {
      // Ignore persistence failures; same-window listeners were already notified.
    }
  },
};
