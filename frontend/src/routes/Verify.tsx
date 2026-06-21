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
            <ReplayTable rows={outcome.rows} />
            <footer className="mt-6 text-xs text-slate-500 leading-relaxed">
              The same replay verifies any real closed ride from on-chain data:
              <pre className="mt-2 overflow-x-auto rounded bg-[#0d0f13] border border-slate-800 p-3 text-slate-300">
                npx tsx scripts/verify.ts --market &lt;id&gt; --ride &lt;id&gt;
              </pre>
            </footer>
          </>
        )}
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
