#!/usr/bin/env tsx
/**
 * judge-halt-smoke — drive a LIVE `MARKET HALT` (v4.26 rug) and prove it was an
 * honest roll. The "house wins" companion to `scripts/judge-ride-smoke.ts`.
 *
 *   WICK_FAUCET_PRIVATE_KEY=suiprivkey1... npx tsx scripts/judge-halt-smoke.ts
 *   # or: WICK_FAUCET_PRIVATE_KEY=... npm run smoke:halt
 *
 * The README leads with the MARKET HALT ("~1.5%/segment the market freezes and
 * wipes any open ride — that's how the house wins"). `verify:halt` proves a
 * *historical* halt was honest; this script makes one happen LIVE: it opens a
 * touch-either ride and cranks the chain until the deterministic per-segment
 * rug roll fires inside the ride's round, wiping it (`EXPIRED_LOSS`), then hands
 * the wiped ride to `verify-v4.ts` which re-derives the keccak halt-roll and
 * confirms `roll < rug_chance_bps` (HONEST). The house can neither fake a halt
 * nor suppress one — and you just watched it happen on-chain.
 *
 * Because the roll is ~1.5%/segment, a halt lands in a given 75-segment round
 * ~68% of the time; the script retries with a fresh ride each round (bounded)
 * until one is caught. Cranking is gas-heavy, so it uses the operator wallet
 * (WICK_FAUCET_PRIVATE_KEY) for both staking and cranking — same wallet the
 * autoplay/sentinel tooling uses. Exits non-zero only on a real failure (a halt
 * that fails verification); "no halt witnessed in N rounds" exits 0 with a note.
 *
 * Env: RPC (default public node), MAX_ROUNDS (default 4), MAX_CRANKS_PER_ROUND.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import {
  buildOpenSegmentRideV4Tx,
  buildRecordSegmentV4Tx,
  buildCloseSegmentRideV4Tx,
  SETTLEMENT_NAME_V4,
} from "../sdk/src/segmentMarketV4.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const D = JSON.parse(readFileSync(join(REPO_ROOT, "deployments/testnet.json"), "utf8"));

const RPC = process.env.RPC ?? "https://sui-testnet-rpc.publicnode.com";
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 4);

const PKG = D.package_id as string;
const m = D.segment_markets_v4.at(-1);
const MARKET = m.market as string;
const VAULT = m.vault as string;
const COLL = m.collateral as string;
const ROUND_DURATION = BigInt(m.round_duration_segments ?? 75);
const STAKE = BigInt(m.min_stake_per_segment ?? 10_000);
const ESCROW = (STAKE * ROUND_DURATION * 11n) / 10n;
const MAX_CRANKS_PER_ROUND = Number(process.env.MAX_CRANKS_PER_ROUND ?? Number(ROUND_DURATION) + 2);

const client = new SuiJsonRpcClient({ url: RPC, network: "testnet" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scan = (kind: string, id: string) => `https://suiscan.xyz/testnet/${kind}/${id}`;

let step = 0;
const log = (msg: string) => console.log(`\x1b[36m[${++step}]\x1b[0m ${msg}`);
const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const info = (msg: string) => console.log(`  \x1b[90m·\x1b[0m ${msg}`);
function die(msg: string): never {
  console.error(`  \x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

const secret = process.env.WICK_FAUCET_PRIVATE_KEY;
if (!secret) {
  die("WICK_FAUCET_PRIVATE_KEY is required (operator wallet — pays stake + cranking gas).");
}
const kp = Ed25519Keypair.fromSecretKey(secret as string);
const me = kp.getPublicKey().toSuiAddress();

async function exec(tx: unknown, opts = {}) {
  return client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx as never,
    options: { showEffects: true, showObjectChanges: true, showEvents: true, ...opts },
  });
}

async function bestCoin(type: string): Promise<string | undefined> {
  const r = await client.getCoins({ owner: me, coinType: type });
  return (r.data ?? [])
    .sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))[0]?.coinObjectId;
}

/** Read the market's current `rugged_at_segment` (null when no halt this round). */
async function readRuggedAtSegment(): Promise<bigint | null> {
  try {
    const d: any = await client.getDynamicFieldObject({
      parentId: MARKET,
      name: {
        type: "vector<u8>",
        value: Array.from(new TextEncoder().encode("rug_config")) as unknown as string,
      },
    });
    const cf = d?.data?.content?.fields?.value?.fields;
    if (!cf || cf.rug_chance_bps == null) return null;
    const raw = cf.rugged_at_segment;
    if (raw == null) return null;
    const vec = raw?.fields?.vec;
    if (Array.isArray(vec) && vec.length > 0) return BigInt(String(vec[0]));
    if (typeof raw === "string" || typeof raw === "number") return BigInt(String(raw));
    return null;
  } catch {
    return null;
  }
}

