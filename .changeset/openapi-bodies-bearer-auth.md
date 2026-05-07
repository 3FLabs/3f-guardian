---
"@3flabs/guardian": patch
"@3flabs/guardian-defaults": patch
---

Fix the OpenAPI document so request bodies, 200 responses, and bearer
authentication actually render.

Before this change `@elysiajs/openapi` saw zod schemas attached via
`body` / `response` and silently emitted nothing for them — request
bodies appeared as empty `content: {}` and 200 responses as `{}` —
because the plugin requires an explicit `mapJsonSchema` mapper for any
non-typebox vendor and because its body-content loop only renders
`application/json` content for parsers whose `fn` is a string (a plain
function-typed `onParse` hook, like the one our raw-body capture
plugin registers globally, makes the loop emit empty content).

Concretely:

- Pass `mapJsonSchema: { zod: z.toJSONSchema }` with `io: "input"` and
  `unrepresentable: "any"`. `io: "input"` documents the wire format
  (`zAddress`'s `regex(...).transform(...)` becomes `{ type: "string",
  pattern: "^0x[0-9a-fA-F]{40}$" }` instead of collapsing to `{}`);
  `unrepresentable: "any"` keeps unrepresentable shapes from throwing
  and replaces them with `{}` instead of erasing the whole schema
  (without it, the entire `/version` response renders as `{}`).
- Add `parse: "json"` to each `POST` route. Documentation-only — the
  global raw-body plugin still parses the body — but it gives the
  openapi plugin's body loop a string-typed parser entry to match,
  which is the only way it will emit `requestBody.content[
  "application/json"]`.
- Declare a `bearerAuth` security scheme (`type: "http", scheme:
  "bearer"`) at the document level and require it globally; `/health`
  and `/version` opt out per-route with `security: []`. Tools like
  Scalar / Swagger UI can now render a working "Authorize" widget that
  injects `Authorization: Bearer <token>` on `/v1/*` requests.
- Replace the per-status `zErrorEnvelope` repetitions with a
  `pickErrorResponses` helper backed by an `errorResponses` map whose
  entries each carry a status-specific `description` ("`forbidden` —
  The authenticated token lacks the endpoint scope required for this
  route." instead of the generic "Error envelope (§6.5)." inherited
  from the base schema). The 503 response on `/health` now describes
  itself as `upstream_unavailable` rather than going undocumented.

The `@3flabs/guardian-defaults` bump is a sync release with the
`@3flabs/guardian` patch — there are no source changes in defaults.
