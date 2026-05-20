// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0

/**
 * Wick Ride — TypeScript wrapper for the streaming-touch ride primitive.
 *
 * Mirrors the `public fun open_ride` / `close_ride` / `crank_expired_ride`
 * entrypoints re-exported by `wick::wick` (which forwards to
 * `wick::ride_position`). Use this from the dApp frontend to build PTBs
 * that open and close rides on Sui testnet.
 *
 * ------------------------------------------------------------------------
 * ABI mapped here (matches `move/sources/wick.move`, lines 230–276):
 *
 *   public fun open_ride<C>(
 *       caps: &mut RideMarketCaps,
 *       path: &PathObservation,
 *       vault: &mut MartingalerVault<C>,
 *       bot_registry: &BotRegistry,
 *       rate_micro_usd_per_sec: u64,
 *       escrow: Coin<C>,
 *       clock: &Clock,
 *       ctx: &mut TxContext,
 *   ): RidePosition
 *
 *   public fun close_ride<C>(
 *       ride: &mut RidePosition,
 *       caps: &mut RideMarketCaps,
 *       path: &PathObservation,
 *       oracle: &WickOracle,
 *       vault: &mut MartingalerVault<C>,
 *       price_oracle: &UsdPriceOracle,
 *       token_state: &mut WickTokenState,
 *       staking_pool: &mut WickStakingPool,
 *       clock: &Clock,
 *       ctx: &mut TxContext,
 *   ): Coin<C>
 *
 * Note: these are `public fun` (not `public entry`), so they return values.
 * The wrapper wires up the returned `RidePosition` / `Coin<C>` via
 * `tx.transferObjects(...)` to the sender — same pattern as `buildBuyTx`
 * in `sdk/src/transactions.ts`.
 *
 * Divergence from the spec interface in the prompt:
 *
 *   - The prompt's `OpenRideParams` / `CloseRideParams` only name the
 *     market-side IDs. The actual Move ABI also needs `&BotRegistry` for
 *     open_ride and `&UsdPriceOracle` + `&mut WickTokenState` +
 *     `&mut WickStakingPool` for close_ride. These extra IDs are added as
 *     additional fields on the params interfaces (named below). They live
 *     in `deployments/testnet.json` at the global keys (`bot_registry`,
 *     `usd_price_oracle`, `wick_token_state`, `wick_staking_pool`) and
 *     are stable across markets.
 *
 *   - The prompt's `RidePositionState` lists `stakePaid`. The on-chain
 *     `RidePosition` struct does NOT store stake_paid — it's derived at
 *     settlement from `stake_rate * elapsed_sec`. We surface a synthetic
 *     `stakePaid` computed against `Date.now()` so polling UIs can show
 *     a live preview without re-implementing the math.
 *
 * ------------------------------------------------------------------------
 * TEST PLAN (hackathon spike — keep gas low, use testnet):
 *
 *   Package ID:     0x81ec682cfa370edad312b6b6b37053552199a7aeab1203bf1bc650f6668cc846
 *   Vault (SUI):    0x59a6ff9c8383855ac11be99ebeca48c62480fe989754339f30b5ba2c18229f2e
 *   BotRegistry:    0x58b2baf812ed18315836a3720ea474e967ddd35b8cbaaeac7f4af41f767e9a18
 *   USD oracle:     0xd113aaa523992f0c13d057b82a7c7f847fb3fa67df1b807f7b4d3df396ba76af
 *   WickStaking:    0x43f90916195fc9bed5131f3c38a439b8ee1a05a91a4e9a60b64888505f0f868c
 *   WickTokenState: 0xcc22b2a651be1c36437f90684cb74258b844b2f96dc5f0d3a41370da0133c663
 *
 *   Arcade markets (from deployments/testnet.json) — RECOMMEND **WICK-RNG-25**
 *   first (the latest of the WICK-RNG-25 cohort and the smallest barrier,
 *   so a random walk is more likely to actually touch during a short test
 *   window):
 *     market: 0x97f7a32279e4677249513b6e2c422388d56bf87875529d99636d03ec308562dc
 *     oracle: 0x1ced9ef2a41d58409e543cb2d0c402bae9be736f68c652670fc74aff48fd762f
 *     path:   0xc73c08a8f947aa9b1c9dcc40ff51201fcb14f204fd0ecdff8af2884b06deff21
 *
 *   BLOCKER (must bootstrap before this wrapper is end-to-end usable on
 *   testnet): `deployments/testnet.json` does NOT yet contain any
 *   `ride_market_caps_*` IDs. `open_ride` takes `caps: &mut RideMarketCaps`,
 *   which is a per-market shared object created via
 *   `wick::ride_market_caps::new<SUI>(&market, &path, ...)` + `share(caps)`.
 *   Until a caps object exists for one of the arcade markets and the ID is
 *   recorded in `deployments/testnet.json`, this wrapper can compile and
 *   be imported, but `buildOpenRideTx` will fail at submit time because
 *   there is no `capsId` to pass. Bootstrapping is a separate task (admin
 *   tx using the publisher key — `ride_market_caps::new` + `share`).
 *
 *   Suggested test escrow: 50_000_000 MIST = 0.05 SUI (~$0.05). Stake rate:
 *   start with the per-market `min_stake_rate_micro_usd_per_sec` once caps
 *   are seeded — read it off the caps object via `getObject`. Expect the
 *   position to drain escrow at that rate; poll `getRidePosition` every
 *   ~1.5s while the user holds the screen.
 *
 *   Successful settlement looks like:
 *     - `closed: true`
 *     - `settlementKind === SETTLEMENT_TOUCH_WIN` (barrier crossed) — payout
 *       coin lands in sender wallet, multiplier_bps × stake_paid / 10_000
 *     - `settlementKind === SETTLEMENT_CASHOUT` (user closed early) — payout
 *       coin ≤ stake_paid (Bachelier factor × stake × (1 - spread))
 *     - `settlementKind === SETTLEMENT_EXPIRED_LOSS` — stake forfeit, only
 *       unused escrow refunded
 *     - `settlementKind === SETTLEMENT_ABORTED_REFUND` — 1:1 escrow refund
 *
 * ------------------------------------------------------------------------
 */

