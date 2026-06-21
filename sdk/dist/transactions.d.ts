/**
 * PTB builders for every Wick entry function. Each returns a {@link Transaction}
 * with no signer attached — the caller signs and executes via dApp Kit, the
 * keeper's keypair, the CLI, or any other path.
 *
 * Why bigint everywhere: Sui u64 amounts can exceed JS Number safe range
 * (2^53). Pass `riskMist: BigInt(100_000)` rather than the raw number.
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
export declare function buildCreateMarketTx(a: BuildCreateMarketArgs): Transaction;
export interface BuildBuyArgs extends BuildTxBase {
    marketId: string;
    side: Side;
    riskMist: bigint;
}
export declare function buildBuyTx(a: BuildBuyArgs): Transaction;
export interface BuildSwapArgs extends BuildTxBase {
    marketId: string;
    positionId: string;
    fromSide: Side;
}
export declare function buildSwapTx(a: BuildSwapArgs): Transaction;
export interface BuildRedeemCompleteSetArgs extends BuildTxBase {
    marketId: string;
    touchPositionId: string;
    noTouchPositionId: string;
}
export declare function buildRedeemCompleteSetTx(a: BuildRedeemCompleteSetArgs): Transaction;
export interface BuildRedeemWinnerArgs extends BuildTxBase {
    marketId: string;
    positionId: string;
}
export declare function buildRedeemWinnerTx(a: BuildRedeemWinnerArgs): Transaction;
export interface BuildRedeemLpArgs extends BuildTxBase {
    marketId: string;
    lpPositionId: string;
}
export declare function buildRedeemLpTx(a: BuildRedeemLpArgs): Transaction;
export interface BuildMarkHitArgs extends BuildTxBase {
    marketId: string;
    oracleId: string;
}
export declare function buildMarkHitTx(a: BuildMarkHitArgs): Transaction;
export interface BuildSettleExpiredArgs extends BuildTxBase {
    marketId: string;
}
export declare function buildSettleExpiredTx(a: BuildSettleExpiredArgs): Transaction;
//# sourceMappingURL=transactions.d.ts.map