import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";

/**
 * Centralized fixture classification for business paths.
 *
 * Structured metadata wins. The prefix rules are intentionally retained only
 * as a compatibility fallback for historical evidence created before the
 * metadata field existed.
 */
export function isFixtureEvidenceSubject(input: {
  subjectKey: string;
  asin?: string | null;
  evidence?: CaptureEvidenceRecord | null;
}): boolean {
  const evidence = input.evidence as (CaptureEvidenceRecord & { pkg?: Record<string, unknown> }) | null | undefined;
  const pkg = evidence?.pkg;
  const candidates: unknown[] = [
    pkg && (pkg as Record<string, unknown>).metadata,
    pkg && (pkg as Record<string, unknown>).extensions,
    evidence && (evidence as unknown as Record<string, unknown>).metadata,
  ];
  for (const value of candidates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    for (const key of ["isFixture", "testFixture", "fixture"]) {
      if (record[key] === true) return true;
    }
    const nested = record.metadata;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedRecord = nested as Record<string, unknown>;
      if (nestedRecord.isFixture === true || nestedRecord.testFixture === true) return true;
    }
  }

  const identity = `${input.asin ?? ""}|${input.subjectKey}`.toUpperCase();
  return /(?:^|[|:_-])(BAD-ASIN|B0SRC|B0CLOSEOU|B0FIX)/u.test(identity);
}