import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

/**
 * Re-export of the codebase's canonical full-RPC client type. `@mysten/sui`
 * v2.x does NOT export a `SuiClient` symbol from `./client` — the analog is
 * `SuiJsonRpcClient` from `./jsonRpc`. We alias it so external call sites
 * that want a "SuiClient"-shaped name can pick it up here.
 */
export type SuiClient = SuiJsonRpcClient;

// ── Settlement-kind enum mirrors `wick::ride_position` constants. ─────────
export const SETTLEMENT_OPEN = 0;
export const SETTLEMENT_TOUCH_WIN = 1;
export const SETTLEMENT_CASHOUT = 2;
export const SETTLEMENT_EXPIRED_LOSS = 3;
export const SETTLEMENT_ABORTED_REFUND = 4;

export function settlementLabel(kind: number): string {
  switch (kind) {
    case SETTLEMENT_OPEN:
      return "OPEN";
    case SETTLEMENT_TOUCH_WIN:
      return "TOUCH_WIN";
    case SETTLEMENT_CASHOUT:
      return "CASHOUT";
    case SETTLEMENT_EXPIRED_LOSS:
      return "EXPIRED_LOSS";
    case SETTLEMENT_ABORTED_REFUND:
      return "ABORTED_REFUND";
    default:
      return `UNKNOWN(${kind})`;
  }
}

// ── Parameter shapes ──────────────────────────────────────────────────────

export interface OpenRideParams {
  marketId: string;
  capsId: string;
  vaultId: string;
  oracleId: string;
  pathId: string;
  /** User-supplied escrow in MIST. The PTB will split this off `tx.gas`. */
  escrowMist: bigint;
  /** Per-second accrual rate in micro-USD. Must be within [min,max] from caps. */
  stakeRateMicroUsdPerSec: bigint;
  /**
   * Required by the Move ABI for open_ride (gates WICK rebates). Optional
   * here so call sites built against the spec interface still compile;
   * `buildOpenRideTx` will throw a clear error at PTB-build time if missing.
   * Live ID lives at `deployments/testnet.json#bot_registry`.
   */
  botRegistryId?: string;
  /** Collateral type-tag, e.g. "0x2::sui::SUI". Defaults to SUI. */
  collateralType?: string;
}

