/**
 * FaucetButton — "Get test SUI" CTA.
 *
 * Controlled component: the parent passes the recipient address (the burner
 * session wallet, in the ride flow) and an `onFunded` callback fired after a
 * successful drip so the parent can refresh balances.
 *
 * POSTs the address to `/api/faucet` (Vercel serverless function), which
 * ships back a `digest`. 0.05 SUI per drip; the server enforces a 5-minute
 * per-recipient cooldown, and we add a local 30s debounce on top.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toaster";
import { explorerTxUrl } from "@/lib/sui";

const LOCAL_COOLDOWN_MS = 30_000;

interface FaucetSuccess {
  digest: string;
  amount_mist: string;
  recipient: string;
}
interface FaucetError {
  error: string;
  retry_after_ms?: number;
}

export function FaucetButton(props: {
  /** Address to fund (the burner session wallet). */
  recipient: string;
  /** Fired after a successful drip — parent should refresh balance. */
  onFunded?: () => void;
  /** Optional label override. */
  label?: string;
  /** Button size — "lg" for the prominent center funding CTA. */
  size?: "sm" | "lg";
}) {
  const { recipient, onFunded } = props;
  const toast = useToast();

  const [pending, setPending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (cooldownUntil <= 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  const onClick = useCallback(async () => {
    if (!recipient) return;
    setPending(true);
    const toastId = toast.push({
      title: "Funding your wallet…",
      tone: "pending",
    });
    try {
      // Drip SUI (for gas) + TUSD (for stake) in parallel.
      // SUI is required for every Sui tx; TUSD is what the v4 market
      // takes as ride stake. Both endpoints are independently
      // rate-limited per-recipient (90s cooldown).
      const [suiRes, tusdRes] = await Promise.all([
        fetch("/api/faucet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipient }),
        }),
        fetch("/api/faucet-tusd", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipient }),
        }),
      ]);

      const suiData = (await suiRes.json()) as Partial<FaucetSuccess & FaucetError>;
      const tusdData = (await tusdRes.json()) as Partial<FaucetSuccess & FaucetError>;

      const suiOk = suiRes.ok && Boolean(suiData.digest);
      const tusdOk = tusdRes.ok && Boolean(tusdData.digest);

      if (!suiOk && !tusdOk) {
        const msg =
          suiRes.status === 429 || tusdRes.status === 429
            ? "Rate-limited — try again in a minute."
            : (suiData.error ?? tusdData.error ?? `HTTP ${suiRes.status}/${tusdRes.status}`);
        toast.update(toastId, {
          title: "Faucet declined",
          description: msg,
          tone: "error",
          ttlMs: 6_000,
        });
        return;
      }

      // At least one of the two succeeded. Show a single combined toast.
      const lines: string[] = [];
      if (suiOk) lines.push("✓ 0.2 SUI for gas");
      else lines.push(`✗ SUI failed: ${suiData.error ?? "unknown"}`);
      if (tusdOk) lines.push("✓ 10 TUSD for staking");
      else lines.push(`✗ TUSD failed: ${tusdData.error ?? "unknown"}`);

      const successDigest = suiData.digest ?? tusdData.digest;
      toast.update(toastId, {
        title: suiOk && tusdOk ? "Funded — ready to ride" : "Partial fund",
        description: lines.join(" · "),
        tone: suiOk && tusdOk ? "success" : "error",
        href: successDigest ? explorerTxUrl(successDigest) : undefined,
        hrefLabel: successDigest ? "view tx" : undefined,
        ttlMs: 8_000,
      });
      setCooldownUntil(Date.now() + LOCAL_COOLDOWN_MS);
      // Give the fullnode a beat to index, then refresh.
      window.setTimeout(() => onFunded?.(), 1200);
      onFunded?.();
    } catch (err) {
      toast.update(toastId, {
        title: "Faucet network error",
        description: String(err),
        tone: "error",
        ttlMs: 6_000,
      });
    } finally {
      setPending(false);
    }
  }, [recipient, onFunded, toast]);

  const remainingMs = Math.max(0, cooldownUntil - now);
  const inCooldown = remainingMs > 0;
  const disabled = pending || inCooldown || !recipient;

  const label = pending
    ? "Sending…"
    : inCooldown
      ? `Wait ${Math.ceil(remainingMs / 1000)}s`
      : (props.label ?? "Get test SUI");

  return (
    <Button
      size={props.size ?? "sm"}
      onClick={() => void onClick()}
      disabled={disabled}
      title="Drips free testnet SUI from the Wick demo wallet"
    >
      {label}
    </Button>
  );
}
