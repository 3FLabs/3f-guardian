// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  MockRetargetter
/// @notice Bare-minimum stand-in for a 3F Retargetter
///         (`grunt/src/manager/rebalancer/Retargetter.sol`) used by the
///         Guardian §A.1 retargetter-path integration tests.
///
///         Exposes exactly the surface the Guardian's `retargetterAbi`
///         reads — `operation()`, with the production return tuple — and
///         populates only the two members the Guardian consumes
///         (`request`, `repaymentDeadline`). The real contract deploys its
///         Request in `startRetargetting` and mirrors the deadline into
///         the operation; here `setOperation` is unauthenticated on
///         purpose so tests can attach / detach a Request directly.
contract MockRetargetter {
  struct Order {
    uint8 mode;
    address owner;
    address receiver;
    uint256 input;
    uint256 output;
    bytes32 salt;
  }

  address public attachedRequest;
  uint40 public attachedRepaymentDeadline;

  function operation()
    external
    view
    returns (
      address positionManager,
      address request,
      address fund,
      uint40 startedAt,
      uint40 repaymentDeadline,
      uint16 operationMaxYieldBps,
      uint32 horizon,
      uint24 tickDuration,
      uint24 tickThreshold,
      Order memory order,
      bool orderLive
    )
  {
    return (
      address(0),
      attachedRequest,
      address(0),
      0,
      attachedRepaymentDeadline,
      0,
      0,
      0,
      0,
      order,
      false
    );
  }

  // ── test setter (unauthenticated by design) ─────────────────────────

  function setOperation(address request, uint40 repaymentDeadline) external {
    attachedRequest = request;
    attachedRepaymentDeadline = repaymentDeadline;
  }
}
