/**
 * POST /api/faucet-tusd
 *
 * Mints TUSD (the Wick testnet stablecoin) to a recipient.
 *
 * The TreasuryCap is owned by the same wallet that drips SUI from
 * /api/faucet — so the existing WICK_FAUCET_PRIVATE_KEY env var works
 * for both. The cap object id is read from deployments/testnet.json at
 * build time (embedded into the bundle below).
 *
 * Request:  { recipient: string }
 * Success:  200 { digest, amount_raw, recipient }
 * Errors:   400 | 429 | 500 | 503
 *
 * Drips 10 TUSD per request by default (10_000_000 raw at 6 decimals).
 * That's enough for ~66 user rides at $0.15 max stake. Rate-limited
 * per recipient with the same 90s cooldown as /api/faucet.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

// ── Constants pinned at module load ───────────────────────────────────────
// Read from deployments/testnet.json at the top so the values are visible
// to the operator on cold-start; if they ever change, this needs a redeploy.
const TUSD_PACKAGE_ID =
  "0x204d595c642a06ccc667a32789a6a5a01d0b7ff3340fb53f7f69649c90d00a31";
const TUSD_TREASURY_CAP =
  "0x7db5b3edead4f503ce8ef19ace6eca26e961edd08871042ad5de6f870a369b11";

const DRIP_RAW = 10_000_000n; // 10 TUSD (6 decimals)
const COOLDOWN_MS = 90 * 1000;

const lastDrip = new Map<string, number>();

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
  cachedKeypair = Ed25519Keypair.fromSecretKey(secret);
  cachedSender = cachedKeypair.getPublicKey().toSuiAddress();
  return { keypair: cachedKeypair, sender: cachedSender };
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function handle(rawBody: unknown): Promise<JsonResponse> {
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

  let signer: { keypair: Ed25519Keypair; sender: string };
  try {
    signer = getKeypair();
  } catch (err) {
    console.error("[api/faucet-tusd] keypair load failed", { error: String(err) });
    return { status: 500, body: { error: "faucet wallet is not configured" } };
  }

  const client = getClient();

  // Build the mint tx: calls wick_tusd::tusd::mint(treasury_cap, amount,
  // recipient). The TreasuryCap is owned by the faucet wallet so we don't
  // need to share it.
  const tx = new Transaction();
  tx.moveCall({
    target: `${TUSD_PACKAGE_ID}::tusd::mint`,
    arguments: [
      tx.object(TUSD_TREASURY_CAP),
      tx.pure.u64(DRIP_RAW),
      tx.pure.address(recipient),
    ],
  });
  tx.setSender(signer.sender);

  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: signer.keypair,
      options: { showEffects: true },
    });

    const status = result.effects?.status?.status;
    if (status !== "success") {
      console.error("[api/faucet-tusd] tx failed on chain", {
        digest: result.digest,
        status,
        err: result.effects?.status?.error,
      });
      return {
        status: 502,
        body: {
          error: "mint did not succeed on-chain",
          digest: result.digest,
        },
      };
    }

    lastDrip.set(recipient, now);

    console.log("[api/faucet-tusd] mint ok", {
      recipient,
      digest: result.digest,
      amount_raw: DRIP_RAW.toString(),
    });

    return {
      status: 200,
      body: {
        digest: result.digest,
        amount_raw: DRIP_RAW.toString(),
        recipient,
      },
    };
  } catch (err) {
    console.error("[api/faucet-tusd] signAndExecuteTransaction threw", {
      error: String(err),
    });
    return { status: 500, body: { error: "mint failed, try again" } };
  }
}

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
