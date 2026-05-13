# 07 — Wick × DeepBook v3 CLOB integration

**Status:** research / spec, pre-implementation.
**Date:** 2026-05-12.
**TL;DR:** Yes — DeepBook v3 supports permissionless pool creation on Sui testnet today. Wick can list `Coin<Position<M, Side>>` against DUSDC for secondary trading, but must (a) Coin'ify positions (replace today's `Position has key, store` object with a `Coin<Position<M, Side>>` issued by a per-market `TreasuryCap`), (b) acquire 500 DEEP per pool on testnet (no faucet — must get airdropped or beg from the DeepBook team), and (c) round price/quantity onto a `power-of-ten` tick/lot grid. The killer demo — "sell your touch ticket before expiry on a real CLOB" — is achievable inside the hackathon scope; OTC fallback is cheap insurance.

All deepbookv3 quotes below are from the `main` branch as of 2026-05-12, commit visible at <https://github.com/MystenLabs/deepbookv3>. The DeepBook testnet package is at version 19 and live: `0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8`.

---

## 1. Pool creation API

From `packages/deepbook/sources/pool.move:150` (verbatim):

```move
public fun create_permissionless_pool<BaseAsset, QuoteAsset>(
    registry: &mut Registry,
    tick_size: u64,
    lot_size: u64,
    min_size: u64,
    creation_fee: Coin<DEEP>,
    ctx: &mut TxContext,
): ID {
    assert!(creation_fee.value() == constants::pool_creation_fee(), EInvalidFee);
    let base_type = type_name::with_defining_ids<BaseAsset>();
    let quote_type = type_name::with_defining_ids<QuoteAsset>();
    let whitelisted_pool = false;
    let stable_pool = registry.is_stablecoin(base_type)
        && registry.is_stablecoin(quote_type);

    create_pool<BaseAsset, QuoteAsset>(
        registry,
        tick_size,
        lot_size,
        min_size,
        creation_fee,
        whitelisted_pool,
        stable_pool,
        ctx,
    )
}
```

**Type-parameter constraints.** None — `BaseAsset` and `QuoteAsset` are bare `phantom`-style type parameters. There is *no* `store`, `drop`, or `key` ability requirement on the type itself, because DeepBook only ever holds a `Balance<BaseAsset>` / `Balance<QuoteAsset>` inside its own `Vault`. What DeepBook *does* require is that some `TreasuryCap<BaseAsset>` exists on-chain — practically meaning the type must be a registered `Coin<T>`. This is the load-bearing requirement for Wick.

The only enforced relationships at the type level are:
- `BaseAsset != QuoteAsset` (`ESameBaseAndQuote`, line 1830).
- The pool cannot be both `whitelisted` and `stable`. Permissionless pools are always `whitelisted = false`. They become `stable = true` automatically iff *both* base and quote types are registered as stablecoins on the `Registry`.

---

## 2. DEEP token requirement

From `packages/deepbook/sources/helper/constants.move:7`:

```move
const POOL_CREATION_FEE: u64 = 500 * 1_000_000; // 500 DEEP
const DEEP_UNIT: u64 = 1_000_000;
```

So **pool creation costs exactly 500 DEEP** (in the smallest unit: 500 × 10^6 = `500_000_000`). The fee is `transfer::public_transfer`'d to the registry's `treasury_address` — it is not burned and not refundable.

**Sourcing DEEP on testnet.** This is the single biggest operational risk. There is no public DEEP faucet. The historical "DeepBook Testnet Campaign" distributed DEEP as airdrops to participants who used partner aggregators (FlowX, 7k, KriyaDex, Turbos). Three realistic paths for the hackathon:

1. **Beg, borrow, or swap** — DEEP is tradable on the existing `DEEP/SUI` and `DEEP/DBUSDC` testnet pools created by Mysten. Buy 500+ DEEP through `place_market_order` against testnet SUI faucet drip.
2. **Reach out to DeepBook devrel** — they routinely whitelist testnet builders.
3. **Reuse one pool per side** — one `Touch/USDC` and one `NoTouch/USDC` pool *per market*. With ~10 demo markets × 2 sides = ~10,000 DEEP. Realistically we can demo with 1–2 markets fully Coin'ified and CLOB-listed (1–2k DEEP).

If DEEP is unobtainable, fall back to §10's OTC plan.

---

