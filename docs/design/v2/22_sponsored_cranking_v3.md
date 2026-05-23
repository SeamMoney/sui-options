# 22 — Sponsored Cranking (v3)

**Status:** v3 architecture spec — locks the contract surface for Wick v3.
**Companion docs:** [23_storage_rebate_pruning_v3.md](23_storage_rebate_pruning_v3.md), [24_walrus_archive_v3.md](24_walrus_archive_v3.md).
**Author:** Claude Opus 4.7 + Max Mohammadi, 2026-05-23.

---

## 1. The problem this fixes

Today (v2): every `record_segment` call costs ~5M MIST. The cranker is permissionless on the Move side; in practice, three things crank in production:

1. **The keeper bot** — if operators run one, it cranks from `WICK_KEEPER_PRIVATE_KEY`. Limited gas budget; operator subsidizes.
2. **D4 client-side fallback** — if the keeper stalls for >3s, the frontend calls `record_segment` from the user's burner. The user pays.
3. **Nothing** — if no keeper is up and no user is on the page, the chart freezes.

The result on 2026-05-23: user burner has 0.098 SUI, one ride's cranking gas is 100M MIST = 0.1 SUI, so the burner drains mid-ride and the chart freezes anyway. Every successful Sui game (Capy, SuiPlay, Mai_san) avoids this by **sponsoring** cranking from a protocol wallet. v3 makes Wick follow that pattern.

**Goal:** every cranking call on a v3 SegmentMarket has its gas paid by a "Wick Sponsor" wallet funded from the fee router's `protocol_bucket`. User pays $0 gas. User keeps their burner balance for `escrow` and the open/close PTBs only.

## 2. Sui sponsored transactions — what's already in the protocol

Sui supports sponsored transactions natively. The tx envelope carries **two signatures**:

- **Sender signature** — the user / caller. Signs the `TransactionData` (what to do).
- **Sponsor signature** — a separate party. Co-signs and is debited for gas.

The Move contract sees `ctx.sender() == <user>` and `tx_context::gas_owner(ctx) == <sponsor>`. Both are first-class. The user authorizes intent; the sponsor authorizes payment.

`@mysten/sui` SDK ships `TransactionBlock.setSender(user)` + `TransactionBlock.setGasOwner(sponsor)` + a 2-of-2 signing flow. This works on testnet and mainnet today; no new RPC is needed.

The bytecode verifier does **not** distinguish sponsored from non-sponsored — the Move function body is identical either way. The sponsorship is purely transport-layer.

## 3. v3 architecture — four pieces

```
┌──────────┐  1. sign intent (burner)        ┌──────────────┐
│  USER    │ ──────────────────────────────► │  /api/sponsor│  (Vercel function)
│ (burner) │                                  │              │
└──────────┘  4. ack: { digest }              │              │
     ▲                                        │              │
     │                                        │  2. validate │
     │                                        │     allowlist│
     │                                        │     rate-limit
     │                                        │     spend-cap│
     │                                        │              │
     │                                        │  3. co-sign  │
     │                                        │     submit   │
     │                                        └──────┬───────┘
     │                                               │
     │                                               ▼
     │                                        ┌──────────────┐
     │                                        │  SUI CHAIN   │
     │                                        │              │
     │                                        │  - sender =  │
     │                                        │    user      │
     │                                        │  - gas_owner=│
     │                                        │    sponsor   │
     │                                        └──────┬───────┘
     │                                               │
     │                                               ▼
     │                                        ┌──────────────┐
     │                                        │ record_segment
     │                                        │  on chain    │
     │                                        └──────────────┘
     │
     │                       ┌─────────────────────────────────┐
     │                       │  protocol_bucket → sponsor_wallet│ (permissionless harvest)
     │                       │  every N hours                   │
     │                       └─────────────────────────────────┘
```

### 3.1 `wick::sponsor` Move module (new)

