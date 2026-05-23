/**
 * RoundCountdown — open-window timer + round timer + "ROUND N LIVE".
 *
 * Doc 19 §7: every round is 75 segments (30 s) and the first 13 segments
 * (~5.2 s) are the OPEN WINDOW — barriers are interactive. After that the
 * barriers lock; rides already open keep running until round end.
 *
 * The component reads the round's start segment + the live `nextSegmentIndex`
 * and renders a two-bar countdown:
 *   - OPEN WINDOW (amber) — only visible while inside it
 *   - ROUND       (white) — always visible, fills as segments record
 *
 * Self-ticking so the bars stay smooth between segment arrivals — at
 * ~16ms / frame we interpolate against an estimated segment cadence,
 * then snap to the exact value whenever a new segment lands.
 */
import { useEffect, useState } from "react";

const DEFAULT_SEGMENT_MS = 400;

interface RoundCountdownProps {
  /** Round number — "ROUND 17 LIVE". */
  readonly roundIndex: bigint | null;
  /** First segment_k bound to this round. */
  readonly startedAtSegment: bigint | null;
  /** Live segment index — comes from useSegmentRide. */
  readonly nextSegmentIndex: bigint;
  /** Round duration in segments (75 = 30 s). */
  readonly roundDurationSegments: number;
  /** Open-window length in segments (13 ≈ 5.2 s). */
  readonly openWindowSegments: number;
  /** Approximate segment cadence (ms) — for smooth between-segment fill. */
  readonly segmentMs?: number;
}

export function RoundCountdown(props: RoundCountdownProps) {
  const {
    roundIndex,
    startedAtSegment,
    nextSegmentIndex,
    roundDurationSegments,
    openWindowSegments,
    segmentMs = DEFAULT_SEGMENT_MS,
  } = props;

  // Tick a local clock every animation frame so the bars stay smooth
  // between segment arrivals. The "real" value snaps in via props
  // whenever the next SegmentRecorded event lands.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setTick((t) => t + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (roundIndex === null || startedAtSegment === null) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
        Waiting for round…
      </div>
    );
  }

  // segmentsIntoRound — integer count of fully-recorded segments past the
  // round's start. nextSegmentIndex is the *next* not-yet-recorded segment,
  // so the count of *recorded* segments is (nextSegmentIndex - startedAtSegment).
  const segmentsIntoRoundI = Number(nextSegmentIndex - startedAtSegment);
  // Continuous (fractional) — for smooth bar fill between arrivals.
  const segmentsIntoRound = Math.max(
    0,
    Math.min(roundDurationSegments, segmentsIntoRoundI + (tick % 32) / 32),
  );

  const roundProgress = segmentsIntoRound / roundDurationSegments;
  const inWindow = segmentsIntoRound < openWindowSegments;
  const windowProgress = inWindow
    ? segmentsIntoRound / openWindowSegments
    : 1;

  const roundSecRemaining = Math.max(
    0,
    ((roundDurationSegments - segmentsIntoRound) * segmentMs) / 1000,
  );
  const windowSecRemaining = inWindow
    ? Math.max(0, ((openWindowSegments - segmentsIntoRound) * segmentMs) / 1000)
    : 0;

  return (
    <div className="glass-container px-3 py-2 rounded-lg font-mono pointer-events-none select-none">
      <div className="glass-filter" />
      <div className="glass-overlay" />
      <div className="glass-specular" />
      <div className="relative z-10 leading-tight">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="text-[9px] uppercase tracking-[0.18em] text-white/45">
            Round
          </div>
          <div className="text-xs font-semibold tabular-nums text-white">
            #{roundIndex.toString()}
          </div>
          {inWindow ? (
            <span className="text-[9px] uppercase tracking-[0.18em] text-amber-300 motion-safe:animate-pulse">
              · OPEN · pick a barrier
            </span>
          ) : (
            <span className="text-[9px] uppercase tracking-[0.18em] text-emerald-400/85">
              · LIVE
            </span>
          )}
        </div>

        {/* Open-window bar (shown only while open) */}
        {inWindow && (
          <div className="mb-1.5">
            <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.14em] text-amber-300/70 mb-0.5">
              <span>open</span>
              <span className="tabular-nums">
                {windowSecRemaining.toFixed(1)}s
              </span>
            </div>
            <div className="h-1 w-32 rounded-full bg-amber-300/10 overflow-hidden">
              <div
                className="h-full bg-amber-300/80"
                style={{ width: `${Math.min(100, windowProgress * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Round bar */}
        <div>
          <div className="flex items-center justify-between text-[9px] uppercase tracking-[0.14em] text-white/45 mb-0.5">
            <span>round</span>
            <span className="tabular-nums">{roundSecRemaining.toFixed(1)}s</span>
          </div>
          <div className="h-1 w-32 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-white/65"
              style={{ width: `${Math.min(100, roundProgress * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default RoundCountdown;
