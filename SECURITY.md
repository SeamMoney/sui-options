# Security & Open-Sourcing Checklist

Wick is currently a private hackathon repo. This file tracks the gates that
must be cleared before flipping the GitHub repo to **public**.

## Before going public

- [ ] **Rotate the keeper key.** `keeper/.keeper-key.json` is in `.gitignore`,
      but anyone who has run `npm run setup-key` locally has a real funded
      testnet keypair on disk. The currently-funded address
      `0x071d…d075` is published in commit messages and READMEs only as a
      reference; if you've ever shared the JSON file out-of-band, regenerate.
- [ ] **Audit `git log -p` for accidental key paste.** Quick check:
      ```bash
      git log -p | grep -nE "suiprivkey1[a-z0-9]{40,}|BEGIN [A-Z ]+KEY|api[_-]?key=|token=[A-Za-z0-9]{20,}"
      ```
      Expected: empty.
- [ ] **Sweep `deployments/archive/`.** It's gitignored, but confirm nothing
      in there was ever staged. `git log --all --full-history -- deployments/archive/`.
- [ ] **Confirm the upgrade cap holder strategy.** Today the publisher key
      `0xfad7…9455` holds the package upgrade capability. Decide before public:
      transfer to a multisig, transfer to a community-controlled object, or
      burn for immutability. Document the choice in the README threat model.
- [ ] **MockOracle stays loud.** README + `move/sources/oracle_adapter.move`
      already call out that `set_price` is permissionless. Verify the public
      README still names this as the load-bearing stub.
- [ ] **CI secrets review.** If you wire GitHub Actions before the flip, use
      Repository Secrets (not workflow files) and never `echo $SECRET` in steps.
- [ ] **License confirm.** `LICENSE` is currently MIT. If you need patent
      grant or copyleft, swap to Apache-2.0 / AGPL-3.0 *before* public flip.

## What is intentionally in the repo

These look secret-adjacent but are public on Sui testnet and **safe to ship**:

- `deployments/testnet.json` — published package id, original id, upgrade
  cap object id, publisher address. All on-chain, all queryable from any RPC.
- `deployments/wallets.json` — alice + bob *addresses* only. Public.
- `deployments/archive/*.json` — historical deploy manifests. Same shape.
- `move/Move.toml` — pinned framework rev. Public.

## Reporting a vulnerability

Until the project goes public, file an issue in the private repo or DM the
maintainers directly. Once public, follow the policy that lands here at flip
time (likely: email a private inbox + 90-day disclosure window).
