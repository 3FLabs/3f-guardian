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
 * `--check` always validates bundled integrity (every artifact exists,
 * parses, carries abi/bytecode/deployedBytecode/sourceCommitHash, and
 * INDEX.json matches the stamps exactly). Sibling-drift comparison runs
 * only for repos whose forge output is actually present — on a fresh
 * clone / CI runner without sibling checkouts it is skipped with a
 * notice and the check still exits 0.
 *
 * Repo locations default to sibling checkouts (`../grunt`,
 * `../3f-request-whitelist`) and can be overridden with the
 * `GRUNT_REPO_ROOT` / `WHITELIST_REPO_ROOT` env vars — useful for
 * extracting from a pristine clone pinned to a release tag.
 *
 * Why this exists: integration tests deploy real contracts on a clean
 * anvil. We don't want every contributor to run `forge build` against
 * unrelated repos; we don't want to invoke foundry from CI either.
 * Checked-in artifacts are the trade-off.
 */

import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
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
  grunt: Bun.env.GRUNT_REPO_ROOT ?? resolve(REPO_ROOT, "../grunt"),
  whitelist: Bun.env.WHITELIST_REPO_ROOT ?? resolve(REPO_ROOT, "../3f-request-whitelist"),
  local: resolve(REPO_ROOT, "packages/guardian-test-fixtures/contracts"),
} as const;

/**
 * Source list — keep in sync with `deployGuardianStack` in
 * `packages/guardian-test-fixtures/src/deploy.ts`.
 */
const SOURCES: readonly Source[] = [
  // Grunt — production contracts
  {
    name: "Facility",
    artifactPath: "out/Facility.sol/Facility.json",
    sourcePath: "src/facility/Facility.sol",
    repo: "grunt",
  },
  {
    name: "IntentDescriptor",
    artifactPath: "out/IntentDescriptor.sol/IntentDescriptor.json",
    sourcePath: "src/facility/IntentDescriptor.sol",
    repo: "grunt",
  },
  {
    name: "TransferGuard",
    artifactPath: "out/TransferGuard.sol/TransferGuard.json",
    sourcePath: "src/guard/TransferGuard.sol",
    repo: "grunt",
  },
  {
    name: "PositionManagerFactory",
    artifactPath: "out/PositionManagerFactory.sol/PositionManagerFactory.json",
    sourcePath: "src/manager/PositionManagerFactory.sol",
    repo: "grunt",
  },
  {
    name: "RequestFactory",
    artifactPath: "out/RequestFactory.sol/RequestFactory.json",
    sourcePath: "src/request/RequestFactory.sol",
    repo: "grunt",
  },
  // Grunt — mocks for tests
  {
    name: "MockERC20",
    artifactPath: "out/MockERC20.sol/MockERC20.json",
    sourcePath: "test/mock/MockERC20.sol",
    repo: "grunt",
  },
  // Request Whitelist
  {
    name: "RequestWhitelist",
    artifactPath: "out/RequestWhitelist.sol/RequestWhitelist.json",
    sourcePath: "src/RequestWhitelist.sol",
    repo: "whitelist",
  },
  {
    name: "ERC1967Factory",
    artifactPath: "out/ERC1967Factory.sol/ERC1967Factory.json",
    sourcePath: "lib/solady/src/utils/ERC1967Factory.sol",
    repo: "whitelist",
  },
  // Local — small Ownable mock fund (grunt's MockFund isn't Ownable)
  {
    name: "OwnableMockFund",
    artifactPath: "out/OwnableMockFund.sol/OwnableMockFund.json",
    sourcePath: "OwnableMockFund.sol",
    repo: "local",
  },
  // Local — Multicall3 vendored from mds1/multicall3 (MIT). Anvil doesn't
  // deploy multicall3 by default; we need it for `client.multicall(...)`.
  {
    name: "Multicall3",
    artifactPath: "out/Multicall3.sol/Multicall3.json",
    sourcePath: "Multicall3.sol",
    repo: "local",
  },
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

/**
 * HEAD commit hash of `repoPath`, cached per path (one repo backs many
 * sources; `markDirty` is uniform within a run, so caching is safe).
 *
 * With `markDirty` (extract mode only), a dirty worktree gets a
 * `-dirty` suffix, mirroring `git describe --dirty`. Side effect on
 * `--check`: a later check from a clean checkout at the same commit
 * flags drift and forces re-extraction from a clean tree — intentional.
 * Check mode itself never appends the marker, so the monorepo's own
 * dirtiness cannot produce false drift.
 */
const gitHeadCache = new Map<string, string>();
function gitHead(repoPath: string, opts: { markDirty: boolean }): string {
  const cached = gitHeadCache.get(repoPath);
  if (cached !== undefined) return cached;
  const result = computeGitHead(repoPath, opts);
  gitHeadCache.set(repoPath, result);
  return result;
}

function computeGitHead(repoPath: string, opts: { markDirty: boolean }): string {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoPath });
  if (!head.success) {
    console.warn(`[fixtures] WARN: ${repoPath} is not a git repo — stamping "no-git"`);
    return "no-git";
  }
  const hash = head.stdout.toString().trim();
  if (!opts.markDirty) return hash;
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repoPath });
  if (status.success && status.stdout.toString().trim().length > 0) {
    console.warn(`[fixtures] WARN: ${repoPath} has uncommitted changes — stamping "${hash}-dirty"`);
    return `${hash}-dirty`;
  }
  return hash;
}

