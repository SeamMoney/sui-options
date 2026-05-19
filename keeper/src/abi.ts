// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// PTB builders for the post-C.3 ABI. Every entrypoint the keeper calls
// lives here so the loop stays declarative.

import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";

export const SUI_CLOCK = SUI_CLOCK_OBJECT_ID;

export interface PackageRef {
  packageId: string;
}

// ---------- random_walk_driver ----------

/// `tick(rw, oracle, clock, ctx)` — advances PRNG and writes an observation.
export interface RandomWalkTickArgs extends PackageRef {
  randomWalkId: string;
  oracleId: string;
}

export function addRandomWalkTick(tx: Transaction, a: RandomWalkTickArgs) {
  tx.moveCall({
    target: `${a.packageId}::random_walk_driver::tick`,
    arguments: [
      tx.object(a.randomWalkId),
      tx.object(a.oracleId),
      tx.object(SUI_CLOCK),
    ],
  });
}

// ---------- path_observation ----------

/// `record(po, oracle, clock)` — ingest the latest oracle observation.
export interface PathRecordArgs extends PackageRef {
  pathId: string;
  oracleId: string;
}

export function addPathRecord(tx: Transaction, a: PathRecordArgs) {
  tx.moveCall({
    target: `${a.packageId}::path_observation::record`,
    arguments: [
      tx.object(a.pathId),
      tx.object(a.oracleId),
      tx.object(SUI_CLOCK),
    ],
  });
}

/// `record_during_drain(po, oracle, clock)` — drain-window ingest for any
/// mempool-delayed pre-expiry observations. Best-effort: aborts cleanly if
/// we're not actually in the drain window.
export function addPathRecordDuringDrain(tx: Transaction, a: PathRecordArgs) {
  tx.moveCall({
    target: `${a.packageId}::path_observation::record_during_drain`,
    arguments: [
      tx.object(a.pathId),
      tx.object(a.oracleId),
      tx.object(SUI_CLOCK),
    ],
  });
}

// ---------- pull_oracle_driver ----------

/// `push_price(feed, oracle, cap, price, ts, attestation, clock, ctx)`.
/// The on-chain function takes the keeper cap as a plain object reference.
export interface PullPushArgs extends PackageRef {
  feedId: string;
  oracleId: string;
  keeperCapId: string;
  /// Scaled price in the oracle's micro-unit (typically 1e6 USD).
  priceScaled: bigint;
  timestampMs: bigint;
  /// Opaque off-chain attestation bytes — recorded for auditability.
  attestation: Uint8Array;
}

export function addPullPush(tx: Transaction, a: PullPushArgs) {
  const attBytes = Array.from(a.attestation);
  tx.moveCall({
    target: `${a.packageId}::pull_oracle_driver::push_price`,
    arguments: [
      tx.object(a.feedId),
      tx.object(a.oracleId),
      tx.object(a.keeperCapId),
      tx.pure.u64(a.priceScaled),
      tx.pure.u64(a.timestampMs),
      tx.pure(bcs.vector(bcs.u8()).serialize(attBytes)),
      tx.object(SUI_CLOCK),
    ],
  });
}

// ---------- wick::lock_and_settle ----------

/// `lock_and_settle<C>(market, vault, path, oracle, registry, clock, ctx)`.
/// Idempotent on the Move side: if market.status != ACTIVE the call returns
/// early without aborting. Safe to retry.
export interface LockAndSettleArgs extends PackageRef {
  collateralType: string;        // e.g. "0x2::sui::SUI"
  marketId: string;
  vaultId: string;
  pathId: string;
  oracleId: string;
  registryId: string;
}

export function addLockAndSettle(tx: Transaction, a: LockAndSettleArgs) {
  tx.moveCall({
    target: `${a.packageId}::wick::lock_and_settle`,
    typeArguments: [a.collateralType],
    arguments: [
      tx.object(a.marketId),
      tx.object(a.vaultId),
      tx.object(a.pathId),
      tx.object(a.oracleId),
      tx.object(a.registryId),
      tx.object(SUI_CLOCK),
    ],
  });
}

// ---------- wick::crank_expired_ride ----------

/// `crank_expired_ride<C>(ride, caps, path, vault, price_oracle,
///                        token_state, staking_pool, clock, ctx) -> Coin<C>`.
/// Returns the bounty coin; we transfer it back to the keeper sender.
export interface CrankExpiredRideArgs extends PackageRef {
  collateralType: string;
  rideId: string;
  capsId: string;          // RideMarketCaps
  pathId: string;
  vaultId: string;
  usdPriceOracleId: string;
  wickTokenStateId: string;
  stakingPoolId: string;
}

export function addCrankExpiredRide(
  tx: Transaction,
  a: CrankExpiredRideArgs,
  sender: string,
) {
  const bounty = tx.moveCall({
    target: `${a.packageId}::wick::crank_expired_ride`,
    typeArguments: [a.collateralType],
    arguments: [
      tx.object(a.rideId),
      tx.object(a.capsId),
      tx.object(a.pathId),
      tx.object(a.vaultId),
      tx.object(a.usdPriceOracleId),
      tx.object(a.wickTokenStateId),
      tx.object(a.stakingPoolId),
      tx.object(SUI_CLOCK),
    ],
  });
  tx.transferObjects([bounty], tx.pure.address(sender));
}