async function nextSegmentIndex(): Promise<bigint> {
  const o: any = await client.getObject({ id: MARKET, options: { showContent: true } });
  return BigInt(String(o.data.content.fields.next_segment_index));
}

async function openRide(): Promise<{ rideId: string; entry: bigint; round: bigint; digest: string }> {
  const coin = await bestCoin(COLL);
  if (!coin) die(`operator ${me} has no ${COLL} to stake`);
  const coins = await client.getCoins({ owner: me, coinType: COLL });
  const extra = (coins.data ?? []).map((c) => c.coinObjectId).filter((id) => id !== coin);
  const tx = buildOpenSegmentRideV4Tx({
    packageId: PKG, collateralType: COLL, sender: me,
    marketId: MARKET, vaultId: VAULT, botRegistryId: D.bot_registry,
    stakePerSegment: STAKE, escrowMist: ESCROW, escrowSourceCoinId: coin,
    additionalCoinIds: extra,
  });
  const res: any = await exec(tx);
  if (res.effects?.status?.status !== "success") die(`open failed: ${JSON.stringify(res.effects?.status)}`);
  const created = (res.objectChanges ?? []).find(
    (c: any) => c.type === "created" && c.objectType?.includes("::segment_market_v4::SegmentRidePositionV4"),
  );
  if (!created?.objectId) die("ride object not created");
  const entry = await nextSegmentIndex(); // index of the next segment to be recorded == ride entry
  const round = entry / ROUND_DURATION;
  return { rideId: created.objectId, entry, round, digest: res.digest };
}

async function crankOnce(): Promise<boolean> {
  try {
    const tx = buildRecordSegmentV4Tx({ packageId: PKG, collateralType: COLL, sender: me, marketId: MARKET });
    const r: any = await exec(tx, { showObjectChanges: false });
    return r.effects?.status?.status === "success";
  } catch {
    return false;
  }
}

async function closeRide(rideId: string): Promise<{ kind: number; digest: string }> {
  const tx = buildCloseSegmentRideV4Tx({
    packageId: PKG, collateralType: COLL, sender: me, rideId,
    marketId: MARKET, vaultId: VAULT, priceOracleId: D.usd_price_oracle,
    tokenStateId: D.wick_token_state, stakingPoolId: D.wick_staking_pool,
  });
  const res: any = await exec(tx);
  if (res.effects?.status?.status !== "success") {
    // A rug-caught ride sometimes can't be voluntarily closed; fall back to the
    // permissionless expired-crank in the caller. Surface the failure.
    return { kind: -1, digest: res.digest ?? "" };
  }
  const ev = (res.events ?? []).find((e: any) => (e.type ?? "").includes("::segment_market_v4::RideClosedV4"));
  return { kind: Number(ev?.parsedJson?.settlement_kind ?? -1), digest: res.digest };
}

