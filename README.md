# bun-guardian

Monorepo for the **Guardian** off-chain signer service — the v1 contract specified at
[gist b50021fb3ee2c059d228b4dcddbb577e](https://gist.github.com/maxencerb/b50021fb3ee2c059d228b4dcddbb577e).

The Guardian attests privileged on-chain actions: a caller submits the intended action,
the Guardian evaluates a fixed catalogue of policy & on-chain checks, and on success
returns an EIP-712 signature that the caller submits alongside its transaction.

## Packages

| Package | Path | Description |
|---|---|---|
| [`@3flabs/guardian`](./packages/guardian) | `packages/guardian` | HTTP shell. Hosts plug in policy, signing, and chain access via a typed `GuardianAbstractions` contract. |
| [`@3flabs/guardian-defaults`](./packages/guardian-defaults) | `packages/guardian-defaults` | Default `Logger` (pino), in-memory rate limiter, and Appendix-A check builders. |

`@3flabs/guardian-defaults` depends on `@3flabs/guardian` via `workspace:*`. The shell never owns
RPCs, secrets, or signing keys; the defaults package adds opinionated implementations a host can
plug in piece-by-piece.

## Stack

- [Bun](https://bun.sh/) workspaces (no pnpm); per-package builds with `tsc` emitting `.js` + `.d.ts`.
- [Elysia](https://elysiajs.com/) for routing, [Zod](https://zod.dev) for schemas.
- [viem](https://viem.sh/) for chain reads & EIP-712 signing.
- [better-result](https://better-result.dev) for typed `Result<T, E>` flow.
- [@noble/hashes](https://github.com/paulmillr/noble-hashes) for HMAC-SHA-256.
- [pino](https://getpino.io/) + [pino-pretty](https://github.com/pinojs/pino-pretty) for the default logger.
- [oxlint](https://oxc.rs/docs/guide/usage/linter/quickstart) + [oxfmt](https://oxc.rs/docs/guide/usage/formatter/quickstart) for lint & format.
- [vitest](https://vitest.dev) for tests.
- [Changesets](https://github.com/changesets/changesets) for versioning + npm publish via GitHub OIDC trusted-publisher (no `NPM_TOKEN` secret).

## Development

```bash
bun install
bun run typecheck       # tsc --noEmit per package
bun run lint            # oxlint
bun run format          # oxfmt
bun run test            # vitest workspace (all packages)
bun run build           # tsc emit .js + .d.ts per package
```

Per-package work:

```bash
bun run --filter '@3flabs/guardian' test
bun run --filter '@3flabs/guardian-defaults' build
```

## Releasing

1. After a code change, run `bun run changeset` and pick the affected package(s) and bump kind. Commit the resulting `.changeset/*.md`.
2. Push to `main`. The `release` workflow opens (or updates) a "Version Packages" PR.
3. Merge that PR. The workflow re-runs and publishes to npm with provenance via GitHub OIDC.

**One-time setup on npmjs.com**: add each package as an *OIDC trusted publisher* pointing at
`3FLabs/3f-guardian` repo / `release.yml` workflow. Without this, the publish step will
fail because no `NPM_TOKEN` is configured (intentional — we don't want long-lived secrets).

## Layout

```
packages/
├─ guardian/
│   ├─ src/
│   │   ├─ abstractions.ts          types-only contract a host fulfils
│   │   ├─ server.ts                buildGuardianServer(abs) ⇒ Elysia
│   │   ├─ index.ts                 public re-exports
│   │   ├─ errors/                  tagged errors + envelope mapping (§6.5)
│   │   ├─ schemas/                 zod primitives, headers, per-endpoint bodies
│   │   ├─ plugins/                 raw-body, request-id, version-header, content-type, logger, auth, error-handler
│   │   ├─ routes/                  one file per endpoint
│   │   ├─ signers/                 dev private-key envelope (host substitutes KMS/HSM in prod)
│   │   └─ lib/                     hmac, time, request-id, checks, result, signing, logger
│   └─ tests/
└─ guardian-defaults/
    ├─ src/
    │   ├─ logger/pino.ts           pinoLogger() — pino + pino-pretty
    │   ├─ rate-limit/in-memory.ts  inMemoryRateLimiter() with pluggable Store
    │   └─ checks/                  buildIntent{Request,Fund,Swap,Whitelisting}Checks
    └─ tests/
```

## License

MIT.
