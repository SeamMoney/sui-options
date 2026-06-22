/**
 * Split the faucet wallet's single SUI coin into many — the one-time, no-code fix
 * for the intermittent `/api/faucet` 500s.
 *
 * Root cause (diagnosed 2026-06-22): the faucet drips from one pre-funded wallet.
 * api/faucet.ts already has anti-contention — on each attempt it picks a RANDOM
 * usable gas coin (`setGasPayment`) — but that only engages when the wallet holds
 * **≥2 usable coins**. The wallet currently holds exactly ONE (~8.7K SUI), so every
 * concurrent drip resolves the same coin version and the loser equivocates → 500.
 * Splitting the coin into ~12 pieces makes the existing random-coin picker spread
 * load and eliminates the contention. No code change, no faucet downtime.
 *
 *   WICK_FAUCET_PRIVATE_KEY=suiprivkey1… npx tsx scripts/split-faucet-coins.ts [count]
 *
 * Idempotent: if the wallet already has ≥ target usable coins, it does nothing.
 * Splits are transferred back to the faucet wallet itself — funds never leave it.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const RPC = process.env.WICK_API_RPC ?? "https://sui-testnet-rpc.publicnode.com";
const TARGET = Math.max(2, Math.min(50, Number(process.argv[2] ?? 12)));
const PER_COIN_MIST = 100n * 1_000_000_000n; // 100 SUI per split coin (well above the 0.22 SUI "usable" floor)
const USABLE_FLOOR = 220_000_000n; // DRIP_MIST(0.2) + GAS_BUFFER(0.02), matches api/faucet.ts

async function main() {
  const secret = process.env.WICK_FAUCET_PRIVATE_KEY;
  if (!secret) {
    console.error("WICK_FAUCET_PRIVATE_KEY is not set (the same key /api/faucet uses).");
    process.exit(1);
  }
  const keypair = Ed25519Keypair.fromSecretKey(secret);
  const sender = keypair.getPublicKey().toSuiAddress();
  const client = new SuiJsonRpcClient({ url: RPC, network: "testnet" });

  const coins = await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI", limit: 200 });
  const usable = coins.data.filter((c) => BigInt(c.balance) >= USABLE_FLOOR);
  console.log(`faucet ${sender}`);
  console.log(`  SUI coins: ${coins.data.length}  ·  usable (≥0.22): ${usable.length}  ·  target: ${TARGET}`);

  if (usable.length >= TARGET) {
    console.log(`  already ≥ ${TARGET} usable coins — nothing to do (anti-contention is active).`);
    return;
  }

  const splitsNeeded = TARGET - usable.length;
  console.log(`  splitting off ${splitsNeeded} coin(s) of 100 SUI each, transferred back to the faucet…`);
  const tx = new Transaction();
  const amounts = Array.from({ length: splitsNeeded }, () => PER_COIN_MIST);
  const newCoins = tx.splitCoins(tx.gas, amounts.map((a) => tx.pure.u64(a)));
  tx.transferObjects(
    amounts.map((_, i) => newCoins[i]),
    sender,
  );
  tx.setSender(sender);

  const res = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair, options: { showEffects: true } });
  const ok = res.effects?.status?.status === "success";
  console.log(`  tx ${res.digest} → ${ok ? "SUCCESS" : "FAILED: " + JSON.stringify(res.effects?.status)}`);
  if (ok) {
    const after = await client.getCoins({ owner: sender, coinType: "0x2::sui::SUI", limit: 200 });
    const u2 = after.data.filter((c) => BigInt(c.balance) >= USABLE_FLOOR).length;
    console.log(`  done — wallet now has ${u2} usable SUI coins. The /api/faucet 500s should be gone.`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("split failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
