import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  STATUS_NAME,
  DIRECTION_NAME,
  SIDE_NAME,
} from "./constants.js";
import type {
  Deployment,
  MarketSnapshot,
  PositionSnapshot,
  LpPositionSnapshot,
  OracleSnapshot,
} from "./types.js";

const decoder = new TextDecoder();
function decodeAssetId(raw: number[] | string | unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return decoder.decode(new Uint8Array(raw as number[]));
  return "";
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "bigint") return Number(v);
  return 0;
}

interface MarketCreatedJson {
  market_id: string;
  asset_id: number[];
  direction: number;
  barrier_price: string;
  expiry_ms: string;
  fee_bps: string;
  seed: string;
}

/**
 * Configurable client wrapping a SuiJsonRpcClient with knowledge of the Wick
 * package layout. All read methods take the client and return plain JSON
 * snapshots. Pass to the SDK's tx builders for write paths.
 */
export class WickClient {
  readonly sui: SuiJsonRpcClient;
  readonly deployment: Deployment;

  constructor(opts: { sui: SuiJsonRpcClient; deployment: Deployment }) {
    this.sui = opts.sui;
    this.deployment = opts.deployment;
  }

  // -- type tags --

  marketTypeTag(collateralType: string): string {
    return `${this.deployment.original_id}::wick::Market<${collateralType}>`;
  }

  positionTypeTag(): string {
    return `${this.deployment.original_id}::wick::Position`;
  }

  lpPositionTypeTag(): string {
    return `${this.deployment.original_id}::wick::LpPosition`;
  }

  oracleTypeTag(): string {
    return `${this.deployment.original_id}::oracle_adapter::MockOracle`;
  }

  marketCreatedEventType(): string {
    return `${this.deployment.package_id}::wick::MarketCreated`;
  }

  // -- queries --

  /**
   * Every market the deployed package has emitted a MarketCreated for.
   * Optional `collateralType` filter restricts to a single coin type.
   */
  async listMarkets(opts?: { collateralType?: string }): Promise<MarketSnapshot[]> {
    const events: MarketCreatedJson[] = [];
    let cursor: { txDigest: string; eventSeq: string } | null = null;
    for (let i = 0; i < 50; i++) {
      const page = await this.sui.queryEvents({
        query: { MoveEventType: this.marketCreatedEventType() },
        cursor,
        limit: 50,
        order: "ascending",
      });
      for (const ev of page.data) events.push(ev.parsedJson as MarketCreatedJson);
      if (!page.hasNextPage || !page.nextCursor) break;
      cursor = page.nextCursor as { txDigest: string; eventSeq: string };
    }
    if (events.length === 0) return [];

    const ids = events.map((e) => e.market_id);
    const objs = await this.sui.multiGetObjects({
      ids,
      options: { showContent: true, showType: true },
    });

    const out: MarketSnapshot[] = [];
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (!o?.data || o.data.content?.dataType !== "moveObject") continue;
      const content = o.data.content as { fields: Record<string, unknown>; type: string };
      // type looks like "<orig>::wick::Market<0x2::sui::SUI>" — extract the type arg.
      const m = /::wick::Market<(.+)>$/.exec(content.type);
      if (!m) continue;
      const collateralType = m[1] as string;
      if (opts?.collateralType && collateralType !== opts.collateralType) continue;

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

  async getMarket(marketId: string): Promise<MarketSnapshot | null> {
    const o = await this.sui.getObject({
      id: marketId,
      options: { showContent: true, showType: true },
    });
    if (!o.data || o.data.content?.dataType !== "moveObject") return null;
    const content = o.data.content as { fields: Record<string, unknown>; type: string };
    const m = /::wick::Market<(.+)>$/.exec(content.type);
    if (!m) return null;
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
      collateralType: m[1] as string,
    };
  }

