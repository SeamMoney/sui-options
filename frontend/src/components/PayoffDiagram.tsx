/**
 * PayoffDiagram — the iconic option payoff "hockey-stick", live off the
 * DeepBook mark. Shows what a CALL (tap UP) and a PUT (tap DOWN) pay at expiry
 * across spot, with the current spot and each break-even marked. It's the bit
 * that makes "real Black-Scholes options" legible at a glance — defined-risk
 * (flat max loss = premium) with asymmetric upside — vs a flat up/down coin flip.
 *
 * Pure render from @sui-options/pro-options' payoffCurve/breakeven; self-contained.
 */
import { payoffCurve, breakeven } from "@sui-options/pro-options";

export interface PayoffDiagramProps {
  readonly spot: number;
  /** Premium paid (quote currency) for each side. ATM ⇒ call ≈ put. */
  readonly callPremium: number;
  readonly putPremium: number;
}

const W = 240;
const H = 70;
const PAD = 4;

export function PayoffDiagram({ spot, callPremium, putPremium }: PayoffDiagramProps) {
  if (!(spot > 0) || !(callPremium > 0)) return null;

  // Window the spot axis so both break-evens sit comfortably inside the frame.
  const maxPrem = Math.max(callPremium, putPremium);
  const range = Math.max(spot * 0.002, (maxPrem / spot) * 3 * spot);
  const sMin = spot - range;
  const sMax = spot + range;
  const call = payoffCurve("call", spot, callPremium, sMin, sMax, 48);
  const put = payoffCurve("put", spot, putPremium, sMin, sMax, 48);

  const pnls = [...call, ...put].map((p) => p.pnl);
  const pMin = Math.min(...pnls);
  const pMax = Math.max(...pnls);
  const pSpan = Math.max(pMax - pMin, 1e-9);

  const x = (s: number) => PAD + ((s - sMin) / (sMax - sMin)) * (W - 2 * PAD);
  const y = (pnl: number) => PAD + (1 - (pnl - pMin) / pSpan) * (H - 2 * PAD);
  const path = (pts: { spot: number; pnl: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.spot).toFixed(1)},${y(p.pnl).toFixed(1)}`).join(" ");

  const zeroY = y(0);
  const spotX = x(spot);
  const beCall = breakeven("call", spot, callPremium);
  const bePut = breakeven("put", spot, putPremium);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" preserveAspectRatio="none" aria-hidden>
      {/* zero-P&L baseline */}
      <line x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.18)" strokeWidth={0.5} strokeDasharray="2 2" />
      {/* current spot */}
      <line x1={spotX} x2={spotX} y1={PAD} y2={H - PAD} stroke="rgba(255,255,255,0.25)" strokeWidth={0.5} />
      {/* break-even markers */}
      <line x1={x(beCall)} x2={x(beCall)} y1={zeroY - 3} y2={zeroY + 3} stroke="rgb(16,185,129)" strokeWidth={1} />
      <line x1={x(bePut)} x2={x(bePut)} y1={zeroY - 3} y2={zeroY + 3} stroke="rgb(244,63,94)" strokeWidth={1} />
      {/* PUT then CALL payoff */}
      <path d={path(put)} fill="none" stroke="rgb(244,63,94)" strokeWidth={1.5} />
      <path d={path(call)} fill="none" stroke="rgb(16,185,129)" strokeWidth={1.5} />
    </svg>
  );
}

export default PayoffDiagram;
