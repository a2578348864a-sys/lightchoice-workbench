import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import type { CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import { PRODUCT_FACT_SCHEMA } from "@/lib/sourceLayer/fact";

const mocks = vi.hoisted(() => {
  let candidates: Array<Record<string, unknown>> = [];
  return {
    reset: () => {
      candidates = [];
    },
    candidates: () => candidates,
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const found = candidates.find((c) => c.id === where.id);
      return found ? { ...found } : null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const idx = candidates.findIndex((c) => c.id === where.id);
      if (idx === -1) throw new Error("Candidate not found");
      candidates[idx] = { ...candidates[idx], ...data };
      return { ...candidates[idx] };
    }),
    create: vi.fn(async () => {
      throw new Error("create should NEVER be called in recovery");
    }),
  };
});

vi.mock("@/lib/server/db", () => ({
  prisma: {
    opportunityCandidate: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      create: mocks.create,
    },
  },
}));

import {
  attachProductFactToExistingCandidate,
  CandidateFactRecoveryError,
} from "@/lib/sourceLayer/server/candidateFactRecovery";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { captureContentHashOf } from "@/lib/sourceLayer/sourceAdapter";

const ownerContext: AccessContext = { mode: "owner", token: "" };
const demoContext: AccessContext = {
  mode: "demo",
  token: "visitor-token",
  demoAccessId: "visitor-a",
  isActive: true,
  isExpired: false,
  remainingAiCalls: 1,
  credentialKind: "password",
};

function makeEvidenceRecord(asin: string, contentHash: string): CaptureEvidenceRecord {
  const record: CaptureEvidenceRecord = {
    schemaVersion: "source-evidence-record.v1",
    evidenceId: `ev-${asin}-${contentHash.slice(0, 8)}`,
    captureId: `cap-${asin}`,
    subjectKey: `amazon:US:${asin}`,
    version: 1,
    sourceType: "sellersprite_xlsx",
    sourceUrl: `https://www.amazon.com/dp/${asin}`,
    capturedAt: "2026-09-19T00:00:00.000Z",
    contentHash,
    pkg: {
      schemaVersion: "source-capture-package.v1",
      captureId: `cap-${asin}`,
      subjectKey: `amazon:US:${asin}`,
      version: 1,
      marketplace: "US",
      fields: {
        asin,
        title: `Product Title for ${asin}`,
        brand: "TestBrand",
        images: ["https://example.com/img.jpg"],
        price: { amount: 19.99, currency: "USD" },
        rating: 4.5,
        reviewCount: 120,
        bsr: { rank: 50, category: "Office Products" },
        subCategoryBsr: null,
        estimatedMonthlySales: 300,
        estimatedMonthlyRevenueUsd: 5997,
        keywords: ["test", "keyword"],
      },
      fieldStates: {
        asin: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "asin" },
        title: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "title" },
        brand: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "brand" },
        images: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "images" },
        price: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "price" },
        rating: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "rating" },
        reviewCount: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "reviews" },
        bsr: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "bsr" },
        subCategoryBsr: { status: "missing", valueOrigin: "provider_export", confidence: 0, sourceRef: "subCategoryBsr" },
        estimatedMonthlySales: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "sales" },
        estimatedMonthlyRevenueUsd: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "revenue" },
        keywords: { status: "confirmed", valueOrigin: "provider_export", confidence: 1, sourceRef: "keywords" },
      },
      sourceProof: {
        sourceType: "sellersprite_xlsx",
        sourceUrl: `https://www.amazon.com/dp/${asin}`,
        capturedAt: "2026-09-19T00:00:00.000Z",
        captureMethod: "xlsx_export",
        operator: "owner:v1",
        sourceFingerprint: "fingerprint-123",
        sourceRecordRef: "row-123",
      },
      riskFlags: [],
      replay: {
        url: `https://www.amazon.com/dp/${asin}`,
        capturedAt: "2026-09-19T00:00:00.000Z",
        pageDigest: "test-digest",
        warnings: [],
      },
    },
    validation: {
      verdict: "passed",
      readyForResearch: true,
      issueCodes: [],
      checkedAt: "2026-09-19T00:00:00.000Z",
    },
    factAuthority: "evidence_only",
  };
  record.contentHash = captureContentHashOf(record.pkg);
  return record;
}

