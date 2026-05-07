/**
 * Typed accessors for the foundry artifacts bundled under `../artifacts/`.
 *
 * Each artifact is a stamped JSON `{ name, abi, bytecode, deployedBytecode,
 * sourceRepo, sourcePath, sourceCommitHash }` produced by
 * `scripts/extract-contract-fixtures.ts`. The script must be re-run when
 * any sibling repo (`grunt`, `3f-request-whitelist`) changes; CI can
 * fail-fast on drift via `bun run scripts/extract-contract-fixtures.ts
 * --check`.
 */

import type { Abi, Hex } from "viem";

import erc1967Factory from "../artifacts/ERC1967Factory.json" with { type: "json" };
import facility from "../artifacts/Facility.json" with { type: "json" };
import intentDescriptor from "../artifacts/IntentDescriptor.json" with { type: "json" };
import mockErc20 from "../artifacts/MockERC20.json" with { type: "json" };
import multicall3 from "../artifacts/Multicall3.json" with { type: "json" };
import ownableMockFund from "../artifacts/OwnableMockFund.json" with { type: "json" };
import positionManagerFactory from "../artifacts/PositionManagerFactory.json" with { type: "json" };
import requestFactory from "../artifacts/RequestFactory.json" with { type: "json" };
import requestWhitelist from "../artifacts/RequestWhitelist.json" with { type: "json" };
import transferGuard from "../artifacts/TransferGuard.json" with { type: "json" };

export type Artifact = {
  readonly name: string;
  readonly abi: Abi;
  readonly bytecode: Hex;
  readonly deployedBytecode: Hex;
  readonly sourceRepo: string;
  readonly sourcePath: string;
  readonly sourceCommitHash: string;
};

const cast = (raw: unknown): Artifact => raw as Artifact;

export const artifacts = {
  Facility: cast(facility),
  IntentDescriptor: cast(intentDescriptor),
  TransferGuard: cast(transferGuard),
  PositionManagerFactory: cast(positionManagerFactory),
  RequestFactory: cast(requestFactory),
  MockERC20: cast(mockErc20),
  RequestWhitelist: cast(requestWhitelist),
  ERC1967Factory: cast(erc1967Factory),
  OwnableMockFund: cast(ownableMockFund),
  Multicall3: cast(multicall3),
} as const;

export type ArtifactName = keyof typeof artifacts;
