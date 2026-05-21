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
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

// Amounts are denominated in MIST. 1 SUI = 1e9 MIST.
const DRIP_MIST = 50_000_000n; // 0.05 SUI
const GAS_BUFFER_MIST = 20_000_000n; // ~0.02 SUI; ample headroom for one transfer
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per recipient

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
    url: getJsonRpcFullnodeUrl("testnet"),
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

  // ---- Build + execute the transfer PTB ------------------------------------
  const tx = new Transaction();
  // Take DRIP_MIST out of the gas coin. The remainder of the gas coin pays
  // the network fee, so we don't need a separate gas split.
  const [dripCoin] = tx.splitCoins(tx.gas, [DRIP_MIST]);
  tx.transferObjects([dripCoin], recipient);
  tx.setSender(signer.sender);

  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: signer.keypair,
      options: { showEffects: true },
    });

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
  } catch (err) {
    console.error("[api/faucet] signAndExecuteTransaction threw", {
      error: String(err),
    });
    return { status: 500, body: { error: "drip failed, try again" } };
  }
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
