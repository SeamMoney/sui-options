/**
 * Request-handling tests for the /api/faucet Vercel function — the first
 * endpoint every judge taps (no-wallet onboarding). `executeWithRetry` (the
 * gas-coin retry) is covered in faucet.test.ts; this pins the HTTP contract
 * AROUND it: method routing, CORS preflight, body parsing, and recipient
 * validation. Every case here returns BEFORE the signer/RPC is ever touched,
 * so the suite runs offline and deterministically — no faucet key, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

import handler from "../api/faucet.js";

interface Captured {
  status: number;
  body?: unknown;
  ended: boolean;
  headers: Record<string, string>;
}

/** Minimal res double that records what the handler set. */
function mockRes(): { res: any; cap: Captured } {
  const cap: Captured = { status: 0, ended: false, headers: {} };
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
    end(body?: string) {
      cap.ended = true;
      if (body !== undefined) cap.body = body;
    },
  };
  return { res, cap };
}

async function call(req: Record<string, unknown>): Promise<Captured> {
  const { res, cap } = mockRes();
  await handler(req as any, res);
  return cap;
}

test("OPTIONS preflight → 204 with permissive CORS headers", async () => {
  const cap = await call({ method: "OPTIONS" });
  assert.equal(cap.status, 204);
  assert.equal(cap.ended, true);
  assert.equal(cap.headers["Access-Control-Allow-Origin"], "*");
  assert.match(cap.headers["Access-Control-Allow-Methods"] ?? "", /POST/);
});

test("non-POST method → 405", async () => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    const cap = await call({ method });
    assert.equal(cap.status, 405, `${method} should be rejected`);
    assert.match((cap.body as { error: string }).error, /method not allowed/);
  }
});

test("POST with an unparseable string body → 400", async () => {
  const cap = await call({ method: "POST", body: "{not json" });
  assert.equal(cap.status, 400);
  assert.match((cap.body as { error: string }).error, /not valid JSON/);
});

test("POST with a missing recipient → 400 (string required)", async () => {
  // Empty body is coerced to {} → recipient is undefined.
  const cap = await call({ method: "POST", body: {} });
  assert.equal(cap.status, 400);
  assert.match((cap.body as { error: string }).error, /recipient must be a string/);
});

test("POST with a non-string recipient → 400", async () => {
  const cap = await call({ method: "POST", body: { recipient: 12345 } });
  assert.equal(cap.status, 400);
  assert.match((cap.body as { error: string }).error, /recipient must be a string/);
});

test("POST with an array body → 400 (must be a JSON object)", async () => {
  const cap = await call({ method: "POST", body: [1, 2, 3] });
  assert.equal(cap.status, 400);
  assert.match((cap.body as { error: string }).error, /must be a JSON object/);
});

test("POST with a malformed Sui address → 400 (validation, pre-network)", async () => {
  const cap = await call({ method: "POST", body: { recipient: "0xnope" } });
  assert.equal(cap.status, 400);
  assert.match((cap.body as { error: string }).error, /not a valid Sui address/);
});

test("POST with a string-encoded JSON body is parsed before validation", async () => {
  // A client that sends a raw JSON string (not pre-parsed) still validates.
  const cap = await call({ method: "POST", body: JSON.stringify({ recipient: "0xnope" }) });
  assert.equal(cap.status, 400);
  assert.match((cap.body as { error: string }).error, /not a valid Sui address/);
});
