#!/usr/bin/env python3
"""
verify-deployment.py — prove the Wick Move deployment is LIVE and FUNDED on Sui
testnet, straight from the manifest. No wallet, no CLI: reads
`deployments/testnet.json`, asks a public fullnode whether every package +
object actually exists on-chain, and reads the demo-critical balances.

    python3 scripts/verify-deployment.py

Exit code is non-zero if any object is missing. The same IDs (with SuiScan
links) are tabulated in `deployments/ADDRESSES.md`.
"""
import json, os, sys, urllib.request

# PublicNode first: the Mysten public fullnode rate-limits under load, so the
# reliable endpoint leads and the others are fallbacks (repo testnet RPC convention).
ENDPOINTS = [
    "https://sui-testnet-rpc.publicnode.com",
    "https://fullnode.testnet.sui.io:443",
    "https://sui-testnet.public.blastapi.io",
]
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = json.load(open(os.path.join(HERE, "deployments", "testnet.json")))


def rpc(method, params):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    last = None
    for ep in ENDPOINTS:
        try:
            req = urllib.request.Request(
                ep, data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 wick-verify"})
            return json.load(urllib.request.urlopen(req, timeout=40)).get("result")
        except Exception as e:  # try the next endpoint
            last = e
    raise SystemExit(f"all RPC endpoints failed: {last}")


# ── collect every id from the manifest ──────────────────────────────────────
labelled = []  # (label, id)
def add(label, i):
    if isinstance(i, str) and i.startswith("0x"):
        labelled.append((label, i))

add("package (v4.26)", d["package_id"])
for k in ["risk_config", "global_exposure_registry", "bot_registry", "usd_price_oracle",
          "wick_staking_pool", "wick_token_state", "vault_sui", "vault_admin_cap_sui",
          "fee_router_sui", "vault_tusd", "vault_admin_cap_tusd",
          "ride_caps_sui", "ride_caps_sui_admin"]:
    add(k, d.get(k))
add("tusd package", d["tusd"]["package_id"])
add("tusd treasury_cap", d["tusd"]["treasury_cap"])
add("tusd metadata", d["tusd"]["metadata"])
add("sponsor policy", d["sponsor"]["policy_id"])
add("sponsor cap", d["sponsor"]["cap_id"])
# genesis (v1) publish — the type-origin package for every v1 module; still
# live and resolvable even though the manifest only names it as the first
# upgrade's `from_package_id`.
if d.get("upgrade_history"):
    add("pkg v1 (genesis)", d["upgrade_history"][0].get("from_package_id"))
for u in d.get("upgrade_history", []):
    add(f"pkg v{u['version']}", u["to_package_id"])
add("upgrade cap", d["upgrade_history"][-1]["upgrade_capability"])
for m in d.get("segment_markets_v4", []):
    add(f"v4 market {m['name']}", m["market"])
for m in d.get("segment_markets", []):
    add("v3 market", m["market"])
for m in d.get("arcade_markets", []):
    add(f"arcade {m['name']}", m["market"]); add("  oracle", m["oracle"]); add("  path", m["path"])

# ── verify existence in batches ─────────────────────────────────────────────
ids = [i for _, i in labelled]
live = set()
for i in range(0, len(ids), 50):
    res = rpc("sui_multiGetObjects", [ids[i:i + 50], {"showType": True}])
    for r in (res or []):
        if r.get("data"):
            live.add(r["data"]["objectId"])

missing = [(lbl, i) for lbl, i in labelled if i not in live]
print(f"\nWick deployment — Sui testnet\n{'='*48}")
print(f"objects + packages verified on-chain: {len(live)}/{len(set(ids))} unique  ({'ALL LIVE' if not missing else str(len(missing))+' MISSING'})")
for lbl, i in missing:
    print(f"  ❌ MISSING  {lbl:28s} {i}")

# ── verify the package exposes the demo-critical Move modules ───────────────
# (a live ID alone doesn't prove the right code shipped — check the ABI)
EXPECTED_MODULES = ["market", "segment_market_v4", "sponsor", "martingaler_vault",
                    "seeded_path", "path_observation", "wick_token", "wick_staking",
                    "risk_config", "usd_price_oracle"]
mods = rpc("sui_getNormalizedMoveModulesByPackage", [d["package_id"]]) or {}
absent = [m for m in EXPECTED_MODULES if m not in mods]
print(f"package exposes {len(mods)} Move modules; demo-critical "
      f"{len(EXPECTED_MODULES) - len(absent)}/{len(EXPECTED_MODULES)} present")
for m in absent:
    print(f"  ❌ MISSING MODULE  {m}")

# ── event type-origin packages (the footgun that caused 4 bugs) ─────────────
# Move event/struct tags keep the package that DEFINED them across upgrades, so
# queryEvents / getOwnedObjects must key on the type-ORIGIN package, not the
# latest package_id. Prove which package defines what by walking the upgrade
# chain oldest→newest and finding the FIRST that exposes the module / struct.
# (segment_market_v4 was introduced mid-history; RugFiredV4 was added later.)
print("\nevent type-origin packages (key queries on THESE, not the latest id):")
chain = [u["to_package_id"] for u in d.get("upgrade_history", [])]
if d.get("upgrade_history"):
    chain = [d["upgrade_history"][0]["from_package_id"], *chain]
seg_origin = rug_origin = None
for pid in chain:
    pm = rpc("sui_getNormalizedMoveModulesByPackage", [pid]) or {}
    sm4 = pm.get("segment_market_v4")
    if sm4 and seg_origin is None:
        seg_origin = pid
    if sm4 and rug_origin is None and "RugFiredV4" in (sm4.get("structs") or {}):
        rug_origin = pid
seg_bad = seg_origin in (None,) or seg_origin == d["package_id"]
print(f"  {'·' if seg_origin else '❌'} segment_market_v4 (RideOpened/Closed/SegmentRecorded/RoundStarted + "
      f"SegmentRidePositionV4): {seg_origin or 'NOT FOUND'}")
print(f"  {'·' if rug_origin else '❌'} RugFiredV4 (added in the v4.26 upgrade): {rug_origin or 'NOT FOUND'}")
if seg_origin and seg_origin != d["package_id"]:
    print(f"  → NOTE: the v4 type-origin ({seg_origin[:10]}…) is NOT the latest package_id "
          f"({d['package_id'][:10]}…) — keying v4 event/struct queries on the latest id returns ZERO rows.")
origins_ok = bool(seg_origin and rug_origin)

# ── demo-critical funded state ──────────────────────────────────────────────
def sui_bal(addr):
    r = rpc("suix_getBalance", [addr, "0x2::sui::SUI"])
    return int(r["totalBalance"]) / 1e9 if r else 0.0

def field(oid, name):
    r = rpc("sui_getObject", [oid, {"showContent": True}])
    f = r["data"]["content"]["fields"] if r and r.get("data") else {}
    return f.get(name)

print(f"\nfunded + demo-ready:")
# The live /ride game + the faucet stake run on the TUSD market (pickSegmentMarketV4
# selects the last v4 market = the TUSD rug market), so the TUSD vault is the one
# that backs every demo payout. The SUI vault backs the legacy SUI-collateral
# markets, which are off the demo path — its low balance is expected, not a gap.
print(f"  MartingalerVault<TUSD>: {int(field(d['vault_tusd'],'treasury') or 0)/1e6:>14,.0f} TUSD   ← the demo vault (/ride + faucet stake)")
print(f"  MartingalerVault<SUI> : {int(field(d['vault_sui'],'treasury') or 0)/1e9:>14,.3f} SUI    (legacy SUI markets — off the demo path)")
print(f"  gas sponsor wallet    : {sui_bal(d['sponsor']['sponsor_address']):>14,.2f} SUI")
ts = field(d["tusd"]["treasury_cap"], "total_supply")
supply = int(ts["fields"]["value"]) / 1e6 if ts else 0
print(f"  TUSD total supply     : {supply:>14,.0f} TUSD")

# ── wallets — addresses, NOT objects ────────────────────────────────────────
# ADDRESSES.md also documents a couple of account addresses (the publisher and
# the gas-sponsor wallet). These are accounts, not owned objects, so they are
# (correctly) absent from the object-existence count above — verify them here as
# funded/active accounts instead, so every documented id is accounted for.
wallets = []
if d.get("publisher"):
    wallets.append(("publisher (deployer)", d["publisher"]))
if d.get("sponsor", {}).get("sponsor_address"):
    wallets.append(("gas sponsor", d["sponsor"]["sponsor_address"]))
if wallets:
    print(f"\nwallet accounts (addresses, not objects):")
    for lbl, addr in wallets:
        owned = rpc("suix_getOwnedObjects", [addr, None, None, 1])
        active = bool(owned and owned.get("data") is not None)
        print(f"  {'✓' if active else '·'} {lbl:22s} {sui_bal(addr):>10,.2f} SUI  {addr[:12]}…")

# The faucet wallet (api/README) drips SUI so a judge can fund a burner and play
# /ride — without runway here, "demo-ready" is a lie. It's an env-configured
# account, not a manifest object, so pin the documented address. Fail the check
# if it can't cover a handful of fund cycles (2 SUI/drip).
FAUCET_WALLET = "0xc9179f15614b95517c7377e721b7a9d0d56eeaea1b9074b27e2c760cdb22c298"
faucet_sui = sui_bal(FAUCET_WALLET)
faucet_drips = int(faucet_sui / 2)
faucet_ok = faucet_drips >= 20
print(f"\nfaucet wallet (drips SUI so judges can fund a burner — api/README):")
print(f"  {'✓' if faucet_ok else '⚠ LOW'}  {faucet_sui:>12,.1f} SUI  (~{faucet_drips:,} drips of 2 SUI)  {FAUCET_WALLET[:12]}…")
# Anti-contention readiness (informational): the faucet's per-request random
# gas-coin picker only engages with ≥2 usable coins. One big coin → concurrent
# drips equivocate (the ~20% 500s the frontend + CLI now retry). The demo works
# either way; for the permanent, snappier fix run scripts/split-faucet-coins.ts.
_fc = rpc("suix_getCoins", [FAUCET_WALLET, "0x2::sui::SUI", None, 50])
_usable = len([c for c in (_fc.get("data") or []) if int(c["balance"]) >= 220_000_000]) if _fc else 0
print(
    f"  {'✓' if _usable >= 2 else 'ℹ'}  {_usable} usable gas coin(s)"
    + ("" if _usable >= 2 else "  — 1 coin contends; run scripts/split-faucet-coins.ts for the permanent fix")
)

print()
sys.exit(1 if (missing or absent or not origins_ok or not faucet_ok) else 0)
