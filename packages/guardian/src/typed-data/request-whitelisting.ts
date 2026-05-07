import { hashTypedData, type Address, type TypedDataDefinition } from "viem";

import type { RequestWhitelistingBody } from "../schemas/request-whitelisting.js";
import type { Eip712Domain, GuardianTypedData } from "./types.js";

/**
 * §A.4 / §7.6 — the request-whitelist contract's whitelist /
 * unwhitelist typed-data structs.
 *
 * Mirrors `_WHITELIST_TYPEHASH` and `_UNWHITELIST_TYPEHASH` in
 * `3f-request-whitelist/src/RequestWhitelist.sol`:
 *
 *   keccak256("WhitelistRequest(address[] targets,uint256 deadline,address validator,uint256 nonce)")
 *   keccak256("UnwhitelistRequest(address[] targets,uint256 deadline,address validator,uint256 nonce)")
 *
 * The contract's per-validator struct hash is
 * `keccak256(abi.encode(TYPEHASH, keccak256(targets), deadline, validator, nonce))`,
 * which viem's `hashTypedData` reproduces identically — the `address[]`
 * member is encoded as `keccak256` over each element's left-padded
 * 32-byte word, matching `_hashAddressArray`'s `calldatacopy`-then-
 * `keccak256` of the calldata layout.
 *
 * `validator` is the Guardian's signer address — the value whose
 * nonce floor and consumed-bitmap §A.4 reads on-chain. The §7.6.1
 * response also exposes it as `address` for caller convenience.
 */
const sharedFields = [
  { name: "targets", type: "address[]" },
  { name: "deadline", type: "uint256" },
  { name: "validator", type: "address" },
  { name: "nonce", type: "uint256" },
] as const;

export const whitelistRequestTypes = {
  WhitelistRequest: sharedFields,
} as const;

export const unwhitelistRequestTypes = {
  UnwhitelistRequest: sharedFields,
} as const;

type WhitelistTypedData = TypedDataDefinition<typeof whitelistRequestTypes, "WhitelistRequest">;
type UnwhitelistTypedData = TypedDataDefinition<
  typeof unwhitelistRequestTypes,
  "UnwhitelistRequest"
>;

export type WhitelistRequestTypedData = GuardianTypedData<
  typeof whitelistRequestTypes,
  "WhitelistRequest"
>;
export type UnwhitelistRequestTypedData = GuardianTypedData<
  typeof unwhitelistRequestTypes,
  "UnwhitelistRequest"
>;

type SharedArgs = {
  domain: Eip712Domain;
  body: Omit<RequestWhitelistingBody, "operation">;
  validator: Address;
};

/**
 * Builds the EIP-712 typed-data payload for `operation = "whitelist"`.
 * `domain.verifyingContract` MUST equal `body.whitelistBook`.
 */
export function buildWhitelistRequestTypedData(args: SharedArgs): WhitelistRequestTypedData {
  const { domain, body, validator } = args;
  const typedData: WhitelistTypedData = {
    domain: domainOf(domain),
    types: whitelistRequestTypes,
    primaryType: "WhitelistRequest",
    message: messageOf(body, validator),
  };
  return { typedData, payloadHash: hashTypedData(typedData) };
}

/**
 * Builds the EIP-712 typed-data payload for `operation = "unwhitelist"`.
 * `domain.verifyingContract` MUST equal `body.whitelistBook`.
 */
export function buildUnwhitelistRequestTypedData(args: SharedArgs): UnwhitelistRequestTypedData {
  const { domain, body, validator } = args;
  const typedData: UnwhitelistTypedData = {
    domain: domainOf(domain),
    types: unwhitelistRequestTypes,
    primaryType: "UnwhitelistRequest",
    message: messageOf(body, validator),
  };
  return { typedData, payloadHash: hashTypedData(typedData) };
}

/**
 * Convenience switch on `body.operation` — useful for tests; the
 * sign-runner orchestrator branches by operation directly so it can
 * hand a concrete (non-union) typed-data to `ctx.signTypedData`
 * without TypeScript balking on the generic.
 */
export function buildRequestWhitelistingTypedData(args: {
  domain: Eip712Domain;
  body: RequestWhitelistingBody;
  validator: Address;
}): WhitelistRequestTypedData | UnwhitelistRequestTypedData {
  const { domain, body, validator } = args;
  const { operation, ...rest } = body;
  return operation === "whitelist"
    ? buildWhitelistRequestTypedData({ domain, body: rest, validator })
    : buildUnwhitelistRequestTypedData({ domain, body: rest, validator });
}

function domainOf(domain: Eip712Domain) {
  return {
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
  };
}

function messageOf(body: Omit<RequestWhitelistingBody, "operation">, validator: Address) {
  return {
    targets: body.requestContracts,
    deadline: BigInt(body.deadline),
    validator,
    nonce: BigInt(body.nonce),
  };
}
