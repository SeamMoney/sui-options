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
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { DIRECTION_CODE } from "./constants.js";
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
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
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
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
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
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
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
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
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
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
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
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
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
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
/** @deprecated Legacy v1 ABI (retired on-chain) — see the module banner. */
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