```move
module wick::sponsor {
    /// Permissioned cap held by the sponsor service; created in init.
    public struct SponsorCap has key { id: UID }

    /// Shared metadata for the sponsor — funding, daily spend cap, refill
    /// trigger. Bound to fee_router's protocol_bucket via address.
    public struct SponsorPolicy has key {
        id: UID,
        sponsor_address: address,
        max_spend_per_day_mist: u64,
        spend_today_mist: u64,
        last_reset_day: u64,
        refill_threshold_mist: u64,
        refill_target_mist: u64,
    }

    /// Permissionless: pull funds from fee_router::protocol_bucket
    /// into the sponsor wallet when balance drops below threshold.
    public entry fun harvest_to_sponsor<C>(
        policy: &mut SponsorPolicy,
        fee_router: &mut FeeRouter,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sponsor_balance = sui::coin::balance_of(policy.sponsor_address);
        assert!(sponsor_balance < policy.refill_threshold_mist, ENotBelowThreshold);
        let needed = policy.refill_target_mist - sponsor_balance;
        let withdrawn = fee_router::withdraw_protocol<C>(fee_router, needed);
        // Transfer to sponsor address
        sui::transfer::public_transfer(withdrawn, policy.sponsor_address);
    }
}
```

### 3.2 `wick::segment_market_v3` — the new market type

v3 only difference: same logic as v2's `record_segment`, but the new module is **explicitly designed to be called sponsored** (allowlist-checked by the sponsor service). The Move side doesn't enforce sponsorship — that's the sponsor service's job — but the v3 module is the surface the allowlist whitelists.

```move
module wick::segment_market_v3 {
    public(package) entry fun record_segment<C>(
        market: &mut SegmentMarketV3<C>,
        r: &Random,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // identical to v2::record_segment
        // (the sponsorship happens off-chain; the Move call is unchanged)
    }
}
```

### 3.3 `/api/sponsor` — the Vercel sponsor service

```typescript
// api/sponsor.ts
export default async function handler(req: ReqLike, res: ResLike) {
  if (req.method !== "POST") return res.status(405)...;

  const { sender, txBytes, userSig } = req.body;
  //  sender   — 0x-prefixed Sui address of the user
  //  txBytes  — base64-encoded BCS TransactionData
  //  userSig  — user's serialized signature

  // 1. Allowlist check: parse txBytes, assert it's a single MoveCall to
  //    wick::segment_market_v3::record_segment (or open/close), against
  //    a known SegmentMarketV3 id, and the gas owner is sponsorAddress.
  if (!isWhitelistedCall(txBytes)) return res.status(403)...;

  // 2. Rate-limit per sender (5 calls / minute / sender).
  if (!underRateLimit(sender)) return res.status(429)...;

  // 3. Daily spend cap check (load SponsorPolicy, check spend_today_mist).
  if (await wouldExceedDailySpendCap()) return res.status(503)...;

  // 4. Co-sign as gas owner using WICK_SPONSOR_PRIVATE_KEY (env var).
  const sponsorKeypair = Ed25519Keypair.fromSecretKey(process.env.WICK_SPONSOR_PRIVATE_KEY!);
  const sponsorSig = await sponsorKeypair.signTransaction(txBytes);

  // 5. Submit fully-signed tx to fullnode.
  const result = await client.executeTransactionBlock({
    transactionBlock: txBytes,
    signature: [userSig, sponsorSig],
    options: { showEffects: true },
  });

  return res.status(200).json({ digest: result.digest });
}
```

### 3.4 SDK client

