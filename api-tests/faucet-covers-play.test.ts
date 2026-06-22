/**
 * Invariant: the faucet must drip enough for a judge to actually PLAY a /ride.
 *
 * Two real, demo-breaking lockouts were shipped and fixed this cycle, both
 * because a faucet drip silently fell below what a ride costs:
 *   - #373 (TUSD): /ride's funding gate (Ride.tsx escrowThresholdRaw) blocks
 *     play until the burner holds a full ride's escrow = max_stake_per_segment
 *     × round_duration × 1.1. The TUSD faucet dripped 10 TUSD but the gate
 *     wanted 12.375 → the "Get free funds" overlay never cleared, /ride was
 *     unplayable. Fixed by minting 50 TUSD.
 *   - #284 (SUI): the player's browser cranks each held segment (~9M MIST
 *     each); a full hold-for-touch ride (~75 segments) burns ~0.7 SUI. The
 *     faucet dripped 0.2 SUI → the ride stalled mid-hold. Fixed at 2 SUI.
 *
 * These asserts pin both drips against the LIVE market's own params, so if
 * someone lowers a faucet OR raises max_stake / round_duration, CI fails here
 * instead of a judge hitting a dead onboarding screen. Pure + offline: reads
 * deployments/testnet.json and the faucet constants, no network, no key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DRIP_RAW as TUSD_DRIP } from "../api/faucet-tusd.js";
import { DRIP_MIST as SUI_DRIP } from "../api/faucet.js";

const here = dirname(fileURLToPath(import.meta.url));
const deployment = JSON.parse(
  readFileSync(join(here, "..", "deployments", "testnet.json"), "utf8"),
);

// The live /ride game uses the latest v4 market (see Ride.tsx pickSegmentMarketV4).
const market = deployment.segment_markets_v4.at(-1);

test("TUSD faucet drip clears the /ride escrow funding gate", () => {
  // Mirror Ride.tsx escrowThresholdRaw: MAX stake × round × 1.1 (useSegmentRideV4
  // stakes at max_stake_per_segment since v4.30, so that's the real escrow).
  const maxStake = BigInt(
    market.max_stake_per_segment ?? market.min_stake_per_segment ?? 10_000,
  );
  const round = BigInt(market.round_duration_segments ?? 75);
  const escrowGate = (maxStake * round * 11n) / 10n;

  assert.ok(
    TUSD_DRIP >= escrowGate,
    `TUSD faucet drips ${TUSD_DRIP} raw but a ride's escrow gate needs ${escrowGate} ` +
      `(max_stake ${maxStake} × round ${round} × 1.1). A judge would fund below the ` +
      `gate and be unable to start a ride. Raise DRIP_RAW in api/faucet-tusd.ts.`,
  );
});

test("SUI faucet drip covers a full hold-for-touch ride's cranking gas", () => {
  // The browser cranks each held segment client-side; a measured record_segment_v4
  // costs ~9M MIST. A full hold is round_duration segments + open + close.
  const round = BigInt(market.round_duration_segments ?? 75);
  const GAS_PER_CRANK_MIST = 9_000_000n; // measured on testnet (#284)
  const fullRideGas = round * GAS_PER_CRANK_MIST + 20_000_000n; // + open/close headroom

  assert.ok(
    SUI_DRIP >= fullRideGas,
    `SUI faucet drips ${SUI_DRIP} MIST but a full ${round}-segment hold needs ~${fullRideGas} ` +
      `(${round} cranks × ~9M + open/close). A judge would run out of gas mid-ride. ` +
      `Raise DRIP_MIST in api/faucet.ts.`,
  );
});
