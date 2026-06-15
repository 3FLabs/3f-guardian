import {
  noopLogger,
  zIntentFundBindingBody,
  zIntentRequestBindingBody,
  zIntentSwapBody,
  zSigningSuccess,
  type GuardianAbstractions,
  type IntentFundBindingBody,
  type IntentRequestBindingBody,
  type IntentSwapBody,
  type SigningContext,
  type SigningSuccess,
} from "@3flabs/guardian";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SIGN_TIMEOUT_MS = 6_000;
const TOKEN_ID = "guardian-coordinator";

type SigningKind = "set_request" | "set_fund" | "swap";
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CoordinatorLogger = Pick<Console, "error" | "log">;
export type CoordinatorGuardian = Pick<
  GuardianAbstractions,
  | "metadata"
  | "logger"
  | "getChainClient"
  | "signTypedData"
  | "probeUpstream"
  | "timeouts"
  | "signIntentRequestBinding"
  | "signIntentFundBinding"
  | "signIntentSwap"
>;

export type CoordinatorConnectionConfig = {
  coordinatorBaseUrl: string;
  coordinatorApiKey: string;
  pollIntervalMs: number;
  pageSize: number;
  chainIds?: Set<number>;
  facilities?: Set<string>;
};

export type GuardianCoordinatorOptions = CoordinatorConnectionConfig & {
  guardian: CoordinatorGuardian;
  fetcher?: FetchLike;
  logger?: CoordinatorLogger;
};

export type SigningRequest = {
  id: string;
  kind: SigningKind;
  chainId: number;
  facility: string;
  payloadHash: string;
  body: unknown;
  mySubmission: unknown | null;
};

export type RunSummary = {
  seen: number;
  submitted: number;
  skipped: number;
  failed: number;
};

type SigningRequestPage = {
  total: number;
  page: number;
  pageSize: number;
  items: SigningRequest[];
};

type ParsedSigningBody =
  | { kind: "set_request"; body: IntentRequestBindingBody }
  | { kind: "set_fund"; body: IntentFundBindingBody }
  | { kind: "swap"; body: IntentSwapBody };

class HttpError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(`${method} ${url} failed with ${status}`);
  }
}

export function loadCoordinatorConfig(
  env: Record<string, string | undefined> = process.env,
): CoordinatorConnectionConfig {
  return {
    coordinatorBaseUrl: baseUrl(required(env, "COORDINATOR_BASE_URL")),
    coordinatorApiKey: required(env, "COORDINATOR_API_KEY"),
    pollIntervalMs: positiveInt(env.POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    pageSize: positiveInt(env.PAGE_SIZE, DEFAULT_PAGE_SIZE),
    chainIds: numberSet(env.CHAIN_IDS),
    facilities: stringSet(env.FACILITIES),
  };
}

export async function runGuardianCoordinator(options: GuardianCoordinatorOptions): Promise<void> {
  for (;;) {
    await runGuardianCoordinatorOnce(options);
    await sleep(options.pollIntervalMs);
  }
}

export async function runGuardianCoordinatorOnce(
  options: GuardianCoordinatorOptions,
): Promise<RunSummary> {
  const fetcher = options.fetcher ?? fetch;
  const logger = options.logger ?? console;
  const summary: RunSummary = { seen: 0, submitted: 0, skipped: 0, failed: 0 };

  for (let page = 1; ; page++) {
    const requests = await listSigningRequests(options, fetcher, page);
    summary.seen += requests.items.length;

    for (const request of requests.items) {
      if (!shouldHandle(options, request)) {
        summary.skipped++;
        continue;
      }

      try {
        const signed = await signWithGuardian(options.guardian, request);
        await submitSignature(options, request, signed, fetcher);
        summary.submitted++;
        logger.log(`submitted guardian signature for ${request.id}`);
      } catch (error) {
        summary.failed++;
        logger.error(`failed guardian signing request ${request.id}: ${errorMessage(error)}`);
      }
    }

    if (requests.items.length === 0 || page * requests.pageSize >= requests.total) break;
  }

  return summary;
}

async function listSigningRequests(
  config: CoordinatorConnectionConfig,
  fetcher: FetchLike,
  page: number,
): Promise<SigningRequestPage> {
  const url = new URL(joinUrl(config.coordinatorBaseUrl, "/v1/guardian/signing-requests"));
  url.searchParams.set("status", "open");
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(config.pageSize));

  const body = await requestJson(fetcher, "GET", url.toString(), {
    headers: { "x-api-key": config.coordinatorApiKey },
  });

  return parseSigningRequestPage(body);
}

