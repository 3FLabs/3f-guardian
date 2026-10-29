import {
  noopLogger,
  runSigning,
  UpstreamUnavailableError,
  zIntentFundBindingBody,
  zIntentRequestBindingBody,
  zIntentSwapBody,
  zRequestWhitelistingBody,
  zRequestWhitelistingResponse,
  zSigningSuccess,
  type GuardianAbstractions,
  type IntentFundBindingBody,
  type IntentRequestBindingBody,
  type IntentSwapBody,
  type RequestWhitelistingBody,
  type SigningSuccess,
  type TokenInfo,
} from "@3flabs/guardian";
import { z } from "zod";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_ID = "guardian-coordinator";
const TOKEN_INFO = {
  tokenId: TOKEN_ID,
  scopes: new Set(),
  requiresHmac: false,
} satisfies TokenInfo;

// The 503 runSigning raises when the signMs deadline fires
// (withAbstractionDeadline in @3flabs/guardian).
const SIGN_TIMEOUT = /^sign did not complete within \d+ms$/;

/**
 * Sign-deadline hits per signing request, per guardian. A request that
 * hits the deadline on every poll holds every request behind it for a
 * full budget each time, so after {@link SIGN_TIMEOUTS_BEFORE_GIVING_UP}
 * the coordinator gives up on it for the life of the process. One hit is
 * retried on the next poll: a cold KMS client or one slow RPC call can
 * outlast the budget once. grunt-api has no rejection endpoint: a request
 * given up on stays unsigned until its deadline.
 */
// ponytail: never pruned; one UUID per timed-out request, prune against the open list if that grows.
const signTimeouts = new WeakMap<CoordinatorGuardian, Map<string, number>>();
const SIGN_TIMEOUTS_BEFORE_GIVING_UP = 2;

const zSigningKind = z.enum(["set_request", "set_fund", "swap", "request_whitelisting"]);

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
> & {
  signRequestWhitelisting?: GuardianAbstractions["signRequestWhitelisting"];
  whitelistNonceCandidates?: (body: RequestWhitelistingBody) => Promise<string[]>;
};

export type CoordinatorConnectionConfig = {
  coordinatorBaseUrl: string;
  coordinatorApiKey: string;
  pollIntervalMs: number;
  pageSize: number;
  chainIds?: Set<number>;
  facilities?: Set<string>;
  requestTimeoutMs?: number;
};

export type GuardianCoordinatorOptions = CoordinatorConnectionConfig & {
  guardian: CoordinatorGuardian;
  fetcher?: FetchLike;
  logger?: CoordinatorLogger;
};

type ParsedSigningBody =
  | { kind: "set_request"; body: IntentRequestBindingBody }
  | { kind: "set_fund"; body: IntentFundBindingBody }
  | { kind: "swap"; body: IntentSwapBody }
  | { kind: "request_whitelisting"; body: RequestWhitelistingBody };

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
    requestTimeoutMs: positiveInt(env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    chainIds: numberSet(env.CHAIN_IDS),
    facilities: stringSet(env.FACILITIES),
  };
}

export type PollCycleStats = {
  fetched: number;
  signed: number;
  skipped: number;
  failed: number;
};

export async function runGuardianCoordinator(options: GuardianCoordinatorOptions): Promise<void> {
  for (;;) {
    await runGuardianCoordinatorCycle(options);
    await sleep(options.pollIntervalMs);
  }
}

/**
 * One poll cycle plus its heartbeat line. The heartbeat is emitted even
 * when the poll throws (`ok: false`): it signals the loop is alive, not
 * that it succeeded, so a missing-heartbeat alert fires only when the
 * process is dead or wedged. The serialized shape is a monitoring
 * contract pinned by a test — do not change it casually.
 */
