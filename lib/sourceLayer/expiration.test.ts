import { describe, expect, it } from "vitest";

import {
  MAX_EVIDENCE_VERSIONS_PER_SUBJECT,
  assignEvidenceVersion,
  evaluateFieldExpiration,
  resolveFieldTtlMs,
} from "@/lib/sourceLayer/expiration";

const CAPTURED_AT = "2026-02-01T00:00:00.000Z";

describe("resolveFieldTtlMs", () => {
  it("gives price a shorter lifetime than images", () => {
    expect(resolveFieldTtlMs("price")).toBeLessThan(resolveFieldTtlMs("images"));
    expect(resolveFieldTtlMs("images")).toBeGreaterThan(resolveFieldTtlMs("title"));
  });

  it("honours an explicit override but ignores invalid ones", () => {
    expect(resolveFieldTtlMs("price", { price: 1000 })).toBe(1000);
    expect(resolveFieldTtlMs("price", { price: 0 })).toBe(resolveFieldTtlMs("price"));
    expect(resolveFieldTtlMs("price", { price: Number.NaN })).toBe(resolveFieldTtlMs("price"));
  });
});

describe("evaluateFieldExpiration", () => {
  it("marks a field valid inside its window", () => {
    const result = evaluateFieldExpiration({
      field: "price",
      capturedAt: CAPTURED_AT,
      present: true,
      now: new Date("2026-02-01T10:00:00.000Z"),
    });
    expect(result.state).toBe("valid");
    expect(result.expiresAt).not.toBeNull();
  });

  it("marks price expired after 48h while images stay valid", () => {
    const now = new Date("2026-02-05T00:00:00.000Z");
    expect(evaluateFieldExpiration({
      field: "price",
      capturedAt: CAPTURED_AT,
      present: true,
      now,
    }).state).toBe("expired");
    expect(evaluateFieldExpiration({
      field: "images",
      capturedAt: CAPTURED_AT,
      present: true,
      now,
    }).state).toBe("valid");
  });

  it("never expires the ASIN identity field", () => {
    const result = evaluateFieldExpiration({
      field: "asin",
      capturedAt: CAPTURED_AT,
      present: true,
      now: new Date("2036-02-05T00:00:00.000Z"),
    });
    expect(result.state).toBe("valid");
    expect(result.expiresAt).toBeNull();
  });

  it("does not judge absent fields and does not guess on invalid timestamps", () => {
    expect(evaluateFieldExpiration({
      field: "price",
      capturedAt: CAPTURED_AT,
      present: false,
      now: CAPTURED_AT,
    }).state).toBe("not_applicable");
    expect(evaluateFieldExpiration({
      field: "price",
      capturedAt: "not-a-date",
      present: true,
      now: CAPTURED_AT,
    }).state).toBe("not_applicable");
  });
});

describe("assignEvidenceVersion", () => {
  it("starts at 1 and increments strictly", () => {
    expect(assignEvidenceVersion([]).version).toBe(1);
    expect(assignEvidenceVersion([1]).version).toBe(2);
    expect(assignEvidenceVersion([1, 2, 3]).version).toBe(4);
  });

  it("tolerates unordered and duplicated history without reusing a version", () => {
    const assignment = assignEvidenceVersion([3, 1, 3, 2]);
    expect(assignment.version).toBe(4);
    expect(assignment.retainedVersions).toEqual([1, 2, 3]);
  });

  it("only prunes the oldest versions and reports what was pruned", () => {
    const versions = Array.from({ length: MAX_EVIDENCE_VERSIONS_PER_SUBJECT }, (_, index) => index + 1);
    const assignment = assignEvidenceVersion(versions);
    expect(assignment.version).toBe(MAX_EVIDENCE_VERSIONS_PER_SUBJECT + 1);
    expect(assignment.prunedVersions).toEqual([1]);
    expect(assignment.retainedVersions).toHaveLength(MAX_EVIDENCE_VERSIONS_PER_SUBJECT - 1);
  });
});
