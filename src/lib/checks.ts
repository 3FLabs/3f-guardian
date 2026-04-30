import type { CheckEntry } from "../schemas/checks.ts";

/** Constructor for a passing check (§6.4.1 invariants enforced). */
export function passed(description: string): CheckEntry {
  return { description, passed: true, skipped: false };
}

/** Constructor for a skipped (and therefore passing) check. */
export function skipped(description: string): CheckEntry {
  return { description, passed: true, skipped: true };
}

/** Constructor for a failing check. `reason` is REQUIRED per §6.4.1. */
export function failed(description: string, reason: string): CheckEntry {
  return { description, passed: false, skipped: false, reason };
}
