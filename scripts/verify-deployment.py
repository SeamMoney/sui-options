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

ENDPOINTS = [
    "https://fullnode.testnet.sui.io:443",
    "https://sui-testnet-rpc.publicnode.com",
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
          "fee_router_sui", "vault_tusd", "vault_admin_cap_tusd", "ride_caps_sui"]:
    add(k, d.get(k))
add("tusd package", d["tusd"]["package_id"])
add("tusd treasury_cap", d["tusd"]["treasury_cap"])
add("tusd metadata", d["tusd"]["metadata"])
add("sponsor policy", d["sponsor"]["policy_id"])
add("sponsor cap", d["sponsor"]["cap_id"])
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
print(f"objects verified on-chain: {len(live)}/{len(set(ids))} unique  ({'ALL LIVE' if not missing else str(len(missing))+' MISSING'})")
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

# ── demo-critical funded state ──────────────────────────────────────────────
def sui_bal(addr):
    r = rpc("suix_getBalance", [addr, "0x2::sui::SUI"])
    return int(r["totalBalance"]) / 1e9 if r else 0.0

def field(oid, name):
    r = rpc("sui_getObject", [oid, {"showContent": True}])
    f = r["data"]["content"]["fields"] if r and r.get("data") else {}
    return f.get(name)

print(f"\nfunded + demo-ready:")
print(f"  MartingalerVault<TUSD>: {int(field(d['vault_tusd'],'treasury') or 0)/1e6:>14,.0f} TUSD")
print(f"  MartingalerVault<SUI> : {int(field(d['vault_sui'],'treasury') or 0)/1e9:>14,.3f} SUI")
print(f"  gas sponsor wallet    : {sui_bal(d['sponsor']['sponsor_address']):>14,.2f} SUI")
ts = field(d["tusd"]["treasury_cap"], "total_supply")
supply = int(ts["fields"]["value"]) / 1e6 if ts else 0
print(f"  TUSD total supply     : {supply:>14,.0f} TUSD")

print()
sys.exit(1 if (missing or absent) else 0)
