# @wick/sdk

TypeScript SDK for [Wick Markets](../README.md) — short-dated touch / no-touch
options and the on-chain **streaming ride** primitive on Sui.

```bash
npm install @wick/sdk @mysten/sui
```

The SDK is **read methods + transaction builders only — no signer**. Every
builder returns a `@mysten/sui` `Transaction` with the sender set and nothing
signed, so the same code runs behind a browser wallet, an `Ed25519Keypair`
service key (the keeper), the API, or the CLI. You pick the signer.

## Read client

```ts
import { WickClient } from "@wick/sdk";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import deployment from "../deployments/testnet.json";

const sui = new SuiJsonRpcClient({ network: "testnet", url: "https://sui-testnet-rpc.publicnode.com" });
const wick = new WickClient({ sui, deployment });

const markets = await wick.listMarkets({ collateralType: "0x2::sui::SUI" });
const positions = await wick.listPositions("0x…address");
```

`WickClient` read methods: `listMarkets({ collateralType? })`, `getMarket(id)`,
`listPositions(address)`, `listLpPositions(address)`, `listOracles()`,
`findOracleForAsset(asset)`, plus type-tag helpers (`marketTypeTag`,
`positionTypeTag`, …).

## The live path — v4 streaming ride (`segmentMarketV4`)

The shipped demo (`/ride`) is a **direction-neutral ride**: you escrow a stake,
hold the screen, and touch on *either* barrier wins the jackpot. Settlement is
permissionless. Builders mirror the `wick::segment_market_v4` Move ABI:

```ts
import { buildOpenSegmentRideV4Tx, SETTLEMENT_NAME_V4 } from "@wick/sdk";

// Open a ride against the current round (caller signs + executes).
const m = deployment.segment_markets_v4[0]; // { market, vault, collateral, … }
const tx = buildOpenSegmentRideV4Tx({
  packageId: deployment.package_id,
  collateralType: m.collateral,         // "0x2::sui::SUI"
  sender: "0x…address",
  marketId: m.market,
  vaultId: m.vault,
  botRegistryId: deployment.bot_registry,
  stakePerSegment: 1_000_000n,   // MIST per ~400ms segment
  escrowMist: 50_000_000n,       // total locked; ≥ stakePerSegment × segments
  // Non-SUI collateral (e.g. TUSD): pass escrowSourceCoinId (+ additionalCoinIds
  // to auto-merge dust coins). SUI splits straight from gas.
});
```

Builders: `buildBootstrapSegmentMarketV4Tx` (admin), `buildRecordSegmentV4Tx`
(keeper crank), `buildOpenSegmentRideV4Tx`, `buildCloseSegmentRideV4Tx` (cash
out — touch wins ties at the boundary), `buildCrankExpiredSegmentRideV4Tx`,
`buildAbortSegmentRideV4Tx` (1:1 refund). Settlement enum:
`SETTLEMENT_OPEN_V4 / TOUCH_WIN_V4 / CASHOUT_V4 / EXPIRED_LOSS_V4 /
ABORTED_REFUND_V4` with `SETTLEMENT_NAME_V4[…]`. Touched-side constants:
`TOUCHED_UPPER / TOUCHED_LOWER / TOUCHED_NONE`.

### Gas-sponsored variants (`sponsored`)

`configureSponsoredTransactions(config)` then `openSegmentRideSponsored(…)`,
`closeSegmentRideSponsored(…)`, `recordSegmentSponsored(…)` co-sign cranking
from a protocol sponsor wallet so the player needs no gas of their own.

## Provably-fair candles — `seededPath`

The exact TypeScript mirror of the Move `expand_segment` walk. Same 32-byte
segment key in ⇒ byte-identical candles out — this is what makes
[`/verify`](../README.md) able to re-derive any on-chain ride off a public RPC,
and it's pinned at **10,000 vectors** against the Move tests in CI
(`npm run conformance:check`).

