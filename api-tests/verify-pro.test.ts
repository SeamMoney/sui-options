/**
 * Unit tests for /api/verify-pro — the URL commit-reveal verifier for /pro rounds.
 *
 * Pure compute, no network: we drive a REAL pro-options round to get a genuine
 * { commit, seed, paramsJson }, then assert the endpoint confirms an honest
 * reveal, catches a tampered one, and validates its inputs. End-to-end this is
 * the same guarantee as `npm run verify:pro-fairness`, but over HTTP.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import handler, { handle } from "../api/verify-pro.js";
import { RoundEngine, roundConfigFromPreset, presetById } from "../packages/pro-options/src/index.js";

// A genuine round: the engine publishes `commit` and reveals `{ seed, paramsJson }`.
const engine = new RoundEngine(roundConfigFromPreset({ preset: presetById("volatile")!, seed: 1337, startedAtMs: 1_000_000 }));
const revealed = engine.reveal();

test("an honest reveal binds: matches=true with the verdict", () => {
  const out = handle({ commit: engine.commit, seed: revealed.seed, paramsJson: revealed.paramsJson });
  assert.equal(out.status, 200);
  const body = out.body as { matches: boolean; recomputed: string; verdict: string };
  assert.equal(body.matches, true);
  assert.equal(body.recomputed, engine.commit);
  assert.match(body.verdict, /HONEST/);
});

test("a tampered seed is caught: matches=false", () => {
  const out = handle({ commit: engine.commit, seed: revealed.seed + 1, paramsJson: revealed.paramsJson });
  const body = out.body as { matches: boolean; verdict: string };
  assert.equal(out.status, 200);
  assert.equal(body.matches, false);
  assert.match(body.verdict, /MISMATCH/);
});

test("seed accepts a numeric string (forms/URLs stringify)", () => {
  const out = handle({ commit: engine.commit, seed: String(revealed.seed), paramsJson: revealed.paramsJson });
  assert.equal((out.body as { matches: boolean }).matches, true);
});

test("the recomputed digest equals node:crypto SHA-256 (independent)", () => {
  const out = handle({ commit: engine.commit, seed: revealed.seed, paramsJson: revealed.paramsJson });
  const expected = createHash("sha256").update(`${revealed.seed}:${revealed.paramsJson}`).digest("hex");
  assert.equal((out.body as { recomputed: string }).recomputed, expected);
});

test("input validation: bad commit / non-object / missing fields → 400", () => {
  assert.equal(handle({ commit: "nope", seed: 1, paramsJson: "{}" }).status, 400);
  assert.equal(handle([1, 2, 3]).status, 400);
  assert.equal(handle({ commit: engine.commit, paramsJson: "{}" }).status, 400); // missing seed
  assert.equal(handle({ commit: engine.commit, seed: 1 }).status, 400); // missing paramsJson
});

// ── HTTP handler (CORS / method / body parsing) ─────────────────────────────
function mockRes() {
  const cap: { status: number; body?: unknown; ended: boolean; headers: Record<string, string> } = {
    status: 0,
    ended: false,
    headers: {},
  };
  const res: any = {
    setHeader: (k: string, v: string) => {
      cap.headers[k] = v;
    },
    status(code: number) {
      cap.status = code;
      return res;
    },
    json(body: unknown) {
      cap.body = body;
    },
    end() {
      cap.ended = true;
    },
  };
  return { res, cap };
}

test("handler: GET with query params verifies (clickable-link form)", () => {
  let m = mockRes();
  handler(
    { method: "GET", query: { commit: engine.commit, seed: String(revealed.seed), paramsJson: revealed.paramsJson } } as any,
    m.res,
  );
  assert.equal(m.cap.status, 200);
  assert.equal((m.cap.body as { matches: boolean }).matches, true);

  // a tampered seed in the query is caught
  m = mockRes();
  handler(
    { method: "GET", query: { commit: engine.commit, seed: String(revealed.seed + 1), paramsJson: revealed.paramsJson } } as any,
    m.res,
  );
  assert.equal((m.cap.body as { matches: boolean }).matches, false);
});

test("handler: OPTIONS → 204, unsupported method → 405, string body parsed", () => {
  let m = mockRes();
  handler({ method: "OPTIONS" } as any, m.res);
  assert.equal(m.cap.status, 204);
  assert.equal(m.cap.headers["Access-Control-Allow-Origin"], "*");

  m = mockRes();
  handler({ method: "PUT" } as any, m.res); // GET/POST are handled; PUT is not
  assert.equal(m.cap.status, 405);

  m = mockRes();
  handler({ method: "POST", body: JSON.stringify({ commit: engine.commit, seed: revealed.seed, paramsJson: revealed.paramsJson }) } as any, m.res);
  assert.equal(m.cap.status, 200);
  assert.equal((m.cap.body as { matches: boolean }).matches, true);
});
