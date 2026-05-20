/**
 * Device-detection helpers — ported from cash-trading-game.
 *
 * Passkey/WebAuthn detection is intentionally dropped: Wick uses Sui wallet
 * adapters (dApp Kit), not WebAuthn passkeys.
 */

export function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
  const isMobileUA = mobileRegex.test(navigator.userAgent);
  const isTouchDevice =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const isPWA =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const isSmallScreen = window.innerWidth < 768;
  return isMobileUA || (isTouchDevice && isSmallScreen) || isPWA;
}

export function isPWA(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}