export interface CloseRideParams {
  marketId: string;
  capsId: string;
  vaultId: string;
  oracleId: string;
  pathId: string;
  positionId: string;
  /**
   * Required by the Move ABI for close_ride. Optional here so call sites
   * built against the spec interface compile; `buildCloseRideTx` throws
   * at PTB-build time if any are missing. Live IDs live at
   * `deployments/testnet.json#usd_price_oracle`, `wick_token_state`,
   * `wick_staking_pool`.
   */
  priceOracleId?: string;
  wickTokenStateId?: string;
  wickStakingPoolId?: string;
  collateralType?: string;
}

export interface CrankExpiredRideParams {
  marketId: string;
  capsId: string;
  vaultId: string;
  pathId: string;
  positionId: string;
  /** See note on CloseRideParams for global ID locations. */
  priceOracleId?: string;
  wickTokenStateId?: string;
  wickStakingPoolId?: string;
  collateralType?: string;
}

/**
 * State of a RidePosition object as observed on-chain. Mirrors fields on
 * `wick::ride_position::RidePosition`.
 *
 * `stakePaid` is NOT a chain-stored field — it's computed client-side at
 * fetch time from `stakeRateMicroUsdPerSec * elapsed_sec`, clamped by
 * `escrowed`. After close, `stakePaid` reflects the value at
 * `closedAtMs`; while open, it reflects the value at `Date.now()`.
 */
export interface RidePositionState {
  positionId: string;
  user: string;
  marketId: string;
  pathId: string;
  capsId: string;
  multiplierBps: number;
  stakeRateMicroUsdPerSec: bigint;
  startTimeMs: bigint;
  escrowed: bigint;
  /** Captured at open from BotRegistry — bot-eligible riders get WICK mint. */
  isBotEligible: boolean;
  closed: boolean;
  closedAtMs: bigint;
  /** SETTLEMENT_OPEN | TOUCH_WIN | CASHOUT | EXPIRED_LOSS | ABORTED_REFUND */
  settlementKind: number;
  /** Client-computed live preview (see struct doc above). */
  stakePaid: bigint;
}

// ── Defaults ─────────────────────────────────────────────────────────────

const DEFAULT_COLLATERAL = "0x2::sui::SUI";

// ── Internal helpers ─────────────────────────────────────────────────────

function asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  return 0n;
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "bigint") return Number(v);
  return 0;
}

function asBool(v: unknown): boolean {
  return v === true || v === "true";
}

/**
 * Mirror of the on-chain stake-paid math at `ride_position::compute_stake_paid`.
 * Clamps to `escrowed` so callers can show "you've burned X of Y so far".
 */
function computeStakePaid(
  stakeRateMicroUsdPerSec: bigint,
  startTimeMs: bigint,
  escrowed: bigint,
  closed: boolean,
  closedAtMs: bigint,
  nowMs: bigint,
): bigint {
  const boundMs = closed ? closedAtMs : nowMs;
  const elapsedMs = boundMs > startTimeMs ? boundMs - startTimeMs : 0n;
  const elapsedSec = elapsedMs / 1000n;
  const raw = (stakeRateMicroUsdPerSec * elapsedSec) / 1_000_000n;
  return raw > escrowed ? escrowed : raw;
}

// ── buildOpenRideTx ──────────────────────────────────────────────────────

/**
 * Build a PTB that opens a streaming ride and transfers the resulting
 * `RidePosition` to the sender.
 *
 * The `suiCoinIn` parameter currently supports `{ kind: "Split", ... }`
 * — splits the requested escrow amount off either the user's gas coin
 * (when `from === "gas"`) or an explicit coin object by ID. Future kinds
 * can be added without breaking callers.
 *
 * @param packageId The on-chain package_id from `deployments/testnet.json`.
 *   For testnet today: `0x81ec682cfa370edad312b6b6b37053552199a7aeab1203bf1bc650f6668cc846`.
 */