async function signWithGuardian(
  guardian: CoordinatorGuardian,
  request: SigningRequest,
): Promise<SigningSuccess> {
  const parsed = parseSigningBody(request);
  const upstream = guardian.probeUpstream?.();
  if (upstream?.isErr()) throw upstream.error;

  const chainClient = guardian.getChainClient(parsed.body.chainId);
  if (chainClient.isErr()) throw chainClient.error;

  const requestId = crypto.randomUUID();
  const signLogger = (guardian.logger ?? noopLogger).child({
    requestId,
    tokenId: TOKEN_ID,
    chainId: parsed.body.chainId,
  });
  const ctxBase = {
    chainId: parsed.body.chainId,
    client: chainClient.value,
    requestId,
    tokenId: TOKEN_ID,
    now: new Date(),
    signTypedData: guardian.signTypedData,
    logger: signLogger,
  };

  const result = await withSignTimeout(
    guardian.timeouts?.signMs ?? DEFAULT_SIGN_TIMEOUT_MS,
    (signal) => signParsedBody(guardian, { ...ctxBase, signal }, parsed),
  );
  if (result.isErr()) throw result.error;

  const signed = zSigningSuccess.parse(result.value);
  if (signed.payloadHash.toLowerCase() !== request.payloadHash.toLowerCase()) {
    throw new Error(
      `payloadHash mismatch: signer returned ${signed.payloadHash}, coordinator expected ${request.payloadHash}`,
    );
  }
  if (signed.guardian.toLowerCase() !== guardian.metadata.guardianSigner.toLowerCase()) {
    throw new Error(
      `guardian mismatch: signer returned ${signed.guardian}, expected ${guardian.metadata.guardianSigner}`,
    );
  }

  return signed;
}

function signParsedBody(
  guardian: CoordinatorGuardian,
  ctx: SigningContext,
  parsed: ParsedSigningBody,
) {
  switch (parsed.kind) {
    case "set_request":
      return guardian.signIntentRequestBinding(ctx, parsed.body);
    case "set_fund":
      return guardian.signIntentFundBinding(ctx, parsed.body);
    case "swap":
      return guardian.signIntentSwap(ctx, parsed.body);
  }
}

async function submitSignature(
  config: CoordinatorConnectionConfig,
  request: SigningRequest,
  signed: SigningSuccess,
  fetcher: FetchLike,
): Promise<void> {
  await requestJson(
    fetcher,
    "PUT",
    joinUrl(config.coordinatorBaseUrl, `/v1/guardian/signing-requests/${request.id}/submission`),
    {
      headers: {
        "content-type": "application/json",
        "x-api-key": config.coordinatorApiKey,
      },
      body: JSON.stringify({ chainId: request.chainId, signature: signed.signature }),
    },
  );
}

function shouldHandle(config: CoordinatorConnectionConfig, request: SigningRequest): boolean {
  if (request.mySubmission !== null) return false;
  if (config.chainIds && !config.chainIds.has(request.chainId)) return false;
  if (config.facilities && !config.facilities.has(request.facility.toLowerCase())) return false;
  return true;
}

function parseSigningBody(request: SigningRequest): ParsedSigningBody {
  switch (request.kind) {
    case "set_request":
      return { kind: request.kind, body: zIntentRequestBindingBody.parse(request.body) };
    case "set_fund":
      return { kind: request.kind, body: zIntentFundBindingBody.parse(request.body) };
    case "swap":
      return { kind: request.kind, body: zIntentSwapBody.parse(request.body) };
  }
}

async function withSignTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`guardian coordinator signing timed out after ${ms}ms`));
      reject(new Error(`guardian coordinator signing timed out after ${ms}ms`));
    }, ms);
  });
  const task = run(controller.signal);
  task.catch(() => {});
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(
  fetcher: FetchLike,
  method: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetcher(url, { ...init, method });
  const text = await response.text();
  const body = text.length > 0 ? parseJson(text) : null;
  if (!response.ok) throw new HttpError(method, url, response.status, body);
  return body;
}

function parseSigningRequestPage(body: unknown): SigningRequestPage {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error("coordinator list response is not a signing-request page");
  }

  return {
    total: numberField(body, "total"),
    page: numberField(body, "page"),
    pageSize: numberField(body, "pageSize"),
    items: body.items.map(parseSigningRequest),
  };
}

function parseSigningRequest(value: unknown): SigningRequest {
  if (!isRecord(value)) throw new Error("coordinator signing request is not an object");

  const kind = stringField(value, "kind");

  return {
    id: stringField(value, "id"),
    kind: signingKind(kind),
    chainId: numberField(value, "chainId"),
    facility: stringField(value, "facility"),
    payloadHash: stringField(value, "payloadHash"),
    body: value.body,
    mySubmission: value.mySubmission ?? null,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    return `${error.message}: ${JSON.stringify(error.responseBody)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function baseUrl(value: string): string {
  return new URL(value).toString().replace(/\/+$/, "");
}

function joinUrl(base: string, path: string): string {
  return `${base}${path}`;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`expected positive integer: ${value}`);
  return parsed;
}

function numberSet(value: string | undefined): Set<number> | undefined {
  if (!value?.trim()) return undefined;
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => positiveInt(part.trim(), 0));
  if (parsed.length === 0) return undefined;
  return new Set(parsed);
}

function stringSet(value: string | undefined): Set<string> | undefined {
  if (!value?.trim()) return undefined;
  return new Set(
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`expected string field ${key}`);
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`expected number field ${key}`);
  return value;
}

function signingKind(value: string): SigningKind {
  if (value === "set_request" || value === "set_fund" || value === "swap") return value;
  throw new Error(`unsupported signing kind: ${value}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
