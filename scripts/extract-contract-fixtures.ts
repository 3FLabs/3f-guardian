#!/usr/bin/env bun
/**
 * extract-contract-fixtures
 *
 * Copies `{ abi, bytecode }` pairs from sibling foundry repos
 * (`grunt`, `3f-request-whitelist`) plus our own
 * `packages/guardian-test-fixtures/contracts/` `forge build` output
 * into `packages/guardian-test-fixtures/artifacts/<Name>.json`. Each
 * stamp is annotated with the source repo + commit hash at extraction
 * time so a `--check` mode can fail CI when the bundled artifacts drift
 * from the sibling repos.
 *
 * Why this exists: integration tests deploy real contracts on a clean
 * anvil. We don't want every contributor to run `forge build` against
 * unrelated repos; we don't want to invoke foundry from CI either.
 * Checked-in artifacts are the trade-off.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const ARTIFACT_DIR = resolve(REPO_ROOT, "packages/guardian-test-fixtures/artifacts");

type Source = {
  /** Display name written into the artifact + used as filename. */
  readonly name: string;
  /** Filesystem path to the foundry-produced JSON (relative to its repo). */
  readonly artifactPath: string;
  /** Filesystem path to the source `.sol` (relative to its repo). */
  readonly sourcePath: string;
  /** Origin repo handle (one of the keys in REPO_ROOTS). */
  readonly repo: keyof typeof REPO_ROOTS;
};

const REPO_ROOTS = {
  grunt: resolve(REPO_ROOT, "../grunt"),
  whitelist: resolve(REPO_ROOT, "../3f-request-whitelist"),
  local: resolve(REPO_ROOT, "packages/guardian-test-fixtures/contracts"),
} as const;

/**
 * Source list — keep in sync with `deployGuardianStack` in
 * `packages/guardian-test-fixtures/src/deploy.ts`.
 */
const SOURCES: readonly Source[] = [
  // Grunt — production contracts
  { name: "Facility", artifactPath: "out/Facility.sol/Facility.json", sourcePath: "src/facility/Facility.sol", repo: "grunt" },
  { name: "IntentDescriptor", artifactPath: "out/IntentDescriptor.sol/IntentDescriptor.json", sourcePath: "src/facility/IntentDescriptor.sol", repo: "grunt" },
  { name: "TransferGuard", artifactPath: "out/TransferGuard.sol/TransferGuard.json", sourcePath: "src/guard/TransferGuard.sol", repo: "grunt" },
  { name: "PositionManagerFactory", artifactPath: "out/PositionManagerFactory.sol/PositionManagerFactory.json", sourcePath: "src/manager/PositionManagerFactory.sol", repo: "grunt" },
  { name: "RequestFactory", artifactPath: "out/RequestFactory.sol/RequestFactory.json", sourcePath: "src/request/RequestFactory.sol", repo: "grunt" },
  // Grunt — mocks for tests
  { name: "MockERC20", artifactPath: "out/MockERC20.sol/MockERC20.json", sourcePath: "test/mock/MockERC20.sol", repo: "grunt" },
  // Request Whitelist
  { name: "RequestWhitelist", artifactPath: "out/RequestWhitelist.sol/RequestWhitelist.json", sourcePath: "src/RequestWhitelist.sol", repo: "whitelist" },
  { name: "ERC1967Factory", artifactPath: "out/ERC1967Factory.sol/ERC1967Factory.json", sourcePath: "lib/solady/src/utils/ERC1967Factory.sol", repo: "whitelist" },
  // Local — small Ownable mock fund (grunt's MockFund isn't Ownable)
  { name: "OwnableMockFund", artifactPath: "out/OwnableMockFund.sol/OwnableMockFund.json", sourcePath: "OwnableMockFund.sol", repo: "local" },
  // Local — Multicall3 vendored from mds1/multicall3 (MIT). Anvil doesn't
  // deploy multicall3 by default; we need it for `client.multicall(...)`.
  { name: "Multicall3", artifactPath: "out/Multicall3.sol/Multicall3.json", sourcePath: "Multicall3.sol", repo: "local" },
] as const;

type StampedArtifact = {
  readonly name: string;
  readonly abi: unknown;
  readonly bytecode: `0x${string}`;
  readonly deployedBytecode: `0x${string}`;
  readonly sourceRepo: string;
  readonly sourcePath: string;
  readonly sourceCommitHash: string;
};

function gitHead(repoPath: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8" }).trim();
  } catch {
    return "no-git";
  }
}

