/**
 * PTB builders for every Wick entry function. Each returns a {@link Transaction}
 * with no signer attached — the caller signs and executes via dApp Kit, the
 * keeper's keypair, the CLI, or any other path.
 *
 * Why bigint everywhere: Sui u64 amounts can exceed JS Number safe range
 * (2^53). Pass `riskMist: BigInt(100_000)` rather than the raw number.
 */
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { DIRECTION_CODE } from "./constants.js";
export function buildCreateMarketTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    const [seed] = tx.splitCoins(tx.gas, [tx.pure.u64(a.seedMist)]);
    tx.moveCall({
        target: `${a.packageId}::wick::create_market`,
        typeArguments: [a.collateralType],
        arguments: [
            tx.pure.vector("u8", Array.from(new TextEncoder().encode(a.asset))),
            tx.pure.u8(DIRECTION_CODE[a.direction]),
            tx.pure.u64(a.barrier),
            tx.pure.u64(a.expiryMs),
            tx.pure.u64(a.feeBps),
            seed,
            tx.object(SUI_CLOCK_OBJECT_ID),
        ],
    });
    return tx;
}
export function buildBuyTx(a) {
    if (a.riskMist <= 0n)
        throw new Error("riskMist must be > 0");
    const tx = new Transaction();
    tx.setSender(a.sender);
    const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(a.riskMist)]);
    const fn = a.side === "TOUCH" ? "buy_touch" : "buy_no_touch";
    const pos = tx.moveCall({
        target: `${a.packageId}::wick::${fn}`,
        typeArguments: [a.collateralType],
        arguments: [tx.object(a.marketId), payment, tx.object(SUI_CLOCK_OBJECT_ID)],
    });
    tx.transferObjects([pos], tx.pure.address(a.sender));
    return tx;
}
export function buildSwapTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    const fn = a.fromSide === "TOUCH" ? "swap_touch_for_no_touch" : "swap_no_touch_for_touch";
    const newPos = tx.moveCall({
        target: `${a.packageId}::wick::${fn}`,
        typeArguments: [a.collateralType],
        arguments: [
            tx.object(a.marketId),
            tx.object(a.positionId),
            tx.object(SUI_CLOCK_OBJECT_ID),
        ],
    });
    tx.transferObjects([newPos], tx.pure.address(a.sender));
    return tx;
}
export function buildRedeemCompleteSetTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    const out = tx.moveCall({
        target: `${a.packageId}::wick::redeem_complete_set`,
        typeArguments: [a.collateralType],
        arguments: [
            tx.object(a.marketId),
            tx.object(a.touchPositionId),
            tx.object(a.noTouchPositionId),
        ],
    });
    tx.transferObjects([out], tx.pure.address(a.sender));
    return tx;
}
export function buildRedeemWinnerTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    const payout = tx.moveCall({
        target: `${a.packageId}::wick::redeem_winner`,
        typeArguments: [a.collateralType],
        arguments: [tx.object(a.marketId), tx.object(a.positionId)],
    });
    tx.transferObjects([payout], tx.pure.address(a.sender));
    return tx;
}
export function buildRedeemLpTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    const claim = tx.moveCall({
        target: `${a.packageId}::wick::redeem_lp`,
        typeArguments: [a.collateralType],
        arguments: [tx.object(a.marketId), tx.object(a.lpPositionId)],
    });
    tx.transferObjects([claim], tx.pure.address(a.sender));
    return tx;
}
export function buildMarkHitTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    tx.moveCall({
        target: `${a.packageId}::wick::mark_hit`,
        typeArguments: [a.collateralType],
        arguments: [
            tx.object(a.marketId),
            tx.object(a.oracleId),
            tx.object(SUI_CLOCK_OBJECT_ID),
        ],
    });
    return tx;
}
export function buildSettleExpiredTx(a) {
    const tx = new Transaction();
    tx.setSender(a.sender);
    tx.moveCall({
        target: `${a.packageId}::wick::settle_expired`,
        typeArguments: [a.collateralType],
        arguments: [tx.object(a.marketId), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
    return tx;
}
//# sourceMappingURL=transactions.js.map