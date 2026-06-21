/**
 * A self-contained sample ride for the in-app verifier — no wallet, no testnet,
 * no network. It is byte-for-byte the same fixture `scripts/verify.ts` replays
 * in its `--rpc mock://synthetic` mode, so the in-app PASS table matches the
 * documented CLI output line for line.
 *
 * The chain-reported extrema (`chainMin`/`chainMax`) below were produced by
 * running `@wick/sdk`'s `expandSegment` over the three segment keys; the
 * verifier recomputes them in your browser and confirms they match. The tamper
 * mode perturbs one reported extremum so you can watch the verifier catch a
 * dishonest house (red FAIL).
 */
import { SETTLEMENT_TOUCH_WIN } from "@wick/sdk";
import type { ChainSegment, VerifyConfig } from "./verifyReplay";

const HOME = 1_000_000_000n; // 1000.00
const VOL_REGIME_INIT = 1_000_000n;

/** The CLI fixture's key derivation: out[i] = (seed + i*17) & 0xff. */
function bytes32(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) out[i] = (seed + i * 17) & 0xff;
  return out;
}

/** Honest chain-reported extrema for keys bytes32(1..3) starting from HOME. */
const HONEST_SEGMENTS: ChainSegment[] = [
  { k: 0, key: bytes32(1), chainMin: 989_817_708n, chainMax: 1_023_869_425n },
  { k: 1, key: bytes32(2), chainMin: 1_001_460_019n, chainMax: 1_028_497_170n },
  { k: 2, key: bytes32(3), chainMin: 1_017_028_905n, chainMax: 1_074_056_187n },
];

export const SYNTHETIC_META = {
  market: "0x…demo-market (synthetic)",
  ride: "0x…demo-ride (synthetic)",
  barrierLabel: "1000.00 upper",
  description:
    "A touch ride that wicked above its barrier. Replays in your browser from the on-chain segment keys.",
};

/**
 * Build the synthetic verify config. With `tamper: true`, segment 2's reported
 * low is nudged up so it no longer matches the recomputed extremum — i.e. a
 * house that lied about how low price went. The verifier flips to FAIL.
 */
export function buildSyntheticConfig(opts?: { tamper?: boolean }): VerifyConfig {
  const segments = HONEST_SEGMENTS.map((s) => ({ ...s }));
  if (opts?.tamper) {
    // Pretend the house under-reported the wick on the final segment.
    segments[2] = { ...segments[2]!, chainMin: segments[2]!.chainMin + 4_000_000n };
  }
  return {
    homePrice: HOME,
    volRegimeInit: VOL_REGIME_INIT,
    barrierPrice: HOME, // upper barrier sits at home for the demo
    barrierUpper: true,
    deadbandBps: 0n,
    entrySegmentIndex: 0,
    scanEndExclusive: 3,
    rideRoundEnd: 6,
    segments,
    onchainSettlementKind: SETTLEMENT_TOUCH_WIN,
  };
}
