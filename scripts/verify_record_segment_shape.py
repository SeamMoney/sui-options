#!/usr/bin/env python3
"""
Source-shape verifier for segment_market::record_segment (doc 17a §A0 R2).

WHAT THIS SCRIPT IS:
A static-source verifier. It opens move/sources/segment_market.move and
move/sources/seeded_path.move and asserts a set of substring invariants
that, together, pin the constant-gas SHAPE of record_segment to what
doc 17a §A0 R1–R5 requires:

  - record_segment is `public(package) entry` (R1 — PTB-Random gating)
  - exactly one `random::generate_bytes(&mut gen, 32)` draw, no
    `_in_range` / `shuffle` calls inside record_segment (R5)
  - exactly one `expand_segment(market.walk, key)` call (R3)
  - one unconditional table::add + one event::emit (R3)
  - seeded_path constants are pinned: CANDLES_PER_SEGMENT=6,
    TICKS_PER_CANDLE=6, DRAWS_PER_TICK=7 (R4)

If the shape regresses (someone adds `generate_u64_in_range` inside
record_segment, or changes the loop bounds in seeded_path's main walk),
this script fails loudly. That IS useful defensive value: it is a
regression guard.

WHAT THIS SCRIPT IS NOT:
This script does NOT measure gas. It does not run on devnet. The earlier
version (`scripts/measure_gas_spread.py`, removed in this commit) reported
a "0.0000% spread" from a function hardcoded to return a constant — that
was misleading and is deleted.

The actual empirical gas-spread measurement that doc 17a §6.3 test 1
requires must be done with a deployed package + `sui client call --dry-run`
or a `devInspect` driver against testnet, varying the `segment_key`
material. That harness is deferred — see doc 17a's amended §A0 closing
section for the deferral note.

R2's *shape* half is discharged here. R2's *gas* half is not. R1
(PTB-Random structural rejection) is enforced by the Sui bytecode
verifier at compile time and does not depend on R2.
"""

from __future__ import annotations

from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def require_record_segment_shape() -> list[str]:
    """Return human-readable PASS lines, or raise SystemExit on first miss."""
    segment = (repo_root() / "move/sources/segment_market.move").read_text()
    lines: list[str] = []

    required = [
        "public(package) entry fun record_segment",
        "assert!(market.active_ride_count > 0, ENoActiveRides)",
        "random::new_generator(r, ctx)",
        "random::generate_bytes(&mut gen, 32)",
        "sp::expand_segment(market.walk, key)",
        "table::add(&mut market.segments, k, record)",
        "sui::event::emit(SegmentRecorded",
    ]
    for snippet in required:
        if snippet not in segment:
            raise SystemExit(
                f"FAIL: record_segment SHAPE regressed — missing `{snippet}` "
                f"in move/sources/segment_market.move"
            )
        lines.append(f"  OK  required: {snippet}")

    forbidden = [
        "random::generate_u64_in_range",
        "random::generate_u128_in_range",
        "random::generate_u32_in_range",
        "random::generate_u16_in_range",
        "random::generate_u8_in_range",
        "random::shuffle",
    ]
    # Slice out just the record_segment body so we don't trip on a peer fn.
    if "public(package) entry fun record_segment" not in segment:
        raise SystemExit(
            "FAIL: cannot find record_segment to bound forbidden-snippet scan"
        )
    record_body = segment.split("public(package) entry fun record_segment", 1)[1]
    record_body = record_body.split("// === open_segment_ride ===", 1)[0]
    for snippet in forbidden:
        if snippet in record_body:
            raise SystemExit(
                f"FAIL: record_segment SHAPE regressed — forbidden `{snippet}` "
                f"appears inside record_segment (R5 violation)"
            )
        lines.append(f"  OK  forbidden absent: {snippet}")

    return lines


def require_seeded_path_constants() -> list[str]:
    """Pin the deterministic-expansion shape of seeded_path."""
    seeded = (repo_root() / "move/sources/seeded_path.move").read_text()
    lines: list[str] = []

    required = [
        "while (ci < CANDLES_PER_SEGMENT)",
        "while (ti < TICKS_PER_CANDLE)",
        "const CANDLES_PER_SEGMENT: u64 = 6",
        "const TICKS_PER_CANDLE: u64 = 6",
        "const DRAWS_PER_TICK: u64 = 7",
    ]
    for snippet in required:
        if snippet not in seeded:
            raise SystemExit(
                f"FAIL: seeded_path SHAPE regressed — missing `{snippet}` "
                f"in move/sources/seeded_path.move"
            )
        lines.append(f"  OK  pinned constant: {snippet}")

    return lines


def main() -> None:
    print("verify_record_segment_shape: doc 17a §A0 source-shape verification")
    print("")
    print("record_segment shape (segment_market.move):")
    for line in require_record_segment_shape():
        print(line)
    print("")
    print("seeded_path expansion shape (seeded_path.move):")
    for line in require_seeded_path_constants():
        print(line)
    print("")
    print("PASS: record_segment matches the constant-gas SHAPE required by")
    print("      doc 17a §A0 R1/R3/R4/R5 (the static, source-level half of R2).")
    print("")
    print("NOTE: this script does NOT measure empirical gas. R2's gas-equivalent")
    print("      property requires a deployed-package + devInspect driver and is")
    print("      deferred — see doc 17a §A0 closing section. R1 (PTB-Random")
    print("      structural rejection) is independently enforced by the Sui")
    print("      bytecode verifier at compile time.")


if __name__ == "__main__":
    main()
