// Number / time formatting helpers tuned for the trader UI.

const SUI_DIVISOR = 1_000_000_000n;

export function mistToSui(mist: bigint | number | string): number {
  const m = typeof mist === "bigint" ? mist : BigInt(mist);
  // Avoid precision loss for typical values; full SUI as float is fine for display.
  const integer = Number(m / SUI_DIVISOR);
  const remainder = Number(m % SUI_DIVISOR) / 1e9;
  return integer + remainder;
}

export function formatSui(mist: bigint | number | string, opts: { digits?: number } = {}) {
  const sui = mistToSui(mist);
  const digits = opts.digits ?? 4;
  return sui.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPriceCents(price: bigint | number | string) {
  // Wick prices are oracle-scale integers. We don't know decimals at this layer;
  // print as raw with thousands separators.
  const n = typeof price === "bigint" ? price : BigInt(price);
  return n.toLocaleString();
}

export function formatPercent(p: number, digits = 2) {
  return (p * 100).toFixed(digits) + "%";
}

export function shortAddr(addr: string, head = 6, tail = 4) {
  if (!addr.startsWith("0x")) return addr;
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head + 2)}…${addr.slice(-tail)}`;
}

export function timeUntil(expiryMs: number, nowMs = Date.now()) {
  const diff = expiryMs - nowMs;
  if (diff <= 0) return { label: "expired", expired: true };
  const sec = Math.floor(diff / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return { label: `${h}h ${m % 60}m`, expired: false };
  }
  return { label: `${m}m ${s.toString().padStart(2, "0")}s`, expired: false };
}
