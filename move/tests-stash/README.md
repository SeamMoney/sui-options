# move/tests-stash/

Move test files for modules that are temporarily stashed in
`../sources-stash/` and therefore not present in the on-chain package
(testnet `0x10c3…` from the 2026-05-23 v4 upgrade). See
`../sources-stash/README.md` for the full story.

Stashed alongside `sources-stash/`:

- `segment_market_v3_tests.move` — tests for `wick::segment_market_v3`,
  which currently lives in `../sources-stash/segment_market_v3.move`.
  Restore both together: move this file to `../tests/` when the source is
  moved to `../sources/`.

- `prune_proto_tests.move` — tests for `wick::prune_proto`, which currently
  lives in `../sources-stash/prune_proto.move`. Restore both together.

`sui move test` only scans `tests/`, so these files are inert here. The
combined test suite drops from 578 to 547 while these are stashed; restoring
brings the v3 + prune_proto coverage back.
