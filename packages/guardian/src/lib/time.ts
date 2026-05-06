/** Unix seconds, integer. */
export function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** RFC 3339 in UTC with literal Z suffix (§3.6). */
export function toRfc3339Utc(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}
