/**
 * @deprecated **Legacy v1 ABI — retired on-chain. Do not use for new integrations.**
 *
 * Every builder in this file targets a `wick::` entry function that no longer
 * exists in the shipped package (`create_market`, `buy_touch`/`buy_no_touch`,
 * `swap_*`, `redeem_complete_set`, `redeem_winner`, `redeem_lp`, `mark_hit`,
 * `settle_expired`) — the v1 `create -> trade <-> swap -> redeem_complete_set`
 * flow described in AGENTS.md as "gone". A transaction built here WILL abort.
 *
 * The live v2/v4 surface: `wick::open_touch`/`open_no_touch` + `lock_and_settle`
 * + `redeem` for touch/no-touch, and the ride/segment builders in
 * `segmentMarket.ts` / `segmentMarketV4.ts` / `sponsored.ts`. These dead builders
 * are kept (not deleted) only because unrouted legacy UI + bots still import them;
 * they are excluded from the documented SDK surface.
 *
 * PTB builders return a {@link Transaction} with no signer attached.
 */
import { Transaction } from "@mysten/sui/transactions";
import type { Direction, Side } from "./types.js";
export interface BuildTxBase {
    packageId: string;
    collateralType: string;
    sender: string;
}
export interface BuildCreateMarketArgs extends BuildTxBase {
    asset: string;
    direction: Direction;
    barrier: bigint;
    expiryMs: bigint;
    feeBps: bigint;
    seedMist: bigint;
}
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
export declare function buildCreateMarketTx(a: BuildCreateMarketArgs): Transaction;
export interface BuildBuyArgs extends BuildTxBase {
    marketId: string;
    side: Side;
    riskMist: bigint;
}
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
export declare function buildBuyTx(a: BuildBuyArgs): Transaction;
export interface BuildSwapArgs extends BuildTxBase {
    marketId: string;
    positionId: string;
    fromSide: Side;
}
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
export declare function buildSwapTx(a: BuildSwapArgs): Transaction;
export interface BuildRedeemCompleteSetArgs extends BuildTxBase {
    marketId: string;
    touchPositionId: string;
    noTouchPositionId: string;
}
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
export declare function buildRedeemCompleteSetTx(a: BuildRedeemCompleteSetArgs): Transaction;
export interface BuildRedeemWinnerArgs extends BuildTxBase {
    marketId: string;
    positionId: string;
}
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
export declare function buildRedeemWinnerTx(a: BuildRedeemWinnerArgs): Transaction;
export interface BuildRedeemLpArgs extends BuildTxBase {
    marketId: string;
    lpPositionId: string;
}
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
export declare function buildRedeemLpTx(a: BuildRedeemLpArgs): Transaction;
export interface BuildMarkHitArgs extends BuildTxBase {
    marketId: string;
    oracleId: string;
}
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
export declare function buildMarkHitTx(a: BuildMarkHitArgs): Transaction;
export interface BuildSettleExpiredArgs extends BuildTxBase {
    marketId: string;
}
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
export declare function buildSettleExpiredTx(a: BuildSettleExpiredArgs): Transaction;
//# sourceMappingURL=transactions.d.ts.map