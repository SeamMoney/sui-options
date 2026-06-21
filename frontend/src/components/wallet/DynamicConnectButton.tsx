/**
 * DynamicConnectButton — single CTA for social login + connected state.
 *
 * - Logged out: opens Dynamic's modal ("Continue with Google / Apple / GitHub
 *   / email"). Falls back to a hint button when no env id is configured.
 * - Logged in: shows the truncated wallet address and a logout button.
 *
 * Replaces the previous `@mysten/dapp-kit` `ConnectButton` in places where
 * we want the social-login UX. The dApp Kit ConnectButton still works in
 * the `/ride-test` debug surface (and can be left in place there).
 */
import { useCallback } from "react";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { Button } from "@/components/ui/button";
import { shortAddr } from "@/lib/format";
import { HAS_DYNAMIC_ENV_ID } from "@/providers/DynamicProvider";

/**
 * Outer wrapper: gates the env-id check BEFORE any Dynamic hook is called.
 * When the env id is missing, `DynamicProvider` short-circuits and renders
 * `<>{children}</>` instead of the real `<DynamicContextProvider>` — so
 * calling `useDynamicContext()` here unconditionally would crash with
 * "Hook must be used within <DynamicContextProvider>". Hooks can't be
 * conditional, so the inner component (which IS allowed to call the hook)
 * only mounts when the provider is real.
 *
 * Fallback: when no Dynamic env id is configured, render dApp Kit's native
 * ConnectButton so users can still connect Slush / Suiet / any injected Sui
 * wallet. Dynamic adds social login on top; without it, the rest of the
 * Sui wallet ecosystem still works perfectly.
 */
export function DynamicConnectButton() {
  if (!HAS_DYNAMIC_ENV_ID) {
    // v4.31g — render nothing when Dynamic isn't configured. The /ride
    // flow doesn't need any wallet — the session wallet in localStorage
    // IS the user. Falling back to dApp Kit's ConnectButton here used
    // to surface a confusing "Connect wallet" CTA that, when tapped,
    // promised to connect Slush/Suiet but those wallets aren't actually
    // wired to do anything useful in the Ride flow (they'd just sit
    // connected and be ignored). Hiding it entirely keeps the UI
    // honest. Once VITE_DYNAMIC_ENVIRONMENT_ID is configured, the real
    // Dynamic Sign-in button appears via DynamicConnectButtonInner.
    return null;
  }
  return <DynamicConnectButtonInner />;
}

function DynamicConnectButtonInner() {
  // Safe to call here: this component only mounts when HAS_DYNAMIC_ENV_ID is
  // true, which is the same condition under which DynamicProvider actually
  // mounts the real <DynamicContextProvider>.
  // `setShowAuthFlow` lives on useDynamicContext in SDK 4.83+, NOT on
  // useDynamicModals (that hook's surface changed).
  const { primaryWallet, handleLogOut, setShowAuthFlow, sdkHasLoaded } =
    useDynamicContext();

  // ALWAYS open the auth flow on click. Dynamic handles a not-yet-ready SDK
  // gracefully (it shows its own loading/error inside the modal), so we must
  // never block the click — a CORS-blocked origin means the SDK never flips
  // sdkHasLoaded, and a button that's hidden or permanently disabled there
  // reads as "login is gone". Keep it visible and tappable; surface the state
  // only as a label.
  const openConnect = useCallback(() => setShowAuthFlow(true), [setShowAuthFlow]);

  if (!primaryWallet) {
    return (
      <Button
        onClick={openConnect}
        size="sm"
        title={sdkHasLoaded ? "Sign in" : "Connecting to sign-in…"}
      >
        {sdkHasLoaded ? "Sign in" : "Connecting…"}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className="font-mono text-xs text-muted-foreground tabular-nums"
        title={primaryWallet.address}
      >
        {shortAddr(primaryWallet.address, 4, 4)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleLogOut()}
        className="text-xs"
      >
        Sign out
      </Button>
    </div>
  );
}
