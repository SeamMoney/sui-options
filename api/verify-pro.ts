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

// Self-contained client-side verifier page served on a bare GET. It hashes with
// the browser's Web Crypto (crypto.subtle) — nothing is sent to the server — so
// it's the most trust-minimized surface: visit the URL, paste the three values,
// re-hash in your own browser. Mirrors scripts/verify-pro.html.
const VERIFIER_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Wick Pro — verify your round</title><style>:root{color-scheme:dark}
body{margin:0;background:#07090c;color:#e7ecf2;font:15px/1.5 ui-monospace,Menlo,monospace}
.w{max-width:680px;margin:0 auto;padding:28px 18px 60px}h1{font-size:20px;margin:0 0 4px}
h1 b{color:#10b981}p.s{color:#8a97a6;margin:0 0 22px}label{display:block;margin:14px 0 5px;color:#aeb9c6;font-size:13px}
input,textarea{width:100%;box-sizing:border-box;background:#0d1117;color:#e7ecf2;border:1px solid #1f2730;border-radius:8px;padding:10px;font:inherit}
textarea{min-height:64px;resize:vertical}button{margin-top:18px;width:100%;background:#10b981;color:#04130d;border:0;border-radius:999px;padding:13px;font:600 15px ui-monospace,monospace;cursor:pointer}
#o{margin-top:22px;padding:16px;border-radius:10px;display:none}#o.ok{display:block;background:#06281c;border:1px solid #10b981}
#o.bad{display:block;background:#2a0d12;border:1px solid #ef4444}.v{font-size:17px;font-weight:700}.okv{color:#34d399}.badv{color:#f87171}
code{color:#9fb0c2;word-break:break-all}.n{margin-top:26px;color:#6b7785;font-size:12px;border-top:1px solid #161d25;padding-top:14px}</style></head>
<body><div class="w"><h1>Wick <b>Pro</b> — verify your round</h1>
<p class="s">Each round publishes <code>commit = SHA-256(seed:params)</code> before the lobby, then reveals the seed at settle.
Paste the three values (from <code>npm run play</code> or the game) — this page re-hashes them <b>in your browser</b> (nothing sent anywhere)
and tells you whether the path was fixed before you bet.</p>
<label>Published commit (64-hex)</label><input id="c" placeholder="b3a76522a158…" autocomplete="off" spellcheck="false"/>
<label>Revealed seed</label><input id="s" inputmode="numeric" placeholder="12648430" autocomplete="off"/>
<label>Revealed paramsJson</label><textarea id="p" placeholder='{"startPrice":100,…}' spellcheck="false"></textarea>
<button id="g">Verify in my browser</button>
<div id="o"><div class="v"></div><div style="margin-top:8px">recomputed: <code class="rc"></code></div><div>published:&nbsp; <code class="pc"></code></div></div>
<p class="n">Trust-minimized: SHA-256 runs client-side via <code>crypto.subtle</code> — no server, no network. Same guarantee as
<code>npm run verify:pro-fairness</code> and the SDK's <code>verifyProRound()</code>.</p></div>
<script>async function h(x){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(x));return[...new Uint8Array(b)].map(n=>n.toString(16).padStart(2,"0")).join("")}
document.getElementById("g").onclick=async()=>{const c=document.getElementById("c").value.trim().toLowerCase(),s=document.getElementById("s").value.trim(),p=document.getElementById("p").value,o=document.getElementById("o"),v=o.querySelector(".v");
if(!/^[0-9a-f]{64}$/.test(c)){o.className="bad";v.innerHTML='<span class="badv">✗ commit must be 64 hex chars</span>';o.querySelector(".rc").textContent="";o.querySelector(".pc").textContent=c||"(empty)";return}
if(!/^-?\\d+$/.test(s)){o.className="bad";v.innerHTML='<span class="badv">✗ seed must be a whole number</span>';o.querySelector(".rc").textContent="";o.querySelector(".pc").textContent=c;return}
const r=await h(s+":"+p),ok=r===c;o.className=ok?"ok":"bad";v.innerHTML=ok?'<span class="okv">✓ HONEST — the revealed seed+params hash to the published commit. The path was fixed before you bet.</span>':'<span class="badv">✗ MISMATCH — these values do NOT hash to the published commit.</span>';
o.querySelector(".rc").textContent=r;o.querySelector(".pc").textContent=c}</script></body></html>`;

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
    // A bare GET from a browser (no commit) gets a self-contained verifier PAGE
    // that hashes client-side — visit the URL, paste three values, no clone/curl.
    if (one(q.commit) === undefined) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).end(VERIFIER_PAGE);
      return;
    }
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