## 3. Coin requirements — the Wick refactor

DeepBook v3 does not call into a global `CoinRegistry`. It has its own `deepbook::registry::Registry` shared object that simply tracks pool keys, stablecoin whitelist (admin-only), and balance manager keys. Permissionless pool creation does *not* require pre-registration of either coin type.

What it *does* require, indirectly: the `Coin<DEEP>` and `Coin<USDC>` arguments at trade time must be real `sui::coin::Coin<T>` instances backed by a `TreasuryCap<T>`. So our position type **must be a Coin, not a `key, store` object**.

Today, `move/sources/market.move` defines:

```move
public struct Position has key, store {
    id: UID,
    market_id: ID,
    side: u8,
    stake: u64,
    payout_if_win: u64,
}
```

This must be refactored into:

```move
// Phantom witnesses for type safety. Each concrete market gets a unique
// `Position<M, Touch>` and `Position<M, NoTouch>` Coin type via a generated
// witness module — see §8.
public struct Touch has drop {}
public struct NoTouch has drop {}

// One TreasuryCap per (market, side) — held inside the Market<C> object.
public struct PositionCaps<phantom C, phantom M> has store {
    touch_cap: TreasuryCap<Position<M, Touch>>,
    no_touch_cap: TreasuryCap<Position<M, NoTouch>>,
}
```

`open_touch` mints `Coin<Position<M, Touch>>` of value = stake. `redeem` burns it via the `TreasuryCap` and pays out collateral.

There is *one* unavoidable wrinkle in Sui Move: a `Coin<T>` requires `T` to be a one-time-witness (OTW) created at module init. You cannot mint a fresh OTW per market at runtime. The two practical workarounds:

