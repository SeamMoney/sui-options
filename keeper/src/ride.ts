// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// Ride cranking. The Move-side `crank_expired_ride<C>` is permissionless
// and pays the caller a 50bps bounty — but it ABORTS if:
//   - the ride is already closed, or
//   - the path touched DURING the ride window (`po::touched_during`), or
//   - the vault treasury can't cover refund + bounty.
//
// On the spec-gap side: RidePosition is `key, store` and lives in the
// USER's account by default. Sui RPC `getOwnedObjects` only returns
// non-shared objects per address — so a full "find all open rides"
// scanner needs a side-indexer. For v1 this module exposes:
//
//   - `findRidesOwnedBy(client, owner)`: enumerate one address's rides
//     (useful for bots or whitelisted accounts).
//   - `RideRecord` shape: callers can also pass in known ride IDs from
//     elsewhere (events, sidecar file).
//
// We do NOT try to enumerate "all rides on chain" in v1.

import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { Config } from "./config.js";
import { addCrankExpiredRide } from "./abi.js";

export interface RideRecord {
  id: string;
  user: string;
  marketId: string;
  pathId: string;
  capsId: string;
  startTimeMs: number;
  /// Path's expiry_ms. Required to decide "is it past expiry?". The Move
  /// crank also reads `po::expiry_ms(path)` itself, so this is a hint.
  expiryMs: number;
  /// Did the path touch between [start, expiry]? If true, the keeper MUST
  /// skip — the user must self-close.
  touched: boolean;
  /// Treasury value — must be ≥ refund + bounty for crank to land.
  /// Optional: if undefined, we attempt the crank anyway.
  treasuryValue?: bigint;
  collateralType: string;
}

/// Best-effort enumerator: list RidePositions owned by one address. v1
/// helper for tests / whitelisted users. Production needs a side-table
/// (event indexer) — see header comment.
export async function findRidesOwnedBy(
  client: SuiJsonRpcClient,
  cfg: Config,
  owner: string,
): Promise<{ id: string; raw: unknown }[]> {
  const typeFilter = `${cfg.packageId}::ride_position::RidePosition`;
  const out: { id: string; raw: unknown }[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.getOwnedObjects({
      owner,
      filter: { StructType: typeFilter },
      options: { showContent: true, showType: true },
      cursor,
    });
    for (const o of page.data ?? []) {
      const id = o?.data?.objectId;
      if (id) out.push({ id, raw: o.data?.content });
    }
    cursor = page.hasNextPage ? page.nextCursor ?? null : null;
  } while (cursor);
  return out;
}

/// Build a one-call PTB for cranking one expired ride. Caller is
/// responsible for `tx.setGasBudget` and signing/sending.
export function buildCrankRideTx(
  cfg: Config,
  sender: string,
  ride: RideRecord,
): Transaction {
  const tx = new Transaction();
  if (!cfg.usdPriceOracleId || !cfg.wickTokenStateId || !cfg.stakingPoolId) {
    throw new Error(
      "ride crank needs WICK_KEEPER_USD_PRICE_ORACLE, " +
        "WICK_KEEPER_WICK_STATE, WICK_KEEPER_STAKING_POOL in env or manifest",
    );
  }
  if (!cfg.vaultId) {
    throw new Error("ride crank needs WICK_KEEPER_VAULT (vault_sui) in env or manifest");
  }
  addCrankExpiredRide(
    tx,
    {
      packageId: cfg.packageId,
      collateralType: ride.collateralType || cfg.collateralType,
      rideId: ride.id,
      capsId: ride.capsId,
      pathId: ride.pathId,
      vaultId: cfg.vaultId,
      usdPriceOracleId: cfg.usdPriceOracleId,
      wickTokenStateId: cfg.wickTokenStateId,
      stakingPoolId: cfg.stakingPoolId,
    },
    sender,
  );
  tx.setGasBudget(cfg.gasBudgetCrank);
  return tx;
}

/// Decide if a ride is crankable right now. Returns the reason to skip if
/// not. Caller uses this to log + skip without RPC roundtrips.
export function rideCrankability(
  ride: RideRecord,
  nowMs: number,
): { ok: true } | { ok: false; reason: string } {
  if (nowMs < ride.expiryMs) {
    return { ok: false, reason: `not yet expired (${ride.expiryMs - nowMs}ms left)` };
  }
  if (ride.touched) {
    return {
      ok: false,
      reason: "path touched during window; user must self-close",
    };
  }
  return { ok: true };
}
