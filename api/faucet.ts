/**
 * POST /api/faucet
 *
 * Vercel serverless function. Drips a fixed amount of testnet SUI from a
 * pre-funded app wallet (`WICK_FAUCET_PRIVATE_KEY`) to any caller-supplied
 * Sui address. Exists because the public Sui faucet is heavily
 * IP-rate-limited and unreliable during demos.
 *
 * Request:  { recipient: string }   // 0x-prefixed 32-byte Sui address
 * Success:  200 { digest, amount_mist, recipient }
 * Errors:   400 { error } | 429 { error } | 500 { error } | 503 { error }
 *
 * Hard rules:
 *  - Never log the private key or anything derived from it.
 *  - Refuse if the source wallet doesn't have at least DRIP + GAS_BUFFER.
 *  - Rate-limit per recipient address (5 min cooldown) in process memory.
 *    This is best-effort because Vercel functions are stateless across
 *    invocations and may run in multiple regions / instances — it stops
 *    the obvious "spam-click the button" case, not a determined abuser.
 *    For production we'd front this with KV/Redis (Upstash, Vercel KV).
 *
 * The function file lives at the repo root (`api/faucet.ts`) so Vercel
 * auto-detects it as a serverless function at `/api/faucet`. Other files
 * under `api/` (the @wick/api Fastify workspace) are excluded via
 * `.vercelignore`.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

// Default to PublicNode, not the Mysten public fullnode: this faucet is the
// highest-traffic public endpoint (the first thing every judge taps), and the
// Mysten testnet endpoint throttles under concurrent load — the same v4.29
// finding that moved the frontend/keeper/bots off it. Override with WICK_API_RPC.
const TESTNET_RPC_URL =
  process.env.WICK_API_RPC ?? "https://sui-testnet-rpc.publicnode.com";
import { Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

// Amounts are denominated in MIST. 1 SUI = 1e9 MIST.
// 2026-05-23: dropped from 0.5 → 0.1 SUI after the 0.5 bump immediately
// drained the faucet wallet (it only holds ~162M MIST and a 0.5 SUI drip
// requires 520M MIST threshold, so every request returned "drained"). The
// per-ride gas math on the smoke market is still 100M MIST/ride, so 0.1
// SUI is just barely enough for one ride — operators should top up the
// faucet wallet between sessions until sponsored transactions land.
// 2026-05-24 v4.19 — bumped 100M → 200M (0.1 → 0.2 SUI). With the
// MIN_RIDE_BALANCE gate at 0.025 SUI and per-ride gas ~0.01 SUI, a
// 0.1 SUI drip survived only ~7 rides before re-triggering the
// funding gate + 90 s faucet cooldown. 0.2 SUI doubles that runway
// with no other cost.
// 2026-06-21 — bumped 200M → 1_000M (0.2 → 1.0 SUI). The earlier low
// drip existed ONLY because the faucet wallet was nearly empty (~162M
// MIST); it now holds ~8.9K SUI, so runway is a non-issue (>8000 drips).
// Crucially, the v4 /ride game has the player's own browser crank each
// held segment (no sponsor wired, no always-on sentinel), and a measured
// record_segment_v4 costs ~9M MIST — so the headline "hold for the touch
// jackpot" play (≈70 segments) burns ~0.65 SUI. At 0.2 SUI a judge ran
// out of gas after ~20 segments and the ride stalled.
// 2026-06-21 — 1.0 → 2.0 SUI. 1.0 covered ONE full hold-to-touch, but a judge
// evaluating a game plays several rides (a win, a cashout, a halt); at 1.0 the
// 2nd full ride hit the per-recipient funding gate + 90s faucet cooldown
// mid-session. 2.0 SUI covers a full multi-ride evaluation (~3 full holds, more
// if they cash out early) without re-faucet friction. Wallet runway is still
// >4000 drips, so no concern.
const DRIP_MIST = 2_000_000_000n; // 2.0 SUI
const GAS_BUFFER_MIST = 20_000_000n; // ~0.02 SUI; ample headroom for one transfer
const COOLDOWN_MS = 90 * 1000; // 90s per recipient

// Module-scoped rate-limit map. Persists across warm invocations only.
// Module load is rare on Vercel so this gives us "minutes of memory" — fine
// for hackathon use, explicitly noted in api/README.md.
const lastDrip = new Map<string, number>();

// Lazy singletons so we don't re-parse the key / re-open the client on every
// warm invocation.
let cachedClient: SuiJsonRpcClient | null = null;
let cachedKeypair: Ed25519Keypair | null = null;
let cachedSender: string | null = null;

function getClient(): SuiJsonRpcClient {
  if (cachedClient) return cachedClient;
  cachedClient = new SuiJsonRpcClient({
    network: "testnet",
    url: TESTNET_RPC_URL,
  });
  return cachedClient;
}

function getKeypair(): { keypair: Ed25519Keypair; sender: string } {
  if (cachedKeypair && cachedSender) {
    return { keypair: cachedKeypair, sender: cachedSender };
  }
  const secret = process.env.WICK_FAUCET_PRIVATE_KEY;
  if (!secret) {
    throw new Error("WICK_FAUCET_PRIVATE_KEY is not set");
  }
  // @mysten/sui v2+ accepts a bech32 `suiprivkey1...` string directly.
  cachedKeypair = Ed25519Keypair.fromSecretKey(secret);
  cachedSender = cachedKeypair.getPublicKey().toSuiAddress();
  return { keypair: cachedKeypair, sender: cachedSender };
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

export type RetryOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * Run `run()`, retrying on a thrown error up to `maxAttempts` times with a
 * jittered backoff between attempts.
 *
 * The faucet wallets own a single gas coin each, so two requests landing close
 * together collide on the same coin version and the second tx throws an
 * object-version / equivocation error — the cause of the intermittent 500s the
 * SUI + TUSD faucets returned during demos. Because `run()` rebuilds the
 * Transaction on every call, a retry re-resolves the now-advanced gas coin and
 * usually succeeds. Pure + dependency-injected (`sleep`) so it is unit-tested
 * directly in api/faucet.test.ts without touching the network.
 */
