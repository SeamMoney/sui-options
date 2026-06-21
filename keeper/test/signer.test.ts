/**
 * Tests for loadKeeperSigner — how the keeper loads its signing key at startup.
 * If this misreads the key (wrong priority, a bad-length hex slipping through,
 * a silent address mismatch) the keeper either won't start or signs as the
 * WRONG account and every crank/settle reverts. Pure: a temp key file + an
 * injected Config, no network.
 *
 *   npx tsx --test keeper/test/signer.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Config } from "../src/config.js";
import { loadKeeperSigner } from "../src/sui.js";

// Minimal Config: loadKeeperSigner only reads these two fields.
function cfg(over: { keeperPrivateKeyHex?: string; keeperKeyPath: string }): Config {
  return over as unknown as Config;
}

const HEX32 = "01".repeat(32); // 64 hex chars = a valid 32-byte ed25519 seed
const MISSING = join(tmpdir(), "definitely-not-a-keeper-key-file.json");

test("loads from KEEPER_PRIVATE_KEY_HEX (with and without 0x) → source env", () => {
  const a = loadKeeperSigner(cfg({ keeperPrivateKeyHex: HEX32, keeperKeyPath: MISSING }));
  assert.equal(a.source, "env");
  assert.match(a.address, /^0x[0-9a-f]{64}$/);
  // 0x-prefixed form derives the SAME address.
  const b = loadKeeperSigner(cfg({ keeperPrivateKeyHex: "0x" + HEX32, keeperKeyPath: MISSING }));
  assert.equal(b.address, a.address);
});

test("rejects a wrong-length hex key with a clear error", () => {
  assert.throws(
    () => loadKeeperSigner(cfg({ keeperPrivateKeyHex: "abcd", keeperKeyPath: MISSING })),
    /must be 32 bytes \(64 hex chars\)/,
  );
});

test("rejects a 64-char non-hex key", () => {
  assert.throws(
    () => loadKeeperSigner(cfg({ keeperPrivateKeyHex: "zz".repeat(32), keeperKeyPath: MISSING })),
    /not valid hex/,
  );
});

test("with no env key and no file, errors with setup guidance", () => {
  assert.throws(
    () => loadKeeperSigner(cfg({ keeperKeyPath: MISSING })),
    /keeper signer missing/,
  );
});

test("falls back to a valid key file → source file, address matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "wick-signer-"));
  try {
    const kp = new Ed25519Keypair();
    const address = kp.getPublicKey().toSuiAddress();
    const path = join(dir, "key.json");
    writeFileSync(path, JSON.stringify({ address, privateKey: kp.getSecretKey() }));
    const loaded = loadKeeperSigner(cfg({ keeperKeyPath: path }));
    assert.equal(loaded.source, "file");
    assert.equal(loaded.address, address);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env key wins even when a valid file is also present", () => {
  const dir = mkdtempSync(join(tmpdir(), "wick-signer-"));
  try {
    const fileKp = new Ed25519Keypair();
    const path = join(dir, "key.json");
    writeFileSync(
      path,
      JSON.stringify({ address: fileKp.getPublicKey().toSuiAddress(), privateKey: fileKp.getSecretKey() }),
    );
    const loaded = loadKeeperSigner(cfg({ keeperPrivateKeyHex: HEX32, keeperKeyPath: path }));
    assert.equal(loaded.source, "env", "env var must take priority over the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a key file whose address disagrees with the derived key is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "wick-signer-"));
  try {
    const kp = new Ed25519Keypair();
    const path = join(dir, "key.json");
    writeFileSync(
      path,
      JSON.stringify({ address: "0x" + "de".repeat(32), privateKey: kp.getSecretKey() }),
    );
    assert.throws(() => loadKeeperSigner(cfg({ keeperKeyPath: path })), /address mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