- **Option A — generic phantom market type, unique witness module per market.** Each market is bootstrapped by a script that emits and `sui client publish`'s a tiny one-shot module: `module wick_market_<UUID> { public struct M has drop {} fun init(otw: M, ctx) { … } }`. The TreasuryCap is then handed back into `wick::market::create_with_caps`. Heavy but real.
- **Option B — fungible Wick-wide position coins keyed by side, with market discrimination via DeepBook's pool isolation.** A single `Coin<TouchTicket>` and `Coin<NoTouchTicket>` exists protocol-wide; market-specific value is enforced because each market has its *own* CLOB pool (the pool's own pair `(Touch_M, USDC)` only ever accepts positions issued by Market `M` — but this is **not safe**, because a `Coin<TouchTicket>` is fungible across markets at the type system level. Risk of cross-market arb / drain. **Reject.**
- **Option C — use a DeepBook v3 *whitelisted* pool with admin-issued caps.** Out of scope (we don't have an admin cap).

**Decision: Option A.** The hackathon demo only needs 1–2 markets Coin'ified to prove the killer composition. The bootstrap script handles the publish step. Documented in §8.

---

## 4. Tick size and lot size constraints

From `pool.move:1821-1827` (verbatim):

```move
assert!(tick_size > 0, EInvalidTickSize);
assert!(math::is_power_of_ten(tick_size), EInvalidTickSize);
assert!(lot_size >= 1000, EInvalidLotSize);
assert!(math::is_power_of_ten(lot_size), EInvalidLotSize);
assert!(min_size > 0, EInvalidMinSize);
assert!(min_size % lot_size == 0, EInvalidMinSize);
assert!(math::is_power_of_ten(min_size), EInvalidMinSize);
```

So:
- `tick_size`, `lot_size`, `min_size` must all be **exact powers of ten**.
- `lot_size >= 1_000`.
- `min_size` is a multiple of `lot_size` *and* itself a power of ten — this constrains `min_size ∈ {lot_size, 10·lot_size, 100·lot_size, …}`.
- DeepBook prices are scaled with `FLOAT_SCALING = 1_000_000_000` (1e9) — i.e. price field carries 9 implied decimal places of *quote-per-base* in the raw on-chain units, adjusted for coin decimals.

**Recommended defaults for binary option positions** (assume position coin has 6 decimals, USDC has 6 decimals, payout cap = 1.0 USDC per position unit):

| param      | raw u64           | meaning                                                              |
|------------|-------------------|----------------------------------------------------------------------|
| `tick_size`| `1_000_000`       | 0.001 USDC per position unit ≈ 0.1¢ price granularity                |
| `lot_size` | `1_000`           | 0.001 position-token min increment                                   |
| `min_size` | `10_000`          | 0.01 position-token min order                                        |

The 0.001 USDC tick gives ~1000 distinct quotable probabilities between 0 and 1.0 — enough to make markets responsive without spam.

---

## 5. Live testnet artifacts

All confirmed against `MystenLabs/deepbookv3@main` and the `@mysten/deepbook-v3` SDK constants:

| artifact | testnet ID |
|---|---|
| **DeepBook v3 package (latest published)** | `0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8` |
| **DeepBook v3 package (original / v0)** | `0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982` |
| **Registry shared object** | `0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1` |
| **DEEP coin type** | `0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP` |
| **DEEP treasury (admin-burn / governance)** | `0x69fffdae0075f8f71f4fa793549c11079266910e8905169845af1f5d00e09dcb` |
| **DBUSDC (testnet USDC stand-in) coin type** | `0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC` |
| **Admin cap owner** | `0xb3d277c50f7b846a5f609a8d13428ae482b5826bb98437997373f3a0d60d280e` |
| **Sui testnet faucet (SUI only)** | <https://faucet.testnet.sui.io/v2/gas> |
| **DeepBook testnet RPC** | `https://fullnode.testnet.sui.io:443` |
| **Sui explorer (verify package live)** | <https://suiscan.xyz/testnet/object/0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8> |
| **Sui explorer (verify registry live)** | <https://suiscan.xyz/testnet/object/0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1> |

(There is no native `USDC` on testnet — DeepBook uses `DBUSDC`. Wick's DUSDC test token at `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a` is *separate* and would need its own pools.)

---

## 6. Sample working PTB — create a `Position<M,Touch>` / DBUSDC pool on testnet

```ts
// keeper/scripts/createCLOBPool.ts
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const DEEPBOOK_PKG    = "0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8";
const REGISTRY_ID     = "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";
const DEEP_TYPE       = "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP";
const DBUSDC_TYPE     = "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

// Per-market witness type, generated and published in the bootstrap script.
const WICK_PKG        = process.env.WICK_PKG!;        // wick package
const MARKET_PKG      = process.env.MARKET_PKG!;      // tiny per-market witness pkg
const TOUCH_TYPE      = `${MARKET_PKG}::market_witness::Position<${MARKET_PKG}::market_witness::M, ${WICK_PKG}::market::Touch>`;

// 500 DEEP, raw units (DEEP has 6 decimals).
const POOL_CREATION_FEE = 500_000_000n;

// Power-of-ten params from §4.
const TICK_SIZE = 1_000_000n; // 0.001 DBUSDC
const LOT_SIZE  = 1_000n;     // 0.001 position
const MIN_SIZE  = 10_000n;    // 0.01 position

async function main() {
  const client = new SuiClient({ url: getFullnodeUrl("testnet") });
  const kp = Ed25519Keypair.fromSecretKey(/* ... */);
  const sender = kp.toSuiAddress();

  // Pre-fetch the user's DEEP coin object, large enough to split 500.
  const { data } = await client.getCoins({ owner: sender, coinType: DEEP_TYPE });
  if (!data.length) throw new Error("no DEEP coins — get DEEP first, see §2");

  const tx = new Transaction();
  // Split exactly POOL_CREATION_FEE off the largest DEEP coin.
  const [deepFee] = tx.splitCoins(tx.object(data[0].coinObjectId), [tx.pure.u64(POOL_CREATION_FEE)]);

  const poolId = tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::create_permissionless_pool`,
    typeArguments: [TOUCH_TYPE, DBUSDC_TYPE],
    arguments: [
      tx.object(REGISTRY_ID),
      tx.pure.u64(TICK_SIZE),
      tx.pure.u64(LOT_SIZE),
      tx.pure.u64(MIN_SIZE),
      deepFee,
      // ctx is implicit in PTB
    ],
  });

  // Pool ID is returned but the pool itself is share_object'd inside the call.
  // Capture it via the PoolCreated event in the tx response.
  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
  const created = res.events?.find(e => e.type.endsWith("::pool::PoolCreated"));
  console.log("pool_id", (created?.parsedJson as any)?.pool_id);
}
main();
```

---

## 7. Order placement — limit, market, cancel

DeepBook v3 trading is mediated by a `BalanceManager` shared object that holds the user's deposited base/quote/DEEP. Every order requires a `TradeProof` minted in the same PTB (cap-based, so it composes with sponsored txs).

### One-time: create a balance manager
```ts
const [bm] = tx.moveCall({
  target: `${DEEPBOOK_PKG}::balance_manager::new`,
  arguments: [],
});
tx.moveCall({
  target: `${DEEPBOOK_PKG}::balance_manager::share`,
  arguments: [bm],
});
```

### Limit order
```ts
const proof = tx.moveCall({
  target: `${DEEPBOOK_PKG}::balance_manager::generate_proof_as_owner`,
  arguments: [tx.object(BM_ID)],
});
// Deposit position coins + DBUSDC + DEEP into the balance manager first…
tx.moveCall({
  target: `${DEEPBOOK_PKG}::balance_manager::deposit`,
  typeArguments: [TOUCH_TYPE],
  arguments: [tx.object(BM_ID), positionCoin],
});

