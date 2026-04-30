const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Resolve the X-Request-Id for an incoming request. §3.7 mandates that
 * malformed or absent values are replaced with a Guardian-generated UUID,
 * and the replacement returned in the response header.
 */
export function resolveRequestId(headerValue: string | undefined): string {
  if (isCanonicalUuid(headerValue)) return headerValue;
  return crypto.randomUUID();
}