  /** Positions owned by `address`. Filters by Position struct type. */
  async listPositions(address: string): Promise<PositionSnapshot[]> {
    const items = await this.sui.getOwnedObjects({
      owner: address,
      filter: { StructType: this.positionTypeTag() },
      options: { showContent: true },
    });
    const out: PositionSnapshot[] = [];
    for (const item of items.data) {
      const data = item.data;
      if (!data || data.content?.dataType !== "moveObject") continue;
      const f = (data.content as { fields: Record<string, unknown> }).fields;
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
  async listLpPositions(address: string): Promise<LpPositionSnapshot[]> {
    const items = await this.sui.getOwnedObjects({
      owner: address,
      filter: { StructType: this.lpPositionTypeTag() },
      options: { showContent: true },
    });
    const out: LpPositionSnapshot[] = [];
    for (const item of items.data) {
      const data = item.data;
      if (!data || data.content?.dataType !== "moveObject") continue;
      const f = (data.content as { fields: Record<string, unknown> }).fields;
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
  async findOracleForAsset(asset: string): Promise<OracleSnapshot | null> {
    const pkgIds = new Set<string>([
      this.deployment.package_id,
      this.deployment.original_id,
      ...((this.deployment.history ?? []).map((h) => h.package_id)),
    ]);
    for (const pkgId of pkgIds) {
      let cursor: string | null = null;
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
        } catch {
          break;
        }
        for (const tx of page.data) {
          for (const c of (tx.objectChanges ?? [])) {
            if ((c as { type: string }).type !== "created") continue;
            const t = (c as { objectType?: string }).objectType ?? "";
            if (!t.endsWith("::oracle_adapter::MockOracle")) continue;
            const oid = (c as { objectId: string }).objectId;
            const obj = await this.sui.getObject({ id: oid, options: { showContent: true } });
            if (!obj.data || obj.data.content?.dataType !== "moveObject") continue;
            const f = (obj.data.content as { fields: Record<string, unknown> }).fields;
            const oracleAsset = decodeAssetId(f.asset_id);
            if (oracleAsset === asset) {
              return { id: oid, asset: oracleAsset, price: asNumber(f.price) };
            }
          }
        }
        if (!page.hasNextPage || !page.nextCursor) break;
        cursor = page.nextCursor as string;
      }
    }
    return null;
  }

  /** All oracles known to the deployment, deduplicated by id. */
  async listOracles(): Promise<OracleSnapshot[]> {
    const pkgIds = new Set<string>([
      this.deployment.package_id,
      this.deployment.original_id,
      ...((this.deployment.history ?? []).map((h) => h.package_id)),
    ]);
    const seen = new Set<string>();
    const out: OracleSnapshot[] = [];
    for (const pkgId of pkgIds) {
      let cursor: string | null = null;
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
        } catch {
          break;
        }
        for (const tx of page.data) {
          for (const c of (tx.objectChanges ?? [])) {
            if ((c as { type: string }).type !== "created") continue;
            const t = (c as { objectType?: string }).objectType ?? "";
            if (!t.endsWith("::oracle_adapter::MockOracle")) continue;
            const oid = (c as { objectId: string }).objectId;
            if (seen.has(oid)) continue;
            seen.add(oid);
            const obj = await this.sui.getObject({ id: oid, options: { showContent: true } });
            if (!obj.data || obj.data.content?.dataType !== "moveObject") continue;
            const f = (obj.data.content as { fields: Record<string, unknown> }).fields;
            out.push({
              id: oid,
              asset: decodeAssetId(f.asset_id),
              price: asNumber(f.price),
            });
          }
        }
        if (!page.hasNextPage || !page.nextCursor) break;
        cursor = page.nextCursor as string;
      }
    }
    return out;
  }
}

function extractBalance(v: unknown): number {
  if (typeof v === "string" || typeof v === "number") return Number(v);
  if (v && typeof v === "object" && "value" in (v as object)) {
    return Number((v as { value: string | number }).value);
  }
  return 0;
}
