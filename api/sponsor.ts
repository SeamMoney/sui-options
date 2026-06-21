/**
 * POST /api/sponsor
 *
 * Vercel serverless sponsor endpoint for Wick v3 SegmentMarket calls. The
 * user signs the TransactionData as sender; this function validates the
 * allowlist, co-signs as gas owner, and submits the fully signed transaction
 * to Sui testnet.
 *
 * Request:  { sender: string, txBytes: base64, userSig: base64 }
 * Success:  200 { digest }
 * Errors:   400 { error } | 403 { error } | 429 { error } | 503 { error }
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

// Default to PublicNode, not the Mysten public fullnode — the sponsor co-signs
// cranking txs and the Mysten testnet endpoint throttles under sustained load
// (v4.29 finding; frontend/keeper/bots already moved off it). Override with
// WICK_API_RPC.
const TESTNET_RPC_URL =
  process.env.WICK_API_RPC ?? "https://sui-testnet-rpc.publicnode.com";
import { Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

const ROUTER_MODULE = "wick";
const MARKET_MODULE = "segment_market_v3";
const ALLOWED_FUNCTIONS = new Set([
  "record_segment_v3",
  "open_segment_ride_v3",
  "close_segment_ride_v3",
  "crank_expired_segment_ride_v3",
  "abort_segment_ride_v3",
]);
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_DEPLOYMENT_PATH = resolve(process.cwd(), "deployments/testnet.json");

const senderWindows = new Map<string, number[]>();
let spendTodayMist = 0n;
let spendDayKey = utcDayKey(Date.now());

let cachedClient: SuiJsonRpcClient | null = null;
let cachedKeypair: Ed25519Keypair | null = null;
let cachedSponsorAddress: string | null = null;
let cachedV3PackageId: string | null = null;

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
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

interface SponsorSigner {
  keypair: Ed25519Keypair;
  address: string;
}

interface GasUsed {
  computationCost?: string;
  storageCost?: string;
  storageRebate?: string;
  nonRefundableStorageFee?: string;
}

interface ExecuteResult {
  digest: string;
  effects?: {
    status?: {
      status?: string;
      error?: string;
    };
    gasUsed?: GasUsed;
  };
}

interface SponsorDeps {
  nowMs?: () => number;
  getClient?: () => SuiJsonRpcClient;
  getSponsor?: () => SponsorSigner;
  getV3PackageId?: () => string;
  getDailyCapMist?: () => bigint;
  lookupObjectType?: (client: SuiJsonRpcClient, objectId: string) => Promise<string | null>;
  executeTransactionBlock?: (
    client: SuiJsonRpcClient,
    txBytes: Uint8Array,
    signatures: string[],
  ) => Promise<ExecuteResult>;
}

interface ParsedTxData {
  sender: string | null;
  gasData: {
    owner: string | null;
  };
  inputs: ParsedInput[];
  commands: ParsedCommand[];
}

type ParsedArgument = Record<string, unknown>;
type ParsedInput = Record<string, unknown>;
type ParsedCommand = Record<string, unknown>;

interface MoveCallInfo {
  package: string;
  module: string;
  function: string;
  arguments: ParsedArgument[];
}

interface Inspection {
  gasOwner: string | null;
  functionName: string;
  marketId: string;
}

function getClient(): SuiJsonRpcClient {
  if (cachedClient) return cachedClient;
  cachedClient = new SuiJsonRpcClient({
    network: "testnet",
    url: TESTNET_RPC_URL,
  });
  return cachedClient;
}

function getSponsor(): SponsorSigner {
  if (cachedKeypair && cachedSponsorAddress) {
    return { keypair: cachedKeypair, address: cachedSponsorAddress };
  }
  const secret = process.env.WICK_SPONSOR_PRIVATE_KEY;
  if (!secret) {
    throw new Error("WICK_SPONSOR_PRIVATE_KEY is not set");
  }
  cachedKeypair = Ed25519Keypair.fromSecretKey(secret);
  cachedSponsorAddress = normalizeSuiAddress(cachedKeypair.getPublicKey().toSuiAddress());
  return { keypair: cachedKeypair, address: cachedSponsorAddress };
}

function getV3PackageId(): string {
  if (cachedV3PackageId) return cachedV3PackageId;

  const raw = readFileSync(DEFAULT_DEPLOYMENT_PATH, "utf8");
  const deployments = JSON.parse(raw) as Record<string, unknown>;
  const segmentV3 =
    typeof deployments.segment_market_v3 === "object" &&
    deployments.segment_market_v3 !== null &&
    !Array.isArray(deployments.segment_market_v3)
      ? (deployments.segment_market_v3 as Record<string, unknown>)
      : null;
  const candidates = [
    segmentV3?.package_id,
    deployments.segment_market_v3_package_id,
    deployments.v3_package_id,
    deployments.package_id,
  ];

  const packageId = candidates.find((candidate): candidate is string => {
    return typeof candidate === "string" && isValidSuiAddress(candidate);
  });
  if (!packageId) {
    throw new Error("deployments/testnet.json does not contain a package id");
  }

  cachedV3PackageId = normalizeSuiAddress(packageId);
  return cachedV3PackageId;
}

function getDailyCapMist(): bigint {
  const raw = process.env.WICK_SPONSOR_MAX_DAILY_MIST;
  if (!raw) {
    throw new Error("WICK_SPONSOR_MAX_DAILY_MIST is not set");
  }
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error("negative cap");
    return value;
  } catch {
    throw new Error("WICK_SPONSOR_MAX_DAILY_MIST must be a non-negative integer");
  }
}

async function lookupObjectType(
  client: SuiJsonRpcClient,
  objectId: string,
): Promise<string | null> {
  const object = await client.getObject({
    id: objectId,
    options: { showType: true },
  });
  return object.data?.type ?? null;
}

async function executeTransactionBlock(
  client: SuiJsonRpcClient,
  txBytes: Uint8Array,
  signatures: string[],
): Promise<ExecuteResult> {
  const result = await client.executeTransactionBlock({
    transactionBlock: txBytes,
    signature: signatures,
    options: { showEffects: true },
  });
  return result as ExecuteResult;
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function resetDailySpendIfNeeded(nowMs: number): void {
  const currentDay = utcDayKey(nowMs);
  if (currentDay !== spendDayKey) {
    spendDayKey = currentDay;
    spendTodayMist = 0n;
  }
}

function decodeBase64Field(value: unknown, label: string): Uint8Array | string {
  if (typeof value !== "string" || value.trim() === "") {
    return `${label} must be a non-empty base64 string`;
  }
  const compact = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return `${label} must be base64 encoded`;
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length === 0) {
    return `${label} must not decode to empty bytes`;
  }
  return new Uint8Array(decoded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandKind(command: ParsedCommand): string | null {
  const explicit = command.$kind;
  if (typeof explicit === "string") return explicit;
  const knownKinds = [
    "MoveCall",
    "TransferObjects",
    "SplitCoins",
    "MergeCoins",
    "Publish",
    "MakeMoveVec",
    "Upgrade",
  ];
  return knownKinds.find((kind) => kind in command) ?? null;
}

function moveCallFromCommand(command: ParsedCommand): MoveCallInfo | null {
  if (commandKind(command) !== "MoveCall") return null;
  const raw = command.MoveCall;
  if (!isRecord(raw)) return null;
  const pkg = raw.package;
  const moduleName = raw.module;
  const functionName = raw.function;
  const args = raw.arguments;
  if (
    typeof pkg !== "string" ||
    typeof moduleName !== "string" ||
    typeof functionName !== "string" ||
    !Array.isArray(args)
  ) {
    return null;
  }
  return {
    package: normalizeSuiAddress(pkg),
    module: moduleName,
    function: functionName,
    arguments: args.filter(isRecord),
  };
}

function inputIndex(argument: ParsedArgument): number | null {
  const input = argument.Input;
  return typeof input === "number" && Number.isInteger(input) && input >= 0 ? input : null;
}

function objectIdFromInput(input: ParsedInput | undefined): string | null {
  if (!input) return null;
  const object = input.Object;
  if (!isRecord(object)) return null;
  const candidates = [object.ImmOrOwnedObject, object.SharedObject, object.Receiving];
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.objectId === "string") {
      return normalizeSuiAddress(candidate.objectId);
    }
  }
  return null;
}

function objectIdFromArgument(
  data: ParsedTxData,
  argument: ParsedArgument | undefined,
): string | null {
  if (!argument) return null;
  const index = inputIndex(argument);
  if (index === null) return null;
  return objectIdFromInput(data.inputs[index]);
}

function pureAddressFromArgument(
  data: ParsedTxData,
  argument: ParsedArgument | undefined,
): string | null {
  if (!argument) return null;
  const index = inputIndex(argument);
  if (index === null) return null;
  const input = data.inputs[index];
  if (!input || !isRecord(input.Pure)) return null;
  const bytes = input.Pure.bytes;
  if (typeof bytes !== "string") return null;
  const decoded = Buffer.from(bytes, "base64");
  if (decoded.length !== 32) return null;
  return normalizeSuiAddress(`0x${decoded.toString("hex")}`);
}

function isMoveCallResult(argument: ParsedArgument, moveCallIndex: number): boolean {
  const result = argument.Result;
  if (typeof result === "number" && result === moveCallIndex) return true;
  const nested = argument.NestedResult;
  return (
    Array.isArray(nested) &&
    nested.length === 2 &&
    nested[0] === moveCallIndex &&
    typeof nested[1] === "number"
  );
}

function validateAuxiliaryCommands(
  data: ParsedTxData,
  moveCallIndex: number,
  sender: string,
): string | null {
  for (let index = 0; index < data.commands.length; index += 1) {
    if (index === moveCallIndex) continue;

    const command = data.commands[index];
    if (!command) {
      return "transaction contains an empty command";
    }
    const kind = commandKind(command);
    if (kind !== "TransferObjects") {
      return "transaction contains unsupported command";
    }

    const transfer = command.TransferObjects;
    if (!isRecord(transfer) || !Array.isArray(transfer.objects)) {
      return "transfer command is malformed";
    }
    const transferAddress = pureAddressFromArgument(data, transfer.address as ParsedArgument);
    if (transferAddress !== sender) {
      return "transfer recipient must be the transaction sender";
    }

    for (const objectArg of transfer.objects) {
      if (!isRecord(objectArg) || !isMoveCallResult(objectArg, moveCallIndex)) {
        return "only the whitelisted MoveCall result may be transferred";
      }
    }
  }
  return null;
}

function marketArgumentIndex(functionName: string): number {
  switch (functionName) {
    case "close_segment_ride_v3":
    case "crank_expired_segment_ride_v3":
    case "abort_segment_ride_v3":
      return 1;
    case "record_segment_v3":
    case "open_segment_ride_v3":
    default:
      return 0;
  }
}

function isSegmentMarketV3Type(type: string, packageId: string): boolean {
  const [address, moduleName, ...rest] = type.split("::");
  if (!address || !moduleName || rest.length === 0) return false;
  const structName = rest.join("::").split("<")[0];
  return (
    normalizeSuiAddress(address) === packageId &&
    moduleName === MARKET_MODULE &&
    structName === "SegmentMarketV3"
  );
}

async function inspectSponsoredTx(
  txBytes: Uint8Array,
  sender: string,
  client: SuiJsonRpcClient,
  v3PackageId: string,
  objectTypeLookup: (client: SuiJsonRpcClient, objectId: string) => Promise<string | null>,
): Promise<Inspection | string> {
  let data: ParsedTxData;
  try {
    data = Transaction.from(txBytes).getData() as ParsedTxData;
  } catch {
    return "txBytes are not valid Sui TransactionData";
  }

  if (data.sender !== sender) {
    return "transaction sender must match request sender";
  }

  const moveCalls = data.commands
    .map((command, index) => ({ command, index, moveCall: moveCallFromCommand(command) }))
    .filter((entry): entry is { command: ParsedCommand; index: number; moveCall: MoveCallInfo } => {
      return entry.moveCall !== null;
    });
  if (moveCalls.length !== 1) {
    return "transaction must contain exactly one MoveCall";
  }
  const firstMoveCall = moveCalls[0];
  if (!firstMoveCall) {
    return "transaction must contain exactly one MoveCall";
  }
  const { index: moveCallIndex, moveCall } = firstMoveCall;

  if (
    moveCall.package !== v3PackageId ||
    moveCall.module !== ROUTER_MODULE ||
    !ALLOWED_FUNCTIONS.has(moveCall.function)
  ) {
    return "MoveCall is not on the Wick SegmentMarketV3 allowlist";
  }

  const commandError = validateAuxiliaryCommands(data, moveCallIndex, sender);
  if (commandError) return commandError;

  const marketId = objectIdFromArgument(data, moveCall.arguments[marketArgumentIndex(moveCall.function)]);
  if (!marketId) {
    return "SegmentMarketV3 object argument is missing";
  }

  let marketType: string | null;
  try {
    marketType = await objectTypeLookup(client, marketId);
  } catch {
    throw new Error("RPC object type lookup failed");
  }
  if (!marketType || !isSegmentMarketV3Type(marketType, v3PackageId)) {
    return "market object is not a SegmentMarketV3 for the configured package";
  }

  const gasOwner = data.gasData.owner ? normalizeSuiAddress(data.gasData.owner) : null;
  return {
    gasOwner,
    functionName: moveCall.function,
    marketId,
  };
}

function checkAndStampRateLimit(sender: string, nowMs: number): JsonResponse | null {
  const windowStart = nowMs - RATE_LIMIT_WINDOW_MS;
  const retained = (senderWindows.get(sender) ?? []).filter((timestamp) => timestamp > windowStart);
  if (retained.length >= RATE_LIMIT_MAX) {
    const oldest = retained[0] ?? nowMs;
    return {
      status: 429,
      body: {
        error: "rate-limited",
        retry_after_ms: Math.max(0, RATE_LIMIT_WINDOW_MS - (nowMs - oldest)),
        limit: RATE_LIMIT_MAX,
        window_ms: RATE_LIMIT_WINDOW_MS,
      },
    };
  }
  retained.push(nowMs);
  senderWindows.set(sender, retained);
  return null;
}

function gasSpentMist(gasUsed: GasUsed | undefined): bigint {
  if (!gasUsed) return 0n;
  const computation = BigInt(gasUsed.computationCost ?? "0");
  const storage = BigInt(gasUsed.storageCost ?? "0");
  const rebate = BigInt(gasUsed.storageRebate ?? "0");
  const nonRefundable = BigInt(gasUsed.nonRefundableStorageFee ?? "0");
  const spent = computation + storage + nonRefundable - rebate;
  return spent > 0n ? spent : 0n;
}

export async function handle(rawBody: unknown, deps: SponsorDeps = {}): Promise<JsonResponse> {
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { status: 400, body: { error: "body must be a JSON object" } };
  }
  const body = rawBody as Record<string, unknown>;

  const senderRaw = body.sender;
  if (typeof senderRaw !== "string") {
    return { status: 400, body: { error: "sender must be a string" } };
  }
  if (!isValidSuiAddress(senderRaw)) {
    return { status: 400, body: { error: "sender is not a valid Sui address" } };
  }
  const sender = normalizeSuiAddress(senderRaw);

  const txBytesDecoded = decodeBase64Field(body.txBytes, "txBytes");
  if (typeof txBytesDecoded === "string") {
    return { status: 400, body: { error: txBytesDecoded } };
  }

  const userSigDecoded = decodeBase64Field(body.userSig, "userSig");
  if (typeof userSigDecoded === "string") {
    return { status: 400, body: { error: userSigDecoded } };
  }
  const userSig = (body.userSig as string).trim();

  const nowMs = (deps.nowMs ?? Date.now)();
  resetDailySpendIfNeeded(nowMs);

  let client: SuiJsonRpcClient;
  let v3PackageId: string;
  try {
    client = (deps.getClient ?? getClient)();
    v3PackageId = normalizeSuiAddress((deps.getV3PackageId ?? getV3PackageId)());
  } catch (err) {
    console.error("[api/sponsor] allowlist config failed", { error: String(err) });
    return { status: 503, body: { error: "sponsor allowlist is not configured" } };
  }

  const inspection = await inspectSponsoredTx(
    txBytesDecoded,
    sender,
    client,
    v3PackageId,
    deps.lookupObjectType ?? lookupObjectType,
  );
  if (typeof inspection === "string") {
    return { status: 403, body: { error: inspection } };
  }

  let sponsor: SponsorSigner;
  try {
    sponsor = (deps.getSponsor ?? getSponsor)();
  } catch (err) {
    console.error("[api/sponsor] keypair load failed", { error: String(err) });
    return { status: 503, body: { error: "sponsor wallet is not configured" } };
  }

  const sponsorAddress = normalizeSuiAddress(sponsor.address);
  if (inspection.gasOwner !== sponsorAddress) {
    return { status: 403, body: { error: "transaction gas owner must be the sponsor address" } };
  }

  const rateLimit = checkAndStampRateLimit(sender, nowMs);
  if (rateLimit) return rateLimit;

  let dailyCapMist: bigint;
  try {
    dailyCapMist = (deps.getDailyCapMist ?? getDailyCapMist)();
  } catch (err) {
    console.error("[api/sponsor] daily cap config failed", { error: String(err) });
    return { status: 503, body: { error: "sponsor daily cap is not configured" } };
  }
  if (spendTodayMist >= dailyCapMist) {
    return {
      status: 503,
      body: {
        error: "sponsor daily spend cap reached",
        spend_today_mist: spendTodayMist.toString(),
        cap_mist: dailyCapMist.toString(),
      },
    };
  }

  try {
    const sponsorSigned = await sponsor.keypair.signTransaction(txBytesDecoded);
    const result = await (deps.executeTransactionBlock ?? executeTransactionBlock)(client, txBytesDecoded, [
      userSig,
      sponsorSigned.signature,
    ]);

    spendTodayMist += gasSpentMist(result.effects?.gasUsed);

    const status = result.effects?.status?.status;
    if (status !== "success") {
      console.error("[api/sponsor] tx failed onchain", {
        digest: result.digest,
        status,
        err: result.effects?.status?.error,
      });
      return {
        status: 503,
        body: {
          error: "transaction did not succeed on-chain",
          digest: result.digest,
        },
      };
    }

    console.log("[api/sponsor] sponsored tx ok", {
      sender,
      digest: result.digest,
      function: inspection.functionName,
      market: inspection.marketId,
      gas_spent_mist: gasSpentMist(result.effects?.gasUsed).toString(),
      spend_today_mist: spendTodayMist.toString(),
    });
    return { status: 200, body: { digest: result.digest } };
  } catch (err) {
    console.error("[api/sponsor] executeTransactionBlock threw", { error: String(err) });
    return { status: 503, body: { error: "sponsored transaction failed, try again" } };
  }
}

export function resetSponsorStateForTests(): void {
  senderWindows.clear();
  spendTodayMist = 0n;
  spendDayKey = utcDayKey(Date.now());
  cachedClient = null;
  cachedKeypair = null;
  cachedSponsorAddress = null;
  cachedV3PackageId = null;
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
