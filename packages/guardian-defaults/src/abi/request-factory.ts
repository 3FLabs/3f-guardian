/**
 * Minimal viem ABI for `RequestFactory` (3F protocol).
 *
 *  - `isRequest(address)` — provenance check: was this address deployed
 *    by THIS factory? Used by §A.1 check #1 to verify a request contract
 *    came from an accepted factory.
 *  - `RequestCreated(...)` — emitted at deployment. Used by the role-
 *    events scan to find the deployment block and stop walking back.
 *    `request` is NOT indexed in the contract, so callers filter
 *    client-side by decoding the log args.
 *
 * Mirrors `grunt/src/request/RequestFactory.sol`.
 */
export const requestFactoryAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "isRequest",
    inputs: [{ name: "request", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "RequestCreated",
    inputs: [
      { name: "request", type: "address", indexed: false },
      { name: "asset", type: "address", indexed: false },
      { name: "ptToken", type: "address", indexed: false },
      { name: "ytToken", type: "address", indexed: false },
    ],
    anonymous: false,
  },
] as const;
