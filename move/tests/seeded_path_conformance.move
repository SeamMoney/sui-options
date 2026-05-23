#[test_only]
module wick::seeded_path_conformance;

use wick::seeded_path::{Self, Candle, WalkState};
use sui::bcs;
use sui::hash::blake2b256;

// ───────────────────────────────────────────────────────────────────────────
//  AUTO-GENERATED — DO NOT EDIT BY HAND.
//  Source:  sdk/scripts/gen-conformance.ts
//  Regen:   npx tsx sdk/scripts/gen-conformance.ts   (npm run conformance -w @wick/sdk)
//
//  10000 vectors, 200 chunks of 50 — doc 17 §8, spine test 1:
//  proof that Move seeded_path::expand_segment is byte-identical to the
//  TypeScript @wick/sdk seededPath.ts expandSegment.
//
//  Both sides derive every input deterministically from MASTER_SEED and fold
//  all outputs into a rolling blake2b digest; this test embeds only the seed
//  and one digest per chunk (package-size-independent — see the harness
//  header for why). A failing conformance_NNN means Move and TS diverged
//  within vectors [NNN*50 .. NNN*50+50); the abort code is that start index.
// ───────────────────────────────────────────────────────────────────────────

const MASTER_SEED: vector<u8> = x"7769636b3a7365656465645f706174683a636f6e666f726d616e63652f763121";
const ACC_INIT: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000000";

/// Derive conformance input i. Must match deriveInput() in gen-conformance.ts.
fun derive_input(i: u64): (vector<u8>, u64, bool, u128, u64, u64) {
    let seed = MASTER_SEED;
    let c = i * 8;
    let price = 50_000_000 + (seeded_path::keystream_word(&seed, c + 1) % 4_950_000_001);
    let vr = 250_000 + (seeded_path::keystream_word(&seed, c + 2) % 3_350_001);
    let home_mul = 700_000 + (seeded_path::keystream_word(&seed, c + 3) % 600_001);
    let home = (((price as u128) * (home_mul as u128)) / 1_000_000) as u64;
    let mcap = ((price as u128) * 13_000) / 1_000_000;
    let mom_mag = (seeded_path::keystream_word(&seed, c + 4) as u128) % (mcap + 1);
    let mom_neg = seeded_path::keystream_word(&seed, c + 5) % 2 == 1;
    // key = blake2b256(MASTER_SEED ‖ le8(c)) — built last so `seed` can move in
    let mut kin = seed;
    vector::append(&mut kin, bcs::to_bytes(&c));
    let key = blake2b256(&kin);
    (key, price, mom_neg, mom_mag, vr, home)
}

/// Fold one segment's outputs into the rolling accumulator. Field order must
/// match fold() in gen-conformance.ts.
fun fold_outputs(
    acc: vector<u8>,
    candles: &vector<Candle>,
    new_st: &WalkState,
    smin: u64,
    smax: u64,
): vector<u8> {
    let mut buf = acc;
    let mut j = 0;
    while (j < 6) {
        let c = vector::borrow(candles, j);
        let o = seeded_path::candle_open(c);
        let h = seeded_path::candle_high(c);
        let l = seeded_path::candle_low(c);
        let cl = seeded_path::candle_close(c);
        vector::append(&mut buf, bcs::to_bytes(&o));
        vector::append(&mut buf, bcs::to_bytes(&h));
        vector::append(&mut buf, bcs::to_bytes(&l));
        vector::append(&mut buf, bcs::to_bytes(&cl));
        j = j + 1;
    };
    let p = seeded_path::state_price(new_st);
    let mn: u64 = if (seeded_path::state_momentum_neg(new_st)) 1 else 0;
    let mm: u64 = (seeded_path::state_momentum_mag(new_st) as u64);
    let vr = seeded_path::state_vol_regime(new_st);
    // FSM fields (u8 in Move, widened to u64 for the digest).
    let pid: u64 = (seeded_path::state_pattern_id(new_st) as u64);
    let cr:  u64 = (seeded_path::state_candles_remaining(new_st) as u64);
    vector::append(&mut buf, bcs::to_bytes(&p));
    vector::append(&mut buf, bcs::to_bytes(&mn));
    vector::append(&mut buf, bcs::to_bytes(&mm));
    vector::append(&mut buf, bcs::to_bytes(&vr));
    vector::append(&mut buf, bcs::to_bytes(&pid));
    vector::append(&mut buf, bcs::to_bytes(&cr));
    vector::append(&mut buf, bcs::to_bytes(&smin));
    vector::append(&mut buf, bcs::to_bytes(&smax));
    blake2b256(&buf)
}

/// Fold count vectors from start, assert the rolling digest matches.
fun run_chunk(start: u64, count: u64, expected: vector<u8>) {
    let mut acc = ACC_INIT;
    let mut i = 0;
    while (i < count) {
        let (key, price, mneg, mmag, vr, home) = derive_input(start + i);
        let st = seeded_path::state_with(price, mneg, mmag, vr, home);
        let (candles, new_st, smin, smax) = seeded_path::expand_segment(st, key);
        acc = fold_outputs(acc, &candles, &new_st, smin, smax);
        i = i + 1;
    };
    assert!(acc == expected, start);
}

