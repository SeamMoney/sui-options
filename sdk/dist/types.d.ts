/**
 * Public types for the Wick Markets SDK. Mirrors the Move package surface.
 *
 * Numbers are JS numbers for ergonomic display use, but PTB construction
 * code paths use bigints throughout to avoid u64 precision loss.
 */
export type Side = "TOUCH" | "NO_TOUCH";
export type Direction = "ABOVE" | "BELOW";
export type Status = "ACTIVE" | "HIT" | "EXPIRED";
export interface MarketSnapshot {
    id: string;
    asset: string;
    direction: Direction;
    barrier: number;
    expiryMs: number;
    status: Status;
    fee_bps: number;
    collateralVault: number;
    touchSupply: number;
    noTouchSupply: number;
    touchReserve: number;
    noTouchReserve: number;
    lpSupply: number;
    underlyingPrice: number;
    /** The collateral type tag for this market, e.g. "0x2::sui::SUI". */
    collateralType: string;
}
export interface PositionSnapshot {
    id: string;
    marketId: string;
    side: Side;
    amount: number;
    /** Address that currently owns the Position. */
    owner: string;
}
export interface LpPositionSnapshot {
    id: string;
    marketId: string;
    shares: number;
    owner: string;
}
export interface OracleSnapshot {
    id: string;
    asset: string;
    price: number;
}
export interface Deployment {
    network: "testnet" | "mainnet" | "devnet" | "localnet";
    package_id: string;
    original_id: string;
    history?: {
        package_id: string;
    }[];
}
//# sourceMappingURL=types.d.ts.map