```ts
import { expandSegment, PATTERN_NAME, SETTLEMENT_NAME_V4 } from "@wick/sdk";

const { candles, state: next } = expandSegment(walkState, segmentKey32);
// candles: 6 per segment, integer fixed-point; carry `next` into the following key.
```

Also exported: `CANDLES_PER_SEGMENT`, `TICKS_PER_CANDLE`, regime helpers
(`regimeDriftForRound`, `applyCumulativeDrift`, `REGIME_LABEL`), the armed-pattern
shaper FSM (`detectArmedPattern`), and the `PATTERN_*` / `PATTERN_NAME` catalog
(doji, hammer, shooting star, bullish/bearish engulfing, three white soldiers).

## Verify a /pro round — `proFairness`

A one-import, independent commit-reveal check for the **Wick Pro** options game.
Each round publishes `commit = SHA-256(`${seed}:${paramsJson}`)` before the lobby
and reveals `{ seed, paramsJson }` at settle:

```ts
import { verifyProRound } from "@wick/sdk";
// the three values the UI shows (also returned by the host's `reveal-seed` event):
const honest = verifyProRound(publishedCommit, revealedSeed, revealedParamsJson); // boolean
```

Hashes with `@noble/hashes` (sync, browser + node) — **independent of the round
engine**, so verifying doesn't trust the thing being verified. Same guarantee as
`npm run verify:pro-fairness` and `POST /api/verify-pro`. Also exports
`proRoundCommit(seed, paramsJson)` if you want the digest itself.

## Candle pattern detection — `patterns`

A pure post-hoc detector catalog over a window of `Candle`s — the same shapes
the in-app coach surfaces:

```ts
import { detectPatterns } from "@wick/sdk";
const matches = detectPatterns(candleWindow); // PatternMatch[]
```

`detectPatterns(window)`, `detectPatternsAt(window, i)`,
`detectPostHocPattern(window)`, plus ~50 single/two/multi-candle predicates
(`isDoji`, `isHammer`, `isMarubozu`, `isEngulfing`, `isHarami`, `isPiercing`,
`isDarkCloudCover`, …).

## Touch / No-Touch market builders (`transactions`) — ⚠️ DEPRECATED (retired v1 ABI)

> **Do not use for new integrations.** These target the retired v1
> `wick::create_market` / `buy_touch` / `swap` / `redeem_complete_set` /
> `mark_hit` ABI, which **no longer exists in the shipped package** — a tx built
> from any of them aborts on-chain. They're kept (each marked `@deprecated`; see
> the module banner in [`src/transactions.ts`](src/transactions.ts)) only because
> unrouted legacy UI + bots still import them. **For the live surface** use the
> segment-market / ride builders above (`buildOpenSegmentRideV4`,
> `buildRecordSegmentV4`, `buildCloseSegmentRideV4`, `buildBootstrapSegmentMarketV4`,
> …) plus the touch facade `open_touch` / `open_no_touch` + `lock_and_settle` +
> `redeem`.

Legacy builders (all `@deprecated`): `buildCreateMarketTx`, `buildBuyTx`,
`buildSwapTx`, `buildRedeemCompleteSetTx`, `buildRedeemWinnerTx`, `buildRedeemLpTx`,
`buildMarkHitTx`, `buildSettleExpiredTx`.

## Helpers

- `mistToSui` / `suiToMist` / `MIST_PER_SUI` — display ↔ on-chain units
- `shortAddr(addr)` — `0x1234…abcd`
- `cpmmOut` — exact mirror of `wick::cpmm_out` (preview a swap before sending)
- `impliedTouchPrice` — implied probability from CPMM reserves
- `STATUS_NAME`, `SIDE_NAME`, `DIRECTION_NAME`, `SIDE_CODE`, `DIRECTION_CODE`,
  `ERROR_CODES` — enum + abort-code lookups

## Why no signer in the SDK

By design. The builder shape is identical on the keeper (Ed25519 service key),
the frontend (browser wallet), the API (read-only), and external integrations.
Signing is environment-specific — keeping it out of the SDK avoids leaky
abstractions and lets each consumer pick the right signer for its context.
