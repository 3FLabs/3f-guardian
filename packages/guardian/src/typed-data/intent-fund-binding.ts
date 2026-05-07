import { hashTypedData, type TypedDataDefinition } from "viem";

import type { IntentFundBindingBody } from "../schemas/intent-fund-binding.js";
import type { Eip712Domain, GuardianTypedData } from "./types.js";

/**
 * §A.2 / §7.4 — the facility's `setFund` typed-data struct.
 *
 * Mirrors `SET_FUND_PARAMS_TYPEHASH` in
 * `grunt/src/facility/base/FacilityIntents.sol`:
 *
 *   keccak256("SetFundParams(uint256 id,address newFund,uint256 deadline)")
 *
 * Note: `body.positionManager` is a §A.2 check input only and is
 * intentionally NOT part of the signed payload — the Facility's
 * `setFund` verifier doesn't take it.
 */
export const setFundParamsTypes = {
  SetFundParams: [
    { name: "id", type: "uint256" },
    { name: "newFund", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

type SetFundParamsTypedData = TypedDataDefinition<typeof setFundParamsTypes, "SetFundParams">;

/**
 * Builds the EIP-712 typed-data payload for §7.4
 * `intent-fund-bindings`. `domain.verifyingContract` MUST equal
 * `body.facility`; a mismatch throws — silently signing for the wrong
 * verifier would yield a digest the on-chain `setFund` could never
 * accept.
 */
export function buildIntentFundBindingTypedData(args: {
  domain: Eip712Domain;
  body: IntentFundBindingBody;
}): GuardianTypedData<typeof setFundParamsTypes, "SetFundParams"> {
  const { domain, body } = args;
  if (domain.verifyingContract.toLowerCase() !== body.facility.toLowerCase()) {
    throw new Error(
      "buildIntentFundBindingTypedData: domain.verifyingContract must equal body.facility",
    );
  }
  const typedData: SetFundParamsTypedData = {
    domain,
    types: setFundParamsTypes,
    primaryType: "SetFundParams",
    message: {
      id: BigInt(body.intent.id),
      newFund: body.fundContract,
      deadline: BigInt(body.deadline),
    },
  };
  return { typedData, payloadHash: hashTypedData(typedData) };
}