async function main() {
  console.log(`judge-halt-smoke — drive a live MARKET HALT and prove it honest`);
  console.log(`  market   ${MARKET}`);
  console.log(`  operator ${me}`);
  console.log(`  rug      ${m.rug_chance_bps ?? "?"} bps/seg · round ${ROUND_DURATION} segs · up to ${MAX_ROUNDS} rounds\n`);
  if ((m.rug_chance_bps ?? 0) === 0) die("latest v4 market has rug disabled (rug_chance_bps=0)");

  let attempts = 0;
  let opens = 0;
  const MAX_OPENS = MAX_ROUNDS + 4; // safety bound (advancing spent rounds costs opens)
  while (attempts < MAX_ROUNDS && opens < MAX_OPENS) {
    opens++;
    const { rideId, entry, round, digest } = await openRide();
    const roundEnd = (round + 1n) * ROUND_DURATION;

    // If this round already halted before our entry, we bet into a spent round
    // and can't be re-halted. Crank it out to the next round (advancing the
    // chart) WITHOUT counting it as a real attempt, then retry fresh.
    const pre = await readRuggedAtSegment();
    if (pre != null && pre < entry) {
      info(`round ${round} already halted @ ${pre} (before our entry @ ${entry}) — cranking to the next round`);
      for (let i = 0; i < MAX_CRANKS_PER_ROUND; i++) {
        if ((await nextSegmentIndex()) >= roundEnd) break;
        await crankOnce();
        await sleep(100);
      }
      await closeRide(rideId).catch(() => {});
      continue;
    }

    attempts++;
    log(`attempt ${attempts}/${MAX_ROUNDS} — ride ${rideId.slice(0, 14)}… entered @ segment ${entry} (round ${round})`);
    info(`open ${scan("tx", digest)}`);

    let caughtAt: bigint | null = null;
    for (let i = 0; i < MAX_CRANKS_PER_ROUND; i++) {
      const cur = await nextSegmentIndex();
      if (cur >= roundEnd) break; // round rolled without catching us
      await crankOnce();
      const rugged = await readRuggedAtSegment();
      if (rugged != null && rugged >= entry && rugged < roundEnd) {
        caughtAt = rugged;
        break;
      }
      await sleep(120);
    }

    if (caughtAt != null) {
      ok(`\x1b[33mMARKET HALT\x1b[0m fired @ segment ${caughtAt} — the ride is wiped`);
      log("closing the wiped ride (on-chain settlement)…");
      const { kind, digest: cd } = await closeRide(rideId);
      const name = SETTLEMENT_NAME_V4[kind as keyof typeof SETTLEMENT_NAME_V4] ?? `kind=${kind}`;
      ok(`settled ${name}  ${cd ? scan("tx", cd) : ""}`);

      log("auditing the halt with scripts/verify-v4.ts (re-derives the keccak roll)…");
      let out = "";
      try {
        out = execFileSync("npx",
          ["tsx", join(REPO_ROOT, "scripts/verify-v4.ts"), "--market", MARKET, "--ride", rideId, "--rpc", RPC],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e: any) {
        console.log(e.stdout ?? ""); console.log(e.stderr ?? "");
        die("verify-v4 did NOT pass — the halt failed its honesty check");
      }
      for (const line of out.trim().split("\n").slice(-8)) console.log(`    ${line}`);
      if (!/\bPASS\b/.test(out)) die("verify-v4 output did not contain PASS");
      console.log(`\n\x1b[32m✅ live MARKET HALT witnessed + proven honest\x1b[0m — the house froze the market, wiped the ride, and the keccak roll checks out. That is the house edge, on-chain and provable.`);
      return;
    }

    info(`no halt in this round (≈32% of rounds) — closing and retrying`);
    await closeRide(rideId).catch(() => {});
  }

  console.log(`\n\x1b[33mno MARKET HALT landed in ${MAX_ROUNDS} rounds\x1b[0m (each round halts ~68% of the time). The rides still lost to the house — re-run to witness a halt, or bump MAX_ROUNDS.`);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
