import { STATUS_NAME, DIRECTION_NAME, SIDE_NAME, } from "./constants.js";
const decoder = new TextDecoder();
function decodeAssetId(raw) {
    if (typeof raw === "string")
        return raw;
    if (Array.isArray(raw))
        return decoder.decode(new Uint8Array(raw));
    return "";
}
function asNumber(v) {
    if (typeof v === "number")
        return v;
    if (typeof v === "string")
        return Number(v);
    if (typeof v === "bigint")
        return Number(v);
    return 0;
}
/**
 * Configurable client wrapping a SuiJsonRpcClient with knowledge of the Wick
 * package layout. All read methods take the client and return plain JSON
 * snapshots. Pass to the SDK's tx builders for write paths.
 */
export class WickClient {
    sui;
    deployment;
    constructor(opts) {
        this.sui = opts.sui;
        this.deployment = opts.deployment;
    }
    // -- type tags --
    marketTypeTag(collateralType) {
        return `${this.deployment.original_id}::wick::Market<${collateralType}>`;
    }
    positionTypeTag() {
        return `${this.deployment.original_id}::wick::Position`;
    }
    lpPositionTypeTag() {
        return `${this.deployment.original_id}::wick::LpPosition`;
    }
    oracleTypeTag() {
        return `${this.deployment.original_id}::oracle_adapter::MockOracle`;
    }
    marketCreatedEventType() {
        return `${this.deployment.package_id}::wick::MarketCreated`;
    }
    // -- queries --
    /**
     * Every market the deployed package has emitted a MarketCreated for.
     * Optional `collateralType` filter restricts to a single coin type.
     */
    async listMarkets(opts) {
        const events = [];
        let cursor = null;
        for (let i = 0; i < 50; i++) {
            const page = await this.sui.queryEvents({
                query: { MoveEventType: this.marketCreatedEventType() },
                cursor,
                limit: 50,
                order: "ascending",
            });
            for (const ev of page.data)
                events.push(ev.parsedJson);
            if (!page.hasNextPage || !page.nextCursor)
                break;
            cursor = page.nextCursor;
        }
        if (events.length === 0)
            return [];
        const ids = events.map((e) => e.market_id);
        const objs = await this.sui.multiGetObjects({
            ids,
            options: { showContent: true, showType: true },
        });
        const out = [];
        for (let i = 0; i < objs.length; i++) {
            const o = objs[i];
            if (!o?.data || o.data.content?.dataType !== "moveObject")
                continue;
            const content = o.data.content;
            // type looks like "<orig>::wick::Market<0x2::sui::SUI>" — extract the type arg.
            const m = /::wick::Market<(.+)>$/.exec(content.type);
            if (!m)
                continue;
            const collateralType = m[1];
            if (opts?.collateralType && collateralType !== opts.collateralType)
                continue;
            const f = content.fields;
            out.push({
                id: o.data.objectId,
                asset: decodeAssetId(f.asset_id),
                direction: DIRECTION_NAME[asNumber(f.direction)] ?? "ABOVE",
                barrier: asNumber(f.barrier_price),
                expiryMs: asNumber(f.expiry_ms),
                status: STATUS_NAME[asNumber(f.status)] ?? "ACTIVE",
                fee_bps: asNumber(f.fee_bps),
                collateralVault: extractBalance(f.collateral_vault),
                touchSupply: asNumber(f.total_touch_supply),
                noTouchSupply: asNumber(f.total_no_touch_supply),
                touchReserve: asNumber(f.touch_reserve),
                noTouchReserve: asNumber(f.no_touch_reserve),
                lpSupply: asNumber(f.lp_supply),
                underlyingPrice: asNumber(f.barrier_price),
                collateralType,
            });
        }
        return out.sort((a, b) => b.expiryMs - a.expiryMs);
    }
    async getMarket(marketId) {
        const o = await this.sui.getObject({
            id: marketId,
            options: { showContent: true, showType: true },
        });
        if (!o.data || o.data.content?.dataType !== "moveObject")
            return null;
        const content = o.data.content;
        const m = /::wick::Market<(.+)>$/.exec(content.type);
        if (!m)
            return null;
        const f = content.fields;
        return {
            id: o.data.objectId,
            asset: decodeAssetId(f.asset_id),
            direction: DIRECTION_NAME[asNumber(f.direction)] ?? "ABOVE",
            barrier: asNumber(f.barrier_price),
            expiryMs: asNumber(f.expiry_ms),
            status: STATUS_NAME[asNumber(f.status)] ?? "ACTIVE",
            fee_bps: asNumber(f.fee_bps),
            collateralVault: extractBalance(f.collateral_vault),
            touchSupply: asNumber(f.total_touch_supply),
            noTouchSupply: asNumber(f.total_no_touch_supply),
            touchReserve: asNumber(f.touch_reserve),
            noTouchReserve: asNumber(f.no_touch_reserve),
            lpSupply: asNumber(f.lp_supply),
            underlyingPrice: asNumber(f.barrier_price),
            collateralType: m[1],
        };
    }
    /** Positions owned by `address`. Filters by Position struct type. */
    async listPositions(address) {
        const items = await this.sui.getOwnedObjects({
            owner: address,
            filter: { StructType: this.positionTypeTag() },
            options: { showContent: true },
        });
        const out = [];
        for (const item of items.data) {
            const data = item.data;
            if (!data || data.content?.dataType !== "moveObject")
                continue;
            const f = data.content.fields;
            out.push({
                id: data.objectId,
                marketId: String(f.market_id),
                side: SIDE_NAME[asNumber(f.side)] ?? "TOUCH",
                amount: asNumber(f.amount),
                owner: address,
            });
        }
        return out;
    }
    /** LP positions owned by `address`. */
    async listLpPositions(address) {
        const items = await this.sui.getOwnedObjects({
            owner: address,
            filter: { StructType: this.lpPositionTypeTag() },
            options: { showContent: true },
        });
        const out = [];
        for (const item of items.data) {
            const data = item.data;
            if (!data || data.content?.dataType !== "moveObject")
                continue;
            const f = data.content.fields;
            out.push({
                id: data.objectId,
                marketId: String(f.market_id),
                shares: asNumber(f.shares),
                owner: address,
            });
        }
        return out;
    }
    /** Find the MockOracle whose asset matches `asset`. Scans all known package versions. */
    async findOracleForAsset(asset) {
        const pkgIds = new Set([
            this.deployment.package_id,
            this.deployment.original_id,
            ...((this.deployment.history ?? []).map((h) => h.package_id)),
        ]);
        for (const pkgId of pkgIds) {
            let cursor = null;
            for (let i = 0; i < 5; i++) {
                let page;
                try {
                    page = await this.sui.queryTransactionBlocks({
                        filter: { MoveFunction: { package: pkgId, module: "oracle_adapter", function: "create_and_share" } },
                        options: { showObjectChanges: true },
                        cursor,
                        limit: 50,
                        order: "descending",
                    });
                }
                catch {
                    break;
                }
                for (const tx of page.data) {
                    for (const c of (tx.objectChanges ?? [])) {
                        if (c.type !== "created")
                            continue;
                        const t = c.objectType ?? "";
                        if (!t.endsWith("::oracle_adapter::MockOracle"))
                            continue;
                        const oid = c.objectId;
                        const obj = await this.sui.getObject({ id: oid, options: { showContent: true } });
                        if (!obj.data || obj.data.content?.dataType !== "moveObject")
                            continue;
                        const f = obj.data.content.fields;
                        const oracleAsset = decodeAssetId(f.asset_id);
                        if (oracleAsset === asset) {
                            return { id: oid, asset: oracleAsset, price: asNumber(f.price) };
                        }
                    }
                }
                if (!page.hasNextPage || !page.nextCursor)
                    break;
                cursor = page.nextCursor;
            }
        }
        return null;
    }
    /** All oracles known to the deployment, deduplicated by id. */
    async listOracles() {
        const pkgIds = new Set([
            this.deployment.package_id,
            this.deployment.original_id,
            ...((this.deployment.history ?? []).map((h) => h.package_id)),
        ]);
        const seen = new Set();
        const out = [];
        for (const pkgId of pkgIds) {
            let cursor = null;
            for (let i = 0; i < 5; i++) {
                let page;
                try {
                    page = await this.sui.queryTransactionBlocks({
                        filter: { MoveFunction: { package: pkgId, module: "oracle_adapter", function: "create_and_share" } },
                        options: { showObjectChanges: true },
                        cursor,
                        limit: 50,
                        order: "descending",
                    });
                }
                catch {
                    break;
                }
                for (const tx of page.data) {
                    for (const c of (tx.objectChanges ?? [])) {
                        if (c.type !== "created")
                            continue;
                        const t = c.objectType ?? "";
                        if (!t.endsWith("::oracle_adapter::MockOracle"))
                            continue;
                        const oid = c.objectId;
                        if (seen.has(oid))
                            continue;
                        seen.add(oid);
                        const obj = await this.sui.getObject({ id: oid, options: { showContent: true } });
                        if (!obj.data || obj.data.content?.dataType !== "moveObject")
                            continue;
                        const f = obj.data.content.fields;
                        out.push({
                            id: oid,
                            asset: decodeAssetId(f.asset_id),
                            price: asNumber(f.price),
                        });
                    }
                }
                if (!page.hasNextPage || !page.nextCursor)
                    break;
                cursor = page.nextCursor;
            }
        }
        return out;
    }
}
function extractBalance(v) {
    if (typeof v === "string" || typeof v === "number")
        return Number(v);
    if (v && typeof v === "object" && "value" in v) {
        return Number(v.value);
    }
    return 0;
}
//# sourceMappingURL=client.js.map