import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { type BarrierIndex } from "./segmentMarket.js";
export interface SponsoredSigner {
    address?: string;
    toSuiAddress?: () => string;
    getPublicKey?: () => {
        toSuiAddress: () => string;
    };
    signTransaction: (txBytes: Uint8Array) => Promise<{
        signature: string;
    }>;
}
export interface SponsoredTransactionConfig {
    packageId?: string;
    collateralType?: string;
    sponsorAddress?: string;
    gasBudgetMist?: bigint;
}
export declare function configureSponsoredTransactions(config: SponsoredTransactionConfig): void;
export declare function recordSegmentSponsored(client: SuiJsonRpcClient, user: SponsoredSigner, marketId: string, sponsorUrl: string): Promise<string>;
export declare function openSegmentRideSponsored(client: SuiJsonRpcClient, user: SponsoredSigner, marketId: string, vaultId: string, botRegistryId: string, stakePerSegment: bigint, escrowCoinId: string, sponsorUrl: string): Promise<string>;
export declare function openSegmentRideSponsored(client: SuiJsonRpcClient, user: SponsoredSigner, marketId: string, vaultId: string, botRegistryId: string, barrierIndex: BarrierIndex, stakePerSegment: bigint, escrowCoinId: string, sponsorUrl: string): Promise<string>;
export declare function closeSegmentRideSponsored(client: SuiJsonRpcClient, user: SponsoredSigner, marketId: string, vaultId: string, oracle: string, tokenState: string, stakingPool: string, rideId: string, sponsorUrl: string): Promise<string>;
//# sourceMappingURL=sponsored.d.ts.map