export function buildOpenRideTx(
  params: OpenRideParams,
  packageId: string,
  suiCoinIn?: { kind: "Split"; from: string; amount: bigint },
): Transaction {
  if (params.escrowMist <= 0n) throw new Error("escrowMist must be > 0");
  if (params.stakeRateMicroUsdPerSec <= 0n) {
    throw new Error("stakeRateMicroUsdPerSec must be > 0");
  }
  if (!params.botRegistryId) {
    throw new Error(
      "buildOpenRideTx: botRegistryId is required (see deployments/testnet.json#bot_registry)",
    );
  }
  // Default to splitting `escrowMist` off the gas coin when no source is
  // named — matches the buildBuyTx pattern in sdk/src/transactions.ts.
  const coinIn = suiCoinIn ?? {
    kind: "Split" as const,
    from: "gas",
    amount: params.escrowMist,
  };
  if (coinIn.kind !== "Split") {
    throw new Error(`unsupported suiCoinIn.kind: ${(coinIn as { kind: string }).kind}`);
  }
  if (coinIn.amount !== params.escrowMist) {
    throw new Error(
      `suiCoinIn.amount (${coinIn.amount}) must equal params.escrowMist (${params.escrowMist})`,
    );
  }

  const collateralType = params.collateralType ?? DEFAULT_COLLATERAL;
  const tx = new Transaction();

  // Source coin: gas by default, or any coin object the caller names.
  const source = coinIn.from === "gas" ? tx.gas : tx.object(coinIn.from);
  const [escrow] = tx.splitCoins(source, [tx.pure.u64(coinIn.amount)]);

  const ride = tx.moveCall({
    target: `${packageId}::wick::open_ride`,
    typeArguments: [collateralType],
    arguments: [
      tx.object(params.capsId),               // caps: &mut RideMarketCaps
      tx.object(params.pathId),               // path: &PathObservation
      tx.object(params.vaultId),              // vault: &mut MartingalerVault<C>
      tx.object(params.botRegistryId),        // bot_registry: &BotRegistry
      tx.pure.u64(params.stakeRateMicroUsdPerSec),
      escrow,                                 // escrow: Coin<C>
      tx.object(SUI_CLOCK_OBJECT_ID),         // clock: &Clock
    ],
  });

  // Route the returned RidePosition to the sender. We resolve the sender
  // via `0x2::tx_context::sender` inside the same PTB, which means the
  // caller does NOT have to pre-set the sender address on the builder —
  // dApp Kit fills it in at signing time and Sui resolves the call.
  const sender = tx.moveCall({ target: "0x2::tx_context::sender" });
  tx.transferObjects([ride], sender);
  return tx;
}

// ── buildCloseRideTx ─────────────────────────────────────────────────────

/**
 * Build a PTB that closes a ride and transfers the payout coin to the
 * sender. Settlement kind (TOUCH_WIN / CASHOUT / EXPIRED_LOSS /
 * ABORTED_REFUND) is decided on-chain — see `decide_settlement` in
 * `move/sources/ride_position.move`.
 */
export function buildCloseRideTx(
  params: CloseRideParams,
  packageId: string,
): Transaction {
  if (!params.priceOracleId || !params.wickTokenStateId || !params.wickStakingPoolId) {
    throw new Error(
      "buildCloseRideTx: priceOracleId, wickTokenStateId, and wickStakingPoolId are required " +
        "(see deployments/testnet.json#{usd_price_oracle,wick_token_state,wick_staking_pool})",
    );
  }
  const collateralType = params.collateralType ?? DEFAULT_COLLATERAL;
  const tx = new Transaction();

  const payout = tx.moveCall({
    target: `${packageId}::wick::close_ride`,
    typeArguments: [collateralType],
    arguments: [
      tx.object(params.positionId),           // ride: &mut RidePosition
      tx.object(params.capsId),               // caps: &mut RideMarketCaps
      tx.object(params.pathId),               // path: &PathObservation
      tx.object(params.oracleId),             // oracle: &WickOracle
      tx.object(params.vaultId),              // vault: &mut MartingalerVault<C>
      tx.object(params.priceOracleId),        // price_oracle: &UsdPriceOracle
      tx.object(params.wickTokenStateId),     // token_state: &mut WickTokenState
      tx.object(params.wickStakingPoolId),    // staking_pool: &mut WickStakingPool
      tx.object(SUI_CLOCK_OBJECT_ID),         // clock: &Clock
    ],
  });

  const sender = tx.moveCall({ target: "0x2::tx_context::sender" });
  tx.transferObjects([payout], sender);
  return tx;
}

