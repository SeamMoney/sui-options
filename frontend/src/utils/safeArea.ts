/**
 * iOS-safe sizing helpers — ported from cash-trading-game/src/utils/helpers.ts.
 *
 * These are load-bearing for the ride canvas: without `getTopMargin` we
 * overlap the iPhone notch when run as a PWA, and without `getSafeBottom`
 * the chart cuts under the home-bar.
 *
 * Reads `--sat` (set to `env(safe-area-inset-bottom)` in `index.css`).
 */

export const isStandalone =
  typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari pre-PWA flag
    (window.navigator as unknown as { standalone?: boolean }).standalone === true);

export function getTopMargin(): number {
  if (typeof window === "undefined") return 50;
  const isMobile = window.innerWidth < 768;
  if (isMobile) {
    // PWA mode hides Safari chrome → push down past the notch.
    return isStandalone ? 60 : 10;
  }
  return 50;
}

export function getSafeBottom(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;
  return parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--sat") || "0",
  );
}
