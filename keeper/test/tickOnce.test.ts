// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// tickOnce is the keeper's core poll-and-crank loop. Every action path iterates
// cfg.arcadeMarkets / cfg.pullMarkets / state.knownRides and only touches the
// chain via runTx, so with nothing to do it must no-op cleanly — never throwing
// and never submitting a tx. That graceful-idle behaviour is what keeps the
// live chart's keeper alive across empty/misconfigured windows, but it was
// untested. Pin the two client-free paths: empty config, and a known-but-not-
// yet-crankable ride (skipped, not force-settled).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { tickOnce } from "../src/keeper.ts";

const signer = Ed25519Keypair.generate();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = {} as any; // must never be touched when there's nothing to do

function mkCfg() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    iterationTimeoutMs: 5_000,
    onlyMarkets: [],
    arcadeMarkets: [],
    pullMarkets: [],
    disableRandomWalkTicks: false,
    disablePullPushes: false,
    disableRideCranks: false,
    collateralType: "0x2::sui::SUI",
  } as any;
}

test("tickOnce no-ops cleanly with no markets and no rides (never touches the client)", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await tickOnce(client, signer, mkCfg(), { knownRides: [] } as any);
  assert.equal(result.actions, 0);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.skippedIdempotent, 0);
  assert.deepEqual(result.events, []);
});

test("tickOnce skips a not-yet-expired known ride without submitting a crank", async () => {
  const ride = { id: "0xr", marketId: "0xm", expiryMs: 99_999_999_999_999, touched: false };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await tickOnce(client, signer, mkCfg(), { knownRides: [ride] } as any);
  assert.equal(result.actions, 0); // skipped → no tx submitted
  assert.equal(result.failed, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skip = result.events.find((e: any) => e.action === "crank-ride");
  assert.ok(skip, "expected a crank-ride skip event");
  assert.equal(skip.msg, "skip");
});