async function loadFoundryArtifact(absPath: string): Promise<{
  abi: unknown;
  bytecode: `0x${string}`;
  deployedBytecode: `0x${string}`;
}> {
  const raw = (await Bun.file(absPath).json()) as {
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

async function stamp(src: Source, opts: { markDirty: boolean }): Promise<StampedArtifact> {
  const repoRoot = REPO_ROOTS[src.repo];
  const artifactAbs = join(repoRoot, src.artifactPath);
  if (!(await Bun.file(artifactAbs).exists())) {
    throw new Error(
      `Missing foundry artifact for ${src.name}: ${artifactAbs}\n` +
        `  Run \`forge build\` in ${repoRoot} (or in our local contracts dir for local sources) and re-run this script.`,
    );
  }
  const { abi, bytecode, deployedBytecode } = await loadFoundryArtifact(artifactAbs);
  return {
    name: src.name,
    abi,
    bytecode,
    deployedBytecode,
    sourceRepo: src.repo,
    sourcePath: src.sourcePath,
    sourceCommitHash: gitHead(repoRoot, opts),
  };
}

function fixturePath(name: string): string {
  return join(ARTIFACT_DIR, `${name}.json`);
}

async function writeArtifact(stamped: StampedArtifact): Promise<void> {
  // Bun.write creates missing parent directories itself.
  await Bun.write(fixturePath(stamped.name), `${JSON.stringify(stamped, null, 2)}\n`);
}

/**
 * Always rebuild the local contracts in extract mode — foundry's build
 * is incremental and near-instant when nothing changed, and an
 * existence-only sentinel would silently re-stamp stale bytecode after
 * a local `.sol` edit.
 */
function buildLocal(): void {
  console.log(`[fixtures] forge build (${REPO_ROOTS.local})…`);
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["forge", "build"], {
      cwd: REPO_ROOTS.local,
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    throw new Error(
      `\`forge\` not found on PATH — install foundry (https://getfoundry.sh) to extract fixtures.`,
    );
  }
  if (!proc.success) {
    throw new Error(`forge build failed in ${REPO_ROOTS.local} (exit ${proc.exitCode})`);
  }
}

async function writeIndex(stamps: readonly StampedArtifact[]): Promise<void> {
  const index = stamps.map((s) => ({
    name: s.name,
    sourceRepo: s.sourceRepo,
    sourcePath: s.sourcePath,
    sourceCommitHash: s.sourceCommitHash,
  }));
  await Bun.write(join(ARTIFACT_DIR, "INDEX.json"), `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * `--check` mode is read-only: never invokes `forge build` or mutates
 * the local `out/` tree. Bundled-integrity validation is deterministic
 * and runnable on a fresh clone / CI runner without Foundry or sibling
 * checkouts (the bundled artifacts are the source of truth there);
 * sibling-drift comparison runs only for repos whose forge output is
 * present and is skipped with a notice otherwise.
 */
async function runCheck(): Promise<void> {
  let failures = 0;

  // 1. Bundled integrity — verifiable everywhere, even without sibling repos.
  const bundled = new Map<string, StampedArtifact>();
  for (const src of SOURCES) {
    const file = Bun.file(fixturePath(src.name));
    if (!(await file.exists())) {
      console.error(
        `[fixtures] MISSING: ${src.name} (${fixturePath(src.name)}) — run \`bun run fixtures:extract\``,
      );
      failures++;
      continue;
    }
    let artifact: StampedArtifact;
    try {
      artifact = (await file.json()) as StampedArtifact;
    } catch {
      console.error(`[fixtures] INVALID: ${src.name} (${fixturePath(src.name)}) is not valid JSON`);
      failures++;
      continue;
    }
    const missing = (["abi", "bytecode", "deployedBytecode", "sourceCommitHash"] as const).filter(
      (field) =>
        artifact[field] === undefined || artifact[field] === null || artifact[field] === "",
    );
    if (missing.length > 0) {
      console.error(`[fixtures] INVALID: ${src.name} is missing field(s): ${missing.join(", ")}`);
      failures++;
      continue;
    }
    bundled.set(src.name, artifact);
  }

  // 2. INDEX.json must match the bundled stamps byte-for-byte (writeIndex is
  //    its only writer). Only comparable once every artifact loaded above.
  if (bundled.size === SOURCES.length) {
    const index = [...bundled.values()].map((a) => ({
      name: a.name,
      sourceRepo: a.sourceRepo,
      sourcePath: a.sourcePath,
      sourceCommitHash: a.sourceCommitHash,
    }));
    const expected = `${JSON.stringify(index, null, 2)}\n`;
    const indexFile = Bun.file(join(ARTIFACT_DIR, "INDEX.json"));
    if (!(await indexFile.exists())) {
      console.error(`[fixtures] MISSING: INDEX.json — run \`bun run fixtures:extract\``);
      failures++;
    } else if ((await indexFile.text()) !== expected) {
      console.error(
        `[fixtures] STALE: INDEX.json does not match the bundled artifact stamps — run \`bun run fixtures:extract\``,
      );
      failures++;
    }
  }

  // 3. Sibling drift — only where the source-side forge output exists.
  //    Artifacts are pinned to release tags, so a sibling checkout sitting on
  //    a *different* commit is an expected state, not drift: byte-comparing a
  //    v1.2.0 stamp against a `main` build is meaningless. Bytes are compared
  //    only when the sibling's HEAD matches the stamped commit; otherwise a
  //    NOTICE points at `fixtures:extract` for an intentional re-pin.
  const skippedRepos = new Map<string, string>();
  const otherCommitRepos = new Map<string, { bundled: string; current: string }>();
  let driftChecked = 0;
  for (const src of SOURCES) {
    const existing = bundled.get(src.name);
    if (!existing) continue; // already reported as MISSING/INVALID above
    const artifactAbs = join(REPO_ROOTS[src.repo], src.artifactPath);
    if (!(await Bun.file(artifactAbs).exists())) {
      skippedRepos.set(src.repo, REPO_ROOTS[src.repo]);
      continue;
    }
    const current = await stamp(src, { markDirty: false });
    // `local` sources are stamped with the monorepo's own HEAD, so every new
    // monorepo commit would otherwise read as a commit mismatch — there the
    // recorded hash is provenance metadata only and content is always compared.
    if (src.repo !== "local" && existing.sourceCommitHash !== current.sourceCommitHash) {
      otherCommitRepos.set(src.repo, {
        bundled: existing.sourceCommitHash,
        current: current.sourceCommitHash,
      });
      continue;
    }
    driftChecked++;
    const abiMatch = JSON.stringify(existing.abi) === JSON.stringify(current.abi);
    const bytecodeMatch = existing.bytecode === current.bytecode;
    const deployedMatch = existing.deployedBytecode === current.deployedBytecode;
    if (!abiMatch || !bytecodeMatch || !deployedMatch) {
      console.error(
        `[fixtures] DRIFT: ${src.name}\n` +
          `  bundled commit:  ${existing.sourceCommitHash}\n` +
          `  current commit:  ${current.sourceCommitHash}\n` +
          `  abi match:       ${abiMatch}\n` +
          `  bytecode match:  ${bytecodeMatch}\n` +
          `  runtime match:   ${deployedMatch}\n` +
          `  Run \`bun run fixtures:extract\` to refresh.`,
      );
      failures++;
    }
  }
  for (const [repo, root] of skippedRepos) {
    console.log(
      `[fixtures] NOTICE: skipped sibling-drift verification for "${repo}" (${root}) — forge output not present.`,
    );
  }
  for (const [repo, { bundled: bundledHash, current }] of otherCommitRepos) {
    console.log(
      `[fixtures] NOTICE: sibling "${repo}" checkout is at ${current.slice(0, 7)} but artifacts are pinned at ${bundledHash.slice(0, 7)} — ` +
        `skipping byte comparison. Run \`bun run fixtures:extract\` only to re-pin intentionally.`,
    );
  }

  if (failures > 0) {
    console.error(`[fixtures] ${failures} problem(s) found.`);
    process.exit(1);
  }
  console.log(
    `[fixtures] OK — ${bundled.size} bundled artifact(s) valid; drift-checked ${driftChecked} against source repos.`,
  );
}

async function runExtract(): Promise<void> {
  buildLocal();
  const stamped = await Promise.all(SOURCES.map((src) => stamp(src, { markDirty: true })));
  for (const s of stamped) {
    await writeArtifact(s);
    console.log(
      `[fixtures] wrote ${fixturePath(s.name)} (${s.sourceRepo}@${s.sourceCommitHash.slice(0, 7)})`,
    );
  }
  await writeIndex(stamped);
  console.log(`[fixtures] wrote ${join(ARTIFACT_DIR, "INDEX.json")}`);
}

if (Bun.argv.includes("--check")) await runCheck();
else await runExtract();
