/**
 * /verify — Provable Fairness, made clickable.
 *
 * Runs the byte-identical seeded-path port (the one checked against 10k vectors
 * in CI) over a sample ride, in your browser, and shows the segment-by-segment
 * replay: recomputed high/low vs the chain's claim, the barrier touch, and the
 * final verdict. Flip "Simulate a dishonest house" to watch the verifier catch
 * a tampered extremum (red FAIL). The same logic verifies real rides via
 * `npx tsx scripts/verify.ts`.
 */
import { useMemo, useState } from "react";
import {
  SETTLEMENT_NAME,
} from "@wick/sdk";
import {
  formatPrice,
  runVerification,
  type VerifyRow,
} from "@/lib/verifyReplay";
import { buildSyntheticConfig, SYNTHETIC_META } from "@/lib/verifyFixture";

function settlementName(kind: number): string {
  return (SETTLEMENT_NAME as Record<number, string>)[kind] ?? `kind ${kind}`;
}

export function Verify() {
  const [tamper, setTamper] = useState(false);
  const [ran, setRan] = useState(false);

  const outcome = useMemo(
    () => runVerification(buildSyntheticConfig({ tamper })),
    [tamper],
  );

  return (
    <div className="min-h-full bg-[#0a0b0e] text-slate-100 font-mono">
      <div className="max-w-4xl mx-auto px-5 py-10">
        <header className="mb-8">
          <a
            href="/"
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            ← back to Wick
          </a>
          <h1 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight">
            Provable Fairness
          </h1>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            Every candle Wick paints is derived from a 32-byte{" "}
            <code className="text-emerald-400">sui::random::Random</code> draw
            committed on-chain. Fairness isn&rsquo;t a promise — it&rsquo;s a
            function call. This page runs the{" "}
            <span className="text-slate-200">exact TypeScript port</span> of the
            on-chain <code className="text-emerald-400">expand_segment</code>{" "}
            (checked against 10k vectors in CI) over a sample ride, right here in
            your browser, and confirms the house never cheated.
          </p>
        </header>

        <section className="mb-6 rounded-lg border border-slate-800 bg-[#0d0f13] p-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <Field label="market" value={SYNTHETIC_META.market} />
            <Field label="ride" value={SYNTHETIC_META.ride} />
            <Field label="barrier" value={SYNTHETIC_META.barrierLabel} />
            <Field label="chain verdict" value={settlementName(outcome.onchainKind)} />
          </div>
          <p className="mt-3 text-xs text-slate-500">{SYNTHETIC_META.description}</p>
        </section>

        <div className="mb-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setRan(true)}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-black hover:bg-emerald-400 transition-colors"
          >
            {ran ? "Re-run verification" : "Run verification ▶"}
          </button>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={tamper}
              onChange={(e) => {
                setTamper(e.target.checked);
                setRan(true);
              }}
              className="accent-rose-500"
            />
            Simulate a dishonest house (tamper with one reported low)
          </label>
        </div>

        {ran && (
          <>
            <Verdict pass={outcome.pass} outcome={outcome} />
            <VerifyChart rows={outcome.rows} />
            <ReplayTable rows={outcome.rows} />
            <footer className="mt-6 text-xs text-slate-500 leading-relaxed">
              The same replay verifies any real closed ride from on-chain data:
              <pre className="mt-2 overflow-x-auto rounded bg-[#0d0f13] border border-slate-800 p-3 text-slate-300">
                npx tsx scripts/verify.ts --market &lt;id&gt; --ride &lt;id&gt;
              </pre>
              <p className="mt-4">
                This page proves the <b className="text-slate-300">provably-fair synthetic mode</b>.
                The live{" "}
                <a href="/pro" className="text-emerald-400 hover:underline">
                  Wick Pro
                </a>{" "}
                options price off something even simpler to trust — the{" "}
                <b className="text-slate-300">real DeepBook on-chain order book</b> itself. Open the
                pool on Suiscan from <code className="text-slate-300">/pro</code> (tap the pair) to
                see its live book.
              </p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The replay as a candle chart: each segment's candle (body = open/close,
 * wick = the chain's REPORTED high/low), the barrier line, and — when the
 * house lied — the mismatched candle boxed in amber. The proof, visual: you
 * see the candles the chain claimed and exactly which one doesn't add up.
 */
function VerifyChart({ rows }: { rows: VerifyRow[] }) {
  if (rows.length === 0) return null;
  const W = 200;
  const H = 80;
  const n = rows.length;
  const num = (b: bigint) => Number(b);
  const barrier = num(rows[0]!.barrier);
  const highs = rows.map((r) => num(r.chainHigh));
  const lows = rows.map((r) => num(r.chainLow));
  const top = Math.max(...highs, barrier);
  const bot = Math.min(...lows, barrier);
  const span = Math.max(1, top - bot);
  const hi = top + span * 0.08;
  const lo = bot - span * 0.08;
  const range = hi - lo;
  const y = (v: number) => ((hi - v) / range) * H;
  const cw = W / n;
  const bw = Math.max(1.4, cw * 0.55);
  // Which side of the barrier did price reach? Shade that "touch zone" so the
  // win condition reads at a glance (self-determined from the data, no
  // hardcoded barrier direction).
  const touchedAbove = highs.some((h) => h > barrier);
  const touchedBelow = lows.some((l) => l < barrier);

  return (
    <div className="mb-4 rounded-lg border border-slate-800 bg-[#0d0f13] p-3">
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
        <span>replay · chain-reported candles</span>
        <span className="text-amber-400/80">— barrier</span>
      </div>
      <div className="h-[180px] w-full">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
          {touchedAbove && (
            <rect x={0} y={0} width={W} height={y(barrier)} fill="#22c55e" opacity={0.05} />
          )}
          {touchedBelow && (
            <rect x={0} y={y(barrier)} width={W} height={H - y(barrier)} fill="#22c55e" opacity={0.05} />
          )}
          <line
            x1={0}
            x2={W}
            y1={y(barrier)}
            y2={y(barrier)}
            stroke="#f59e0b"
            strokeWidth={0.5}
            strokeDasharray="2 2"
            opacity={0.7}
            vectorEffect="non-scaling-stroke"
          />
          {rows.map((r, i) => {
            const x = i * cw + cw / 2;
            const o = num(r.open);
            const c = num(r.close);
            const up = c >= o;
            const color = up ? "#22c55e" : "#f43f5e";
            const oy = y(o);
            const cy = y(c);
            return (
              <g key={r.k}>
                {!r.extremaMatch && (
                  <rect x={x - cw / 2} y={0} width={cw} height={H} fill="#f59e0b" opacity={0.18} />
                )}
                <line
                  x1={x}
                  x2={x}
                  y1={y(num(r.chainHigh))}
                  y2={y(num(r.chainLow))}
                  stroke={r.extremaMatch ? color : "#f59e0b"}
                  strokeWidth={0.6}
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  x={x - bw / 2}
                  y={Math.min(oy, cy)}
                  width={bw}
                  height={Math.max(0.5, Math.abs(cy - oy))}
                  fill={color}
                />
                {/* Where the chain misreported an extreme, mark our recomputed
                    TRUTH in cyan — the gap from the amber wick is the lie. */}
                {!r.extremaMatch &&
                  [
                    num(r.chainHigh) !== num(r.high) ? num(r.high) : null,
                    num(r.chainLow) !== num(r.low) ? num(r.low) : null,
                  ]
                    .filter((v): v is number => v != null)
                    .map((v, mi) => (
                      <line
                        key={mi}
                        x1={x - bw}
                        x2={x + bw}
                        y1={y(v)}
                        y2={y(v)}
                        stroke="#22d3ee"
                        strokeWidth={0.7}
                        strokeDasharray="1 0.8"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-500 shrink-0">{label}:</span>
      <span className="text-slate-200 truncate">{value}</span>
    </div>
  );
}

function Verdict({
  pass,
  outcome,
}: {
  pass: boolean;
  outcome: ReturnType<typeof runVerification>;
}) {
  return (
    <div
      className={`mb-5 rounded-lg border p-4 ${
        pass
          ? "border-emerald-700 bg-emerald-950/40"
          : "border-rose-700 bg-rose-950/40"
      }`}
    >
      <div
        className={`text-lg font-bold ${pass ? "text-emerald-400" : "text-rose-400"}`}
      >
        {pass ? "✓ PASS — fair" : "✗ FAIL — the chain lied"}
      </div>
      <ul className="mt-2 space-y-1 text-xs text-slate-300">
        <li>
          extrema replay:{" "}
          <span className={outcome.allExtremaMatch ? "text-emerald-400" : "text-rose-400"}>
            {outcome.allExtremaMatch ? "every segment matches" : "MISMATCH found"}
          </span>
        </li>
        <li>
          off-chain verdict:{" "}
          <span className="text-slate-200">{settlementName(outcome.offchainKind)}</span>{" "}
          vs on-chain{" "}
          <span className="text-slate-200">{settlementName(outcome.onchainKind)}</span>{" "}
          <span className={outcome.verdictMatch ? "text-emerald-400" : "text-rose-400"}>
            {outcome.verdictMatch ? "(match)" : "(mismatch)"}
          </span>
        </li>
      </ul>
    </div>
  );
}

function ReplayTable({ rows }: { rows: VerifyRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="bg-[#0d0f13] text-slate-500">
            <Th>k</Th>
            <Th>open</Th>
            <Th>high</Th>
            <Th>low</Th>
            <Th>close</Th>
            <Th>chain high</Th>
            <Th>chain low</Th>
            <Th>barrier</Th>
            <Th>touch</Th>
            <Th>match</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k} className="border-t border-slate-900">
              <Td>{r.k}</Td>
              <Td>{formatPrice(r.open)}</Td>
              <Td>{formatPrice(r.high)}</Td>
              <Td>{formatPrice(r.low)}</Td>
              <Td>{formatPrice(r.close)}</Td>
              <Td>{formatPrice(r.chainHigh)}</Td>
              <Td>{formatPrice(r.chainLow)}</Td>
              <Td>{formatPrice(r.barrier)}</Td>
              <Td>
                <span className={r.touched ? "text-emerald-400" : "text-slate-600"}>
                  {r.touched ? "yes" : "—"}
                </span>
              </Td>
              <Td>
                <span className={r.extremaMatch ? "text-emerald-400" : "text-rose-400"}>
                  {r.extremaMatch ? "✓" : "✗"}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-right font-medium first:text-left">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-1.5 text-right text-slate-300 first:text-left">{children}</td>;
}
