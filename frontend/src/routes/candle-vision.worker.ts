/**
 * Candle-vision detection worker.
 *
 * Runs the expensive part of the scan — `detectUnifiedCandlePatterns` (70+
 * candlestick / structure / TA detectors) — off the main thread so the
 * streaming chart never waits on it. The main thread keeps the cheap
 * post-processing (ranking, diverse selection, trade decision) and falls back
 * to a synchronous scan if this worker fails to initialize.
 *
 * Message in:  { candles, options }
 * Message out: { detected }
 */
import {
  detectUnifiedCandlePatterns,
  type CandleInput,
  type CandlePatternEvent,
} from "@sui-options/candle-vision";

type DetectOptions = Parameters<typeof detectUnifiedCandlePatterns>[1];
type ScanRequest = { candles: CandleInput[]; options: DetectOptions };
type ScanResponse = { detected: CandlePatternEvent[] };

// Typed as Worker (not the webworker lib) so this compiles under the app's DOM
// tsconfig without extra lib config.
const ctx = self as unknown as Worker;

ctx.onmessage = (event: MessageEvent<ScanRequest>) => {
  const { candles, options } = event.data;
  const detected = detectUnifiedCandlePatterns(candles, options);
  ctx.postMessage({ detected } satisfies ScanResponse);
};
