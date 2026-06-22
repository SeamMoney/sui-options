// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// The pattern registry is the catalog the detectors/coach resolve a pattern
// KIND to its definition + metadata against. A registry that fails to resolve a
// known kind (or claims to support an unknown one) silently drops or mislabels
// patterns. Pin construction + lookup + the support predicate's agreement.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createPatternRegistry,
  getPatternDefinition,
  isSupportedPatternKind,
} from "../src/registry.ts";

test("createPatternRegistry builds a registry that resolves a known pattern (marubozu)", () => {
  const reg = createPatternRegistry();
  const def = getPatternDefinition("marubozu", reg);
  assert.ok(def, "marubozu should resolve to a definition");
  assert.equal(def!.kind, "marubozu");
});

test("getPatternDefinition uses the default registry and returns undefined for unknown kinds", () => {
  assert.ok(getPatternDefinition("marubozu"), "marubozu resolves in the default registry");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(getPatternDefinition("definitely-not-a-pattern" as any), undefined);
});

test("isSupportedPatternKind agrees with getPatternDefinition", () => {
  assert.equal(isSupportedPatternKind("marubozu"), true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(isSupportedPatternKind("definitely-not-a-pattern" as any), false);
});
