import type { Address, Hex, TypedData, TypedDataDefinition } from "viem";

import type { Eip712DomainNameVersion } from "../lib/eip712-domain.js";

/**
 * Full EIP-712 domain expected by viem's `TypedDataDefinition`.
 *
 * `name` / `version` come from the verifying contract via ERC-5267
 * (see {@link fetchEip712DomainNameVersion}); `chainId` and
 * `verifyingContract` are already known to the request-bound code path.
 */
export type Eip712Domain = Eip712DomainNameVersion & {
  readonly chainId: number;
  readonly verifyingContract: Address;
};

/**
 * Wraps a viem `TypedDataDefinition` together with the EIP-712 digest
 * the host must echo as `payloadHash` (§6.4) so callers can cross-check
 * the binding without re-hashing themselves.
 *
 *  - `typedData` is what the host MUST hand to {@link SignTypedData}.
 *  - `payloadHash` MUST equal `hashTypedData(typedData)` and the on-
 *    chain `_hashTypedData(structHash)` value the verifier recomputes.
 */
export type GuardianTypedData<
  TTypes extends TypedData | Record<string, unknown> = TypedData,
  TPrimaryType extends keyof TTypes | "EIP712Domain" = keyof TTypes,
> = {
  readonly typedData: TypedDataDefinition<TTypes, TPrimaryType>;
  readonly payloadHash: Hex;
};
