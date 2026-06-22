# Wick Markets — On-chain Addresses (Sui Testnet)

> **69/69 unique objects verified live on-chain 2026-06-21** via `fullnode.testnet.sui.io`.
> All links → [SuiScan testnet](https://suiscan.xyz/testnet). Source of truth: `deployments/testnet.json`.
> Network: **testnet** · ✅ = confirmed on-chain this run.
> **Re-verify it yourself** (no wallet/CLI): `python3 scripts/verify-deployment.py` — checks every object is live and the vaults are funded, straight from a public fullnode.

## Live on-chain state (verified 2026-06-21)

The deployment isn't just published — it's funded and demo-ready right now:

| What | Live balance | Why it matters |
|---|---|---|
| **MartingalerVault&lt;TUSD&gt;** collateral | **100,000,077 TUSD** | the loss-recycling LP vault is fully backed — the ride game settles **real** payouts |
| **Gas sponsor wallet** | **200.04 SUI** | funds v4 sponsored cranking (players crank with no gas of their own) |
| TUSD total supply (minted) | 1,000,000,340 TUSD | faucet (`/api/faucet-tusd`) mints from the TreasuryCap on demand |
| MartingalerVault&lt;SUI&gt; collateral | 0.38 SUI | the SUI fallback market |
| Publisher / deployer | 32.82 SUI | holds the UpgradeCap |

**Funding flow verified live this run** — a judge funds a fresh wallet in two requests, no wallet extension needed, then plays the on-chain ride game:

- `POST /api/faucet` → **2 SUI** gas — [tx `BmmMj8ox…`](https://suiscan.xyz/testnet/tx/BmmMj8oxaxpQJXYoVPqWHrD8YGSpQygCse2yBNA6H9Bg) ✅ success
- `POST /api/faucet-tusd` → **50 TUSD** stake — [tx `9sRSaWme…`](https://suiscan.xyz/testnet/tx/9sRSaWmeeSBnFS89AUkaZwg1MJQzszbKCUggeTzXSLpb) ✅ success

Both landed on-chain; the funded wallet then held 2 SUI + 50 TUSD — enough to clear the per-ride escrow gate (a /ride escrows ~12.375 TUSD) and crank a full hold, so it's genuinely ready to ride. (Amounts were 0.2 SUI / 10 TUSD earlier this cycle; 10 TUSD sat below the gate and left the player stuck on the funding screen — bumped to 2 SUI / 50 TUSD so funding actually unlocks play.)

## Move package (`wick`)

| | Package ID | SuiScan |
|---|---|---|
| **Current — v4.26** (rug-pull house edge) | `0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924` | [`0x1fdf7847…815924`](https://suiscan.xyz/testnet/object/0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924) ✅ |
| Publisher / deployer | `0xfad710377f820b10097f7ac445bc56e738db2bce712f898072061e0591049455` | [`0xfad71037…049455`](https://suiscan.xyz/testnet/account/0xfad710377f820b10097f7ac445bc56e738db2bce712f898072061e0591049455) |
| Publish digest | `7kUBQmP6kFfN1ePFDz9iNYQKRDkFiXdzwqYZ46rgSMiV` | [`7kUBQmP6kF…`](https://suiscan.xyz/testnet/tx/7kUBQmP6kFfN1ePFDz9iNYQKRDkFiXdzwqYZ46rgSMiV) |

### Upgrade history

| Version | Package ID | Upgraded | Digest |
|---|---|---|---|
| v1 (publish) | `0x9f0320d08c2025c57720b6f9b64fdc767441acb1ef778512abbf00c12e1ee8ba` | 20260520T050846Z | [`7kUBQmP6kF…`](https://suiscan.xyz/testnet/tx/7kUBQmP6kFfN1ePFDz9iNYQKRDkFiXdzwqYZ46rgSMiV) |
| v2 | `0x0b94e3daa9ca156f2e541caa177ae27abd40aaacbe599a8f93b3a5a136700e70` | 20260523T074046Z | [`6PUSDbPqRR…`](https://suiscan.xyz/testnet/tx/6PUSDbPqRRMAYaJwDq7CM9De5SQpK7SXTCPLrLh75LXi) |
| v3 | `0x10c3384310549ca77b881ecc3f956abef5553c913b855e0062233fc9320e7a4e` | 20260524T043838Z | [`BZQsgWFcBG…`](https://suiscan.xyz/testnet/tx/BZQsgWFcBGM9hvhNVxRhv1rJMH4mxapyPtJ4HHhsPNcj) |
| v4 | `0x1fdf784743d82c000e84154506e21daedc45bf241818fef6b28635e99e815924` | 20260525T073831Z | `unknown` |

UpgradeCap: [`0xa5bd66c0…5cb590`](https://suiscan.xyz/testnet/object/0xa5bd66c01634671d92ce1ce6084074feaadc74e844f28e2f09af9ed8175cb590) ✅

### Move modules in the package (26, all live)

A live package ID alone doesn't prove the right code shipped — the deployed
package exposes the full Wick protocol ABI (`sui_getNormalizedMoveModulesByPackage`):

- **Markets & rides** — `market` · `segment_market` · `segment_market_v4` · `ride_position` · `ride_market_caps` · `ride_pricing`
- **Vault, fees, impact** — `martingaler_vault` · `vault` · `fee_router` · `impact_fee`
- **Provable fairness & oracles** — `seeded_path` · `path_observation` · `price_observation` · `probability` · `pull_oracle_driver` · `random_walk_driver` · `wick_oracle` · `oracle_version_lock` · `usd_price_oracle`
- **Risk & registries** — `risk_config` · `global_exposure_registry` · `bot_registry`
- **WICK token & staking** — `wick` · `wick_token` · `wick_staking`
- **Gas sponsorship** — `sponsor`

### Source correctness

The deployed source compiles clean and passes **605 / 605 Move tests** (0 failed,
`npm run test:move`) — including the `seeded_path_conformance` provable-fairness
vectors (the TypeScript port reproduces the on-chain candle math bit-for-bit) and
the collateral-invariant suite (vault conservation —
`cumulative_in − cumulative_out == held` after every state transition; the older
cross-side supply-equality phrasing is a retired-v1 artifact, see `move/SAFETY.md`).

## Core protocol objects (shared)

| Object | ID | SuiScan |
|---|---|---|
| RiskConfig | `0xe16efc34b63d627aca1c8ad659ac1f04859109aa2b4a4b8bd2998680f18c1fc4` | [`0xe16efc34…8c1fc4`](https://suiscan.xyz/testnet/object/0xe16efc34b63d627aca1c8ad659ac1f04859109aa2b4a4b8bd2998680f18c1fc4) ✅ |
| GlobalExposureRegistry | `0x8504d0b83423039abed8d7aef84314bc91a1ed035259f1fe0f6cdbdcbe29f432` | [`0x8504d0b8…29f432`](https://suiscan.xyz/testnet/object/0x8504d0b83423039abed8d7aef84314bc91a1ed035259f1fe0f6cdbdcbe29f432) ✅ |
| BotRegistry | `0x50077c5bf80e400ff21220b6b30dfd7a28dda6de83fb2f72f0900903037aa447` | [`0x50077c5b…7aa447`](https://suiscan.xyz/testnet/object/0x50077c5bf80e400ff21220b6b30dfd7a28dda6de83fb2f72f0900903037aa447) ✅ |
| UsdPriceOracle | `0x11c742d91273eb293726f20e9aee0eb1ab696702c9fb8fa4d033cad31118da46` | [`0x11c742d9…18da46`](https://suiscan.xyz/testnet/object/0x11c742d91273eb293726f20e9aee0eb1ab696702c9fb8fa4d033cad31118da46) ✅ |
| WickStakingPool | `0x0d23ac7733f83be7b5a1905b4413ae055c6c7afb60cb2f7a41ca0e730c8b8e67` | [`0x0d23ac77…8b8e67`](https://suiscan.xyz/testnet/object/0x0d23ac7733f83be7b5a1905b4413ae055c6c7afb60cb2f7a41ca0e730c8b8e67) ✅ |
| WickTokenState (WICK token) | `0xbce483cc0392ae8207ce24d3cf77564913ab38fa2b8fbf024841c833d7213892` | [`0xbce483cc…213892`](https://suiscan.xyz/testnet/object/0xbce483cc0392ae8207ce24d3cf77564913ab38fa2b8fbf024841c833d7213892) ✅ |

## Collateral vaults

| Object | ID | SuiScan |
|---|---|---|
| MartingalerVault&lt;SUI&gt; | `0x73d3a17ab1e1cdc173b8cde1ae7d9789a29d1a177ebfd415196a04a6a10e5b9f` | [`0x73d3a17a…0e5b9f`](https://suiscan.xyz/testnet/object/0x73d3a17ab1e1cdc173b8cde1ae7d9789a29d1a177ebfd415196a04a6a10e5b9f) ✅ |
| MartingalerVault&lt;SUI&gt; AdminCap | `0x90245d7d154095c75dc07aa6d815d9b4df694d5a90c948a4be4f68914016b12c` | [`0x90245d7d…16b12c`](https://suiscan.xyz/testnet/object/0x90245d7d154095c75dc07aa6d815d9b4df694d5a90c948a4be4f68914016b12c) ✅ |
| FeeRouter&lt;SUI&gt; | `0xe9a3f0919de13146e4cc0ef451084954c9518e1761af44b4ec44553e45a68c20` | [`0xe9a3f091…a68c20`](https://suiscan.xyz/testnet/object/0xe9a3f0919de13146e4cc0ef451084954c9518e1761af44b4ec44553e45a68c20) ✅ |
| MartingalerVault&lt;TUSD&gt; | `0xd9ff33f4f6e4014bcac74e89261ec47ce2ed34be4c6ea1ce10592fe7e081aa4d` | [`0xd9ff33f4…81aa4d`](https://suiscan.xyz/testnet/object/0xd9ff33f4f6e4014bcac74e89261ec47ce2ed34be4c6ea1ce10592fe7e081aa4d) ✅ |
| MartingalerVault&lt;TUSD&gt; AdminCap | `0x9fbcca5761e7928e3a1e2ae09180361d48bb1509753c898dc9bebb214c5ed538` | [`0x9fbcca57…5ed538`](https://suiscan.xyz/testnet/object/0x9fbcca5761e7928e3a1e2ae09180361d48bb1509753c898dc9bebb214c5ed538) ✅ |
| RideMarketCaps&lt;SUI&gt; | `0xe4706b39c0e9fd815f762e7e748146b65a240da8d374ee521d6e554030cac528` | [`0xe4706b39…cac528`](https://suiscan.xyz/testnet/object/0xe4706b39c0e9fd815f762e7e748146b65a240da8d374ee521d6e554030cac528) ✅ |

## TUSD — test stablecoin

| | ID | SuiScan |
|---|---|---|
| Coin package | `0x204d595c642a06ccc667a32789a6a5a01d0b7ff3340fb53f7f69649c90d00a31` | [`0x204d595c…d00a31`](https://suiscan.xyz/testnet/object/0x204d595c642a06ccc667a32789a6a5a01d0b7ff3340fb53f7f69649c90d00a31) ✅ |
| Coin type | `0x204d595c642a06ccc667a32789a6a5a01d0b7ff3340fb53f7f69649c90d00a31::tusd::TUSD` | — |
| TreasuryCap (faucet mints) | `0x7db5b3edead4f503ce8ef19ace6eca26e961edd08871042ad5de6f870a369b11` | [`0x7db5b3ed…369b11`](https://suiscan.xyz/testnet/object/0x7db5b3edead4f503ce8ef19ace6eca26e961edd08871042ad5de6f870a369b11) ✅ |
| CoinMetadata | `0x820cc6ee93078333a5eff2cdec6473859cb57ce7f901e05a47eaeade8a3d7480` | [`0x820cc6ee…3d7480`](https://suiscan.xyz/testnet/object/0x820cc6ee93078333a5eff2cdec6473859cb57ce7f901e05a47eaeade8a3d7480) ✅ |

Decimals: 6 · Publisher minted: 1,000,000,000 TUSD

## Gas sponsorship (v4 — sponsored cranking)

| | ID | SuiScan |
|---|---|---|
| SponsorPolicy | `0x00d868c659dd0bda6dab50100aad10312939ac2a307c85957e00bb30da7d5387` | [`0x00d868c6…7d5387`](https://suiscan.xyz/testnet/object/0x00d868c659dd0bda6dab50100aad10312939ac2a307c85957e00bb30da7d5387) ✅ |
| SponsorCap | `0x505084ecf0d81ca974ca4fb5dfe6d1214a3f183134031ac72792d1084b514829` | [`0x505084ec…514829`](https://suiscan.xyz/testnet/object/0x505084ecf0d81ca974ca4fb5dfe6d1214a3f183134031ac72792d1084b514829) ✅ |
| Sponsor wallet | `0x02e3f17cac22394741feb3d5d0afa2461df873eafd746777aadaeac04204fefa` | [`0x02e3f17c…04fefa`](https://suiscan.xyz/testnet/account/0x02e3f17cac22394741feb3d5d0afa2461df873eafd746777aadaeac04204fefa) |

Max spend/day: 1.0 SUI

## Markets — SegmentMarketV4 (the Ride game · current)

| Name | Market ID | Collateral | SuiScan |
|---|---|---|---|
| WICK-SEG-V4-75-1000bps | `0xec32d173efe554247bc0b2b676f52a2f98918f6e0e6065d756757590ba526943` | SUI | [`0xec32d173…526943`](https://suiscan.xyz/testnet/object/0xec32d173efe554247bc0b2b676f52a2f98918f6e0e6065d756757590ba526943) ✅ |
| WICK-SEG-V4-75-1000bps | `0xa72a369e2fea69c100ee8be10c291f72ffaf18687bf578435565c92bfa981665` | SUI | [`0xa72a369e…981665`](https://suiscan.xyz/testnet/object/0xa72a369e2fea69c100ee8be10c291f72ffaf18687bf578435565c92bfa981665) ✅ |
| WICK-SEG-V4-TUSD-75-1000bps | `0xe98ace0ba07f165626c66b8d0ef9ec4858fe5d0b7fda8561d41a9e71476fa113` | TUSD | [`0xe98ace0b…6fa113`](https://suiscan.xyz/testnet/object/0xe98ace0ba07f165626c66b8d0ef9ec4858fe5d0b7fda8561d41a9e71476fa113) ✅ |
| WICK-SEG-V4-TUSD-RUG-150bps | `0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282` | TUSD | [`0x54e91530…0b5282`](https://suiscan.xyz/testnet/object/0x54e915308c596981fa94e5ff1f6f4e602e8bd1aae8c4a610cb782573310b5282) ✅ |

## Markets — SegmentMarket (v3)

| Market ID | SuiScan |
|---|---|
| `0x0c2bdb9ecafe70cc6c09a3cee6cac29d9a9da0f9618864ad8922d676c05e71f9` | [`0x0c2bdb9e…5e71f9`](https://suiscan.xyz/testnet/object/0x0c2bdb9ecafe70cc6c09a3cee6cac29d9a9da0f9618864ad8922d676c05e71f9) ✅ |
| `0x2f74fbdb20560206617c711a454dc29d4d6b000cc9ab2e4537400d80f88d1e45` | [`0x2f74fbdb…8d1e45`](https://suiscan.xyz/testnet/object/0x2f74fbdb20560206617c711a454dc29d4d6b000cc9ab2e4537400d80f88d1e45) ✅ |

## Markets — Arcade RNG (touch / no-touch)

| Name | Market | Oracle | PathObservation |
|---|---|---|---|
| WICK-RNG-25 | [`0x6b55fd4c…af9ba3`](https://suiscan.xyz/testnet/object/0x6b55fd4ca9452765eddfbbf1fcf3757380ef51bf6cbb8be7e1f376af4faf9ba3) ✅ | [`0x48d4a382…5967b3`](https://suiscan.xyz/testnet/object/0x48d4a382195c7fafa7740e2d4755003651c29fdee544ac3fe65ef7bf115967b3) ✅ | [`0x808a0620…89487d`](https://suiscan.xyz/testnet/object/0x808a0620cf8f48a711150a8385f80210dcc0018fa8512ac469ba00ec1389487d) ✅ |
| WICK-RNG-100 | [`0x47e68445…4b9e7a`](https://suiscan.xyz/testnet/object/0x47e684459027ed6bed2c1a32fb0dd5c26c211e75d83b077c9117c97d934b9e7a) ✅ | [`0x99683dab…35499e`](https://suiscan.xyz/testnet/object/0x99683dab7a41cb012227f0afe19d950233d9f041692a12581ecaea81bc35499e) ✅ | [`0xbaa0cc25…8db2ab`](https://suiscan.xyz/testnet/object/0xbaa0cc2547d29b645a8b1f3d8b937d0681c66a815197a17b72e26f2f2f8db2ab) ✅ |
| WICK-RNG-1000 | [`0x9f9e00ff…8670db`](https://suiscan.xyz/testnet/object/0x9f9e00ffb7cb14da084c986efa27b7b527e7a113e67285e90bd1151b728670db) ✅ | [`0x78b051a0…807416`](https://suiscan.xyz/testnet/object/0x78b051a0ac8890c44e89ea90eb85d3a974127a50245812a3033bfa8d0d807416) ✅ | [`0x2aa2c30b…603c85`](https://suiscan.xyz/testnet/object/0x2aa2c30b16e6dc4ed9475d7a8980347d14fa9f0fba556a74973f5cb922603c85) ✅ |
| WICK-RNG-25 | [`0xd3e06e18…8c4b85`](https://suiscan.xyz/testnet/object/0xd3e06e186a86e381c770f22de910a25155cb7ea7f8f255f8e1f32eaca18c4b85) ✅ | [`0x20fca9dc…1bff7f`](https://suiscan.xyz/testnet/object/0x20fca9dcde8d0d40a264c15fcd987d729c979470e1d2dba054099c4a461bff7f) ✅ | [`0x546f649c…f728e3`](https://suiscan.xyz/testnet/object/0x546f649c4f3c7636cc73f8b3319232a4d7edca27b53e24eac36e72789ef728e3) ✅ |
| WICK-RNG-100 | [`0xc6d2c6e3…96bf77`](https://suiscan.xyz/testnet/object/0xc6d2c6e3496939627ef4fd9b66d35a689a8b7220a2aeffc623b4cd8c8a96bf77) ✅ | [`0x03e54d35…4bf4f4`](https://suiscan.xyz/testnet/object/0x03e54d35ebdf795a23f2b0d2c1fe845e751d54cb45e102c108fb0d043d4bf4f4) ✅ | [`0x2193ff8d…d300b6`](https://suiscan.xyz/testnet/object/0x2193ff8d2c5c3662402a76b9d701ecd47820da144220271e38bbc0420bd300b6) ✅ |
| WICK-RNG-1000 | [`0x4b6062d5…cd6e45`](https://suiscan.xyz/testnet/object/0x4b6062d57de9a39edfd5c902fe86c6e5c02fef0a62fb87dd765e8b4dc0cd6e45) ✅ | [`0x30c8c3d8…39d3b9`](https://suiscan.xyz/testnet/object/0x30c8c3d81258d9d0219499ac9ee8d37a053ebb38cdb2868e9e67ab24e939d3b9) ✅ | [`0x3c1c0444…517e17`](https://suiscan.xyz/testnet/object/0x3c1c044424e502395db9fe558e66428e1b437f6b39810296698ec03345517e17) ✅ |
| WICK-RNG-25 | [`0xe3c9cf0f…48cadc`](https://suiscan.xyz/testnet/object/0xe3c9cf0f3bc99fd3580502831f786f3106e028804ed15589685523c18d48cadc) ✅ | [`0xc8a8531d…6efcc4`](https://suiscan.xyz/testnet/object/0xc8a8531d37312c84232ffc4a03c2a9f13b94ec072b1c8e57f683e5b34d6efcc4) ✅ | [`0xf69b208e…dc11f9`](https://suiscan.xyz/testnet/object/0xf69b208e1b7a412e41758ea8fda9495fbeef8d70ce0076b08d75ed0a68dc11f9) ✅ |
| WICK-RNG-100 | [`0x01f0fc41…9960e2`](https://suiscan.xyz/testnet/object/0x01f0fc411740a2b337bc656132c8d14c92cfd1f6c5b1306499784efd539960e2) ✅ | [`0x7e8c6a3d…a751fc`](https://suiscan.xyz/testnet/object/0x7e8c6a3d0f09d6ef35efeb5680990a2d50ad70949bf9fefeb669740ec6a751fc) ✅ | [`0xcab043a4…23a30f`](https://suiscan.xyz/testnet/object/0xcab043a48d3916b60758a0355f57ab5e0b482470472d8ddd863df025b923a30f) ✅ |
| WICK-RNG-1000 | [`0x5791b60c…aa05c6`](https://suiscan.xyz/testnet/object/0x5791b60cc4bdf3fae925228283bbcbd74498feb867b1b8779e8f7b3dc8aa05c6) ✅ | [`0xdcbc1790…ac606c`](https://suiscan.xyz/testnet/object/0xdcbc1790445538d6dac2a52a2eaa14c8a633176b3982f4a42c586c3992ac606c) ✅ | [`0xd9fcf09d…4a633a`](https://suiscan.xyz/testnet/object/0xd9fcf09d6a27c7fd922ce51001b56313a1ee1cccc94f87ea183e564c6d4a633a) ✅ |
| WICK-RNG-25 | [`0x7a99fbd7…b9c976`](https://suiscan.xyz/testnet/object/0x7a99fbd74a47be73fd56cced8900caff9f28474b296ecd36dee4d8a6d0b9c976) ✅ | [`0x52eb2252…69d024`](https://suiscan.xyz/testnet/object/0x52eb22525a1c2d724593e82730cf6ee54efccfeac4979aab01b8e54a4669d024) ✅ | [`0xdbaa87a2…4d7942`](https://suiscan.xyz/testnet/object/0xdbaa87a27b4480d84576070bcf724247334f1a3794b075c844e3444c344d7942) ✅ |
| WICK-RNG-25 | [`0xce9da45c…3893eb`](https://suiscan.xyz/testnet/object/0xce9da45c4b092d8494a0686eaf92e2927cca22b78db4c74710de9e7f0f3893eb) ✅ | [`0x3a842cb5…cb0774`](https://suiscan.xyz/testnet/object/0x3a842cb590859925b61d0058380b7ce888f5d23066939e89eafc459a30cb0774) ✅ | [`0xf2f7bc39…2fa5ee`](https://suiscan.xyz/testnet/object/0xf2f7bc39b93db993567e1ac15d1134cd82f4a72a9ca3c1f6a81f04804a2fa5ee) ✅ |
| WICK-RNG-100 | [`0x1dcd685c…55e70b`](https://suiscan.xyz/testnet/object/0x1dcd685c5bf8aca342defcd5a9229ed1920c25a68abb1f33975a7bae6a55e70b) ✅ | [`0x471bd988…02aab5`](https://suiscan.xyz/testnet/object/0x471bd98813717c83157df258b0cff7285193dcbad649a0311374467a5302aab5) ✅ | [`0x66afbf1d…74ea36`](https://suiscan.xyz/testnet/object/0x66afbf1dc814d92ac7417ccb47f3052222667cf8edd459a312cfb4249774ea36) ✅ |
| WICK-RNG-1000 | [`0xc1034a66…d1207b`](https://suiscan.xyz/testnet/object/0xc1034a6647b488f1f48ed6f993cc6f734fa4d067a52db72620f5c88a0cd1207b) ✅ | [`0xda8a3ca9…5f0c2a`](https://suiscan.xyz/testnet/object/0xda8a3ca970c3b2323c95485217cde4d40548af60e1b01fa964d03ffa045f0c2a) ✅ | [`0x14c5d249…d3917d`](https://suiscan.xyz/testnet/object/0x14c5d249fcfb38c4c27b550a35cc9adc5f4c1b6d2b6e8eaf2be4d2f97bd3917d) ✅ |
| WICK-RNG-1000 | [`0x9c153a82…f77617`](https://suiscan.xyz/testnet/object/0x9c153a825b3b6acebccc5e29fd7cd1916bdca11b9df510527abfa72443f77617) ✅ | [`0x82f0c373…7b1966`](https://suiscan.xyz/testnet/object/0x82f0c373d0408365a30d3d4e40ec7ee75fb7552ec1bb57ba9213eda3a27b1966) ✅ | [`0x382e656b…ab48d4`](https://suiscan.xyz/testnet/object/0x382e656bc609e52b14a50709667bf8892369d79b8bf60941b54ba9dc9dab48d4) ✅ |
