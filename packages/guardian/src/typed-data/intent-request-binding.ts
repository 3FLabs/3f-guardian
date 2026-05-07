import { hashTypedData, type TypedDataDefinition } from "viem";

import type { IntentRequestBindingBody } from "../schemas/intent-request-binding.js";
import type { Eip712Domain, GuardianTypedData } from "./types.js";

/**
 * §A.1 / §7.3 — the facility's `setRequest` typed-data struct.
 *
 * Mirrors `SET_REQUEST_PARAMS_TYPEHASH` in
 * `grunt/src/facility/base/FacilityIntents.sol`:
 *
 *   keccak256("SetRequestParams(uint256 id,address newRequest,uint256 deadline)")
 *
 * The on-chain verifier hashes
 * `_hashTypedData(keccak256(abi.encode(TYPEHASH, id, newRequest, deadline)))`,
 * which viem's `hashTypedData` reproduces exactly given this `types`
 * object and `primaryType: "SetRequestParams"`.
 */
export const setRequestParamsTypes = {
  SetRequestParams: [
    { name: "id", type: "uint256" },
    { name: "newRequest", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

type SetRequestParamsTypedData = TypedDataDefinition<
  typeof setRequestParamsTypes,
  "SetRequestParams"
>;

/**
 * Builds the EIP-712 typed-data payload for §7.3
 * `intent-request-bindings`.
 *
 *  - `domain.verifyingContract` MUST equal `body.facility`; a mismatch
 *    throws — signing under the wrong verifier yields a digest the
 *    on-chain `setRequest` could never accept.
 *  - `body.intent.id` is decimal; viem accepts decimal strings for
 *    `uint256` and converts internally — no manual `BigInt` cast is
 *    required.
 */
export function buildIntentRequestBindingTypedData(args: {
  domain: Eip712Domain;
  body: IntentRequestBindingBody;
}): GuardianTypedData<typeof setRequestParamsTypes, "SetRequestParams"> {
  const { domain, body } = args;
  if (domain.verifyingContract.toLowerCase() !== body.facility.toLowerCase()) {
    throw new Error(
      "buildIntentRequestBindingTypedData: domain.verifyingContract must equal body.facility",
    );
  }
  const typedData: SetRequestParamsTypedData = {
    domain,
    types: setRequestParamsTypes,
    primaryType: "SetRequestParams",
    message: {
      id: BigInt(body.intent.id),
      newRequest: body.requestContract,
      deadline: BigInt(body.deadline),
    },
  };
  return { typedData, payloadHash: hashTypedData(typedData) };
}
