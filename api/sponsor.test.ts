import assert from "node:assert/strict";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

import { handle, resetSponsorStateForTests } from "./sponsor.js";

const PACKAGE_ID = "0x0b94e3daa9ca156f2e541caa177ae27abd40aaacbe599a8f93b3a5a136700e70";
const SENDER = "0x510e60a9faf790c747a982cc39b6332c821d1f61a28ba71381864977c744cd57";
const MARKET = "0x2f74fbdb20560206617c711a454dc29d4d6b000cc9ab2e4537400d80f88d1e45";
const RANDOM = "0x0000000000000000000000000000000000000000000000000000000000000008";
const CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";
const GAS = "0x0000000000000000000000000000000000000000000000000000000000000007";
const DIGEST = "11111111111111111111111111111111";

const sponsorKeypair = new Ed25519Keypair();
const sponsorAddress = sponsorKeypair.getPublicKey().toSuiAddress();

function objectRef(objectId: string) {
  return { objectId, version: "1", digest: DIGEST };
}

async function buildTxBytes(options: {
  target?: string;
  gasOwner?: string;
  sender?: string;
} = {}): Promise<string> {
  const tx = new Transaction();
  tx.setSender(options.sender ?? SENDER);
  tx.setGasOwner(options.gasOwner ?? sponsorAddress);
  tx.setGasBudget(10_000_000);
  tx.setGasPrice(1_000);
  tx.setGasPayment([objectRef(GAS)]);
  tx.moveCall({
    target:
      options.target ??
      `${PACKAGE_ID}::wick::record_segment_v3`,
    arguments: [
      tx.objectRef(objectRef(MARKET)),
      tx.objectRef(objectRef(RANDOM)),
      tx.objectRef(objectRef(CLOCK)),
    ],
  });
  return Buffer.from(await tx.build()).toString("base64");
}

function deps(options: {
  capMist?: bigint;
  nowMs?: number;
  digest?: string;
} = {}) {
  return {
    nowMs: () => options.nowMs ?? Date.parse("2026-05-23T12:00:00.000Z"),
    getClient: () => ({}) as never,
    getSponsor: () => ({ keypair: sponsorKeypair, address: sponsorAddress }),
    getV3PackageId: () => PACKAGE_ID,
    getDailyCapMist: () => options.capMist ?? 1_000_000n,
    lookupObjectType: async () =>
      `${PACKAGE_ID}::segment_market_v3::SegmentMarketV3<0x2::sui::SUI>`,
    executeTransactionBlock: async () => ({
      digest: options.digest ?? "TEST_DIGEST",
      effects: {
        status: { status: "success" },
        gasUsed: {
          computationCost: "1000",
          storageCost: "0",
          storageRebate: "0",
          nonRefundableStorageFee: "0",
        },
      },
    }),
  };
}

async function request(txBytes: string) {
  return {
    sender: SENDER,
    txBytes,
    userSig: "AA==",
  };
}

resetSponsorStateForTests();
{
  const txBytes = await buildTxBytes({ target: "0x2::sui::transfer" });
  const out = await handle(await request(txBytes), deps());
  assert.equal(out.status, 403);
  assert.match(String(out.body.error), /allowlist/);
}

resetSponsorStateForTests();
{
  const txBytes = await buildTxBytes({
    target: `${PACKAGE_ID}::segment_market_v3::record_segment`,
  });
  const out = await handle(await request(txBytes), deps());
  assert.equal(out.status, 403);
  assert.match(String(out.body.error), /allowlist/);
}

resetSponsorStateForTests();
{
  const txBytes = await buildTxBytes({ gasOwner: SENDER });
  const out = await handle(await request(txBytes), deps());
  assert.equal(out.status, 403);
  assert.match(String(out.body.error), /gas owner/);
}

resetSponsorStateForTests();
{
  const txBytes = await buildTxBytes();
  for (let index = 0; index < 5; index += 1) {
    const out = await handle(await request(txBytes), deps());
    assert.equal(out.status, 200);
  }
  const limited = await handle(await request(txBytes), deps());
  assert.equal(limited.status, 429);
}

resetSponsorStateForTests();
{
  const txBytes = await buildTxBytes();
  const out = await handle(await request(txBytes), deps({ capMist: 0n }));
  assert.equal(out.status, 503);
  assert.match(String(out.body.error), /daily spend cap/);
}

resetSponsorStateForTests();
{
  const txBytes = await buildTxBytes();
  const out = await handle(await request(txBytes), deps({ digest: "HAPPY_DIGEST" }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { digest: "HAPPY_DIGEST" });
}

console.log("api/sponsor.test.ts ok");