tx.moveCall({
  target: `${DEEPBOOK_PKG}::pool::place_limit_order`,
  typeArguments: [TOUCH_TYPE, DBUSDC_TYPE],
  arguments: [
    tx.object(POOL_ID),
    tx.object(BM_ID),
    proof,
    tx.pure.u64(client_order_id),
    tx.pure.u8(0),                  // NO_RESTRICTION
    tx.pure.u8(0),                  // SELF_MATCHING_ALLOWED
    tx.pure.u64(price),             // scaled by FLOAT_SCALING (1e9)
    tx.pure.u64(quantity),          // base units, multiple of lot_size
    tx.pure.bool(is_bid),
    tx.pure.bool(true),             // pay_with_deep — must be true in v3
    tx.pure.u64(expire_ts_ms),
    tx.object("0x6"),               // Clock
  ],
});
```

Reference Move signature (from `pool.move:180`):
```move
public fun place_limit_order<BaseAsset, QuoteAsset>(
    self: &mut Pool<BaseAsset, QuoteAsset>,
    balance_manager: &mut BalanceManager,
    trade_proof: &TradeProof,
    client_order_id: u64,
    order_type: u8,
    self_matching_option: u8,
    price: u64,
    quantity: u64,
    is_bid: bool,
    pay_with_deep: bool,
    expire_timestamp: u64,
    clock: &Clock,
    ctx: &TxContext,
): OrderInfo
```

### Market order
Identical args minus `price`, `order_type`, `expire_timestamp`:
```move
public fun place_market_order<BaseAsset, QuoteAsset>(
    self, balance_manager, trade_proof,
    client_order_id, self_matching_option,
    quantity, is_bid, pay_with_deep,
    clock, ctx,
): OrderInfo
```
Internally it calls `place_limit_order` with `IMMEDIATE_OR_CANCEL` and `MAX_PRICE` / `MIN_PRICE`.

### Cancel
```move
public fun cancel_order<BaseAsset, QuoteAsset>(
    self, balance_manager, trade_proof,
    order_id: u128, clock, ctx,
)
```
`order_id` is the `u128` returned in the `OrderInfo` from the original placement (also emitted in the `OrderPlaced` event).

---

## 8. Wick integration plan — bootstrap and keeper roles

### 8.1 New `bootstrap_pull_market_with_clob`

Today's `bootstrap_pull_market<C>` (move/sources/wick.move:78) creates the market, path, oracle, and feed. The CLOB extension adds:

1. **Generate a per-market witness module.** A keeper-side TS script:
   - reads the next available market UUID,
   - templates `move/dyn_markets/wick_market_<UUID>/sources/witness.move` containing:
     ```move
     module wick_market_<UUID>::market_witness;
     public struct M has drop {}
     public struct WITNESS_OTW has drop {}
     fun init(otw: WITNESS_OTW, ctx: &mut TxContext) {
         // The two TreasuryCaps live inside the Wick Market<C> after bootstrap.
         let touch_cap = wick::market::mint_witness_caps_touch<M>(ctx);
         let no_touch_cap = wick::market::mint_witness_caps_no_touch<M>(ctx);
         transfer::public_transfer(touch_cap, tx_context::sender(ctx));
         transfer::public_transfer(no_touch_cap, tx_context::sender(ctx));
     }
     ```
   - publishes it (`sui client publish`),
   - captures the two `TreasuryCap` IDs from the publish effects.

2. **Call the new bootstrap entrypoint** that takes the caps + the standard pull-market args:

```move
public entry fun bootstrap_pull_market_with_clob<C, M>(
    name: String, underlying: String, upstream_id: String,
    keeper_cap: &KeeperCap,
    barrier: u64, direction: u8,
    expiry_ms: u64, settlement_freshness_ms: u64,
    payout_multiplier_bps: u64,
    seed_collateral: Coin<C>,
    touch_cap: TreasuryCap<Position<M, Touch>>,
    no_touch_cap: TreasuryCap<Position<M, NoTouch>>,
    ctx: &mut TxContext,
) {
    // …existing oracle + path + market construction…
    market::store_caps(&mut market, touch_cap, no_touch_cap);
    market::share(market);
    // …
}
```

3. **In the same outer PTB**, call DeepBook to create both pools — `Touch/DBUSDC` and `NoTouch/DBUSDC` — using the §6 pattern. Two `create_permissionless_pool` calls = 1000 DEEP burned per market.

4. **Persist pool IDs** on the `Market` object via a small `set_clob_pools(&mut Market, touch_pool_id, no_touch_pool_id)` so the keeper and frontend can find them.

### 8.2 Keeper's job

The keeper now has three concurrent loops:

- **Path-update loop** (existing) — pushes upstream prices into `path_observation`.
- **CLOB seeding loop** (new) — on market creation, deposit a small inventory of position tokens + DBUSDC into a Wick-owned BalanceManager, then place initial 2-sided quotes (see §9).
- **CLOB rebalance loop** (new) — on each path-update tick, re-quote both pools with fresh fair-value bids/asks. If the keeper is touched, withdraw / re-deposit to manage one-sided inventory.

---

## 9. Pricing — the keeper as binary-option market maker

### 9.1 Theoretical fair value

For a touch option observed by an oracle at random tick times, with current spot `S`, barrier `B`, time-to-expiry `T`, instantaneous vol `σ`:

$$
P_{\text{touch}}(S, B, T, \sigma) \;\approx\; 1 - \Phi(d_+) + \left(\frac{B}{S}\right)^{2\mu/\sigma^2}\Phi(d_-)
$$

(the Reiner-Rubinstein closed form; we already have a simplified `touch_probability` helper in `path_observation`). Touch payout is `payout_multiplier_bps / 10_000` per position unit. So:

```
fair_value_touch    = touch_probability * payout
fair_value_no_touch = (1 - touch_probability) * payout
```

(Already enforced by the collateral invariant: `touch + no_touch = 1.0 * payout`.)

### 9.2 Keeper quoting logic

```ts
async function quoteMarket(market: WickMarket) {
  const p_touch = await pathOracle.touchProbability(market.id);
  const payout = market.payout_per_unit;   // e.g. 1.0 DBUSDC

  const fv_touch    = p_touch * payout;
  const fv_no_touch = (1 - p_touch) * payout;

  const SPREAD_BPS  = 50;    // ±50bps half-spread → 1% spread
  const SIZE_TOUCH  = 100;   // 100 position tokens per side
  const SKEW_BPS    = inventorySkewBps(market);  // shift quote based on inventory

  for (const [pool, fv] of [[market.touchPool, fv_touch], [market.noTouchPool, fv_no_touch]]) {
    const bid = scaleToFloat(fv * (1 - (SPREAD_BPS - SKEW_BPS) / 10_000));
    const ask = scaleToFloat(fv * (1 + (SPREAD_BPS + SKEW_BPS) / 10_000));

    await cancelAllOrders(pool, market.bm);
    await placeLimit(pool, market.bm, bid, SIZE_TOUCH, /*is_bid*/ true);
    await placeLimit(pool, market.bm, ask, SIZE_TOUCH, /*is_bid*/ false);
  }
}
```

Key invariants the keeper enforces:
- Never quote `bid >= ask` (sanity).
- Never quote `ask > payout * 1.0` or `bid < 0` (impossible prices).
- Throttle: re-quote at most every `min_requote_ms` to avoid churn.
- If the `path_observation` flips to `HIT`, immediately cancel everything — the position is a $1 redeem ticket, not a quote.

---

## 10. Failure modes and the OTC fallback

| failure | likelihood | mitigation |
|---|---|---|
| DeepBook v3 testnet package gets bumped beyond what `current_version` allows | low — versioned objects, allowed_versions list | use `published-at` from `Published.toml`, not the original-id; track `version = 19` |
| Cannot acquire 500+ DEEP per pool | **medium-high** | swap on existing testnet `DEEP/SUI` pool via `swap_exact_quote_for_base`; fall back to OTC §10.1 |
| Coin'ifying `Position` breaks the invariant tests | medium | add new `invariants.move` cases for mint-burn against `TreasuryCap`; the supply equality check already proves conservation |
| Per-market witness publish flow takes too long (~3s × N markets) | low | only Coin'ify the 1–2 demo markets; rest stay as `key, store` Position objects |
| Pool creation requires admin permission we don't have | **none** — `create_permissionless_pool` is `public fun`, no cap | n/a |
| Tick/lot rounding makes prices visibly wrong on UI | low | the 1e9 FLOAT_SCALING + 0.001 tick gives 0.1¢ resolution |

### 10.1 OTC fallback ("Wick OTC")

If DeepBook integration slips, ship a peer-to-peer OTC layer in 1 day:

```move
public struct OtcOrder<phantom C, phantom T> has key, store {
    id: UID,
    market_id: ID,
    maker: address,
    side: u8,                       // bid or ask
    price_per_unit: u64,            // in C
    size: u64,                      // in position tokens
    locked_collateral: Balance<C>,  // for bids — escrow
    locked_position: Option<Position>, // for asks — escrow the ticket
    expires_ms: u64,
}