function loadFoundryArtifact(absPath: string): {
  abi: unknown;
  bytecode: `0x${string}`;
  deployedBytecode: `0x${string}`;
} {
  const raw = JSON.parse(readFileSync(absPath, "utf8")) as {
    abi: unknown;
    bytecode: { object: string };
    deployedBytecode: { object: string };
  };
  return {
    abi: raw.abi,
    bytecode: raw.bytecode.object as `0x${string}`,
    deployedBytecode: raw.deployedBytecode.object as `0x${string}`,
  };
}

function stamp(src: Source): StampedArtifact {
  const repoRoot = REPO_ROOTS[src.repo];
  const artifactAbs = join(repoRoot, src.artifactPath);
  if (!existsSync(artifactAbs)) {
    throw new Error(
      `Missing foundry artifact for ${src.name}: ${artifactAbs}\n` +
        `  Run \`forge build\` in ${repoRoot} (or in our local contracts dir for local sources) and re-run this script.`,
    );
  }
  const { abi, bytecode, deployedBytecode } = loadFoundryArtifact(artifactAbs);
  return {
    name: src.name,
    abi,
    bytecode,
    deployedBytecode,
    sourceRepo: src.repo,
    sourcePath: src.sourcePath,
    sourceCommitHash: gitHead(repoRoot),
  };
}

function fixturePath(name: string): string {
  return join(ARTIFACT_DIR, `${name}.json`);
}

function writeArtifact(stamped: StampedArtifact): void {
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(fixturePath(stamped.name), `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
}

function readArtifact(name: string): StampedArtifact | undefined {
  const path = fixturePath(name);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as StampedArtifact;
}

function buildLocalIfNeeded() {
  const sentinels = [
    "out/OwnableMockFund.sol/OwnableMockFund.json",
    "out/Multicall3.sol/Multicall3.json",
  ];
  const allBuilt = sentinels.every((p) => existsSync(join(REPO_ROOTS.local, p)));
  if (allBuilt) return;
  console.log(`[fixtures] forge build (${REPO_ROOTS.local})…`);
  execSync("forge build", { cwd: REPO_ROOTS.local, stdio: "inherit" });
}

function writeIndex(stamps: readonly StampedArtifact[]) {
  const index = stamps.map((s) => ({
    name: s.name,
    sourceRepo: s.sourceRepo,
    sourcePath: s.sourcePath,
    sourceCommitHash: s.sourceCommitHash,
  }));
  writeFileSync(join(ARTIFACT_DIR, "INDEX.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function run(checkOnly: boolean) {
  // `--check` mode is read-only: never invoke `forge build` or mutate the
  // local `out/` tree. Verification must be deterministic and runnable in
  // CI environments without Foundry installed (the bundled artifacts are
  // the source of truth there).
  if (!checkOnly) buildLocalIfNeeded();

  const stamped = SOURCES.map(stamp);

  if (checkOnly) {
    let drift = 0;
    for (const s of stamped) {
      const existing = readArtifact(s.name);
      if (!existing) {
        console.error(`[fixtures] MISSING: ${s.name} (${fixturePath(s.name)}) — run \`bun run fixtures:extract\``);
        drift++;
        continue;
      }
      const abiMatch = JSON.stringify(existing.abi) === JSON.stringify(s.abi);
      const bytecodeMatch = existing.bytecode === s.bytecode;
      const deployedMatch = existing.deployedBytecode === s.deployedBytecode;
      const commitMatch = existing.sourceCommitHash === s.sourceCommitHash;
      if (!abiMatch || !bytecodeMatch || !deployedMatch || !commitMatch) {
        console.error(
          `[fixtures] DRIFT: ${s.name}\n` +
            `  bundled commit:  ${existing.sourceCommitHash}\n` +
            `  current commit:  ${s.sourceCommitHash}\n` +
            `  abi match:       ${abiMatch}\n` +
            `  bytecode match:  ${bytecodeMatch}\n` +
            `  runtime match:   ${deployedMatch}\n` +
            `  Run \`bun run fixtures:extract\` to refresh.`,
        );
        drift++;
      }
    }
    if (drift > 0) {
      console.error(`[fixtures] ${drift} drifted/missing artifact(s).`);
      process.exit(1);
    }
    console.log(`[fixtures] OK — ${stamped.length} artifact(s) match sibling repos.`);
    return;
  }

  for (const s of stamped) {
    writeArtifact(s);
    console.log(`[fixtures] wrote ${fixturePath(s.name)} (${s.sourceRepo}@${s.sourceCommitHash.slice(0, 7)})`);
  }
  writeIndex(stamped);
  console.log(`[fixtures] wrote ${join(ARTIFACT_DIR, "INDEX.json")}`);
}

const checkOnly = process.argv.includes("--check");
run(checkOnly);
