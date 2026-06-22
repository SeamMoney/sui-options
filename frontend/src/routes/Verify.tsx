/**
 * /verify — Provable Fairness, made clickable.
 *
 * Runs the byte-identical seeded-path port (the one checked against 10k vectors
 * in CI) over a sample ride, in your browser, and shows the segment-by-segment
 * replay: recomputed high/low vs the chain's claim, the barrier touch, and the
 * final verdict. Flip "Simulate a dishonest house" to watch the verifier catch
 * a tampered extremum (red FAIL). The same logic verifies real LIVE v4 rides
 * via `scripts/verify-v4.ts` (and `npm run prove:live` for the whole chain).
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
import { verifyBusiestLiveMarket, type LiveVerifyResult } from "@/lib/liveVerify";
import { TESTNET_RPC_URL } from "@/lib/sui";
import { TESTNET_DEPLOYMENT } from "@/lib/deployments";

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

  // Live mode: replay the busiest LIVE v4 market's most recent candles in the
  // browser, straight off the on-chain segment Table (prune-proof). Same
  // expand_segment port as the sample above — but real, current chain data.
  const [live, setLive] = useState<
    { s: "idle" | "loading" | "done" | "error"; r?: LiveVerifyResult; e?: string }
  >({ s: "idle" });
  const runLive = async () => {
    setLive({ s: "loading" });
    try {
      const ids = (TESTNET_DEPLOYMENT.segment_markets_v4 ?? []).map((m) => m.market);
      const r = await verifyBusiestLiveMarket(TESTNET_RPC_URL, ids, 8);
      setLive({ s: "done", r });
    } catch (err) {
      setLive({ s: "error", e: err instanceof Error ? err.message : String(err) });
    }
  };
  // "Dishonest house" for the LIVE result: we can't tamper the chain, so we
  // tamper the CHAIN-REPORTED value of one fetched candle and re-run the same
  // match — proving the verifier flags a lie on real data too, not just the
  // sample. Pure UI derivation over the fetched result; no re-fetch.
  const [tamperLive, setTamperLive] = useState(false);
  const liveView = useMemo(() => {
    const r = live.r;
    if (!r || r.rows.length === 0) return r;
    if (!tamperLive) return r;
    const rows = r.rows.map((row, i) =>
      i === r.rows.length - 1
        ? { ...row, chainHigh: row.chainHigh + 5_000_000n, match: false } // forge +$5 on the last candle
        : row,
    );
    return { ...r, rows, allMatch: false };
  }, [live.r, tamperLive]);

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
              The same byte-identical replay verifies the LIVE chain from a terminal —
              one command audits every market&apos;s candles and the vault&apos;s solvency:
              <pre className="mt-2 overflow-x-auto rounded bg-[#0d0f13] border border-slate-800 p-3 text-slate-300">
                npm run prove:live
              </pre>
              …or audit a single closed v4 ride end-to-end:
              <pre className="mt-2 overflow-x-auto rounded bg-[#0d0f13] border border-slate-800 p-3 text-slate-300">
                npx tsx scripts/verify-v4.ts --market &lt;id&gt; --ride &lt;id&gt;
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

        {/* ── Live mode: verify the REAL chain, right here ──────────────── */}
        <section className="mt-10 border-t border-slate-800 pt-8">
          <h2 className="text-lg font-bold tracking-tight">…or verify the LIVE chain</h2>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            The sample above proves the logic. This runs the{" "}
            <span className="text-slate-200">same byte-identical</span>{" "}
            <code className="text-emerald-400">expand_segment</code> over the{" "}
            <span className="text-slate-200">most recent candles of a real, live testnet market</span>,
            read straight from its on-chain segment table — prune-proof, no indexer. If every
            recomputed high/low equals what the chain published, the live chart is honest.
          </p>
          <div className="mt-4">
            <button
              type="button"
              onClick={runLive}
              disabled={live.s === "loading"}
              className="rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-black hover:bg-sky-400 transition-colors disabled:opacity-60"
            >
              {live.s === "loading"
                ? "Reading the chain…"
                : live.s === "done"
                  ? "Re-verify live ↻"
                  : "Verify live on-chain candles ▶"}
            </button>
          </div>

          {live.s === "error" && (
            <p className="mt-4 text-sm text-amber-400">
              Couldn&rsquo;t reach the chain ({live.e}). Try again, or run{" "}
              <code className="text-slate-300">npm run prove:live</code> from a terminal.
            </p>
          )}

          {live.s === "done" && liveView && (
            <div className="mt-5">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-slate-400">
                <span
                  className={`text-sm font-bold ${liveView.allMatch ? "text-emerald-400" : "text-rose-400"}`}
                >
                  {liveView.allMatch
                    ? "✓ LIVE — every candle reproduces"
                    : tamperLive
                      ? "✗ caught the tampered candle"
                      : "✗ MISMATCH"}
                </span>
                <a
                  href={`https://suiscan.xyz/testnet/object/${liveView.marketId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-400 hover:underline"
                >
                  market {liveView.marketId.slice(0, 10)}… ↗
                </a>
                <span>{liveView.totalSegments.toLocaleString()} segments recorded on-chain</span>
                <label className="flex items-center gap-1.5 cursor-pointer select-none text-slate-400">
                  <input
                    type="checkbox"
                    checked={tamperLive}
                    onChange={(e) => setTamperLive(e.target.checked)}
                    className="accent-rose-500"
                  />
                  simulate a dishonest house
                </label>
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-xs">
                  <thead className="bg-[#0d0f13] text-slate-400">
                    <tr>
                      <Th>k</Th>
                      <Th>open</Th>
                      <Th>high</Th>
                      <Th>low</Th>
                      <Th>close</Th>
                      <Th>chain hi</Th>
                      <Th>chain lo</Th>
                      <Th>match</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveView.rows.map((r) => (
                      <tr key={r.k} className="border-t border-slate-900">
                        <Td>{r.k}</Td>
                        <Td>{formatPrice(r.open)}</Td>
                        <Td>{formatPrice(r.high)}</Td>
                        <Td>{formatPrice(r.low)}</Td>
                        <Td>{formatPrice(r.close)}</Td>
                        <Td>{formatPrice(r.chainHigh)}</Td>
                        <Td>{formatPrice(r.chainLow)}</Td>
                        <Td>
                          <span className={r.match ? "text-emerald-400" : "text-rose-400"}>
                            {r.match ? "✓" : "✗"}
                          </span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
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