public fun post_bid<C>(market: &Market<C>, price: u64, size: u64,
                       collateral: Coin<C>, expires_ms: u64, ctx)
public fun post_ask<C>(market: &Market<C>, price: u64, position: Position,
                       expires_ms: u64, ctx)
public fun fill_bid<C>(order: &mut OtcOrder<C, _>, position: Position, ctx): Coin<C>
public fun fill_ask<C>(order: &mut OtcOrder<C, _>, payment: Coin<C>, ctx): Position
public fun cancel<C>(order: OtcOrder<C, _>, ctx): (...)
```

Frontend lists open `OtcOrder` objects via event indexing. No DeepBook dependency, no DEEP needed, ships in an afternoon. Demo narrative degrades from "live CLOB" to "P2P escrow marketplace" — still genuinely useful, just less impressive.

---

## 11. Verification commands

Run from any machine with `sui` CLI on testnet:

```bash
# 0. Confirm CLI is on testnet.
sui client active-env  # expect: testnet

# 1. Confirm DeepBook v3 package is alive on testnet.
sui client object 0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8

# 2. Confirm Registry shared object exists.
sui client object 0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1

# 3. Confirm DEEP coin type is published.
sui client object 0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8

# 4. Inspect what your wallet holds in DEEP.
sui client gas
sui client objects --json | jq '.[] | select(.data.type | tostring | contains("::deep::DEEP"))'

