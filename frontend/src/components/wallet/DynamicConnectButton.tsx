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

export function DynamicConnectButton() {
  // `useDynamicContext` returns no-op-ish defaults when the provider isn't
  // mounted (happens when VITE_DYNAMIC_ENVIRONMENT_ID is unset). We still
  // gate explicitly on the env-id sentinel so we can show a clearer message.
  // `setShowAuthFlow` lives on useDynamicContext in SDK 4.83+, NOT on
  // useDynamicModals (that hook's surface changed).
  const { primaryWallet, handleLogOut, setShowAuthFlow } = useDynamicContext();

  const openConnect = useCallback(() => setShowAuthFlow(true), [setShowAuthFlow]);

  if (!HAS_DYNAMIC_ENV_ID) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        title="Set VITE_DYNAMIC_ENVIRONMENT_ID in frontend/.env.local — register your app at https://app.dynamic.xyz/dashboard/developer/api"
      >
        Sign in (no env id)
      </Button>
    );
  }

  if (!primaryWallet) {
    return (
      <Button onClick={openConnect} size="sm">
        Sign in
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
