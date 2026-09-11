/**
 * Minimal viem ABI for `Retargetter` (3F protocol). Only the surface the
 * §A.1 retargetter path reads is included.
 *
 * `operation()` returns the in-flight retargetting operation. The
 * Guardian consumes two members:
 *
 *  - `request` — the Request contract the retargetter deployed in
 *    `startRetargetting` and still holds as its active operation
 *    (`address(0)` when idle or inside a SYNC flash-loan window).
 *  - `repaymentDeadline` — that Request's repayment deadline, mirrored
 *    into the operation at start (`REPAYMENT_DEADLINE_OFFSET`, 90 days).
 *    On chain the loan clock can only start while at least
 *    `MIN_DEADLINE_BUFFER` (80 days) remains before it.
 *
 * Mirrors `grunt/src/manager/rebalancer/Retargetter.sol` (`operation()`)
 * and `grunt/src/libs/funds/Order.sol` (the `Order` tuple).
 */
export const retargetterAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "operation",
    inputs: [],
    outputs: [
      { name: "positionManager", type: "address" },
      { name: "request", type: "address" },
      { name: "fund", type: "address" },
      { name: "startedAt", type: "uint40" },
      { name: "repaymentDeadline", type: "uint40" },
      { name: "operationMaxYieldBps", type: "uint16" },
      { name: "horizon", type: "uint32" },
      { name: "tickDuration", type: "uint24" },
      { name: "tickThreshold", type: "uint24" },
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "mode", type: "uint8" },
          { name: "owner", type: "address" },
          { name: "receiver", type: "address" },
          { name: "input", type: "uint256" },
          { name: "output", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "orderLive", type: "bool" },
    ],
  },
] as const;