# 5. Get testnet SUI for gas.
curl --location --request POST 'https://faucet.testnet.sui.io/v2/gas' \
  --header 'Content-Type: application/json' \
  --data-raw "{\"FixedAmountRequest\":{\"recipient\":\"$(sui client active-address)\"}}"

# 6. Acquire DEEP by swapping on existing DEEP/SUI testnet pool — see scripts/buy-deep.ts.

# 7. Publish a junk coin to use as a pool base.
cd /tmp && cargo new --lib junkcoin && # …or cribbed from packages/dbtc
sui client publish --gas-budget 200000000 ./junkcoin

# 8. Create the test pool with junk coin / DBUSDC.
ts-node keeper/scripts/createCLOBPool.ts \
  --base-type "$JUNK_TYPE" \
  --quote-type "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC"

# 9. Verify the new pool object on chain.
sui client object $POOL_ID --json | jq .data.type
# expect: "<DEEPBOOK_PKG>::pool::Pool<<JUNK>, <DBUSDC>>"
```

---

## Final verdict

DeepBook v3 listing is **viable on testnet today** with two caveats: (1) we need 500 DEEP per pool and there's no faucet, and (2) we need to ship the `Position-as-Coin` refactor with a per-market witness publish step. Both are surmountable in a hackathon timeframe for 1–2 flagship markets. The full prize-winning demo — "Predict gives BTC its candle, Wick mints a touch ticket, you sell that ticket on a real CLOB before it expires" — is a real composition, not a story. OTC is the safety net.