describe("candidateFactRecovery", () => {
  let tempDir: string;
  let previousStoreDir: string | undefined;

  beforeEach(() => {
    mocks.reset();
    mocks.findUnique.mockClear();
    mocks.update.mockClear();
    tempDir = mkdtempSync(join(tmpdir(), "recovery-test-"));
    previousStoreDir = process.env.SOURCE_LAYER_STORE_DIR;
    process.env.SOURCE_LAYER_STORE_DIR = tempDir;
  });

  afterEach(() => {
    if (previousStoreDir === undefined) {
      delete process.env.SOURCE_LAYER_STORE_DIR;
    } else {
      process.env.SOURCE_LAYER_STORE_DIR = previousStoreDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects non-owner recovery before reading or updating formal Candidates", async () => {
    await expect(
      attachProductFactToExistingCandidate({
        candidateId: "owner-candidate-1",
        context: demoContext,
      }),
    ).rejects.toMatchObject({ code: "owner_only_required" });

    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fails if candidate is not found", async () => {
    await expect(
      attachProductFactToExistingCandidate({
        candidateId: "non-existent",
        context: ownerContext,
      }),
    ).rejects.toThrow(CandidateFactRecoveryError);
  });

  it("fails if evidence does not exist in store", async () => {
    mocks.candidates().push({
      id: "cand-1",
      link: "https://www.amazon.com/dp/B00000JBNX",
      sourceMetaJson: JSON.stringify({ identity: { asin: "B00000JBNX" } }),
    });

    await expect(
      attachProductFactToExistingCandidate({
        candidateId: "cand-1",
        context: ownerContext,
      }),
    ).rejects.toThrow(CandidateFactRecoveryError);
  });

  it("successfully attaches ProductFact and verifies idempotency without creating duplicate candidates", async () => {
    const asin = "B00000JBNX";
    const record = makeEvidenceRecord(asin, "a".repeat(64));
    const contentHash = record.contentHash;
    const store = createEvidenceStore("owner:v1");
    await store.appendEvidence({
      evidence: record,
      auditEntries: [],
      operator: "owner:v1",
      now: new Date(),
    });

    mocks.candidates().push({
      id: "cand-1",
      link: `https://www.amazon.com/dp/${asin}`,
      sourceMetaJson: JSON.stringify({
        identity: { asin },
        sourceLayerCapture: { version: 1, contentHash },
      }),
    });

    // 第一次附加
    const firstResult = await attachProductFactToExistingCandidate({
      candidateId: "cand-1",
      context: ownerContext,
    });

    expect(firstResult.alreadyAttached).toBe(false);
    expect(firstResult.productFact.schema).toBe(PRODUCT_FACT_SCHEMA);
    expect(firstResult.productFact.subjectKey).toBe(`amazon:US:${asin}`);
    expect(firstResult.productFact.basic.asin.value).toBe(asin);
    expect(firstResult.productFact.basic.title.value).toBe(`Product Title for ${asin}`);
    expect(firstResult.productFact.basic.price.value?.amount).toBe(19.99);

    // 检查数据库记录已更新
    const candInDb = mocks.candidates()[0];
    const parsedMeta = JSON.parse(candInDb.sourceMetaJson as string);
    expect(parsedMeta.productFact).toBeDefined();
    expect(parsedMeta.productFact.schema).toBe("product-fact.v3");
    expect(parsedMeta.productFactRecovery).toMatchObject({ strategy: "exact_binding", requestedVersion: 1, resolvedVersion: 1 });

    // 第二次附加：幂等性验证
    const secondResult = await attachProductFactToExistingCandidate({
      candidateId: "cand-1",
      context: ownerContext,
    });
    expect(secondResult.alreadyAttached).toBe(true);
    expect(mocks.candidates()).toHaveLength(1); // 零重复 Candidate
  });

  it("rejects a missing explicit version even when a newer passed version is available", async () => {
    const asin = "B00000JBNX";
    const record = makeEvidenceRecord(asin, "a".repeat(64));
    await createEvidenceStore("owner:v1").appendEvidence({ evidence: record, auditEntries: [], operator: "owner:v1", now: new Date() });
    mocks.candidates().push({ id: "bound-candidate", sourceMetaJson: JSON.stringify({ identity: { asin }, sourceLayerCapture: { version: 99, contentHash: record.contentHash } }) });
    await expect(attachProductFactToExistingCandidate({ candidateId: "bound-candidate", context: ownerContext }))
      .rejects.toMatchObject({ code: "evidence_binding_stale" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("labels unbound recovery and refuses to replace an explicitly failed version with older passed evidence", async () => {
    const asin = "B00000JBNX";
    const store = createEvidenceStore("owner:v1");
    const record = makeEvidenceRecord(asin, "a".repeat(64));
    await store.appendEvidence({ evidence: record, auditEntries: [], operator: "owner:v1", now: new Date() });
    mocks.candidates().push({ id: "unbound-candidate", sourceMetaJson: JSON.stringify({ identity: { asin } }) });
    await attachProductFactToExistingCandidate({ candidateId: "unbound-candidate", context: ownerContext });
    expect(JSON.parse(mocks.candidates()[0].sourceMetaJson as string).productFactRecovery.strategy).toBe("latest_passed_unbound");
    const failed = makeEvidenceRecord(asin, "b".repeat(64));
    failed.pkg.fields.title = "Another observed title";
    failed.contentHash = captureContentHashOf(failed.pkg);
    failed.validation = { ...failed.validation, verdict: "blocked", readyForResearch: false };
    await store.appendEvidence({ evidence: failed, auditEntries: [], operator: "owner:v1", now: new Date() });
    mocks.candidates().push({ id: "failed-bound", sourceMetaJson: JSON.stringify({ identity: { asin }, sourceLayerCapture: { version: 2, contentHash: failed.contentHash } }) });
    const updates = mocks.update.mock.calls.length;
    await expect(attachProductFactToExistingCandidate({ candidateId: "failed-bound", context: ownerContext })).rejects.toMatchObject({ code: "evidence_not_passed" });
    expect(mocks.update).toHaveBeenCalledTimes(updates);
  });
});
