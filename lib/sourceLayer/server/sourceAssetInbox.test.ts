import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSourceAssetInbox } from "./sourceAssetInbox";
import type { AccessContext } from "@/lib/server/accessPassword";
import type {
  EvidenceSubjectIndexEntry,
  EvidenceSubjectRecord,
} from "@/lib/sourceLayer/server/evidenceStore";
import { manualEntryAdapter } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";

const evidenceState = vi.hoisted(() => ({
  subjects: [] as EvidenceSubjectIndexEntry[],
  records: new Map<string, EvidenceSubjectRecord | null>(),
}));

vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({
  createEvidenceStore: () => ({
    listSubjects: async () => evidenceState.subjects,
    getSubject: async (subjectKey: string) => evidenceState.records.get(subjectKey) ?? null,
  }),
}));

describe("sourceAssetInbox (商品资产收件箱只读投影)", () => {
  const mockContext: AccessContext = {
    mode: "owner",
    token: "test-owner-token",
  };

  beforeEach(() => {
    evidenceState.subjects = [];
    evidenceState.records.clear();
  });

  it("支持读取商品资产收件箱投影，结构符合 source-asset-inbox.v1", async () => {
    const payload = await getSourceAssetInbox(mockContext);
    expect(payload.schemaVersion).toBe("source-asset-inbox.v1");
    expect(payload.accessMode).toBe("owner");
    expect(typeof payload.totalCount).toBe("number");
    expect(typeof payload.passedCount).toBe("number");
    expect(typeof payload.reviewCount).toBe("number");
    expect(typeof payload.blockedCount).toBe("number");
    expect(Array.isArray(payload.items)).toBe(true);

    // 如果当前环境存在已入库商品，验证每项属性的合法性
    for (const item of payload.items) {
      expect(item.subjectKey).toBeDefined();
      expect(["可研究", "需复核", "已阻断"]).toContain(item.statusLabel);
      expect(["passed", "needs_review", "blocked"]).toContain(item.latestVerdict);
      expect(item.fieldCoverage.totalCount).toBe(8);
      expect(item.fieldCoverage.presentCount).toBeLessThanOrEqual(8);
      expect(Array.isArray(item.sources)).toBe(true);
      // 验证未编造伪评分
      expect((item as Record<string, unknown>).score).toBeUndefined();
      expect((item as Record<string, unknown>).qualityScore).toBeUndefined();
    }
  });

  it("索引标记 passed 但实际 Evidence versions 为空时 fail-closed", async () => {
    const subjectKey = "amazon:US:B0ORPHAN001";
    evidenceState.subjects = [subjectIndex({ subjectKey, latestVerdict: "passed" })];
    evidenceState.records.set(subjectKey, emptyRecord(subjectKey));

    const payload = await getSourceAssetInbox(mockContext);
    const item = payload.items[0];

    expect(item.latestVerdict).toBe("passed");
    expect(item.statusLabel).toBe("需复核");
    expect(item.readyForResearch).toBe(false);
    expect(item.versionCount).toBe(0);
    expect(item.issues).toContainEqual({
      code: "evidence_versions_unavailable",
      severity: "warning",
      field: null,
      hint: "来源证据版本不可用，需要重新接入或复核。",
    });
    expect(payload.passedCount).toBe(0);
    expect(payload.reviewCount).toBe(1);
  });

  it("正常 Evidence verdict passed 且 readyForResearch=true 时计入可研究", async () => {
    const evidence = makePassedEvidence();
    evidenceState.subjects = [subjectIndex({
      subjectKey: evidence.subjectKey,
      latestVerdict: evidence.validation.verdict,
    })];
    evidenceState.records.set(evidence.subjectKey, {
      schemaVersion: "source-evidence-subject.v1",
      subjectKey: evidence.subjectKey,
      marketplace: "US",
      updatedAt: evidence.capturedAt,
      operator: "owner-v1",
      versions: [evidence],
    });

    const payload = await getSourceAssetInbox(mockContext);
    const item = payload.items[0];

    expect(evidence.validation.verdict).toBe("passed");
    expect(evidence.validation.readyForResearch).toBe(true);
    expect(item.statusLabel).toBe("可研究");
    expect(item.readyForResearch).toBe(true);
    expect(payload.passedCount).toBe(1);
    expect(payload.reviewCount).toBe(0);
  });
});

function subjectIndex(input: {
  subjectKey: string;
  latestVerdict: EvidenceSubjectIndexEntry["latestVerdict"];
}): EvidenceSubjectIndexEntry {
  return {
    subjectKey: input.subjectKey,
    marketplace: "US",
    sourceType: "manual_entry",
    latestVersion: 1,
    versions: [1],
    latestCapturedAt: "2026-09-20T00:00:00.000Z",
    latestVerdict: input.latestVerdict,
    updatedAt: "2026-09-20T00:00:00.000Z",
    operator: "owner-v1",
    displayTitle: "Test product",
    asin: input.subjectKey.split(":").at(-1) ?? null,
  };
}

function emptyRecord(subjectKey: string): EvidenceSubjectRecord {
  return {
    schemaVersion: "source-evidence-subject.v1",
    subjectKey,
    marketplace: "US",
    updatedAt: "2026-09-20T00:00:00.000Z",
    operator: "owner-v1",
    versions: [],
  };
}

function makePassedEvidence(): CaptureEvidenceRecord {
  const capturedAt = "2026-09-20T00:00:00.000Z";
  const captured = manualEntryAdapter.capture({
    payload: {
      asin: "B0VAL00001",
      title: "Valid evidence product",
      brand: "Test Brand",
      productUrl: "https://www.amazon.com/dp/B0VAL00001",
      images: ["https://m.media-amazon.com/images/I/valid.jpg"],
      price: 19.99,
      currency: "USD",
      rating: 4.5,
      reviewCount: 120,
      bsrRank: 100,
      bsrCategory: "Office Products",
      estimatedMonthlySales: 300,
      estimatedMonthlyRevenueUsd: 5997,
      keywords: ["test"],
    },
    capturedAt,
    operator: "owner:v1",
  });
  const draft = captured.drafts[0];
  if (!draft) throw new Error("test fixture did not produce a manual entry draft");
  const pkg = manualEntryAdapter.normalize({ draft, captureId: "cap-valid-1", version: 1 });
  const outcome = manualEntryAdapter.validate({ pkg, context: { now: capturedAt } });
  return manualEntryAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });
}
