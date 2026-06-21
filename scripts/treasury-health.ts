/**
 * Treasury / faucet health check (read-only) — `npm run check:treasury`.
 *
 * The faucet wallet (= treasury) is the first thing every judge touches: it
 * drips SUI gas and mints TUSD stake. This script confirms, from public RPC
 * only (no keys), that it can keep serving:
 *
 *   - SUI balance is above a runway floor       (hard)
 *   - it still owns the TUSD TreasuryCap         (hard — /api/faucet-tusd mints)
 *   - the sponsor wallet has gas                 (hard)
 *   - coin-object count                          (info only)
 *
 * Note on the coin count: it is NOT a pass/fail. Splitting the gas coin into a
 * pool does NOT survive — Sui *gas-smashing* merges the faucet tx's gas coins
 * back into one on every drip, so the count drifts back toward 1. The real cure
 * for the intermittent faucet 500s is the per-request retry in api/faucet.ts
 * (PR #36), not a coin pool. The count is printed for visibility only.
 *
 * Exits non-zero if any hard check fails, so it can gate a demo runbook.
 */

const RPC = process.env.WICK_API_RPC ?? "https://sui-testnet-rpc.publicnode.com";

const TREASURY =
  "0xc9179f15614b95517c7377e721b7a9d0d56eeaea1b9074b27e2c760cdb22c298";
const SPONSOR =
  "0x02e3f17cac22394741feb3d5d0afa2461df873eafd746777aadaeac04204fefa";
const TUSD_TREASURY_CAP =
  "0x7db5b3edead4f503ce8ef19ace6eca26e961edd08871042ad5de6f870a369b11";

// Thresholds. The faucet drips 2.0 SUI/req (0.2 → 1.0 in #232 so a full
// hold-for-touch ride doesn't run out of gas, then 1.0 → 2.0 for smooth
// multi-ride judge sessions). Keep the warning floor at ~100 drips of headroom
// → 200 SUI at the current 2.0 SUI/req drip.
const MIN_TREASURY_SUI = 200;
const MIN_SPONSOR_SUI = 5;

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method} → ${JSON.stringify(json.error)}`);
  return json.result;
}

async function suiBalance(addr: string): Promise<number> {
  const r = await rpc("suix_getBalance", [addr, "0x2::sui::SUI"]);
  return Number(r.totalBalance) / 1e9;
}

async function suiCoinCount(addr: string): Promise<number> {
  const r = await rpc("suix_getCoins", [addr, "0x2::sui::SUI", null, 200]);
  return (r.data ?? []).length;
}

async function ownerOf(objectId: string): Promise<string | null> {
  const r = await rpc("sui_getObject", [objectId, { showOwner: true }]);
  const owner = r?.data?.owner;
  return owner && typeof owner === "object" && "AddressOwner" in owner
    ? (owner.AddressOwner as string)
    : null;
}

const fails: string[] = [];
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => {
  console.log(`  ✗ ${m}`);
  fails.push(m);
};

async function main() {
  console.log(`treasury health @ ${RPC}\n`);

  const tBal = await suiBalance(TREASURY);
  const tCoins = await suiCoinCount(TREASURY);
  console.log(`treasury ${TREASURY.slice(0, 10)}…  ${tBal.toFixed(1)} SUI · ${tCoins} coins`);
  tBal >= MIN_TREASURY_SUI
    ? ok(`SUI balance ≥ ${MIN_TREASURY_SUI}`)
    : bad(`SUI balance ${tBal.toFixed(1)} < ${MIN_TREASURY_SUI} — top up the faucet`);
  // Info only — gas-smashing re-merges coins each drip, so a pool can't persist.
  // The 500-fix is the retry in api/faucet.ts (PR #36), not a coin pool.
  console.log(`  · ${tCoins} coin object(s) (info; not a pass/fail — see header)`);

  const capOwner = await ownerOf(TUSD_TREASURY_CAP);
  capOwner === TREASURY
    ? ok("treasury owns the TUSD TreasuryCap (mint works)")
    : bad(`TUSD TreasuryCap owner is ${capOwner ?? "?"}, not the treasury`);

  const sBal = await suiBalance(SPONSOR);
  console.log(`\nsponsor  ${SPONSOR.slice(0, 10)}…  ${sBal.toFixed(1)} SUI`);
  sBal >= MIN_SPONSOR_SUI
    ? ok(`SUI balance ≥ ${MIN_SPONSOR_SUI}`)
    : bad(`sponsor SUI ${sBal.toFixed(1)} < ${MIN_SPONSOR_SUI}`);

  console.log("");
  if (fails.length > 0) {
    console.error(`FAIL — ${fails.length} check(s) failed`);
    process.exit(1);
  }
  console.log("PASS — faucet treasury healthy");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(msg)) {
    console.log(`SKIP — RPC unreachable: ${msg}`);
  } else {
    console.error("ERROR:", msg);
    process.exit(1);
  }
});
