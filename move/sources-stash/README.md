# move/sources-stash/

Move source files that are intentionally **not** in `move/sources/` so they
don't get compiled into the on-chain Wick package. They live here because the
combined package exceeded Sui's `MovePackageTooBig` per-package limit of
102,400 bytes during the 2026-05-23 v4 upgrade — the build came in at 115,023
bytes, so the v3 module + the prune-proto were stashed to bring v4 in under
the cap.

`sui move build` only scans `sources/`, `tests/`, and `examples/` by
convention, so anything in this directory is invisible to the compiler and to
upgrade transactions until it is moved back.

## Files

### `segment_market_v3.move` (52,774 bytes source / ~30 KB bytecode)

The v3 touch-direction + open-window arcade module. Replicates much of v2's
shape but adds the sponsored-cranking, prune-settled-segments, and Walrus
archive flows from `docs/design/v2/22+23+24`.

**Why stashed**: v4 (`segment_market_v4.move`) is the superseding production
module per `docs/design/v2/25_touch_either_laser_v3.md`. v4 ships its own
`prune_settled_segments` (line 1054) and `record_walrus_archive` (line 698)
entry points, so the prune + Walrus features are still live on testnet via
v4; only the v3-specific direction-pick + open-window mechanics are absent.

**Effect on the package on-chain**: testnet package `0x10c3...` does **not**
contain a `segment_market_v3` module. Anything in `wick.move` that referenced
`sm3::*` has been block-commented (see lines around 417 in the post-upgrade
wick.move). The `use wick::segment_market_v3` import is also disabled.

**To restore in a future upgrade**: split the Move workspace into multiple
packages first (Sui's per-package limit is hard, so you can't fit v2 + v3 + v4
+ sponsor + prune_proto under 102 KB). The cleanest split is:

- `wick-core`  — vault + token + risk + fee_router + market (v2 legacy)
- `wick-arcade-v3` — segment_market_v3 + its dependencies on wick-core
- `wick-arcade-v4` — segment_market_v4 + dependencies (already what's live)

Once split, move `segment_market_v3.move` back into `wick-arcade-v3/sources/`
and un-comment the re-exports in `wick.move`.

### `prune_proto.move` (6,899 bytes source)

A standalone prototype module that demonstrated the storage-rebate flow
empirically (see `scripts/prune-proto-smoke.sh`) before the real
`prune_settled_segments` logic landed inside `segment_market_v3.move` (and
later `segment_market_v4.move`). The SEV-2 #A fix for the asymmetric
self-grief vector was prototyped here.

**Why stashed**: prototype only — never had production callers. The
production `prune_settled_segments` shipped inside v4. Keeping it in the
package would waste ~5 KB of the 102 KB limit for code nothing calls.

**To restore**: only if you need the empirical-rebate proto again (e.g., to
validate a new rebate edge case). Move back into `sources/` and rebuild;
the proto's `prune_proto` entry points become callable on the next upgrade.

## Restore procedure

```bash
cd move
mv sources-stash/segment_market_v3.move sources/
# Then in sources/wick.move, un-comment:
#   - the `use wick::segment_market_v3::...` line near line 38
#   - the `/* ... */` block from line ~420 to line ~570 wrapping the
#     bootstrap_segment_market_v3 / record_segment_v3 / ... functions
# Repeat for prune_proto.move if needed.
sui move build   # confirm size < 102_400 bytes; if not, split packages
```
