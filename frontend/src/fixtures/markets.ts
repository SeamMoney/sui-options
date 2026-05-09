// Stub markets for the empty-state demo. Real markets come from `@wick/sdk`'s
// `WickClient.listMarkets()` — see `useLiveMarkets`.

import type { MarketSnapshot, Side, Direction, Status } from "@wick/sdk";
export { impliedTouchPrice } from "@wick/sdk";
export type { MarketSnapshot, Side, Direction, Status };

const NOW = Date.now();
const MIN = 60 * 1000;
const SUI = "0x2::sui::SUI";

export const STUB_MARKETS: MarketSnapshot[] = [
  {
    id: "0xstub01",
    asset: "BTC/USD",
    direction: "ABOVE",
    barrier: 100_000,
    expiryMs: NOW + 5 * MIN,
    status: "ACTIVE",
    fee_bps: 30,
    collateralVault: 1_000_000,
    touchSupply: 1_000_000,
    noTouchSupply: 1_000_000,
    touchReserve: 1_000_000,
    noTouchReserve: 1_000_000,
    lpSupply: 1_000_000,
    underlyingPrice: 99_212,
    collateralType: SUI,
  },
  {
    id: "0xstub02",
    asset: "BTC/USD",
    direction: "ABOVE",
    barrier: 101_500,
    expiryMs: NOW + 12 * MIN,
    status: "ACTIVE",
    fee_bps: 30,
    collateralVault: 2_500_000,
    touchSupply: 2_500_000,
    noTouchSupply: 2_500_000,
    touchReserve: 1_823_000,
    noTouchReserve: 3_426_000,
    lpSupply: 2_500_000,
    underlyingPrice: 99_212,
    collateralType: SUI,
  },
  {
    id: "0xstub03",
    asset: "SUI/USD",
    direction: "ABOVE",
    barrier: 5_400,
    expiryMs: NOW + 2 * MIN,
    status: "ACTIVE",
    fee_bps: 30,
    collateralVault: 750_000,
    touchSupply: 750_000,
    noTouchSupply: 750_000,
    touchReserve: 690_000,
    noTouchReserve: 815_000,
    lpSupply: 750_000,
    underlyingPrice: 5_312,
    collateralType: SUI,
  },
];