#[test] fun conformance_000() { run_chunk(0, 50, x"8e4fdcde86fbd617646f25f243d8fa6d759ff433d8e2ec7176b9b65677b32be4") }
#[test] fun conformance_001() { run_chunk(50, 50, x"a1ee2789c64f7132dce881bc646f44f5c0412971593b46d05f2cf1c3c5228a69") }
#[test] fun conformance_002() { run_chunk(100, 50, x"98d6f1d140e8b97ad0f6376e11868807324d2d6794fb502bc8126660d322c29c") }
#[test] fun conformance_003() { run_chunk(150, 50, x"41320b11a25dd595380327f7b208ab103465b31eb775710290ab4ba1fd046ea6") }
#[test] fun conformance_004() { run_chunk(200, 50, x"dff26e2ad934b74c5902fb4cb7ce90a524aef49a78c59a5b27e985a7a8db4eb2") }
#[test] fun conformance_005() { run_chunk(250, 50, x"14205769db667ef4be7e90395b8bd4aa348868957914c9e88a0e15f00658d995") }
#[test] fun conformance_006() { run_chunk(300, 50, x"46d9487e44daa11dbe48c011a7fa6ace4a92c41cd31d3a06407d164781a4027c") }
#[test] fun conformance_007() { run_chunk(350, 50, x"b1956b7786904e0b0024918b55e9c3b4e98767a103006a210355b55e46d45538") }
#[test] fun conformance_008() { run_chunk(400, 50, x"17299ece5818e6b4288655906f98043a7859ceba019e0f77eb932c295c7e9b95") }
#[test] fun conformance_009() { run_chunk(450, 50, x"426dee733ceb6bb76387e5b9cdcbc18b72c6b254bf857c7e4be7282f4502b7e5") }
#[test] fun conformance_010() { run_chunk(500, 50, x"cb6cc42fbe805d5db5c79f214a70053336476963a40d43b31741b661fbed0790") }
#[test] fun conformance_011() { run_chunk(550, 50, x"73d3fd5905f8a3d2a0947977c31bc3a070dc30fb73c11a92872f820132c1ba73") }
#[test] fun conformance_012() { run_chunk(600, 50, x"0f20dc0925246615ee7019ec7f669852b8ecc962854299e7b089d090783c30e7") }
#[test] fun conformance_013() { run_chunk(650, 50, x"6278d475d1f39eab5ce1fc986cb3d200b76c1aa503a83f77b36eb56189965852") }
#[test] fun conformance_014() { run_chunk(700, 50, x"f22bad1ae163d9cfe5a6d59157367cb0f5d2799f8883b48ceb8f2673ac05b487") }
#[test] fun conformance_015() { run_chunk(750, 50, x"998e6e7b3f28fa74fb1aade8b40bd7dbf5f8300cfc6a738549e3b60d4fbaa600") }
#[test] fun conformance_016() { run_chunk(800, 50, x"9dea8919283c4eff91006e573e358b0f007fe50c9849b29b162d6cb39df91662") }
#[test] fun conformance_017() { run_chunk(850, 50, x"794c29e4c7d71b9c9bdf1201e2aab8ebcd113dfbed7440921da64dbbf3acf5c7") }
#[test] fun conformance_018() { run_chunk(900, 50, x"df67378d8340b01efe081bd062e6b258691bdb6a816a7ec43f782726854a50dc") }
#[test] fun conformance_019() { run_chunk(950, 50, x"b3e8faf8f566a311f92ecb26c4004c196c2adf2844b2ad693faaf1a51581ff44") }
#[test] fun conformance_020() { run_chunk(1000, 50, x"a4b1864d72005a96daf16c28908b3e2e1ffd9e4e94b4ae5eb09a90c171a579e0") }
#[test] fun conformance_021() { run_chunk(1050, 50, x"910c31480de4ee76f3021e1c3b04171e04100b032381efd351535b2125dd5fe2") }
#[test] fun conformance_022() { run_chunk(1100, 50, x"cfb238162f519c0bedac1a2d866ee5beff5d566c8f54d06ad5b5ba669c4c70f8") }
#[test] fun conformance_023() { run_chunk(1150, 50, x"4a7da939a70bd8cff77efd1bfcf0b1b9d833591488ed7ffd3e8b8ce8686c8c3b") }
#[test] fun conformance_024() { run_chunk(1200, 50, x"e388d69cd484c41710e3d95acb7155e56827db228799c1f9e51c7329d1041fd0") }
#[test] fun conformance_025() { run_chunk(1250, 50, x"86fb1de007c188576f2069ff73279ccc09b0e290dc0b3ea2c4c1239320458ec0") }
#[test] fun conformance_026() { run_chunk(1300, 50, x"741c51efe8276b58a6aaf1fc5ad121c8ad7900c51071a2e2aa9b47d8abc829bc") }
#[test] fun conformance_027() { run_chunk(1350, 50, x"84defa7be19b894cd35b9e0bf6fc1bdd7ba7fc7cf1917ef47b4d86f4c87fa466") }
#[test] fun conformance_028() { run_chunk(1400, 50, x"7a0c88ed21927f9c82473a72159f2d3d78f295e801425d643885f115f76bbcf0") }
#[test] fun conformance_029() { run_chunk(1450, 50, x"624184e2aa1c59399cae30532304a0bb169a1dec2ca0e6c2a6c5df7c758697e8") }
#[test] fun conformance_030() { run_chunk(1500, 50, x"16c79ac0eea1bfa2a82625022956238169cdb9c386a66d8ea2ce8cfaae8afde6") }
#[test] fun conformance_031() { run_chunk(1550, 50, x"62a0662752ccff3deefbafbf318ff8eae001e2b9dc6296c76e3aafbab477df39") }
#[test] fun conformance_032() { run_chunk(1600, 50, x"342c1016376305967fe447b8976683fed9a570dfe6d2e8a564fb1ca32cf5baa3") }
#[test] fun conformance_033() { run_chunk(1650, 50, x"7817cbbe9ce558a5b62f3be8fe734c94b7c1998890051471ac97dcf5b7e8f72c") }
#[test] fun conformance_034() { run_chunk(1700, 50, x"3d8b216f4ad85316980998ad94b4efb063b29398674482b6c674b816a40a3508") }
#[test] fun conformance_035() { run_chunk(1750, 50, x"d6a1e79d2f407a12d8d6f21cf1a95b46f8fc59ac27932f32531a6b3df718840d") }
#[test] fun conformance_036() { run_chunk(1800, 50, x"bffbef04e58d9128b39b991f4ace07822ff9b4524da1a433a1120ee0178b761a") }
#[test] fun conformance_037() { run_chunk(1850, 50, x"4d2504b736a4d79bfcf0e00a13516428234f3e4557f98070e3a842d14358b19d") }
#[test] fun conformance_038() { run_chunk(1900, 50, x"62f799985b6cd1fd6523b035f21c7488c228caa6860c120242852952a34bd3ee") }
#[test] fun conformance_039() { run_chunk(1950, 50, x"40c4bc4aa604632a6ede9bf243ab21249b6990c2dc4b7f00ca57ed939301f10d") }
#[test] fun conformance_040() { run_chunk(2000, 50, x"819f36a9041c1c3d1497864236299f8248eea0a1efe9135c02efd69c2f0510ee") }
#[test] fun conformance_041() { run_chunk(2050, 50, x"6bd34b8b707a5457e19f568c4006f2edf3c189e4c58639f763f7a4d218f61568") }
#[test] fun conformance_042() { run_chunk(2100, 50, x"9095a9a01bbf5cf5a6db471e993c8ab94baf15d1586caecd1d9cc609da9bad9a") }
#[test] fun conformance_043() { run_chunk(2150, 50, x"7244a6269c626d6915a5cc9d2712b94e1ab9419bd9cf677cf6100679f62325e7") }
#[test] fun conformance_044() { run_chunk(2200, 50, x"7cde7aa02b64410732fe8ec84861e10174f08ea663403aec5a7c04d7afa785e5") }
#[test] fun conformance_045() { run_chunk(2250, 50, x"4d0813807fd2b2d7e2f1ceb880a6e617b509c0854b6483a322f290a8df41fa9d") }
#[test] fun conformance_046() { run_chunk(2300, 50, x"be62b45d0268442d8f864da5a54d93d6749f822ddc86861c9a94eae5d8b35534") }
#[test] fun conformance_047() { run_chunk(2350, 50, x"41cefc995c9f6bed40d3f0289de02afbebfc4246e3c18211d522f5f052cea54a") }
#[test] fun conformance_048() { run_chunk(2400, 50, x"064b7cef056a91c34315fa338f939a0a2d679eafc3e0952ec67871245d19d92b") }
#[test] fun conformance_049() { run_chunk(2450, 50, x"99f1566826edf36f0b7373606179c205543987e8e3be2397d5ce58ac391727c3") }
#[test] fun conformance_050() { run_chunk(2500, 50, x"ed320e8a95639ef55263a106627781c557d9a11670699aa1faeb9e9db58db2fa") }
#[test] fun conformance_051() { run_chunk(2550, 50, x"08f83c88babd7d54e646e629d35303d1f750e1076f3d1565fe84848589feea55") }
#[test] fun conformance_052() { run_chunk(2600, 50, x"765aae1c368603974d0f1bca40d0a0922fea11c99861ec12dfec95832702e4ec") }
#[test] fun conformance_053() { run_chunk(2650, 50, x"8ad4fdab3aa2f533aead74404e9ad3dbc0671c6fad2c3f1b34df56018efcffd3") }
#[test] fun conformance_054() { run_chunk(2700, 50, x"b3db9b30a93b16077af25ce193420c01c143b9b4370c20847476e671ecc61df7") }
#[test] fun conformance_055() { run_chunk(2750, 50, x"cd2bbbc7f2ab8673ba8c7c60496fa71666fb0863c7753163f028527415ca0c65") }
#[test] fun conformance_056() { run_chunk(2800, 50, x"b7b05ac03d146caf520ea861766ed4675580f42cffa458b90138b2579ec797eb") }
#[test] fun conformance_057() { run_chunk(2850, 50, x"6df3cb8fe345766afeee6ff2e858009a6de8b80dc2fa48298c1274fb3cac6089") }
#[test] fun conformance_058() { run_chunk(2900, 50, x"6c6e9cc089b92d7b63ce712b6fa0af1587cfc51a16db5dc19557ec0e43dd6785") }
#[test] fun conformance_059() { run_chunk(2950, 50, x"452733a5146da3a6bb0c0439e6430d8583e43b0dca447974e98a6732fef26e87") }
#[test] fun conformance_060() { run_chunk(3000, 50, x"4d26b0f5875f9c1d086d26c0ede2b7db1e61021423d9c93534eb3ad7496ea0d5") }
#[test] fun conformance_061() { run_chunk(3050, 50, x"36867b95fa6fe130c2e5da0bb0f58c3da269a1ffc4bb526a701c5848bb567882") }
#[test] fun conformance_062() { run_chunk(3100, 50, x"e4443ef9db2a3511431a8d4ad5a7ce9b885c15e23f38324c09f14690e4830323") }
#[test] fun conformance_063() { run_chunk(3150, 50, x"e3390e712cf28f4a3d2cd732212b43e25a0906db3027d2cadbae824a00ff7e7f") }
#[test] fun conformance_064() { run_chunk(3200, 50, x"5c7c3eb2e81d2f4ed8dd6aeda32712a7cd367f1de8d447bac2542032d71f4388") }
#[test] fun conformance_065() { run_chunk(3250, 50, x"a4be3d01d9cae76f36dcd886bbca87f509a2c6381d19512d3e6e7fb1f99bcecc") }
#[test] fun conformance_066() { run_chunk(3300, 50, x"ed468f5f69c023d793b533444bd930856caa739e37bdbf77ef0c94f415b42a02") }
#[test] fun conformance_067() { run_chunk(3350, 50, x"ebbae3f4f8a011d31d71a79845ddccb0b543ae10337988d4ba12fbdf18a99fa4") }
#[test] fun conformance_068() { run_chunk(3400, 50, x"ae5f6d2cf5b92b633e954c5d615a6a413e930247eecfd3d2cca3f076205cd55a") }
#[test] fun conformance_069() { run_chunk(3450, 50, x"7c2c1394d6ed19adc077aea846757323570d5cd50ce067fd311d54ed1eb4bda5") }
#[test] fun conformance_070() { run_chunk(3500, 50, x"9ca93af6df8ec4f3f6cb4ae9cd4721ced6bd8d43f53070883095fbaa875b5732") }
#[test] fun conformance_071() { run_chunk(3550, 50, x"f35f066e105c2fd374bccfac18699e433a1b65cca481d686f02154359276b981") }
#[test] fun conformance_072() { run_chunk(3600, 50, x"4a9966607494eef379f91c0f6e0b4d7928bcb8589408a2d3e8297f7cd66d54dd") }
#[test] fun conformance_073() { run_chunk(3650, 50, x"666cf207f2ad2819e4424bd74c166bd0aac08c240d4a48df1cd0a67a2985f9b7") }
#[test] fun conformance_074() { run_chunk(3700, 50, x"eb196e182a723255b9650855e9b941112b5d40b50ffbc424172b193afa94bb3b") }
#[test] fun conformance_075() { run_chunk(3750, 50, x"77a609f7719a231dbce8ecf2595690c4ee3670195d22ecc8481e03b5d3bb91bc") }
#[test] fun conformance_076() { run_chunk(3800, 50, x"bfd4d92fc42a96e61e48ab4453037d0b6650b4c8ea7e5b5cf4e65d6562e095fb") }
#[test] fun conformance_077() { run_chunk(3850, 50, x"fa2d7b32dc8549243245245174ea87113baee6da86468b9740fd6ba9e5c4d6db") }
#[test] fun conformance_078() { run_chunk(3900, 50, x"615aaa517f12002514b2834a0f90f96dbc6450b2f5fd99fab51038bf1bfd911d") }
#[test] fun conformance_079() { run_chunk(3950, 50, x"09dae4c89822a2f50ab2500aff2055af014f513aa37e36d6dc484cf56ba3506f") }
#[test] fun conformance_080() { run_chunk(4000, 50, x"db9455756ec6c07489ffff3bab7dfe25059ac4bc9eb5ab978b6f26471d46eea0") }
#[test] fun conformance_081() { run_chunk(4050, 50, x"94bbc10920b2992aa02e44bd769c2010529cb515d03f0696a1142cb14e54dd58") }
#[test] fun conformance_082() { run_chunk(4100, 50, x"ab0e6840f1fced90a4d955b84c0c04fec01db4f3a509f8194fc4c4990247f4b2") }
#[test] fun conformance_083() { run_chunk(4150, 50, x"f8a5f8fe6888687b438448c9bb51aaa19a790b1988ab9dfb74fb5868df769db6") }
#[test] fun conformance_084() { run_chunk(4200, 50, x"edd8f982a7d3668e230248dec3c9ca086516a86f48f97fb84593194e9e5aea59") }
#[test] fun conformance_085() { run_chunk(4250, 50, x"b1ba8c691e6aaf512f02edcb1d5a0664a569579882a223756d6473457662a382") }
#[test] fun conformance_086() { run_chunk(4300, 50, x"9f45fc24968b016357685eb34fa0e9e458328e872bcf0d82345245a8c7054b44") }
#[test] fun conformance_087() { run_chunk(4350, 50, x"0aec18598da7dd5e98e902b6afd5de75d84e0c17b6f2334963b3218dc48c2d2a") }
#[test] fun conformance_088() { run_chunk(4400, 50, x"12123e2f3174f6d4687c111a6e463ed6dc240e982e7a3dcc6e8cabe14cf6e0d8") }
#[test] fun conformance_089() { run_chunk(4450, 50, x"669dfdd0be19a2ddb811d02b4a4d3a1cfeb6735aa6bbe9bff23e9524702d2671") }
#[test] fun conformance_090() { run_chunk(4500, 50, x"97faa7a3854e43be18e27b000b8a90cc675bd43c4c8d66f365b127ca9932ad13") }
#[test] fun conformance_091() { run_chunk(4550, 50, x"38721e433ad9272077fc15ecc28b539e6f67d892abe595127469b48a92ba88a6") }
#[test] fun conformance_092() { run_chunk(4600, 50, x"26596edd4cf798f41caea0cd45aaead8ca438ca566087c76b8dbf28eaf4f7d75") }
#[test] fun conformance_093() { run_chunk(4650, 50, x"1b1bea0ad962d14388d9028770c91bbce5ac6cf36ee1241162b5a3d92fef2af3") }
#[test] fun conformance_094() { run_chunk(4700, 50, x"5a54e676f99ddd7d4b852b3556ec8bb1dbe5a3a0fda1085d3433b8b29f82b6d7") }
#[test] fun conformance_095() { run_chunk(4750, 50, x"af9d53bb588416d779f77f69caec6f5e1d8050cf7ebd5016cbb5134a93422430") }
#[test] fun conformance_096() { run_chunk(4800, 50, x"4d1cccb585b518fd079a0cb4409bc31bd2ac8f0bd8d783bb832eb710ddf701de") }
#[test] fun conformance_097() { run_chunk(4850, 50, x"7b5d711d7c325dfe8a6a2b5b2da57c20de21f4b1b54738aa9a36b4cf69359a02") }
#[test] fun conformance_098() { run_chunk(4900, 50, x"e886020c1f73e4693d03b7ff00d7928cc2d3f4ed6e3dd8e5811365a7a81d51f1") }
#[test] fun conformance_099() { run_chunk(4950, 50, x"8b66587a64cb09d67a259377c727a434388a9b657a1bd7eca4df0b4f71fd8cbb") }
#[test] fun conformance_100() { run_chunk(5000, 50, x"99f89ee947f17a3a69345d8c1346975a93a85e7a3c2cc675cef341ccdbbf9f91") }
#[test] fun conformance_101() { run_chunk(5050, 50, x"3f002fba5d036a3758b760c822f167c59d578476a02beefd01f786f3aaa28826") }
#[test] fun conformance_102() { run_chunk(5100, 50, x"76007871ca0f4e4d6c1ca94cfe41ba3d39942a15cf488ef53d9590a21a65a0f8") }
#[test] fun conformance_103() { run_chunk(5150, 50, x"1a1a23e55eda220441403597ad504a47edf2c6851315e99e00f7e3e1c8d325cc") }
#[test] fun conformance_104() { run_chunk(5200, 50, x"66abbd5b55e0fbc0e443eb1467ffeeee697bcd22584c150fd70aa813b8805778") }
#[test] fun conformance_105() { run_chunk(5250, 50, x"44779c233ebc45af01f3d8b2762c3861dbb725888fa86f1170aaaccfc5ad6a6f") }
#[test] fun conformance_106() { run_chunk(5300, 50, x"a81bcee37250f0ba19d32b09d647de93b5201bae2cf8606b09db9d3b5e167095") }
#[test] fun conformance_107() { run_chunk(5350, 50, x"1d5d1d51f6fd826f72c63221124a4fc0a59c51786d99244895eaab2b37b81458") }
#[test] fun conformance_108() { run_chunk(5400, 50, x"ae2da44268ce33f7d8737000905a201a7212573fd652aacb34f25e09f29ecfd1") }
#[test] fun conformance_109() { run_chunk(5450, 50, x"b530897304cfa361e20a9bad18205be275ac7c881cca3d9dbae91d83ea556408") }
#[test] fun conformance_110() { run_chunk(5500, 50, x"e10b27d1919bc6bc3e35b93681959e9f7de229d763bcbc196b1da4f4a1068c3a") }
#[test] fun conformance_111() { run_chunk(5550, 50, x"9bf9d468f26b30a339718e6c779c68faf823bb2943bd8e8548784b6ca4c0e86b") }
#[test] fun conformance_112() { run_chunk(5600, 50, x"87222447b8f96392e310f69d8c5cac119ce62d3afebdb1fb9cd28c195b36bfd5") }
#[test] fun conformance_113() { run_chunk(5650, 50, x"02e4f28c67fdec1633fc234f886a29e00dd11fa099392a5beee6e5d549ee9fd8") }
#[test] fun conformance_114() { run_chunk(5700, 50, x"f49f83e6c352e318db766cc2d7c30e1ea61baf731fd0ee50bd2e1680dde567d3") }
#[test] fun conformance_115() { run_chunk(5750, 50, x"f6d710f19ea49870271bd0d904f5c759ad29facc3f5a9079847e22bfbbfd9bda") }
#[test] fun conformance_116() { run_chunk(5800, 50, x"378a41522e3eee4627d3dab98d9c1c7c7d76bb46914bc9805a2fa5e8e29cc63a") }
#[test] fun conformance_117() { run_chunk(5850, 50, x"8b489fff8789e8fa6ef346052b74e27bd8687daa58a44ba402f38fc864549906") }
#[test] fun conformance_118() { run_chunk(5900, 50, x"1840f11ac9d6c9ce7ff78b027b85b55b306b0a85f9cd7920385f88dad88f632a") }
#[test] fun conformance_119() { run_chunk(5950, 50, x"d093d925f35f45b4d39517314ca6174e373ed5a55e83a6fda0b93c2949d15f53") }
#[test] fun conformance_120() { run_chunk(6000, 50, x"a94f3f072233e22a50f951051aef917e2c9a78e7d8fdde9f1feae066b2c72ff8") }
#[test] fun conformance_121() { run_chunk(6050, 50, x"349e19f5b6216464e018c24b862a4990e91048e083a4e9a5159ab1c485f67f39") }
#[test] fun conformance_122() { run_chunk(6100, 50, x"f06f68a30d8b0adaf24c5d93a0d93b9159d145c1200a46ee0cfd02289b24400f") }
#[test] fun conformance_123() { run_chunk(6150, 50, x"c6db49e1eed3c6c9d73154032f1b213ae9cc636f446091055a2af682f8480731") }
#[test] fun conformance_124() { run_chunk(6200, 50, x"590024ce4f816cb1ba0842e5a888fef57f9289b24dd79f957b41c18f1d6c4a2d") }
#[test] fun conformance_125() { run_chunk(6250, 50, x"695582131e28d8d1ff70a2b2a795e6b32395fef133063196a520c47ba71086da") }
#[test] fun conformance_126() { run_chunk(6300, 50, x"6dee736f0915390f3f19c2baf75df045f9c7fc9c361a11b46e647940ad150f06") }
#[test] fun conformance_127() { run_chunk(6350, 50, x"e5e3d7c44bb8c9637eb0ea83f3fd4c82ce9ceb847d48fdff85aa66b0770feaaf") }
#[test] fun conformance_128() { run_chunk(6400, 50, x"f3b26973db46a4827cf36430d337d7fe31ff4b2d7b69df83aac0751019cf1740") }
#[test] fun conformance_129() { run_chunk(6450, 50, x"2c7c27b34e55adc7362e4450078b788f6c678f5ab1fc8846f7519f7d2f2c4f15") }
#[test] fun conformance_130() { run_chunk(6500, 50, x"d03c8bf9a67b211885f6a3f315a8c02b6501f359920c93ba85c8fe31b3e25c15") }
#[test] fun conformance_131() { run_chunk(6550, 50, x"53a9b73165e33ddca6973f8abd1c2c50e3cf21d20ba4045bb03cbeabd39ee10b") }
#[test] fun conformance_132() { run_chunk(6600, 50, x"0a16ff6e0d9ebf9d9a4282b367ca58268ad8e2d28258f4a557958fb482408b38") }
#[test] fun conformance_133() { run_chunk(6650, 50, x"c4e3c01400db437ffbc9fff33a4283a0d95bae255ff8f33269751e78b4b06558") }
#[test] fun conformance_134() { run_chunk(6700, 50, x"b99d7795ea3067c9bf28bbdda55e0cd944e462f243c65846b94b8d7479a171e1") }
#[test] fun conformance_135() { run_chunk(6750, 50, x"5e8bae9595c483d344490b2441de210032b45265e16c6d90b2c2c4d9a56bd0fb") }
#[test] fun conformance_136() { run_chunk(6800, 50, x"f0a1d15fac6deeaca35e4dea3a1a7061d8a471f6f337c07a8f1edc9bede6ada4") }
#[test] fun conformance_137() { run_chunk(6850, 50, x"5fd1c9dcdbb6c5dfb5718ba179e3427591f15dc9c902fbe3f717630648cbae72") }
#[test] fun conformance_138() { run_chunk(6900, 50, x"9277fac7b0d40f10dbfe7c1940d92e87eff8906f882367de5cbea80a519d29d8") }
#[test] fun conformance_139() { run_chunk(6950, 50, x"d2fb7c020db2289f00f7ab64ab33581652108763e615759f1f175fd76e694ee1") }
#[test] fun conformance_140() { run_chunk(7000, 50, x"4d1f16aa45d630d948895fc0604830f6df7a4fc8bf152f482aaf69fca00c66f8") }
#[test] fun conformance_141() { run_chunk(7050, 50, x"a290f612e3c386ecc008911d308d522cb7fc494697068c24c9727413ef8d42ab") }
#[test] fun conformance_142() { run_chunk(7100, 50, x"fcd6b820da008014acd4d5b6a42f42f79f9d374af5fecff36f6d2822c9bfc033") }
#[test] fun conformance_143() { run_chunk(7150, 50, x"edbfff84fa81b3724c207ca9f5cd182a2a361a753f8204ab4ed1d7ae6d557200") }
#[test] fun conformance_144() { run_chunk(7200, 50, x"a47c6b4a2e39623af0ecb61bf0a960d44fd776dad5380f5b1fc4655b3a0d91ba") }
#[test] fun conformance_145() { run_chunk(7250, 50, x"35d834a2e696d3ad74dc8948cd33847b04ef086642cfe19f162b443fd52c353d") }
#[test] fun conformance_146() { run_chunk(7300, 50, x"a65e1e70be896e19bb505572f9efc4d0c5516cc1cc5311cec1782d1309d5eebd") }
#[test] fun conformance_147() { run_chunk(7350, 50, x"404e98f804097fe1cd2bc7eeda5f17cab0ca457e32e934da76c1dea25b3185ad") }
#[test] fun conformance_148() { run_chunk(7400, 50, x"9f8c6bdd645134147d06a0bb1b971fda466ada99ca36a72f06d17652a6b2473f") }
#[test] fun conformance_149() { run_chunk(7450, 50, x"4c09f6dcc5994f6f22e6eb415ce35f77224c968be8875c8dbd52d2f1b8beaa91") }
#[test] fun conformance_150() { run_chunk(7500, 50, x"c45e4500575621a469107d63649a87411c12983203306715b3253c64dff1ac96") }
#[test] fun conformance_151() { run_chunk(7550, 50, x"d0518c678ab47bb680d6a93c910a61c1cfb189a86e976a364b9d9a65131665d4") }
#[test] fun conformance_152() { run_chunk(7600, 50, x"995325b0d0e5a60cf897fc25f47796a2040e9a262ccced870c7b9a0483676519") }
#[test] fun conformance_153() { run_chunk(7650, 50, x"78f9afbfb554d275bf2a1a88d19b556865168291a67e1228912a5113bb122d48") }
#[test] fun conformance_154() { run_chunk(7700, 50, x"9c19b54ece8dc7bbe5735d4a2072d1f8788fea7ef55e82ef9618f16825e929f9") }
#[test] fun conformance_155() { run_chunk(7750, 50, x"d5813976f79a667c910c76fe123ba9fa417db3c01b20b918349aa345f4938514") }
#[test] fun conformance_156() { run_chunk(7800, 50, x"5d72c29daca4d1d4deecd2ab327b9289d0059ec8894bc2433734a1e7f32a1496") }
#[test] fun conformance_157() { run_chunk(7850, 50, x"71ad0da57f0ba60fd67f18cb9cf67bc93416e2ca99766c933af23625b21adaf2") }
#[test] fun conformance_158() { run_chunk(7900, 50, x"9195350eca5fb9ca2b391b9009029a6c8b08dc8ebe58d8ce32ab25677f309439") }
#[test] fun conformance_159() { run_chunk(7950, 50, x"bb47155ba62253219fe237ac2b08eae4e2391680f3e5270eb6149b1292038ef1") }
#[test] fun conformance_160() { run_chunk(8000, 50, x"9917b6cde5064e332b4eaeebeeca072df82b4fab2bb0064db7c963394473961f") }
#[test] fun conformance_161() { run_chunk(8050, 50, x"1cbfe86aa9f463446ad1991ce832c308218613f6b15ad38ce41976b9997a6a89") }
#[test] fun conformance_162() { run_chunk(8100, 50, x"e007315cc620a4a2ec97cd3cece12e1dbca1a0c00995456bb7ff7a333aa92010") }
#[test] fun conformance_163() { run_chunk(8150, 50, x"5b09b7c6783621d3356ebd934910017caef94346462916e67edcb4cea590e46a") }
#[test] fun conformance_164() { run_chunk(8200, 50, x"f75cf270216f62f8dce024d0c59b6647e8db1b92e8f112bdbe38de6ab7b432a0") }
#[test] fun conformance_165() { run_chunk(8250, 50, x"c80d1615a946f67689075858323c43b2def858af53d858666d624672fb1213ba") }
#[test] fun conformance_166() { run_chunk(8300, 50, x"2ef2b886d7d895dbfdab0257ba01e3f404f17a399231e8eadd1a780b67e438b2") }
#[test] fun conformance_167() { run_chunk(8350, 50, x"63933b6f35d40b846d5ee61a734721fe7c2d49ccd808ab972e1574439fb13502") }
#[test] fun conformance_168() { run_chunk(8400, 50, x"3fcda63e41e77406863d36e209686b898300f8db58a8a5049b80882f06d9291d") }
#[test] fun conformance_169() { run_chunk(8450, 50, x"1e0409760a88e1c0135a50ef6e88a741701251788bab06e4fb95c81a6c662aed") }
#[test] fun conformance_170() { run_chunk(8500, 50, x"998914353a108c665b5a43ffe94321178aa40639c172327a422a3320b2f465ef") }
#[test] fun conformance_171() { run_chunk(8550, 50, x"a909cc264573358ff8de6e606ebdca96cd71492ac311a3887bb8e93b6a3f1d5a") }
#[test] fun conformance_172() { run_chunk(8600, 50, x"4f84eb60e499a41a3f2082ad46e0da0ae076eb76cc5ac780c32ad51d1947f242") }
#[test] fun conformance_173() { run_chunk(8650, 50, x"5a13a5f1343b7dce6d633ce54d6b7d12655e139167fd7efe875263c0120bf03e") }
#[test] fun conformance_174() { run_chunk(8700, 50, x"7ec6f0b6b000fb74200b7635efd71d1efc4438dc4c0ffd4fccf1b11b1ab21094") }
#[test] fun conformance_175() { run_chunk(8750, 50, x"1c74334d512d7723e9e5e66cca420b13a723858ab2eca253704aaf86088e344e") }
#[test] fun conformance_176() { run_chunk(8800, 50, x"e36e1386f98a932ad9ae608b2f6c6b47224f83a2275746752b3418a35d13cc65") }
#[test] fun conformance_177() { run_chunk(8850, 50, x"91a99a2881b2376c119b02bb53e3d477542ff557c253b3b9cb2dc5ac7adb0f9b") }
#[test] fun conformance_178() { run_chunk(8900, 50, x"9a17a4b75ae7379b2e5de06c85d12b78a293a37835f723fcdd521deb75c1af97") }
#[test] fun conformance_179() { run_chunk(8950, 50, x"bb7a131aaec603274905af3a3b67ec5929be5f347b30d0a0fe41070a31581cb6") }
#[test] fun conformance_180() { run_chunk(9000, 50, x"5c146d491f036fb9891a32497784aab918c34f8e1ea92328724d70d2eb369124") }
#[test] fun conformance_181() { run_chunk(9050, 50, x"ce81921d1152e48178ae905252f627f1820ba8d847589b65224d14923be36897") }
#[test] fun conformance_182() { run_chunk(9100, 50, x"2cf11a55933ad4e5842c6c8269944f4ae48feed9a2c1f64f7bfca9f9119c0eb3") }
#[test] fun conformance_183() { run_chunk(9150, 50, x"8ae443b720a80ee97100b86c5b6c9fe6ae52284930bf42d1e2d7c978dc86cd09") }
#[test] fun conformance_184() { run_chunk(9200, 50, x"d2241e3cb86a904523b5c7255345e5a5988b85a15d6da5f76cff171dbc440257") }
#[test] fun conformance_185() { run_chunk(9250, 50, x"332e59199bd423ac4ae7e922841deb737db2b64eee3536806689679941045e49") }
#[test] fun conformance_186() { run_chunk(9300, 50, x"262354d1f63da0adcea2f422c8bdaf46571f992f4f8350e19d7c0f48038bf4c5") }
#[test] fun conformance_187() { run_chunk(9350, 50, x"2501b611543a8409e3f884613dbfea68ddf359aec606b1f2f634e6ef0e21c281") }
#[test] fun conformance_188() { run_chunk(9400, 50, x"a241340ab82c9b774a49ebdbcbd558fcb8668ce989b45cf599cdd5456c242e34") }
#[test] fun conformance_189() { run_chunk(9450, 50, x"aa3283fc2a65c4f442d11bdf99190db220c6a0d758e718143b320b87adf0e9aa") }
#[test] fun conformance_190() { run_chunk(9500, 50, x"21f3fb7017fbf89c7203dba57830786f7fa77f296e49adb12176785e5b4ef69a") }
#[test] fun conformance_191() { run_chunk(9550, 50, x"34b36b0f1bf6a1fcef5976f94783cdaa21599224b3dea8c2ca0d34356c89ff27") }
#[test] fun conformance_192() { run_chunk(9600, 50, x"93dd9488d385c1927a2efa07bd01fa664c544398038caedb314aa9e047a635eb") }
#[test] fun conformance_193() { run_chunk(9650, 50, x"c022cd21a6f1379339f86494fbea7029e7a4b90c649310d7701912e0c4e16136") }
#[test] fun conformance_194() { run_chunk(9700, 50, x"0c8465a74d8a071be3551d6f918c1b3450214cb81b86569b891e28b3362aebd8") }
#[test] fun conformance_195() { run_chunk(9750, 50, x"86e96a7b3902bbdf91fb2cd3b99743ed02edf6fe2d22ded49921bb7088722327") }
#[test] fun conformance_196() { run_chunk(9800, 50, x"d5ad75ce2ce6e0f585b1ae130080b7810def71d22ebaa58d6aeaa771e2f1ee00") }
#[test] fun conformance_197() { run_chunk(9850, 50, x"3bf9d60cb0a8dc822d47b752fab896a055af57d95f2cb07fc5f2bb1dbc6c90f8") }
#[test] fun conformance_198() { run_chunk(9900, 50, x"99af478c18f915603c2334488d149f049785ac3a4c7505442306c5a4d29b4d2c") }
#[test] fun conformance_199() { run_chunk(9950, 50, x"dac4f5005e93e4aeabb83349167c4393fa23f5d623d0bed9e420ec133501e17d") }