// ── buildCrankExpiredRideTx (bonus — keeper / permissionless) ────────────

/**
 * Build a PTB for `crank_expired_ride`. The caller receives the bounty
 * coin (~50bps of forfeit). The user's refund is `transfer::public_transfer`'d
 * from inside Move. Reverts if the barrier fired during the window (the
 * user must self-close in that case — see the SEV-1 guard at
 * `move/sources/ride_position.move:344`).
 */
export function buildCrankExpiredRideTx(
  params: CrankExpiredRideParams,
  packageId: string,
): Transaction {
  if (!params.priceOracleId || !params.wickTokenStateId || !params.wickStakingPoolId) {
    throw new Error(
      "buildCrankExpiredRideTx: priceOracleId, wickTokenStateId, and wickStakingPoolId are required " +
        "(see deployments/testnet.json#{usd_price_oracle,wick_token_state,wick_staking_pool})",
    );
  }
  const collateralType = params.collateralType ?? DEFAULT_COLLATERAL;
  const tx = new Transaction();

  const bounty = tx.moveCall({
    target: `${packageId}::wick::crank_expired_ride`,
    typeArguments: [collateralType],
    arguments: [
      tx.object(params.positionId),
      tx.object(params.capsId),
      tx.object(params.pathId),
      tx.object(params.vaultId),
      tx.object(params.priceOracleId),
      tx.object(params.wickTokenStateId),
      tx.object(params.wickStakingPoolId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const sender = tx.moveCall({ target: "0x2::tx_context::sender" });
  tx.transferObjects([bounty], sender);
  return tx;
}

// ── getRidePosition ──────────────────────────────────────────────────────

/**
 * Fetch and decode a `RidePosition` object by ID. Returns `null` if the
 * object doesn't exist, isn't a Move object, or isn't a RidePosition.
 *
 * Pair with react-query (`refetchInterval: 1500`) for smooth polling while
 * the user holds the ride open. The returned `stakePaid` is computed
 * client-side against `Date.now()` (or `closedAtMs` if already closed) so
 * the UI can draw a live "burn" bar without extra math.
 */
export async function getRidePosition(
  client: SuiJsonRpcClient,
  positionId: string,
): Promise<RidePositionState | null> {
  const obj = await client.getObject({
    id: positionId,
    options: { showContent: true, showType: true },
  });
  if (!obj.data || obj.data.content?.dataType !== "moveObject") return null;

  const content = obj.data.content as {
    fields: Record<string, unknown>;
    type: string;
  };
  if (!content.type.includes("::ride_position::RidePosition")) return null;

  const f = content.fields;
  const stakeRate = asBigInt(f.stake_rate_micro_usd_per_sec);
  const startTimeMs = asBigInt(f.start_time_ms);
  const escrowed = asBigInt(f.escrowed);
  const closed = asBool(f.closed);
  const closedAtMs = asBigInt(f.closed_at_ms);
  const stakePaid = computeStakePaid(
    stakeRate,
    startTimeMs,
    escrowed,
    closed,
    closedAtMs,
    BigInt(Date.now()),
  );

  return {
    positionId: obj.data.objectId,
    user: String(f.user ?? ""),
    marketId: String(f.market_id ?? ""),
    pathId: String(f.path_id ?? ""),
    capsId: String(f.caps_id ?? ""),
    multiplierBps: asNumber(f.multiplier_bps),
    stakeRateMicroUsdPerSec: stakeRate,
    startTimeMs,
    escrowed,
    isBotEligible: asBool(f.is_bot_eligible),
    closed,
    closedAtMs,
    settlementKind: asNumber(f.settlement_kind),
    stakePaid,
  };
}