export async function executeWithRetry<T>(
  run: () => Promise<T>,
  opts?: {
    maxAttempts?: number;
    onError?: (err: unknown, attempt: number) => void;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  },
): Promise<RetryOutcome<T>> {
  const maxAttempts = opts?.maxAttempts ?? 4;
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts?.random ?? Math.random;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { ok: true, value: await run() };
    } catch (err) {
      lastErr = err;
      opts?.onError?.(err, attempt);
      if (attempt < maxAttempts) {
        // Backoff grows per attempt; the jitter spreads concurrent retries so
        // they don't collide on the same coin version again.
        const backoffMs = 250 * attempt + Math.floor(random() * 200);
        await sleep(backoffMs);
      }
    }
  }
  return { ok: false, error: lastErr };
}

async function handle(rawBody: unknown): Promise<JsonResponse> {
  // ---- Parse + validate input ----------------------------------------------
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { status: 400, body: { error: "body must be a JSON object" } };
  }
  const recipientRaw = (rawBody as Record<string, unknown>).recipient;
  if (typeof recipientRaw !== "string") {
    return { status: 400, body: { error: "recipient must be a string" } };
  }
  if (!isValidSuiAddress(recipientRaw)) {
    return { status: 400, body: { error: "recipient is not a valid Sui address" } };
  }
  const recipient = normalizeSuiAddress(recipientRaw);

  // ---- Rate limit (per-recipient) ------------------------------------------
  const now = Date.now();
  const prev = lastDrip.get(recipient);
  if (prev !== undefined && now - prev < COOLDOWN_MS) {
    const retryAfterMs = COOLDOWN_MS - (now - prev);
    return {
      status: 429,
      body: {
        error: "rate-limited",
        retry_after_ms: retryAfterMs,
        cooldown_ms: COOLDOWN_MS,
      },
    };
  }

  // ---- Load signer ---------------------------------------------------------
  let signer: { keypair: Ed25519Keypair; sender: string };
  try {
    signer = getKeypair();
  } catch (err) {
    console.error("[api/faucet] keypair load failed", { error: String(err) });
    return { status: 500, body: { error: "faucet wallet is not configured" } };
  }

  // ---- Source-balance precheck --------------------------------------------
  const client = getClient();
  let totalMist: bigint;
  try {
    const balance = await client.getBalance({
      owner: signer.sender,
      coinType: "0x2::sui::SUI",
    });
    totalMist = BigInt(balance.totalBalance);
  } catch (err) {
    console.error("[api/faucet] getBalance failed", { error: String(err) });
    return { status: 503, body: { error: "RPC unreachable, try again" } };
  }
  if (totalMist < DRIP_MIST + GAS_BUFFER_MIST) {
    console.error("[api/faucet] source wallet drained", {
      sender: signer.sender,
      totalMist: totalMist.toString(),
    });
    return {
      status: 503,
      body: {
        error: "faucet wallet is drained — ping the maintainer",
        sender: signer.sender,
      },
    };
  }

  // ---- Build + execute the transfer PTB (retry on gas-coin contention) ------
  // The wallet historically held its SUI in ONE coin, so two requests landing
  // close together resolved the SAME gas coin and the second equivocated → 500.
  // Anti-contention: on EACH attempt, fetch a FRESH view of the wallet's coin
  // pool and pin gas to a random usable coin (setGasPayment). Fetching per
  // attempt (not once up front) means a retry re-resolves CURRENT coin versions,
  // so it escapes both the collision AND the stale-snapshot a sibling drip just
  // advanced. Strict no-op until the wallet has ≥2 usable coins (0–1 → auto gas,
  // exactly today's behavior); a getCoins failure also falls back to auto gas.
  const outcome = await executeWithRetry(
    async () => {
      let gasCoin: { objectId: string; version: string; digest: string } | null = null;
      try {
        const coins = await client.getCoins({
          owner: signer.sender,
          coinType: "0x2::sui::SUI",
          limit: 50,
        });
        const usable = coins.data.filter(
          (c) => BigInt(c.balance) >= DRIP_MIST + GAS_BUFFER_MIST,
        );
        if (usable.length >= 2) {
          const c = usable[Math.floor(Math.random() * usable.length)]!;
          gasCoin = { objectId: c.coinObjectId, version: c.version, digest: c.digest };
        }
      } catch (err) {
        console.error("[api/faucet] getCoins failed; using auto gas", { error: String(err) });
      }
      const tx = new Transaction();
      // Take DRIP_MIST out of the gas coin. The remainder of the gas coin pays
      // the network fee, so we don't need a separate gas split.
      const [dripCoin] = tx.splitCoins(tx.gas, [DRIP_MIST]);
      tx.transferObjects([dripCoin], recipient);
      tx.setSender(signer.sender);
      if (gasCoin) tx.setGasPayment([gasCoin]);
      return client.signAndExecuteTransaction({
        transaction: tx,
        signer: signer.keypair,
        options: { showEffects: true },
      });
    },
    {
      onError: (err, attempt) =>
        console.error("[api/faucet] signAndExecuteTransaction threw", {
          error: String(err),
          attempt,
        }),
    },
  );

  if (!outcome.ok) {
    console.error("[api/faucet] all attempts exhausted", {
      error: String(outcome.error),
    });
    return { status: 500, body: { error: "drip failed, try again" } };
  }

  const result = outcome.value;
  const status = result.effects?.status?.status;
  if (status !== "success") {
    console.error("[api/faucet] tx failed onchain", {
      digest: result.digest,
      status,
      err: result.effects?.status?.error,
    });
    return {
      status: 502,
      body: {
        error: "transaction did not succeed on-chain",
        digest: result.digest,
      },
    };
  }

  // Only stamp the rate-limit on success so a transient RPC failure doesn't
  // lock the recipient out for 5 minutes.
  lastDrip.set(recipient, now);

  console.log("[api/faucet] drip ok", {
    recipient,
    digest: result.digest,
    amount_mist: DRIP_MIST.toString(),
  });

  return {
    status: 200,
    body: {
      digest: result.digest,
      amount_mist: DRIP_MIST.toString(),
      recipient,
    },
  };
}

/**
 * Vercel Node runtime handler. We use plain `req`/`res` typed structurally so
 * we don't need to add `@vercel/node` as a build dep — the runtime is the
 * same Node http API either way.
 */
interface ReqLike {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}
interface ResLike {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ResLike;
  json: (body: unknown) => void;
  end: (body?: string) => void;
}

export default async function handler(req: ReqLike, res: ResLike): Promise<void> {
  // CORS — frontend on the same Vercel project is same-origin, but support
  // local dev (vite at :5173 → vercel dev at :3000) and explicit calls.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed; use POST" });
    return;
  }

  // Vercel parses application/json bodies into `req.body` automatically when
  // the Content-Type header is set. If a client sends a raw string we still
  // accept it.
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

  const out = await handle(parsed);
  res.status(out.status).json(out.body);
}
