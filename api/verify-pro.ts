/**
 * POST /api/verify-pro
 *
 * Verifies a Wick Pro round's commit-reveal from a URL — no clone, no CLI, no
 * wallet. Every /pro round publishes `commit = SHA-256(`${seed}:${paramsJson}`)`
 * BEFORE the lobby, then reveals `{ seed, paramsJson }` at settle. This endpoint
 * recomputes the digest INDEPENDENTLY (node:crypto) and reports whether the
 * revealed preimage binds to the published commit — so a judge can paste the
 * three values the UI shows and confirm the price path was fixed in advance.
 *
 * Request:  { commit: string(64-hex), seed: number, paramsJson: string }
 * Success:  200 { matches: boolean, recomputed: string, commit: string }
 *           matches=true  → the round was honest (the path was committed before the bet)
 *           matches=false → the revealed seed/params do NOT hash to the published commit
 * Errors:   400 (bad input) · 405 (non-POST)
 *
 * Pure compute: no network, no RPC, no key — it cannot time out or leak.
 * `handle()` is exported for unit tests (see api-tests/verify-pro.test.ts).
 */
import { createHash } from "node:crypto";

interface ReqLike {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
}
interface ResLike {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ResLike;
  json: (body: unknown) => void;
  end: (body?: string) => void;
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

/** Independent commit recomputation — the trust-minimizing step. */
function commitOf(seed: number, paramsJson: string): string {
  return createHash("sha256").update(`${seed}:${paramsJson}`).digest("hex");
}

export function handle(rawBody: unknown): JsonResponse {
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { status: 400, body: { error: "body must be a JSON object" } };
  }
  const { commit, seed, paramsJson } = rawBody as Record<string, unknown>;

  if (typeof commit !== "string" || !/^[0-9a-f]{64}$/.test(commit)) {
    return { status: 400, body: { error: "commit must be a 64-char lowercase hex SHA-256 string" } };
  }
  // Accept the seed as a number or a numeric string (URLs/forms stringify it).
  const seedNum = typeof seed === "number" ? seed : typeof seed === "string" ? Number(seed) : NaN;
  if (!Number.isFinite(seedNum)) {
    return { status: 400, body: { error: "seed must be a number" } };
  }
  if (typeof paramsJson !== "string") {
    return { status: 400, body: { error: "paramsJson must be a string (the exact revealed params)" } };
  }
  // A real /pro paramsJson is ~200 bytes. Cap the input so an oversized string
  // can't turn this open, key-less endpoint into a hashing-DoS vector.
  if (paramsJson.length > 8192) {
    return { status: 400, body: { error: "paramsJson too large (max 8192 chars; a real round's is ~200)" } };
  }

  const recomputed = commitOf(seedNum, paramsJson);
  return {
    status: 200,
    body: {
      matches: recomputed === commit,
      recomputed,
      commit,
      // a human-readable verdict, mirroring the CLI verifier's language
      verdict:
        recomputed === commit
          ? "HONEST — the revealed seed+params hash to the published commit; the path was fixed before the bet"
          : "MISMATCH — the revealed seed+params do NOT hash to the published commit",
    },
  };
}

export default function handler(req: ReqLike, res: ResLike): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // GET makes verification a clickable link: /api/verify-pro?commit=…&seed=…&paramsJson=…
  // (the three values URL-encoded). Read-only, idempotent — safe as a GET.
  if (req.method === "GET") {
    const q = req.query ?? {};
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    const seedStr = one(q.seed);
    const out = handle({
      commit: one(q.commit),
      seed: seedStr === undefined ? undefined : Number(seedStr),
      paramsJson: one(q.paramsJson),
    });
    res.status(out.status).json(out.body);
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed; use POST or GET" });
    return;
  }

  let parsed: unknown = req.body;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      res.status(400).json({ error: "body is not valid JSON" });
      return;
    }
  }
  if (parsed === undefined || parsed === null || parsed === "") {
    parsed = {};
  }

  const out = handle(parsed);
  res.status(out.status).json(out.body);
}
