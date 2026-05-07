#!/usr/bin/env bun
/**
 * Rewrites `workspace:*` / `workspace:^` / `workspace:~` / `workspace:<range>`
 * specifiers in every `packages/*\/package.json` to a real semver range, in
 * place. Intended to run in CI immediately before `changeset publish` —
 * `npm publish` (which `changeset publish` shells out to per package) does
 * NOT understand the `workspace:` protocol, so without this step published
 * manifests contain `"workspace:*"` literally and are uninstallable.
 *
 * Mirrors the rewrite that `pnpm publish` and `bun publish` perform natively:
 *   workspace:*       → <version>      (exact)
 *   workspace:^       → ^<version>
 *   workspace:~       → ~<version>
 *   workspace:<range> → <range>        (explicit override)
 *
 * MUST only run from the publish step in .github/workflows/release.yml — if
 * it runs before `changeset version`, the rewritten manifests get committed
 * into the Version Packages PR and break local workspace symlinking.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

type PackageJson = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const packageDirs = readdirSync(PACKAGES_DIR).filter((entry) =>
  statSync(join(PACKAGES_DIR, entry)).isDirectory(),
);

const versions = new Map<string, string>();
const manifests: Array<{ path: string; pkg: PackageJson }> = [];

for (const dir of packageDirs) {
  const path = join(PACKAGES_DIR, dir, "package.json");
  const file = Bun.file(path);
  if (!(await file.exists())) continue;
  const pkg = (await file.json()) as PackageJson;
  versions.set(pkg.name, pkg.version);
  manifests.push({ path, pkg });
}

function resolveSpec(spec: string, depName: string): string {
  const range = spec.slice("workspace:".length);
  const target = versions.get(depName);
  if (!target) {
    throw new Error(
      `Cannot resolve workspace dependency "${depName}" — not found among packages/*.`,
    );
  }
  if (range === "*" || range === "") return target;
  if (range === "^") return `^${target}`;
  if (range === "~") return `~${target}`;
  return range;
}

let rewritten = 0;
for (const { path, pkg } of manifests) {
  let dirty = false;
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [depName, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      const resolved = resolveSpec(spec, depName);
      deps[depName] = resolved;
      dirty = true;
      console.log(`  ${pkg.name} :: ${field}.${depName}  ${spec}  →  ${resolved}`);
    }
  }
  if (dirty) {
    await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`);
    rewritten++;
  }
}

console.log(
  rewritten > 0
    ? `\nRewrote workspace: specifiers in ${rewritten} package.json file(s).`
    : "\nNo workspace: specifiers found — nothing to rewrite.",
);
