import { describe, expect, it } from "vitest";
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";
import { comparisonKind, effectiveGate, gateSaveBlocked, linkedThemeReviews, uniqueReviewProducts, type ScanReadModel } from "./researchPresentation";

const scan = { id: "scan-a", sampleHash: "hash-a", resourceVersion: "v1", marketGate: { status: "PROCEED", effectiveStatus: "PROCEED", stale: false }, decisionReadiness: { blockers: [], acknowledgeableMissing: [] } } as unknown as ScanReadModel;
describe("research presentation safeguards", () => {
  it("does not treat two missing properties as equal or comparable", () => {
    expect(comparisonKind(null, null)).toBe("unknown");
    expect(comparisonKind("", "")).toBe("unknown");
    expect(comparisonKind(0, null)).toBe("unknown");
    expect(comparisonKind(0, 0)).toBe("same");
  });
  it("keeps an expired proceed decision pending", () => {
    expect(effectiveGate({ ...scan, marketGate: { ...scan.marketGate!, stale: true } })).toBe("PENDING");
    expect(effectiveGate({ ...scan, marketWorkflow: { stale: true, effectiveGateStatus: "PROCEED" } })).toBe("PENDING");
    expect(effectiveGate(null)).toBe("PENDING");
  });
  it("never saves PENDING as a fresh human choice", () => {
    expect(gateSaveBlocked(scan, "PENDING", "已有充分理由", true)).toContain("PENDING");
  });
  it("requires version, reason and acknowledgement before enabling save", () => {
    expect(gateSaveBlocked({ ...scan, resourceVersion: "" }, "PAUSE", "已有充分理由", true)).toContain("版本");
    expect(gateSaveBlocked(scan, "PAUSE", "短", true)).toContain("理由");
    expect(gateSaveBlocked(scan, "PAUSE", "已有充分理由", false)).toContain("确认");
    expect(gateSaveBlocked(scan, "PAUSE", "已有充分理由", true)).toBeNull();
  });
  it("blocks proceed with unread readiness or a hard blocker, allowing a pause decision", () => {
    expect(gateSaveBlocked({ ...scan, decisionReadiness: undefined }, "PROCEED", "已有充分理由", true)).toContain("就绪");
    const blocked = { ...scan, decisionReadiness: { ...scan.decisionReadiness!, blockers: [{ code: "BLOCK", label: "硬阻塞", detail: "缺证" }] } };
    expect(gateSaveBlocked(blocked, "PROCEED", "已有充分理由", true)).toContain("硬阻塞");
    expect(gateSaveBlocked(blocked, "PAUSE", "已有充分理由", true)).toBeNull();
  });
  it("counts review coverage by current sample identity, excluding outside subjects", () => {
    const data = { samples: [{ subjectKey: "amazon:US:A" }], reviews: [{ subjectKey: "amazon:US:A", subjectKeys: ["amazon:US:A", "outside"] }, { subjectKey: "amazon:US:A" }] } as unknown as MarketIntelligence;
    expect(uniqueReviewProducts(data)).toBe(1);
  });
  it("does not substitute another review for an unresolved historical citation", () => {
    const data = { reviews: [{ id: "current-a", text: "original" }, { id: "current-b", text: "other" }] } as unknown as MarketIntelligence;
    expect(linkedThemeReviews(data, ["current-a", "missing-id"])).toEqual([data.reviews[0]]);
  });
});