```typescript
// sdk/src/sponsored.ts
export async function recordSegmentSponsored(
  client: SuiJsonRpcClient,
  user: Ed25519Keypair,
  marketId: string,
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::segment_market_v3::record_segment`,
    arguments: [tx.object(marketId), tx.object("0x8"), tx.object("0x6")],
    typeArguments: ["0x2::sui::SUI"],
  });
  tx.setSender(user.toSuiAddress());
  tx.setGasOwner(SPONSOR_ADDRESS);

  const txBytes = await tx.build({ client });
  const userSig = await user.signTransaction(txBytes);

  const res = await fetch(`${SPONSOR_URL}/api/sponsor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: user.toSuiAddress(),
      txBytes: toB64(txBytes),
      userSig: toB64(userSig.signature),
    }),
  });
  const { digest } = await res.json();
  return digest;
}
```

## 4. Security invariants

The sponsor service is a high-value attack surface (it has gas the attacker wants). Five invariants:

1. **Allowlist is strict.** Only `record_segment / open_segment_ride / close_segment_ride` on the SegmentMarketV3 type-tag pattern. Any other call → 403.
2. **Gas owner pinned.** The tx's `gas_owner` field must equal the sponsor's address. If user-supplied tx has a different gas owner, reject.
3. **Per-sender rate limit.** 5 sponsored calls / minute / sender. Sliding window. Persisted in KV (Upstash Redis).
4. **Daily spend cap.** SponsorPolicy.max_spend_per_day_mist enforced both off-chain (in the service) and on-chain (in `harvest_to_sponsor`). Halts at cap.
5. **No gas tank refill from user funds.** `harvest_to_sponsor` only pulls from `fee_router::protocol_bucket`. Sponsor wallet is the ONLY recipient.

## 5. Economic model

Funded entirely from protocol fees. The flow:

```
Fees from settling rides → fee_router → protocol_bucket → sponsor wallet → cranking gas
```

Estimated daily cost (with [23](23_storage_rebate_pruning_v3.md) lean storage):
- Sentinel ride: ~10M MIST per round × 10,800 rounds/day = 108B MIST = **108 SUI/day**
- Sponsored user cranking (10 concurrent active users on average): same scale, ~100 SUI/day extra
- **Total: ~200 SUI/day** = ~73,000 SUI/year

At a 50 bps base fee on profit, the protocol breaks even at ~$300/day in trader profit (at $1/SUI testnet equivalent). At any non-toy scale, this is trivially covered.

## 6. Migration plan

V3 ships **alongside** v2 — no breaking change:

| Day | Work |
|---|---|
| 1 | This doc + `23` + `24` finalized |
| 2-3 | `wick::sponsor` Move module + `segment_market_v3` (clone of v2 with rebate hooks per [23](23_storage_rebate_pruning_v3.md)) |
| 4 | `/api/sponsor` Vercel function + Upstash KV for rate limits |
| 5 | `sdk/src/sponsored.ts` + frontend feature flag (V3 markets route through sponsor) |
| 6 | V3 Move upgrade on testnet + bootstrap V3 SegmentMarket + smoke |
| 7 | Sentinel runner (Node script on a Fly machine) → keep V3 chart alive 24/7 |
| 8 | Monitoring + alerting (sponsor balance, daily spend, error rate) |
| 9-10 | V2 deprecation: stop frontend from picking V2 markets; let v2 positions settle naturally |

## 7. What this is NOT

- Not a custodial wallet — user still signs every intent with their own burner. Sponsor only signs gas-payer side.
- Not a meta-transaction relayer in the generic sense — only Wick's specific market calls are sponsored. Allowlist is closed.
- Not a free-money faucet — daily spend cap + rate limits + allowlist mean an attacker can at worst drain the daily cap, never the full sponsor wallet.

## 8. Open questions

- **Sponsor key custody.** For mainnet: multisig or threshold-key? 2-of-3 ops keys for V1, move to threshold (e.g. `tss-ed25519`) once user count justifies.
- **Sponsor failover.** If `/api/sponsor` goes down, fall back to D4 client-side crank for graceful degradation? Yes — but show a "sponsor degraded, gas now from your wallet" badge.
- **Per-market allowlist refresh.** When ops bootstraps a new SegmentMarketV3, how does the sponsor service learn about it? Option A: read `deployments/testnet.json`; Option B: read on-chain index. v3.0 ships with A; v3.1 migrates to B for full decentralization.

## 9. References

- Sui sponsored-tx spec: https://docs.sui.io/concepts/transactions/sponsored-transactions
- Sui `tx_context::gas_owner`: https://docs.sui.io/standard-library/sui/tx_context
- Companion: [`23_storage_rebate_pruning_v3.md`](23_storage_rebate_pruning_v3.md) — pairs with this; lean storage means sponsor budget goes ~3× further
- Companion: [`24_walrus_archive_v3.md`](24_walrus_archive_v3.md) — permanent decentralized archive of pruned segments
