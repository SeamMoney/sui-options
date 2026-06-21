import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { BARRIER_UPPER } from "./segmentMarket.js";
const DEFAULT_COLLATERAL = "0x2::sui::SUI";
const DEFAULT_GAS_BUDGET_MIST = 50000000n;
let sponsoredConfig = {};
export function configureSponsoredTransactions(config) {
    sponsoredConfig = { ...sponsoredConfig, ...config };
}
function env(name) {
    const meta = import.meta;
    const nodeProcess = globalThis.process;
    return meta.env?.[name] ?? nodeProcess?.env?.[name];
}
function firstEnv(...names) {
    for (const name of names) {
        const value = env(name);
        if (value)
            return value;
    }
    return undefined;
}
function requiredPackageId() {
    const packageId = sponsoredConfig.packageId ??
        firstEnv("VITE_WICK_V3_PACKAGE_ID", "WICK_V3_PACKAGE_ID", "VITE_WICK_PACKAGE_ID", "WICK_PACKAGE_ID");
    if (!packageId) {
        throw new Error("Sponsored transactions require a Wick package id");
    }
    return packageId;
}
function requiredSponsorAddress() {
    const sponsorAddress = sponsoredConfig.sponsorAddress ??
        firstEnv("VITE_WICK_SPONSOR_ADDRESS", "WICK_SPONSOR_ADDRESS");
    if (!sponsorAddress) {
        throw new Error("Sponsored transactions require VITE_WICK_SPONSOR_ADDRESS");
    }
    return sponsorAddress;
}
function collateralType() {
    return sponsoredConfig.collateralType ?? firstEnv("VITE_WICK_COLLATERAL_TYPE", "WICK_COLLATERAL_TYPE") ?? DEFAULT_COLLATERAL;
}
function gasBudgetMist() {
    return sponsoredConfig.gasBudgetMist ?? DEFAULT_GAS_BUDGET_MIST;
}
function senderAddress(user) {
    if (user.address)
        return user.address;
    if (user.toSuiAddress)
        return user.toSuiAddress();
    const publicKey = user.getPublicKey?.();
    if (publicKey)
        return publicKey.toSuiAddress();
    throw new Error("Sponsored signer does not expose a Sui address");
}
function sponsorEndpoint(sponsorUrl) {
    const trimmed = sponsorUrl.replace(/\/+$/, "");
    return trimmed.endsWith("/api/sponsor") ? trimmed : `${trimmed}/api/sponsor`;
}
async function signAndSponsor(client, user, tx, sponsorUrl) {
    const sender = senderAddress(user);
    const txBytes = await tx.build({ client });
    const signed = await user.signTransaction(txBytes);
    const res = await fetch(sponsorEndpoint(sponsorUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            sender,
            txBytes: toBase64(txBytes),
            userSig: signed.signature,
        }),
    });
    const body = (await res.json().catch(() => ({})));
    if (!res.ok) {
        throw new Error(typeof body.error === "string" ? body.error : `sponsor request failed (${res.status})`);
    }
    if (typeof body.digest !== "string" || body.digest.length === 0) {
        throw new Error("sponsor response did not include a digest");
    }
    return body.digest;
}
function sponsoredTx(user) {
    const sender = senderAddress(user);
    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasOwner(requiredSponsorAddress());
    tx.setGasBudget(gasBudgetMist());
    return { tx, sender };
}
export async function recordSegmentSponsored(client, user, marketId, sponsorUrl) {
    const { tx } = sponsoredTx(user);
    tx.moveCall({
        target: `${requiredPackageId()}::wick::record_segment_v3`,
        typeArguments: [collateralType()],
        arguments: [tx.object(marketId), tx.object.random(), tx.object.clock()],
    });
    return signAndSponsor(client, user, tx, sponsorUrl);
}
export async function openSegmentRideSponsored(client, user, marketId, vaultId, botRegistryId, barrierOrStake, stakeOrEscrow, escrowOrUrl, maybeSponsorUrl) {
    const barrierIndex = typeof barrierOrStake === "bigint" ? BARRIER_UPPER : barrierOrStake;
    const stakePerSegment = typeof barrierOrStake === "bigint" ? barrierOrStake : stakeOrEscrow;
    const escrowCoinId = typeof barrierOrStake === "bigint" ? stakeOrEscrow : escrowOrUrl;
    const sponsorUrl = typeof barrierOrStake === "bigint" ? escrowOrUrl : maybeSponsorUrl;
    if (!sponsorUrl)
        throw new Error("sponsorUrl is required");
    if (stakePerSegment <= 0n)
        throw new Error("stakePerSegment must be > 0");
    const { tx, sender } = sponsoredTx(user);
    const ride = tx.moveCall({
        target: `${requiredPackageId()}::wick::open_segment_ride_v3`,
        typeArguments: [collateralType()],
        arguments: [
            tx.object(marketId),
            tx.object(vaultId),
            tx.object(botRegistryId),
            tx.pure.u8(barrierIndex),
            tx.pure.u64(stakePerSegment),
            tx.object(escrowCoinId),
            tx.object.clock(),
        ],
    });
    tx.transferObjects([ride], tx.pure.address(sender));
    return signAndSponsor(client, user, tx, sponsorUrl);
}
export async function closeSegmentRideSponsored(client, user, marketId, vaultId, oracle, tokenState, stakingPool, rideId, sponsorUrl) {
    const { tx, sender } = sponsoredTx(user);
    const payout = tx.moveCall({
        target: `${requiredPackageId()}::wick::close_segment_ride_v3`,
        typeArguments: [collateralType()],
        arguments: [
            tx.object(rideId),
            tx.object(marketId),
            tx.object(vaultId),
            tx.object(oracle),
            tx.object(tokenState),
            tx.object(stakingPool),
            tx.object.clock(),
        ],
    });
    tx.transferObjects([payout], tx.pure.address(sender));
    return signAndSponsor(client, user, tx, sponsorUrl);
}
//# sourceMappingURL=sponsored.js.map