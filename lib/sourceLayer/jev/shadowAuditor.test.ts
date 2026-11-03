import { describe, expect, it } from "vitest";

import { auditProductFactSnapshot } from "@/lib/sourceLayer/jev/shadowAuditor";

const fact = {
  basic: {
    asin: { value: "B000000001", status: "present" },
    title: { value: "Product", status: "present" },
    price: { value: { amount: 10, currency: "USD" }, status: "present" },
  },
  market: { bsr: { value: 1, status: "present" } },
  profit: {},
};

describe("shadow auditor", () => {
  it("reports missing evidence without changing the fact", () => {
    const snapshot = JSON.parse(JSON.stringify(fact));
    const result = auditProductFactSnapshot({ fact, evidenceRefs: [] });
    expect(result.status).toBe("MISSING_CANDIDATE");
    expect(fact).toEqual(snapshot);
    expect(result).not.toHaveProperty("patch");
  });

  it("detects conflict and structure drift as sidecar statuses", () => {
    const result = auditProductFactSnapshot({
      fact: { ...fact, market: { bsr: { value: null, status: "conflict" } } },
      evidenceRefs: ["ev-1"],
      pageTemplateHash: "new",
      previousPageTemplateHash: "old",
    });
    expect(result.status).toBe("STRUCTURE_DRIFT");
    expect(result.findings.map((item) => item.code)).toContain("FIELD_CONFLICT");
  });
});

