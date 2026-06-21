/**
 * Pure TypeScript port of Move `segment_market_v4::roll_rug` — the v4.26
 * MARKET-HALT (rug) dice. Kept in its own side-effect-free module so both the
 * `verify-v4` CLI and its unit test can import it without triggering the CLI's
 * top-level `verify(...)` run.
 *
 *   buf  = segment_key ‖ object::id_bytes(market) ‖ bcs::to_bytes(round_index)
 *   roll = u64_LE(keccak256(buf)[0..8]) % 10_000
 *   fired = rug_chance_bps > 0 && roll < rug_chance_bps
 *
 * The dice are public: anyone with a closed ride's segment key, the market id,
 * and the round index can re-run this and confirm the chain only ever halted a
 * round when `roll < rug_chance_bps`. That is the provable-fairness guarantee
 * for the house edge, identical in spirit to the candle-extrema replay.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

const BPS_DENOMINATOR = 10_000n;

export function rollRugFired(
  segmentKey: Uint8Array,
  marketId: string,
  roundIndex: bigint,
  rugChanceBps: bigint,
): { roll: bigint; fired: boolean } {
  const idHex = (marketId.startsWith("0x") ? marketId.slice(2) : marketId).padStart(64, "0");
  const idBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    idBytes[i] = parseInt(idHex.slice(i * 2, i * 2 + 2), 16);
  }
  const roundBytes = new Uint8Array(8); // bcs u64 = 8 little-endian bytes
  let x = roundIndex;
  for (let i = 0; i < 8; i++) {
    roundBytes[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  const buf = new Uint8Array(segmentKey.length + 32 + 8);
  buf.set(segmentKey, 0);
  buf.set(idBytes, segmentKey.length);
  buf.set(roundBytes, segmentKey.length + 32);
  const h = keccak_256(buf);
  let v = 0n; // first 8 bytes of the digest, little-endian, as u64
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(h[i]!);
  const roll = v % BPS_DENOMINATOR;
  return { roll, fired: rugChanceBps > 0n && roll < rugChanceBps };
}
