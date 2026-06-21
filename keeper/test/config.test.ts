/**
 * Tests for loadConfig — the keeper's env + deployment-manifest parsing. A
 * silent misparse here (wrong gas budget, wrong RPC, a disable-flag that
 * doesn't disable) breaks the LIVE keeper without an obvious error, so the
 * defaults, env overrides, and list/flag parsing get pinned. Fully offline:
 * points at a temp manifest and drives process.env.
 *
 *   npx tsx --test keeper/test/config.test.ts
 */
import { strict as assert } from "node:assert";
import { test, beforeEach, afterEach } from "node:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "WICK_KEEPER_DEPLOYMENT_PATH",
  "WICK_KEEPER_RPC",
  "WICK_KEEPER_COLLATERAL",
  "WICK_KEEPER_POLL_MS",
  "WICK_KEEPER_GAS_CRANK",
  "WICK_KEEPER_GAS_SETTLE",
  "WICK_KEEPER_HEALTH_PORT",
  "WICK_KEEPER_MARKETS",
  "WICK_KEEPER_REGISTRY",
  "WICK_KEEPER_DISABLE_RIDE_CRANKS",
];

let saved: Record<string, string | undefined>;
let dir: string;
let manifest: string;

const DEP = {
  network: "testnet",
  package_id: "0xpkg",
  original_id: "0xorig",
  vault_sui: "0xvault",
  bot_registry: "0xbot",
  global_exposure_registry: "0xglobalreg",
  arcade_markets: [],
};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "wick-keeper-cfg-"));
  manifest = join(dir, "testnet.json");
  writeFileSync(manifest, JSON.stringify(DEP));
  process.env.WICK_KEEPER_DEPLOYMENT_PATH = manifest;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

test("applies sane defaults when no env overrides are set", () => {
  const cfg = loadConfig();
  assert.equal(cfg.network, "testnet");
  assert.equal(cfg.packageId, "0xpkg");
  assert.equal(cfg.collateralType, "0x2::sui::SUI");
  assert.equal(cfg.pollIntervalMs, 2_000);
  assert.equal(cfg.gasBudgetCrank, 300_000_000n);
  assert.equal(cfg.gasBudgetSettle, 300_000_000n);
  assert.equal(cfg.gasBudgetTick, 50_000_000n);
  assert.equal(cfg.healthPort, 8080);
  // testnet defaults to PublicNode (the keeper is the heaviest RPC user).
  assert.match(cfg.rpcUrl, /publicnode\.com/);
  assert.equal(cfg.disableRideCranks, false);
  assert.deepEqual(cfg.onlyMarkets, []);
});

test("env overrides win over defaults, with correct types", () => {
  process.env.WICK_KEEPER_RPC = "https://my.node/rpc";
  process.env.WICK_KEEPER_COLLATERAL = "0xtusd::tusd::TUSD";
  process.env.WICK_KEEPER_POLL_MS = "5000";
  process.env.WICK_KEEPER_GAS_CRANK = "123456789";
  process.env.WICK_KEEPER_HEALTH_PORT = "9099";
  const cfg = loadConfig();
  assert.equal(cfg.rpcUrl, "https://my.node/rpc");
  assert.equal(cfg.collateralType, "0xtusd::tusd::TUSD");
  assert.equal(cfg.pollIntervalMs, 5000);
  assert.equal(cfg.gasBudgetCrank, 123_456_789n);
  assert.equal(typeof cfg.gasBudgetCrank, "bigint");
  assert.equal(cfg.healthPort, 9099);
});

test("WICK_KEEPER_MARKETS is split, trimmed, and emptied-filtered", () => {
  process.env.WICK_KEEPER_MARKETS = " 0xa , 0xb ,, 0xc ";
  assert.deepEqual(loadConfig().onlyMarkets, ["0xa", "0xb", "0xc"]);
});

test("registry falls back through global_exposure_registry", () => {
  // No env, no dep.registry → uses dep.global_exposure_registry.
  assert.equal(loadConfig().registryId, "0xglobalreg");
  process.env.WICK_KEEPER_REGISTRY = "0xoverride";
  assert.equal(loadConfig().registryId, "0xoverride");
});

test("disable flags parse 1/true/yes truthily, everything else false", () => {
  for (const truthy of ["1", "true", "TRUE", "yes", "Yes"]) {
    process.env.WICK_KEEPER_DISABLE_RIDE_CRANKS = truthy;
    assert.equal(loadConfig().disableRideCranks, true, `${truthy} → true`);
  }
  for (const falsy of ["0", "false", "no", "off", ""]) {
    process.env.WICK_KEEPER_DISABLE_RIDE_CRANKS = falsy;
    assert.equal(loadConfig().disableRideCranks, false, `${falsy} → false`);
  }
});

test("throws a clear error when the deployment manifest is missing", () => {
  process.env.WICK_KEEPER_DEPLOYMENT_PATH = join(dir, "does-not-exist.json");
  assert.throws(() => loadConfig(), /deployment manifest not found/);
});
