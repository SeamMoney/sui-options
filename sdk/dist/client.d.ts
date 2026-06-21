import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Deployment, MarketSnapshot, PositionSnapshot, LpPositionSnapshot, OracleSnapshot } from "./types.js";
/**
 * Configurable client wrapping a SuiJsonRpcClient with knowledge of the Wick
 * package layout. All read methods take the client and return plain JSON
 * snapshots. Pass to the SDK's tx builders for write paths.
 */
export declare class WickClient {
    readonly sui: SuiJsonRpcClient;
    readonly deployment: Deployment;
    constructor(opts: {
        sui: SuiJsonRpcClient;
        deployment: Deployment;
    });
    marketTypeTag(collateralType: string): string;
    positionTypeTag(): string;
    lpPositionTypeTag(): string;
    oracleTypeTag(): string;
    marketCreatedEventType(): string;
    /**
     * Every market the deployed package has emitted a MarketCreated for.
     * Optional `collateralType` filter restricts to a single coin type.
     */
    listMarkets(opts?: {
        collateralType?: string;
    }): Promise<MarketSnapshot[]>;
    getMarket(marketId: string): Promise<MarketSnapshot | null>;
    /** Positions owned by `address`. Filters by Position struct type. */
    listPositions(address: string): Promise<PositionSnapshot[]>;
    /** LP positions owned by `address`. */
    listLpPositions(address: string): Promise<LpPositionSnapshot[]>;
    /** Find the MockOracle whose asset matches `asset`. Scans all known package versions. */
    findOracleForAsset(asset: string): Promise<OracleSnapshot | null>;
    /** All oracles known to the deployment, deduplicated by id. */
    listOracles(): Promise<OracleSnapshot[]>;
}
//# sourceMappingURL=client.d.ts.map