export async function runGuardianCoordinatorCycle(
  options: GuardianCoordinatorOptions,
): Promise<PollCycleStats> {
  const logger = options.logger ?? console;
  const startedAt = Date.now();
  const stats: PollCycleStats = { fetched: 0, signed: 0, skipped: 0, failed: 0 };
  let ok = true;
  try {
    await runGuardianCoordinatorOnce(options, stats);
  } catch (error) {
    ok = false;
    logger.error(
      `guardian coordinator poll failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  logger.log(
    JSON.stringify({
      level: "info",
      event: "guardian.heartbeat",
      ok,
      ...stats,
      durationMs: Date.now() - startedAt,
    }),
  );
  return stats;
}

export async function runGuardianCoordinatorOnce(
  options: GuardianCoordinatorOptions,
  stats: PollCycleStats = { fetched: 0, signed: 0, skipped: 0, failed: 0 },
): Promise<PollCycleStats> {
  const fetcher = options.fetcher ?? fetch;
  const logger = options.logger ?? console;
  const timeouts = signTimeouts.get(options.guardian) ?? new Map<string, number>();
  signTimeouts.set(options.guardian, timeouts);

  for (const filter of pollFilters(options)) {
    for (let page = 1; ; page++) {
      const url = new URL(`${apiRoot(options.coordinatorBaseUrl)}/guardian/signing-requests`);
      url.searchParams.set("status", "open");
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(options.pageSize));
      if (filter.chainId !== undefined) url.searchParams.set("chainId", String(filter.chainId));
      if (filter.facility !== undefined) url.searchParams.set("facility", filter.facility);

      const requests = zSigningRequestPage.parse(
        await requestJson(
          fetcher,
          "GET",
          url.toString(),
          { headers: { "x-api-key": options.coordinatorApiKey } },
          options.requestTimeoutMs,
        ),
      );
      stats.fetched += requests.items.length;

      for (const item of requests.items) {
        const row = zSigningRequest.safeParse(item);
        if (!row.success) {
          stats.failed++;
          logger.error(`skipping malformed guardian signing request: ${row.error.message}`);
          continue;
        }
        const request = row.data;

        if (
          request.mySubmission !== null ||
          (timeouts.get(request.id) ?? 0) >= SIGN_TIMEOUTS_BEFORE_GIVING_UP
        ) {
          stats.skipped++;
          continue;
        }

        try {
          const parsed = parseSigningBody(request);
          if (request.chainId !== parsed.body.chainId) {
            throw new Error(
              `chainId mismatch: request ${request.chainId}, body ${parsed.body.chainId}`,
            );
          }
          const target = requestTarget(parsed);
          if (request.facility.toLowerCase() !== target.address.toLowerCase()) {
            throw new Error(
              `${target.field} mismatch: request ${request.facility}, body ${target.address}`,
            );
          }
          if (
            (options.chainIds && !options.chainIds.has(parsed.body.chainId)) ||
            (options.facilities && !options.facilities.has(target.address.toLowerCase()))
          ) {
            stats.skipped++;
            continue;
          }

          const independentNonce =
            parsed.kind === "request_whitelisting" &&
            !("nonce" in (request.body as Record<string, unknown>));
          if (independentNonce && parsed.kind === "request_whitelisting") {
            if (!options.guardian.whitelistNonceCandidates)
              throw new Error("Independent whitelist nonces are not configured");
            const candidates = await options.guardian.whitelistNonceCandidates(parsed.body);
            if (!candidates.length) {
              stats.skipped++;
              continue;
            }
            const reserved = z
              .object({
                nonce: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
                payloadHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
              })
              .parse(
                await requestJson(
                  fetcher,
                  "PUT",
                  `${apiRoot(options.coordinatorBaseUrl)}/guardian/signing-requests/${request.id}/nonce`,
                  {
                    headers: {
                      "content-type": "application/json",
                      "x-api-key": options.coordinatorApiKey,
                    },
                    body: JSON.stringify({ candidates }),
                  },
                  options.requestTimeoutMs,
                ),
              );
            if (!candidates.includes(reserved.nonce))
              throw new Error(
                "Reserved whitelist nonce is no longer available in this validator's window",
              );
            parsed.body.nonce = reserved.nonce;
            request.payloadHash = reserved.payloadHash;
          }
          const signed = await signWithGuardian(options.guardian, request, parsed);
          await requestJson(
            fetcher,
            "PUT",
            `${apiRoot(options.coordinatorBaseUrl)}/guardian/signing-requests/${request.id}/submission`,
            {
              headers: {
                "content-type": "application/json",
                "x-api-key": options.coordinatorApiKey,
              },
              body: JSON.stringify({
                chainId: parsed.body.chainId,
                signature: signed.signature,
                ...(independentNonce && parsed.kind === "request_whitelisting"
                  ? { nonce: parsed.body.nonce }
                  : {}),
              }),
            },
            options.requestTimeoutMs,
          );
          stats.signed++;
          logger.log(`submitted guardian signature for ${request.id}`);
        } catch (error) {
          stats.failed++;
          const message = error instanceof Error ? error.message : String(error);
          let gaveUp = false;
          if (error instanceof UpstreamUnavailableError && SIGN_TIMEOUT.test(message)) {
            const hits = (timeouts.get(request.id) ?? 0) + 1;
            timeouts.set(request.id, hits);
            gaveUp = hits >= SIGN_TIMEOUTS_BEFORE_GIVING_UP;
          }
          logger.error(
            `failed guardian signing request ${request.id}: ${message}${gaveUp ? "; not retrying it" : ""}`,
          );
        }
      }

      if (requests.items.length === 0 || page * requests.pageSize >= requests.total) break;
    }
  }
  return stats;
}

async function signWithGuardian(
  guardian: CoordinatorGuardian,
  request: SigningRequest,
  parsed: ParsedSigningBody,
): Promise<SigningSuccess> {
  const requestId = crypto.randomUUID();
  const logger = (guardian.logger ?? noopLogger).child({
    requestId,
    tokenId: TOKEN_ID,
  });

  const args = {
    abs: guardian,
    requestId,
    tokenInfo: TOKEN_INFO,
    logger,
  };
  const signed = await (async () => {
    switch (parsed.kind) {
      case "set_request":
        return runSigning({ ...args, sign: guardian.signIntentRequestBinding, body: parsed.body });
      case "set_fund":
        return runSigning({ ...args, sign: guardian.signIntentFundBinding, body: parsed.body });
      case "swap":
        return runSigning({ ...args, sign: guardian.signIntentSwap, body: parsed.body });
      case "request_whitelisting":
        if (!guardian.signRequestWhitelisting) {
          throw new Error("request_whitelisting signing requires signRequestWhitelisting support");
        }
        return runSigning({ ...args, sign: guardian.signRequestWhitelisting, body: parsed.body });
    }
  })();

  const checked =
    parsed.kind === "request_whitelisting"
      ? zRequestWhitelistingResponse.parse(signed)
      : zSigningSuccess.parse(signed);
  if (checked.payloadHash.toLowerCase() !== request.payloadHash.toLowerCase()) {
    throw new Error(
      `payloadHash mismatch: signer returned ${checked.payloadHash}, coordinator expected ${request.payloadHash}`,
    );
  }
  if (checked.guardian.toLowerCase() !== guardian.metadata.guardianSigner.toLowerCase()) {
    throw new Error(
      `guardian mismatch: signer returned ${checked.guardian}, expected ${guardian.metadata.guardianSigner}`,
    );
  }

  return checked;
}

function parseSigningBody(request: SigningRequest): ParsedSigningBody {
  switch (request.kind) {
    case "set_request":
      return { kind: request.kind, body: zIntentRequestBindingBody.parse(request.body) };
    case "set_fund":
      return { kind: request.kind, body: zIntentFundBindingBody.parse(request.body) };
    case "swap":
      return { kind: request.kind, body: zIntentSwapBody.parse(request.body) };
    case "request_whitelisting":
      return {
        kind: request.kind,
        body: zRequestWhitelistingBody.parse(
          request.body !== null && typeof request.body === "object" && !("nonce" in request.body)
            ? { ...request.body, nonce: "0" }
            : request.body,
        ),
      };
  }
}

function requestTarget(parsed: ParsedSigningBody): {
  field: "facility" | "whitelistBook";
  address: string;
} {
  return parsed.kind === "request_whitelisting"
    ? { field: "whitelistBook", address: parsed.body.whitelistBook }
    : { field: "facility", address: parsed.body.facility };
}

async function requestJson(
  fetcher: FetchLike,
  method: string,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    method,
    signal: AbortSignal.timeout(timeoutMs),
  });
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

// A bare host is the legacy root, whose API lives under /v1; a base URL with a path is a gateway
// route prefix such as /v2/chains/<id>, which the gateway rewrites to /v1.
function apiRoot(coordinatorBaseUrl: string): string {
  return new URL(coordinatorBaseUrl).pathname === "/"
    ? `${coordinatorBaseUrl}/v1`
    : coordinatorBaseUrl;
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
  const ipv4 = host.split(".");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    (ipv4.length === 4 &&
      ipv4[0] === "127" &&
      ipv4.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255))
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
