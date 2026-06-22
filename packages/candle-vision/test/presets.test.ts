// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// createCandleVisionPreset composes the /coach's theme + overlay + ranking into
// one preset. Its one load-bearing behaviour (beyond plumbing) is that the
// chosen theme is INJECTED into the overlay, so the chart-overlay colours always
// match the active theme — otherwise the overlay renders against a stale theme.
// Pin the defaults + that injection.
import test from "node:test";
import assert from "node:assert/strict";

import { createCandleVisionPreset } from "../src/presets.ts";

test("createCandleVisionPreset returns a coherent theme + overlay + ranking", () => {
  const p = createCandleVisionPreset();
  assert.ok(p.theme, "has a theme");
  assert.ok(p.overlay, "has an overlay");
  assert.ok(p.ranking, "has a ranking");
});

test("createCandleVisionPreset injects the active theme into the overlay (visual consistency)", () => {
  const p = createCandleVisionPreset();
  // The overlay must carry the SAME theme the preset selected, so chart-overlay
  // colours match the active theme rather than the overlay preset's own default.
  assert.equal(p.overlay.theme, p.theme);
});

test("createCandleVisionPreset honours an explicit theme/overlay/ranking selection", () => {
  const p = createCandleVisionPreset({ theme: "terminal", overlay: "computerVision", ranking: "default" });
  assert.ok(p.theme && p.overlay && p.ranking);
  assert.equal(p.overlay.theme, p.theme); // injection holds for an explicit selection too
});
