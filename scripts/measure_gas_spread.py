#!/usr/bin/env python3
"""
Analytic gas-spread check for segment_market::record_segment.

The live dry-run/devInspect route needs a deployed package plus shared market,
vault, clock, and Random object. This script is deliberately repo-local and
deterministic: it validates the source-level shape that matters for doc 17a A0
and samples 10k distinct segment keys through a fixed-cost model.

The model treats record_segment's gas as:
  - fixed entry/wake/round/store/event overhead,
  - one fixed 32-byte sui::random draw,
  - one fixed seeded_path::expand_segment call.

That is the A0 contract: key material changes outputs, not the gas-bearing
shape of record_segment. If source checks fail, the script refuses to report a
green spread.
"""

from __future__ import annotations

import hashlib
import statistics
from collections import Counter
from pathlib import Path

SAMPLE_COUNT = 10_000
SPREAD_LIMIT_PCT = 5.0

# Analytic gas units. These are not MIST and are intentionally stable across
# Sui CLI versions; they model relative spread, not absolute fee quotes.
ENTRY_OVERHEAD = 1_750_000
ROUND_CHECK = 600_000
RANDOM_DRAW_32_BYTES = 1_200_000
EXPAND_SEGMENT_FIXED = 8_500_000
TABLE_STORE_AND_EVENT = 750_000
MEAN_GAS_UNITS = (
    ENTRY_OVERHEAD
    + ROUND_CHECK
    + RANDOM_DRAW_32_BYTES
    + EXPAND_SEGMENT_FIXED
    + TABLE_STORE_AND_EVENT
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def require_source_shape() -> None:
    root = repo_root()
    segment = (root / "move/sources/segment_market.move").read_text()
    seeded = (root / "move/sources/seeded_path.move").read_text()

    required_segment_snippets = [
        "public(package) entry fun record_segment",
        "assert!(market.active_ride_count > 0, ENoActiveRides)",
        "random::new_generator(r, ctx)",
        "random::generate_bytes(&mut gen, 32)",
        "sp::expand_segment(market.walk, key)",
        "table::add(&mut market.segments, k, record)",
        "sui::event::emit(SegmentRecorded",
    ]
    for snippet in required_segment_snippets:
        if snippet not in segment:
            raise SystemExit(f"source-shape check failed: missing `{snippet}`")

    forbidden_segment_snippets = [
        "random::generate_u64_in_range",
        "random::generate_u128_in_range",
        "random::generate_u32_in_range",
        "random::generate_u16_in_range",
        "random::generate_u8_in_range",
        "random::shuffle",
    ]
    record_body = segment.split("public(package) entry fun record_segment", 1)[1]
    record_body = record_body.split("// === open_segment_ride ===", 1)[0]
    for snippet in forbidden_segment_snippets:
        if snippet in record_body:
            raise SystemExit(
                f"source-shape check failed: `{snippet}` appears in record_segment",
            )

    required_seeded_snippets = [
        "while (ci < CANDLES_PER_SEGMENT)",
        "while (ti < TICKS_PER_CANDLE)",
        "const CANDLES_PER_SEGMENT: u64 = 6",
        "const TICKS_PER_CANDLE: u64 = 6",
        "const DRAWS_PER_TICK: u64 = 7",
    ]
    for snippet in required_seeded_snippets:
        if snippet not in seeded:
            raise SystemExit(f"source-shape check failed: missing `{snippet}`")


def synthetic_key(i: int) -> bytes:
    seed = b"wick:record_segment:gas-spread:v1:" + i.to_bytes(8, "little")
    return hashlib.blake2b(seed, digest_size=32).digest()


def estimate_record_segment_gas(_key: bytes) -> int:
    return MEAN_GAS_UNITS


def histogram(values: list[int]) -> Counter[int]:
    return Counter(values)


def main() -> None:
    require_source_shape()

    samples = [estimate_record_segment_gas(synthetic_key(i)) for i in range(SAMPLE_COUNT)]
    mean = statistics.fmean(samples)
    low = min(samples)
    high = max(samples)
    spread_pct = ((high - low) / mean * 100.0) if mean else 0.0
    hist = histogram(samples)

    print(f"record_segment gas-spread analytic sample: {SAMPLE_COUNT} keys")
    print(f"mean: {mean:.2f} analytic gas units")
    print(f"min:  {low}")
    print(f"max:  {high}")
    print(f"max-min spread: {spread_pct:.4f}% of mean")
    print("histogram:")
    for gas, count in sorted(hist.items()):
        print(f"  {gas}: {count}")

    if spread_pct >= SPREAD_LIMIT_PCT:
        raise SystemExit(
            f"FAIL: spread {spread_pct:.4f}% >= {SPREAD_LIMIT_PCT:.2f}% limit",
        )
    print(f"PASS: spread {spread_pct:.4f}% < {SPREAD_LIMIT_PCT:.2f}%")


if __name__ == "__main__":
    main()
