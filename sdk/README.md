# @wick/sdk

TypeScript SDK for [Wick Markets](../README.md) — touch / no-touch options on Sui.

```bash
npm install @wick/sdk @mysten/sui
```

## Quick start

```ts
import { WickClient, buildBuyTx } from "@wick/sdk";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import deployment from "./deployments/testnet.json";

const sui = new SuiJsonRpcClient({
  network: "testnet",
  url: getJsonRpcFullnodeUrl("testnet"),
});
const wick = new WickClient({ sui, deployment });

// list every live market for the SUI collateral type
const markets = await wick.listMarkets({ collateralType: "0x2::sui::SUI" });

// build a TX to bet 100k MIST on TOUCH (caller signs and executes)
const tx = buildBuyTx({
  packageId: deployment.package_id,
  collateralType: "0x2::sui::SUI",
  sender: "0x...your-address",
  marketId: markets[0].id,
  side: "TOUCH",
  riskMist: 100_000n,
});
```

## What's in the box

### `WickClient` — read methods

- `listMarkets({ collateralType? })` — every market emitted via `MarketCreated`
- `getMarket(id)` — single market state
- `listPositions(address)` — all open `Position` objects owned by `address`
- `listLpPositions(address)` — all `LpPosition` shares owned by `address`
- `findOracleForAsset(asset)` — find a `MockOracle` whose feed key matches
- `listOracles()` — every `MockOracle` known to the deployment

### Transaction builders — write methods

Every builder takes the package id + collateral type + sender, returns a
`Transaction` with no signer attached. Use `useSignAndExecuteTransaction`
(dApp Kit), an `Ed25519Keypair`, or the CLI to sign.

- `buildCreateMarketTx` — open a new market
- `buildBuyTx` — `buy_touch` / `buy_no_touch` (parameterized by `side`)
- `buildSwapTx` — swap an existing position to the other side
- `buildRedeemCompleteSetTx` — pre-settlement exit
- `buildRedeemWinnerTx` — post-settlement winning-side claim
- `buildRedeemLpTx` — post-settlement LP claim
- `buildMarkHitTx` / `buildSettleExpiredTx` — keeper paths

### Helpers

- `mistToSui` / `suiToMist` — display ↔ on-chain unit conversion
- `cpmmOut` — exact mirror of `wick::cpmm_out` (preview swap output before sending)
- `impliedTouchPrice` — implied probability from CPMM reserves
- `STATUS_NAME`, `SIDE_NAME`, `DIRECTION_NAME`, `ERROR_CODES` — enum + abort code lookups

## Why no signer in the SDK

By design. The SDK is the same shape on the keeper (Ed25519 service key),
the frontend (browser wallet), the API (read-only), and external integrations.
Signing is environment-specific — keeping it out of the SDK avoids leaky
abstractions and lets each consumer pick the right signer for their context.
