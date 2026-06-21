/**
 * patterns.ts — pure-TypeScript candlestick pattern detection catalog.
 *
 * Wick Markets' chart consumes this in real time over a sliding window of
 * candles to render highlights, tooltips, and glow effects when one of the
 * 54 named patterns from doc 17 §15.6 forms.
 *
 * The catalog uses the CONTINUOUS / CRYPTO interpretation throughout — i.e.
 * patterns whose textbook definition requires a price *gap* between candles
 * are ported to "next candle opens at or very near the previous close" form.
 * Crypto markets trade 24/7 and rarely produce true gaps; requiring them
 * would mean these predicates almost never fire.
 *
 * All arithmetic uses `bigint` so we never lose u64 precision when fed real
 * on-chain ticks. `strength ∈ [0, 1]` measures how cleanly the pattern fits.
 *
 * Pure functions — no I/O, no clock reads, no mutation.
 *
 * `Candle` is imported from `seededPath.ts` (the canonical source of truth
 * across the SDK). Originally agent-boundary-isolated; merged on integration.
 */
import type { Candle } from "./seededPath.js";
/**
 * String-literal union of every pattern name in the §15.6 catalog. Using a
 * union (rather than an enum) keeps the JSON-serialized form human-readable
 * and stable.
 */
export type Pattern = "Doji" | "Dragonfly Doji" | "Gravestone Doji" | "Long-Legged Doji" | "Rickshaw Man" | "Takuri" | "Hammer" | "Inverted Hammer" | "Hanging Man" | "Shooting Star" | "Marubozu" | "Closing Marubozu" | "Spinning Top" | "High-Wave" | "Long Line" | "Short Line" | "Belt-hold" | "Engulfing" | "Harami" | "Harami Cross" | "Piercing" | "Dark Cloud Cover" | "Counterattack" | "Separating Lines" | "Matching Low" | "Homing Pigeon" | "On-Neck" | "In-Neck" | "Thrusting" | "Doji Star" | "Hikkake" | "Morning Star" | "Evening Star" | "Morning Doji Star" | "Evening Doji Star" | "Three White Soldiers" | "Three Black Crows" | "Identical Three Crows" | "Three Inside Up/Down" | "Three Outside Up/Down" | "Three Stars in the South" | "Tristar" | "Unique Three River" | "Advance Block" | "Stalled Pattern" | "Two Crows" | "Stick Sandwich" | "Three-Line Strike" | "Concealing Baby Swallow" | "Ladder Bottom" | "Mat Hold" | "Rising/Falling Three Methods" | "Breakaway" | "Modified Hikkake";
/**
 * The result of a successful predicate match.
 *
 * `startIndex` and `endIndex` are inclusive indices into the `window` array
 * passed to `detectPatterns` (or to the individual predicate).
 *
 * `strength` is a 0..1 fit score — 1.0 = textbook-perfect, 0.0 = barely
 * matches the threshold. UIs can map this to glow opacity.
 */
export interface PatternMatch {
    name: Pattern;
    matched: true;
    strength: number;
    startIndex: number;
    endIndex: number;
}
export interface PostHocPatternMatch extends PatternMatch {
    label: string;
    candleIndex: number;
}
export declare const isDoji: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isDragonflyDoji: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isGravestoneDoji: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isLongLeggedDoji: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isRickshawMan: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isTakuri: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isHammer: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isInvertedHammer: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isHangingMan: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isShootingStar: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isMarubozu: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isClosingMarubozu: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isSpinningTop: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isHighWave: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isLongLine: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isShortLine: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isBeltHold: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isEngulfing: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isHarami: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isHaramiCross: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isPiercing: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isDarkCloudCover: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isCounterattack: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isSeparatingLines: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isMatchingLow: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isHomingPigeon: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isOnNeck: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isInNeck: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isThrusting: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isDojiStar: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isHikkake: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isMorningStar: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isEveningStar: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isMorningDojiStar: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isEveningDojiStar: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isThreeWhiteSoldiers: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isThreeBlackCrows: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isIdenticalThreeCrows: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isThreeInsideUpDown: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isThreeOutsideUpDown: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isThreeStarsInTheSouth: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isTristar: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isUniqueThreeRiver: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isAdvanceBlock: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isStalledPattern: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isTwoCrows: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isStickSandwich: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isThreeLineStrike: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isConcealingBabySwallow: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isLadderBottom: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isMatHold: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isRisingFallingThreeMethods: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isBreakaway: (window: Candle[], offset: number) => PatternMatch | null;
export declare const isModifiedHikkake: (window: Candle[], offset: number) => PatternMatch | null;
/**
 * Detector entry: predicate + minimum window size it requires.
 *
 * The window-size hint lets `detectPatterns` short-circuit predicates that
 * can't possibly match because they would walk off the start of the array.
 */
interface Detector {
    name: Pattern;
    size: number;
    fn: (window: Candle[], offset: number) => PatternMatch | null;
}
/**
 * The catalog. Ordered roughly by candle-count so the chart's tooltip layer
 * can iterate without further sorting. The order is NOT load-bearing for
 * correctness; predicates are mutually independent.
 */
export declare const DETECTORS: readonly Detector[];
/**
 * Run every predicate over the window and return all matches.
 *
 * Each predicate is invoked at every offset large enough to satisfy its
 * size requirement. The output is the unsorted union of all hits — the UI
 * can group by `endIndex` to render highlights.
 *
 * Pure, deterministic, no side effects.
 *
 * Cost: O(window.length × 54). For a typical 200-candle visible chart that's
 * ~11k evaluations, each O(1). The chart calls this once per new candle and
 * can incrementally append (the matches whose endIndex < newCandle.index - 5
 * are immutable).
 */
export declare const detectPatterns: (window: Candle[]) => PatternMatch[];
/**
 * Convenience: return only the matches that end at `offset` (i.e. fired
 * because of the candle at `offset`). Used by the live tick path.
 */
export declare const detectPatternsAt: (window: Candle[], offset: number) => PatternMatch[];
/**
 * Live detector for the newest candle only.
 *
 * Scans the last N candles, where N is the largest catalog predicate window,
 * and returns any predicates that fired because of the newest candle. Indices
 * are lifted back into the original `candles` array so callers can highlight
 * the matched span directly.
 */
export declare const detectPostHocPattern: (candles: Candle[]) => PostHocPatternMatch[];
export {};
//# sourceMappingURL=patterns.d.ts.map