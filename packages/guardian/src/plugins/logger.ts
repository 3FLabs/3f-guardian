import { Elysia } from "elysia";

import { type Logger, noopLogger } from "../lib/logger.js";
import { requestIdPlugin } from "./request-id.js";

/**
 * Per-request logger plugin. Child-binds the host's logger (or the
 * built-in noop logger when the host did not supply one) with
 * `{ requestId }` so every record emitted during the request carries
 * the X-Request-Id correlation field.
 *
 * The auth plugin re-binds with `{ tokenId }` after authentication
 * succeeds; route handlers then pass `ctx.logger` to `runSigning`,
 * which child-binds with `{ chainId }` before reaching the
 * abstraction.
 *
 * Order on the server: `requestIdPlugin` → `loggerPlugin` → auth → routes.
 */
export function loggerPlugin(base: Logger | undefined) {
  const root = base ?? noopLogger;
  return new Elysia({ name: "guardian:logger" })
    .use(requestIdPlugin)
    .derive({ as: "global" }, ({ requestId }) => ({
      logger: root.child({ requestId }),
    }))
    .as("scoped");
}
