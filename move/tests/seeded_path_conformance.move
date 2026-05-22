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
    vector::append(&mut buf, bcs::to_bytes(&p));
    vector::append(&mut buf, bcs::to_bytes(&mn));
    vector::append(&mut buf, bcs::to_bytes(&mm));
    vector::append(&mut buf, bcs::to_bytes(&vr));
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

#[test] fun conformance_000() { run_chunk(0, 50, x"4e0ba642b46c88ab4b6f66a207ae263a7c9028a54a7697086946a7ef5627a8be") }
#[test] fun conformance_001() { run_chunk(50, 50, x"f3ed43fbd76f4eb355aecfdd674df3a573e401bb60a4e10009bbca2a5702cd44") }
#[test] fun conformance_002() { run_chunk(100, 50, x"3e5a03869769ecd402e063c7f5281f7f14ad5e89c73828b395ae3fd45ba59e35") }
#[test] fun conformance_003() { run_chunk(150, 50, x"86ee51574075cc8bee8b12dcbb54198f6139566ddf5359366dc675499c9be9e8") }
#[test] fun conformance_004() { run_chunk(200, 50, x"10273b14ad2b0f21e5c68bd6d4bfeb66e09655c0e853dfb5d55b2d1d40cf5d2a") }
#[test] fun conformance_005() { run_chunk(250, 50, x"7ad53259f52df19578f0df84aa61a29f86fb598072b3ba4381f1fd03758b7f12") }
#[test] fun conformance_006() { run_chunk(300, 50, x"002a7bce599e7f409c8c70f25619facb290102a624858f4566767164e33bd4ec") }
#[test] fun conformance_007() { run_chunk(350, 50, x"78e6988d3eb8f4fab74863295c1997d1b6bfd704c08ae45a65cf25710c1ed843") }
#[test] fun conformance_008() { run_chunk(400, 50, x"ebfc3a916ca0a765d59b777eefb5e61c5bd10bea195c40b8492464af0f435940") }
#[test] fun conformance_009() { run_chunk(450, 50, x"20d836e65fcbc0d67317c4b8002b8eb130b634384e64c93e1e31a7c5fdbb8eb4") }
#[test] fun conformance_010() { run_chunk(500, 50, x"0daa8ac46234b2d6962a571403c45e9db2dcb6a2ad7e72a78f0ff37632c15b1c") }
#[test] fun conformance_011() { run_chunk(550, 50, x"fe6b139203e212ebba597518f3624d61dd15b0fc6b63a18e5d4af9c4f292a80a") }
#[test] fun conformance_012() { run_chunk(600, 50, x"d50a6600821c6702902f8f3f370f4ff03605e038a45a3b5b6375a7f1b1037d17") }
#[test] fun conformance_013() { run_chunk(650, 50, x"d6ac10a85668a9db38537464796a3c8ca58fa5f348dae82ab032701488fca9e0") }
#[test] fun conformance_014() { run_chunk(700, 50, x"b397eac46462aee6cc54879af8e21bbc98cf6f24217018e399c7189317cafac8") }
#[test] fun conformance_015() { run_chunk(750, 50, x"9bd5961d4d6f2a6f9b60728e954bf6ed7aa93bbb2ef246dae36b65c4f3a68fd2") }
#[test] fun conformance_016() { run_chunk(800, 50, x"bd3a612788bd83b8d1d62501b2a0880886ecdf5812900dfe9ea977fe00f4b83b") }
#[test] fun conformance_017() { run_chunk(850, 50, x"eaf24a8dddf90b76b7a32184ab66008df84cfd8c5f1ac833bf092f447452049e") }
#[test] fun conformance_018() { run_chunk(900, 50, x"f8cd712f11134f284e49a92172d1f83b0354bcd646d6481cf14b974550f37f87") }
#[test] fun conformance_019() { run_chunk(950, 50, x"680f34df80f8dbf40d627e0df89d9a29a60098de3c6a1bbcc3d54ea2e41e9b51") }
#[test] fun conformance_020() { run_chunk(1000, 50, x"f675f74a644b60fe69cb1500ed91e01211ade99d0a22d5fa87804b0b3c79510d") }
#[test] fun conformance_021() { run_chunk(1050, 50, x"fd29c142d7a2753cfbcac4a64add124b3cc1d364a4073b8206bff336f2e79620") }
#[test] fun conformance_022() { run_chunk(1100, 50, x"36251f485d684343099910ba97c1d8e1db27993313abfb57ae21461635683a65") }
#[test] fun conformance_023() { run_chunk(1150, 50, x"d92c7f8e7912f93f230d4a3f5d933525a627645465f2342205df41fc829307c8") }
#[test] fun conformance_024() { run_chunk(1200, 50, x"1fa4571d476dffaa07f6b0238c629cac2b8bec8d56ab4824de14685eec6715ef") }
#[test] fun conformance_025() { run_chunk(1250, 50, x"01e0d3ac1a1e0c6294d0ee7270ebe1d89a82fc1b5add9b9d3eacd90c796ada88") }
#[test] fun conformance_026() { run_chunk(1300, 50, x"23fc987653c670f632b26250e7fd6df866c6b32147a54c9695c68d48514853f4") }
#[test] fun conformance_027() { run_chunk(1350, 50, x"ad3a19108583de5b36e50a566f20c4b51c88a740da31ea5377f7b493d0478315") }
#[test] fun conformance_028() { run_chunk(1400, 50, x"d7a86198fc4e8c862c9a186c7731bd2e90cc5c3a9440bd23aea9a91983ad62f3") }
#[test] fun conformance_029() { run_chunk(1450, 50, x"1d08296c21dc183b633725af9b62b2d61537043127926844784343eceab917cf") }
#[test] fun conformance_030() { run_chunk(1500, 50, x"97161aef34a967d9cac64ae77c6eaccef8e6d9a7c71b8efa98f7fd67ca23d9cc") }
#[test] fun conformance_031() { run_chunk(1550, 50, x"0da505a6de93369f4112ee2156da8dc9e8b9c202090dd32e1e91a3c640024ab1") }
#[test] fun conformance_032() { run_chunk(1600, 50, x"7b0f10785c0b008943bd7c8863cefcbdbddfdb27d7d39a9ebd326c4345b69dec") }
#[test] fun conformance_033() { run_chunk(1650, 50, x"cea0598af61a0f45d4374c757025b937ddb46d8fa0779634a122e09d4ee26abc") }
#[test] fun conformance_034() { run_chunk(1700, 50, x"a6a7f3808e92452508db2e5c7a40f69b292928d73798fc629cf6234e8b36de58") }
#[test] fun conformance_035() { run_chunk(1750, 50, x"d2931d1fa4c6def613d521801a54448475e81005b18c2899e80bcd03971100b5") }
#[test] fun conformance_036() { run_chunk(1800, 50, x"91acab22295040fcfafb6d6fbad7f5a748c51836d47bf27dc3ba7d4e8ccbdf03") }
#[test] fun conformance_037() { run_chunk(1850, 50, x"99957b86c5ce11ceafd5d5531478dc177bd170b173f6abea76192a45399ef85b") }
#[test] fun conformance_038() { run_chunk(1900, 50, x"f670d960b876fd01293ff308550e01f20c1d34718131d099b6977a887ca17013") }
#[test] fun conformance_039() { run_chunk(1950, 50, x"140d766b2269ba8066cea5b33252f51bb3391fb114c385dd996c057ad34f3222") }
#[test] fun conformance_040() { run_chunk(2000, 50, x"288921aed35c0c18e76299e12698d164897665122f9d8b75f1d408e2ee16be05") }
#[test] fun conformance_041() { run_chunk(2050, 50, x"de44fc0237aa60e9ea52a2a00ebf55218faa75c7d9fc71e4c5498cc60c3658cf") }
#[test] fun conformance_042() { run_chunk(2100, 50, x"d9f44abd4481d914bd925a13ba1a9f48e772398388531fdbfda87c5699b8e418") }
#[test] fun conformance_043() { run_chunk(2150, 50, x"9122e336661e29c9ef125595113cd15c30cdf4e7d59cd7c4295b3bc62ffe2b9a") }
#[test] fun conformance_044() { run_chunk(2200, 50, x"dbf6a30b4e24dfe0e6fbdf4f59094a3b0da71eba025f08905653a7941c66768e") }
#[test] fun conformance_045() { run_chunk(2250, 50, x"ad7e5308f08a135ffe498eaf8e49974b617dbad926502b350ecd48f9e54ab481") }
#[test] fun conformance_046() { run_chunk(2300, 50, x"a117bcc633db02a08e8b534ae79870af076ec254a78a9db3a174fbbec620ab2c") }
#[test] fun conformance_047() { run_chunk(2350, 50, x"670aac492c8be4d871749d2e7daa50018d0a024d3f36e32d4107027099a0224a") }
#[test] fun conformance_048() { run_chunk(2400, 50, x"bddfb3e16bb1eee321ab6f04a1f6731a29b1903300b7486cf0a314fc45074634") }
#[test] fun conformance_049() { run_chunk(2450, 50, x"535b34755be705fbd3e1362f96f814d4a42127127d7afff0ef0cba11dbeee1c4") }
#[test] fun conformance_050() { run_chunk(2500, 50, x"c808d08f23aed65093c5b16ccbeef8cca4e46d71fea5d72dcb3b8ee9843f73fd") }
#[test] fun conformance_051() { run_chunk(2550, 50, x"3148d3c093ef9f9f613ef5777bc0d5868eef91ce50158c65b0784ee3bc04e3fa") }
#[test] fun conformance_052() { run_chunk(2600, 50, x"495f8206054379d4c0a65dccc6cd0c17d9481c5a118a300b915e57da1879c63a") }
#[test] fun conformance_053() { run_chunk(2650, 50, x"408a6fb806e5d357d4a31731b5db89ae30a61b405be98ee00b62c7678c1cd76c") }
#[test] fun conformance_054() { run_chunk(2700, 50, x"4ff26dd335ba136da43ccfb31345bade85e35c5fa7d6b15717a2761e4ab5e2fc") }
#[test] fun conformance_055() { run_chunk(2750, 50, x"d848e377203b8bb282d4963e873a43f0b37bbfc52fd7babb70e82da0ec51173f") }
#[test] fun conformance_056() { run_chunk(2800, 50, x"a6dedec9c05502a0cf43d8cab906f4c4c6b13c37c9264ffc58d2fda4e2a859e9") }
#[test] fun conformance_057() { run_chunk(2850, 50, x"924c20d1280ad03e01ca23f0073cfa6a6ed9da3e93df05bda84ffc5e371c71fb") }
#[test] fun conformance_058() { run_chunk(2900, 50, x"05125fe56f6e8021c96b333688ccd3221648eb02e3ae01305d329ccfec4f20cc") }
#[test] fun conformance_059() { run_chunk(2950, 50, x"cc5d9b8e05b1e8330d752184e375e9d68c268e19c12eef4a07929f8dbcef6fb1") }
#[test] fun conformance_060() { run_chunk(3000, 50, x"6262825e9cf1a98f45acb1bb3095a208fc7d44eab3b904b0a82ab7d4fc39b9d0") }
#[test] fun conformance_061() { run_chunk(3050, 50, x"f10890aeec9345eaf4ea0e4bc8c9712917321d507e3c2fb410f6b7343fa3cd66") }
#[test] fun conformance_062() { run_chunk(3100, 50, x"6d579f2b16bc9fdfc88975efc23d7ce794bc893be67f6dc591819f37f0075479") }
#[test] fun conformance_063() { run_chunk(3150, 50, x"830800c5538b9724d969dd070f47a2e70f2217edbd757061a6316da7cca555c5") }
#[test] fun conformance_064() { run_chunk(3200, 50, x"e54e3d403bf57d64e2c4cc9fb850b77d8bac5137dd145170c312f1ba3b56ae5f") }
#[test] fun conformance_065() { run_chunk(3250, 50, x"63c17d837c049be1272f78a5ff5a2779e0bc50f95e5d1c4b5eec553fdd700adf") }
#[test] fun conformance_066() { run_chunk(3300, 50, x"b6bc512ce60190adf745685f3aa2392b188747791139c4d8cad3e15b7dc4aef6") }
#[test] fun conformance_067() { run_chunk(3350, 50, x"10a25862e0b2f32f2ca4ff2fac017b1735374885c34bdab19b8bdd4c998b35d4") }
#[test] fun conformance_068() { run_chunk(3400, 50, x"81dea331441676827d16a935934089f161b18543baea2738da20acea682be4d0") }
#[test] fun conformance_069() { run_chunk(3450, 50, x"4884614385025b4748ccaf335df7c9ccfc5a4f5ca2ce5d29788ee62294010cbb") }
#[test] fun conformance_070() { run_chunk(3500, 50, x"ccdb975ef7ed62db411e0e0ab11828e786b0de968bd3c9095083f399724dc5aa") }
#[test] fun conformance_071() { run_chunk(3550, 50, x"850b9691bb6525c826ddc4d356cb90a28abc26592a81473f4169f521437448b2") }
#[test] fun conformance_072() { run_chunk(3600, 50, x"f0c825b2a89af73bcbc343f55d383851416627e9d7a4d7fe7ff5d687151808af") }
#[test] fun conformance_073() { run_chunk(3650, 50, x"9a3b9dc5c01a635d22fd31ea8601cb33270572a07698e6abf217ecdeb6be057d") }
#[test] fun conformance_074() { run_chunk(3700, 50, x"31f67ad725766c57dc910e17ba12fea1de19d3bb6890ebbf64a7d09a548d727a") }
#[test] fun conformance_075() { run_chunk(3750, 50, x"834aa53612fe59aaacd1f5ca748ed26ce2ad00e97c10bab13e990d29a8c8d6f4") }
#[test] fun conformance_076() { run_chunk(3800, 50, x"0640280650dbb02cad181324ecc90e03e751c28bc09269010bdbf051491cfe7a") }
#[test] fun conformance_077() { run_chunk(3850, 50, x"8779dfbec8ec7717389427b69975c15de3470a398f01e195f7d4d2dec0082180") }
#[test] fun conformance_078() { run_chunk(3900, 50, x"852930af72ca9b02679577820380de0e022fbff6f1f459be859f183dc0300ac7") }
#[test] fun conformance_079() { run_chunk(3950, 50, x"2f9556f4b6b318712b399f189e2ff9146a1f41f60385879c1a676d9bbf79f5f3") }
#[test] fun conformance_080() { run_chunk(4000, 50, x"13b904252da639a5f586c1a2593886876898f5f0be5af3848483acd59987ae28") }
#[test] fun conformance_081() { run_chunk(4050, 50, x"c42ca87f9ee197058f477a3eb5f5332cc13de966826c604c87124ab89146726e") }
#[test] fun conformance_082() { run_chunk(4100, 50, x"a189cfff21feb2a0f4fa6ab141c617c4ee011f51f3e826a86f4fb19490546cbd") }
#[test] fun conformance_083() { run_chunk(4150, 50, x"3e3986b40ac077aa8e6e3cadca104b98bfec2f8a5c51c429e7736c0eaa39ad26") }
#[test] fun conformance_084() { run_chunk(4200, 50, x"1fd178a19f1fb97bce6df58c8947f3f480a05e0929b977e8b43e721b4e63aaad") }
#[test] fun conformance_085() { run_chunk(4250, 50, x"4eadc3a47a5e0c72c1461cecdf221b0ce2660e8520c6a20ba797a23b26944c28") }
#[test] fun conformance_086() { run_chunk(4300, 50, x"aae389ff9d8a8ac750f7f352f99f63d31318784b216217f18e514c292623c630") }
#[test] fun conformance_087() { run_chunk(4350, 50, x"11f630bf14766c74194a08e9ef70bb7b94cd1e70d02d5dd5766b6569e39b5bf9") }
#[test] fun conformance_088() { run_chunk(4400, 50, x"e6a235bb8f15fa9b346f3f7a8028fc92b91852bc75f3152b6ca7e6c73151ba52") }
#[test] fun conformance_089() { run_chunk(4450, 50, x"8eaaf1539b0aec905bfcc1c7823ae845e63dedacd03935b8d63f0f0718e7956e") }
#[test] fun conformance_090() { run_chunk(4500, 50, x"f51333132d07a5088e96a37967e61c6a9ae97c3484950eb00ed55383a7fe1c56") }
#[test] fun conformance_091() { run_chunk(4550, 50, x"8c69a4a747a59ede62c633a5bb52a52d063051801515dc4d9028cb6e6783d300") }
#[test] fun conformance_092() { run_chunk(4600, 50, x"8977c607b503e955f2229450a1d835a98acce43d13146c94ec6ff73a95c3d930") }
#[test] fun conformance_093() { run_chunk(4650, 50, x"1eb9caf322af381ed5c83cd110b71a828f172a2874efb9e01f3020c63739315e") }
#[test] fun conformance_094() { run_chunk(4700, 50, x"ffa19b259187c9ead45ed5f051c943109e9f7b3da88be6b0f024da1e6c2eff2a") }
#[test] fun conformance_095() { run_chunk(4750, 50, x"d09054a704d9510c6d01a1bac32d1f75d29dc408f28b95fa2f71a7d3e939b6b9") }
#[test] fun conformance_096() { run_chunk(4800, 50, x"cf4673730265b9a00d570adfbc3a08e7671da799a57a7873ad56f45b05215944") }
#[test] fun conformance_097() { run_chunk(4850, 50, x"c93a90a021f1fe4357f403e84056132be05722c7ca6a5f8b98837d6809d0dce5") }
#[test] fun conformance_098() { run_chunk(4900, 50, x"6fac580b052d90419e6d49b7e585b72035ccd5084371aabfbba38d6432ca0a43") }
#[test] fun conformance_099() { run_chunk(4950, 50, x"edb293ff7a7e86bd4fb90e868626f028b5dfde3f3dab0de4d8703ce34f29d76c") }
#[test] fun conformance_100() { run_chunk(5000, 50, x"af8fd3c5e0a9219e5c9ea7cfd683fbc6b633c4fc7d31ccbd4d8cccc9869c82aa") }
#[test] fun conformance_101() { run_chunk(5050, 50, x"c5dbe15d2624ed4331dc0da8b25b8c925ca0cd57cf511083cb3ca0e5c5d1e4ba") }
#[test] fun conformance_102() { run_chunk(5100, 50, x"e275c6560380bfc5bbe5073211e3619c5157d39afc82700cabd9e0e6b2f08a0e") }
#[test] fun conformance_103() { run_chunk(5150, 50, x"572cc8505d05083728936cfc7cffbb714605bafb5c9ff676be7711f79770935c") }
#[test] fun conformance_104() { run_chunk(5200, 50, x"ee964c8ce6ef26cb42e0f589135fac84232371166742c6f6ca0f57dcb392e165") }
#[test] fun conformance_105() { run_chunk(5250, 50, x"33cd373d8c41117261e898135dfc5afe63931de811273f6443295421911a0b87") }
#[test] fun conformance_106() { run_chunk(5300, 50, x"8ff9156c22d0136e26fbc21a9aa7ce92eab13d5307fda2d769aa07fa53318b70") }
#[test] fun conformance_107() { run_chunk(5350, 50, x"7e49a3c9342787f555a4ab379d47f0716096ed81c518181ffc27f7ae6a719ac7") }
#[test] fun conformance_108() { run_chunk(5400, 50, x"00aef2874ef2bb8084b0151953abef251919402440b89f4696d6efbb237674d5") }
#[test] fun conformance_109() { run_chunk(5450, 50, x"629af0162fb716c7f5813fd7ea9b3795e8f7b8a9f44de548205d7576bc41798f") }
#[test] fun conformance_110() { run_chunk(5500, 50, x"53746adb2e29f43020bd677a0c74b5750ff53252a6d3107fc05be3698594aaf0") }
#[test] fun conformance_111() { run_chunk(5550, 50, x"3eb4153fcce8c3193f91df32de7c583ee8aa5153f4f64fc2bec3e2f01a6ad43c") }
#[test] fun conformance_112() { run_chunk(5600, 50, x"ab1d485bbc5519175c1270fc030cb621181b1c79a9c2b1a6315fe8fd29feacbd") }
#[test] fun conformance_113() { run_chunk(5650, 50, x"16819523224fb7bf14b482d36005288a9f7e1d30edd6b0ba1d3f550bfdd498fb") }
#[test] fun conformance_114() { run_chunk(5700, 50, x"7b3801a306d23ef9e21229f708a478f409cfe1111f15dbadccfc25a046798218") }
#[test] fun conformance_115() { run_chunk(5750, 50, x"dfbd225b5ef5e98a41eb2dc3c8702348763e439f974d5489e352197078336ba1") }
#[test] fun conformance_116() { run_chunk(5800, 50, x"957ea5e94238e9d4efebb9bcfb0ac32de950b7ebb6cad9eea3a9ce63930416c2") }
#[test] fun conformance_117() { run_chunk(5850, 50, x"7ab35b4082e4fa844891ed207f720f378fa3fcdde67caa63e9d5032343b922f7") }
#[test] fun conformance_118() { run_chunk(5900, 50, x"2dd924890adad88b6274c1a7d379b0beaca5231c7a23f78811e07542d34646d1") }
#[test] fun conformance_119() { run_chunk(5950, 50, x"66274253e0c346d94cc59184adcdae77833dd01f40b6fbdf7472223679cdf5bc") }
#[test] fun conformance_120() { run_chunk(6000, 50, x"35987f2528b9878c624289798a5d41ead4d01ace8679719ecaaa4a03b1312d1b") }
#[test] fun conformance_121() { run_chunk(6050, 50, x"7b6aa70fa6d5907b0b4b8b89caadcc70645eca4cba9d76383816c2d1ee2d128b") }
#[test] fun conformance_122() { run_chunk(6100, 50, x"b756cffaccc042431cc2fe48a5a4d496180025b945b83a2e707972cbc595f683") }
#[test] fun conformance_123() { run_chunk(6150, 50, x"e104cbf68952f773e99ac8c25cf5e6c8ff59732b56c18d6bc8e260b12ec28203") }
#[test] fun conformance_124() { run_chunk(6200, 50, x"8306a8211f77add5920077c60fc6de7a5d6714d5c9a5c101a91c712bc2f189e1") }
#[test] fun conformance_125() { run_chunk(6250, 50, x"fb29167993d404157c076195372a70894a053744a9b7bcd54b2fa034fcaffd40") }
#[test] fun conformance_126() { run_chunk(6300, 50, x"602cd41a07e7050473a497cfda74249cbd880245256e4e4b20baf46f8bdc94ad") }
#[test] fun conformance_127() { run_chunk(6350, 50, x"dc5a0ecc51467c647812bfbde6de2d0c5c8088d5f900c271bcd24b3057679371") }
#[test] fun conformance_128() { run_chunk(6400, 50, x"50b627e985d5004e5e7d07647e178630b089aa5edcfdd2f1ab50976f90d42c49") }
#[test] fun conformance_129() { run_chunk(6450, 50, x"c6ee48849af6d5ed1f77ae7a563a43da54a5b12b91e718cec1b11ef24a8797b3") }
#[test] fun conformance_130() { run_chunk(6500, 50, x"d85cd9724eb4dd2f96bbc160aba8bad67ecba70d79a5592aeca6b0a227950d84") }
#[test] fun conformance_131() { run_chunk(6550, 50, x"32bd7a9a8635dbc1e0370516d9e130ea44607a6897384ae0aea5272a2addf806") }
#[test] fun conformance_132() { run_chunk(6600, 50, x"405773b081aff431fa37cf041bde8f8c26a1b8b5e75163463d46d2ca01303dc5") }
#[test] fun conformance_133() { run_chunk(6650, 50, x"0bce668abd535bfb0464ae08b4ae0d54838a9203975c32ea19d68f245da71981") }
#[test] fun conformance_134() { run_chunk(6700, 50, x"64db137c41604ee1e4f9deeae580b7b751b54ade156abb36276b108a4a1c0398") }
#[test] fun conformance_135() { run_chunk(6750, 50, x"19b2c61633599c347ed9dfb6a3322769944cb618c9c7964786913f6e74870040") }
#[test] fun conformance_136() { run_chunk(6800, 50, x"4cbecb7118579b37ce3631f33dab725f00310f5f4d6783571517bfedff29e27a") }
#[test] fun conformance_137() { run_chunk(6850, 50, x"ef0761bc3875cbc32e7be725b77032dc10357b1642317ea268269f080616fcab") }
#[test] fun conformance_138() { run_chunk(6900, 50, x"ed449b9165de692f83fd184c2b1f4c9ec4828fd7c98649e5399489d6abd2584c") }
#[test] fun conformance_139() { run_chunk(6950, 50, x"5faf2e40cb29f0cc218b594ad88635a4b870edd48445fdbf047755012805868a") }
#[test] fun conformance_140() { run_chunk(7000, 50, x"fc91e6563a76f212e650161c35a0ea23fd4242006e560ccd86e445e42adf69a9") }
#[test] fun conformance_141() { run_chunk(7050, 50, x"e98d8f8b061844db24a8566959b9ab389a15affb5c9f32af71ad5917ab9e6913") }
#[test] fun conformance_142() { run_chunk(7100, 50, x"f8c2a372ae9186efbbc7dac7a60a02e7604873735f2a31c67c151c3ddc264ccc") }
#[test] fun conformance_143() { run_chunk(7150, 50, x"43173cb1e2212b713f7afb80d337ca493ec97dbff3d6d60663c6dcf7f65e9c2d") }
#[test] fun conformance_144() { run_chunk(7200, 50, x"04c058b920645ee9714900a6cca84503b98000243e2321ffc2f24b6e05e8c85e") }
#[test] fun conformance_145() { run_chunk(7250, 50, x"9e9852f800a9d1aab9617f86040e65421c77fe661bfeb7f4bf660ea097f2ee90") }
#[test] fun conformance_146() { run_chunk(7300, 50, x"52d29da248fd6897f4e4e3807cbe575d59f6d3bedeb4bf7054acaf147170ff31") }
#[test] fun conformance_147() { run_chunk(7350, 50, x"e351aee95c02cb77832adfac1a5c4ebbad5880a2452419347e082787ac444201") }
#[test] fun conformance_148() { run_chunk(7400, 50, x"2fc7532a5e005899f9c138772a352ecfef896a346bac7b671bcc86a629701876") }
#[test] fun conformance_149() { run_chunk(7450, 50, x"88adcbf1fa0487585714e62d0bc5673bb7eed7f8c036679e03ee4214c495469a") }
#[test] fun conformance_150() { run_chunk(7500, 50, x"90be6e8112454744f91af582442aa6fec071569ad285f78c848253474b420e60") }
#[test] fun conformance_151() { run_chunk(7550, 50, x"6644ac0f1124673642f4d6963320624dff34894c4f90bf0ba7deef1cc40e99a4") }
#[test] fun conformance_152() { run_chunk(7600, 50, x"8d5d9bf2da79cf4b307b30832a224f39672bc600572016a737705f49bb750982") }
#[test] fun conformance_153() { run_chunk(7650, 50, x"d2b1a3a43f65359226c12610ba704d31933a0db51d7f9432fe1bb6758bfffdd1") }
#[test] fun conformance_154() { run_chunk(7700, 50, x"56c44b74f9eedae8381e6cf2b9c9bdd24705681ad75a587426ba76d28497b9bd") }
#[test] fun conformance_155() { run_chunk(7750, 50, x"4b459acdeaa9395e2b269c898a2dcc805eb1d954a17b7ad7e8ffa0da2aea5f8e") }
#[test] fun conformance_156() { run_chunk(7800, 50, x"6aaf2bf66a8fd5a0b1c2aa96dba4b9e455e8cdf770b6f9e343a8a80648160157") }
#[test] fun conformance_157() { run_chunk(7850, 50, x"fd5886c928deaac573fd14618395bac1c12fa2eecb92ba5915caae0c293c5f37") }
#[test] fun conformance_158() { run_chunk(7900, 50, x"99f355d76577da0b79b185190f469112744bd733b94842d56e33c193053329f6") }
#[test] fun conformance_159() { run_chunk(7950, 50, x"6600279a1d4500854ea62ab4ab4b00ecdd2b0f540d1309586d6926634bc1210c") }
#[test] fun conformance_160() { run_chunk(8000, 50, x"183dd41fd59d06af867003553560129d8eb125f34d1220f7bd9631858ef56e3d") }
#[test] fun conformance_161() { run_chunk(8050, 50, x"2da26f3b538ba4817c94d45f45dc86b43823e68fdedc10c372f22e757af70e67") }
#[test] fun conformance_162() { run_chunk(8100, 50, x"cbdd7b7fd3aa983252af87b18edebcd79c6207de42038076c089343ac90c9f56") }
#[test] fun conformance_163() { run_chunk(8150, 50, x"7362b7f46e4a07240671cdc15d17044f9e89a36c24ec9e896ee493f229ed26ba") }
#[test] fun conformance_164() { run_chunk(8200, 50, x"7ee74a3a8d28ecafa4250a48979157978cd1f7466ddaeee6d58f0814ec10362a") }
#[test] fun conformance_165() { run_chunk(8250, 50, x"cc70e083be30d8b460f847d49df7ebf44c63e8b37061260e53cb5e0ef4bc43b5") }
#[test] fun conformance_166() { run_chunk(8300, 50, x"db63e4d3e5077ad86712d59c09c3897aaed078a5b7706bf25e115d564697ae80") }
#[test] fun conformance_167() { run_chunk(8350, 50, x"b32958c87a4c9d990665c2c9ffb3e90ff80c0c89c2bc7e5bdc0d2ab412f3db36") }
#[test] fun conformance_168() { run_chunk(8400, 50, x"8d8ca3ef45424b1eaacfa2ace7ecb6ebfdb0e4e22299a25063d93ac8b4ee122a") }
#[test] fun conformance_169() { run_chunk(8450, 50, x"9e4acd3ea71599e54c48f209b8f58c7c839bd32b0e2bca20e2ac6935d5011981") }
#[test] fun conformance_170() { run_chunk(8500, 50, x"6b0a180bb3aa6444721cc3e40c837fdb33fd76a9b7289a0a4667c8d743f64cf1") }
#[test] fun conformance_171() { run_chunk(8550, 50, x"fe1579e1704f26b610faa09c0ccc08027ad64c77b763d721b67e17f50171efb6") }
#[test] fun conformance_172() { run_chunk(8600, 50, x"61e7318a0a1202249260656877732687f2599fd6f7b6f3db3dab17e3feecd7a4") }
#[test] fun conformance_173() { run_chunk(8650, 50, x"48b63e328b389263c924e176f0f0d5d6a3089197e9a0a3d988b7bd70d1c10896") }
#[test] fun conformance_174() { run_chunk(8700, 50, x"3edf8074dcc391651aa7cd061638deabbd0db5a3fd66b509f19d7c9ee6cfd0f6") }
#[test] fun conformance_175() { run_chunk(8750, 50, x"40431633d4d378466fdbe8dc10ebe5fec7e6897fe6b28d58209ee992a5941e67") }
#[test] fun conformance_176() { run_chunk(8800, 50, x"be928c85d9cdf1e2500e9c3024891f4ee943a9e55232abf9fa2ed8f213071587") }
#[test] fun conformance_177() { run_chunk(8850, 50, x"149d9894a159bbe78013a3b89bf8a50231017776c0c4e9fa3a99169097bf2c1c") }
#[test] fun conformance_178() { run_chunk(8900, 50, x"00cf764b8d16ca7957599cd35bae9620026cee259f89bc5867cdf325df9b9ea5") }
#[test] fun conformance_179() { run_chunk(8950, 50, x"cd546a8ccdb7c9587fffc639c16b3285572bfedb58d9b62bcc5230b0b820cab2") }
#[test] fun conformance_180() { run_chunk(9000, 50, x"95ef54a5740de9b9927cc1732d8a8c31ccf11a3905ca7b1c40c35ad6abf35d58") }
#[test] fun conformance_181() { run_chunk(9050, 50, x"76be14f615951fb8491c3736245c9b14faa0d5de82afd7a6bf75fca1cbeb7ec3") }
#[test] fun conformance_182() { run_chunk(9100, 50, x"d30dfe5913d83b4ea50a22058ae2c518589fd6e7640be98650ba4aa282f5f847") }
#[test] fun conformance_183() { run_chunk(9150, 50, x"41086bdcc2b783ca08001ebd0104f8f0dad74e213a8d78d84854739dca6c983e") }
#[test] fun conformance_184() { run_chunk(9200, 50, x"0b0100dff24681826a2f20c274461c46589652b04fac01cff8ab3cbd91e485eb") }
#[test] fun conformance_185() { run_chunk(9250, 50, x"79098a2cf73fa5e534dab8a8e737b74841fe855833491d409b59b971c5dc4e9c") }
#[test] fun conformance_186() { run_chunk(9300, 50, x"13de72e9a66f3df463d19183c5c75df80af8d467f20c4f50dd35bb1f40f571de") }
#[test] fun conformance_187() { run_chunk(9350, 50, x"f3ceee079f3c49b8897f79f28749f1aa8b5df116ded725c3c9e4777dc1c02fb0") }
#[test] fun conformance_188() { run_chunk(9400, 50, x"fb50683fb90e5720a3226399d49ce4a00fe27d7b8e8e90e8910e117abdbdcff3") }
#[test] fun conformance_189() { run_chunk(9450, 50, x"1a63ea15f17b08842ab02d91c15c96165f85739e3de913adcd7d1ed05bba7477") }
#[test] fun conformance_190() { run_chunk(9500, 50, x"af0f6ec0651bbd9b8f470c2ccef56916f766ac71f59780c18f10a9b07bcdb30f") }
#[test] fun conformance_191() { run_chunk(9550, 50, x"94cfcb2251a9d1173531f878d2de57e54da2a64d21a75aca3495665641073b4e") }
#[test] fun conformance_192() { run_chunk(9600, 50, x"f056e83560a3d67d8459d9b8465fb6e28748d9ec1c32b9f5dde576c606c4de7c") }
#[test] fun conformance_193() { run_chunk(9650, 50, x"29229790c2aa3199b7de95fdc8aa37abefb34ee96292c4e6203d934de03d42fc") }
#[test] fun conformance_194() { run_chunk(9700, 50, x"6d17e5c70190a8b2c344df0f97d46570a0c81d1b082766192ed554825db5a50c") }
#[test] fun conformance_195() { run_chunk(9750, 50, x"b8c1c0c42edc853ec700679a18109a80f7b09b43f7522c41cb9c8f0bc410631c") }
#[test] fun conformance_196() { run_chunk(9800, 50, x"e5d78d5e128ce8dea4e6fc742d173508dd18bf50cf71225852bb9cf11d7321ef") }
#[test] fun conformance_197() { run_chunk(9850, 50, x"813e613c477483368cb7ee56b10b7f0a5cfed7d62b7d474b2e09ca99584ca8bb") }
#[test] fun conformance_198() { run_chunk(9900, 50, x"122ce62675f345980e359b70abe7bf95e64a840853b95ad97fec2cb5e6189609") }
#[test] fun conformance_199() { run_chunk(9950, 50, x"ec0cd25b96bc8b7e11b16b444d57244e6d0ea714054f0f990c5f3f2d70dbc928") }
