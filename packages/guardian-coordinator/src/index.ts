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
  type SigningSuccess,
} from "@3flabs/guardian";
import { z } from "zod";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_SIGN_TIMEOUT_MS = 6_000;
const TOKEN_ID = "guardian-coordinator";

const zSigningKind = z.enum(["set_request", "set_fund", "swap"]);

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

type ParsedSigningBody =
  | { kind: "set_request"; body: IntentRequestBindingBody }
  | { kind: "set_fund"; body: IntentFundBindingBody }
  | { kind: "swap"; body: IntentSwapBody };

const zSigningRequest = z
  .object({
    id: z.string(),
    kind: zSigningKind,
    chainId: z.number(),
    facility: z.string(),
    payloadHash: z.string(),
    body: z.unknown(),
    mySubmission: z.unknown().nullable().optional(),
  })
  .transform((request) => ({
    ...request,
    mySubmission: request.mySubmission ?? null,
  }));

const zSigningRequestPage = z.object({
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  items: z.array(z.unknown()),
});

export type SigningRequest = z.infer<typeof zSigningRequest>;

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
  const logger = options.logger ?? console;
  for (;;) {
    try {
      await runGuardianCoordinatorOnce(options);
    } catch (error) {
      logger.error(
        `guardian coordinator poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await sleep(options.pollIntervalMs);
  }
}

export async function runGuardianCoordinatorOnce(
  options: GuardianCoordinatorOptions,
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const logger = options.logger ?? console;

  for (const filter of pollFilters(options)) {
    for (let page = 1; ; page++) {
      const url = new URL(`${options.coordinatorBaseUrl}/v1/guardian/signing-requests`);
      url.searchParams.set("status", "open");
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(options.pageSize));
      if (filter.chainId !== undefined) url.searchParams.set("chainId", String(filter.chainId));
      if (filter.facility !== undefined) url.searchParams.set("facility", filter.facility);

      const requests = zSigningRequestPage.parse(
        await requestJson(fetcher, "GET", url.toString(), {
          headers: { "x-api-key": options.coordinatorApiKey },
        }),
      );

      for (const item of requests.items) {
        const row = zSigningRequest.safeParse(item);
        if (!row.success) {
          logger.error(`skipping malformed guardian signing request: ${row.error.message}`);
          continue;
        }
        const request = row.data;

        if (request.mySubmission !== null) {
          continue;
        }

        try {
          const parsed = parseSigningBody(request);
          if (request.chainId !== parsed.body.chainId) {
            throw new Error(
              `chainId mismatch: request ${request.chainId}, body ${parsed.body.chainId}`,
            );
          }
          if (request.facility.toLowerCase() !== parsed.body.facility.toLowerCase()) {
            throw new Error(
              `facility mismatch: request ${request.facility}, body ${parsed.body.facility}`,
            );
          }
          if (
            (options.chainIds && !options.chainIds.has(parsed.body.chainId)) ||
            (options.facilities && !options.facilities.has(parsed.body.facility.toLowerCase()))
          ) {
            continue;
          }

          const signed = await signWithGuardian(options.guardian, request, parsed);
          await requestJson(
            fetcher,
            "PUT",
            `${options.coordinatorBaseUrl}/v1/guardian/signing-requests/${request.id}/submission`,
            {
              headers: {
                "content-type": "application/json",
                "x-api-key": options.coordinatorApiKey,
              },
              body: JSON.stringify({ chainId: parsed.body.chainId, signature: signed.signature }),
            },
          );
          logger.log(`submitted guardian signature for ${request.id}`);
        } catch (error) {
          logger.error(
            `failed guardian signing request ${request.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (requests.items.length === 0 || page * requests.pageSize >= requests.total) break;
    }
  }
}

async function signWithGuardian(
  guardian: CoordinatorGuardian,
  request: SigningRequest,
  parsed: ParsedSigningBody,
): Promise<SigningSuccess> {
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
    (signal) => {
      const ctx = { ...ctxBase, signal };
      switch (parsed.kind) {
        case "set_request":
          return guardian.signIntentRequestBinding(ctx, parsed.body);
        case "set_fund":
          return guardian.signIntentFundBinding(ctx, parsed.body);
        case "swap":
          return guardian.signIntentSwap(ctx, parsed.body);
      }
    },
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
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok)
    throw new Error(`${method} ${url} failed with ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

export function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function baseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("COORDINATOR_BASE_URL must use https unless it points at localhost");
  }
  return url.toString().replace(/\/+$/, "");
}

export function positiveInt(value: string | undefined, fallback: number): number {
  const raw = value?.trim() || String(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`expected positive integer: ${raw}`);
  return parsed;
}

function pollFilters(
  options: GuardianCoordinatorOptions,
): Array<{ chainId?: number; facility?: string }> {
  const chainIds = options.chainIds?.size ? [...options.chainIds] : [undefined];
  const facilities = options.facilities?.size ? [...options.facilities] : [undefined];
  return chainIds.flatMap((chainId) => facilities.map((facility) => ({ chainId, facility })));
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127.")
  );
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
  const parsed = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parsed.length === 0) return undefined;
  return new Set(parsed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
