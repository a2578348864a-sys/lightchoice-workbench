import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  buildV5MarketCandidateEvidenceBinding,
  buildV5MarketCandidateV3Meta,
  extractCandidateEvidenceBinding,
  isV5MarketCandidateMeta,
  verifyCandidateFactBinding,
  V5_MARKET_CANDIDATE_V1_SCHEMA,
  V5_MARKET_CANDIDATE_V2_SCHEMA,
  V5_MARKET_CANDIDATE_V3_SCHEMA,
  type V5MarketCandidateV2Meta,
  type V5MarketCandidateV3Meta,
} from "@/lib/marketScan/candidateContract";
import { captureContentHashOf, type CaptureEvidenceRecord } from "@/lib/sourceLayer/sourceAdapter";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { attachProductFactToExistingCandidate } from "@/lib/sourceLayer/server/candidateFactRecovery";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { hashJson } from "@/lib/server/v5CoreCommon";
import {
  buildInitialMarketWorkflowMetadata,
  writeMarketWorkflowMetadata,
} from "@/lib/marketWorkflow/metadata";
import { buildSampleSnapshot } from "@/lib/marketScan/metrics";
import {
  makeSampleInput,
  FIXTURE_NICHE_DEFINITION,
  FIXTURE_SAMPLE_DEFINITION,
} from "@/lib/marketScan/__fixtures__/productFactFixture";

const ownerContext: AccessContext = {
  mode: "owner",
  token: "owner-token",
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

describe("R2-1.5 Candidate Contract Upgrade (v2 -> v3)", () => {
  let tempStoreDir: string;
  let prevStoreDir: string | undefined;

  beforeEach(() => {
    tempStoreDir = mkdtempSync(join(tmpdir(), "v3-contract-test-"));
    prevStoreDir = process.env.SOURCE_LAYER_STORE_DIR;
    process.env.SOURCE_LAYER_STORE_DIR = tempStoreDir;
  });

  afterEach(() => {
    if (prevStoreDir === undefined) {
      delete process.env.SOURCE_LAYER_STORE_DIR;
    } else {
      process.env.SOURCE_LAYER_STORE_DIR = prevStoreDir;
    }
    rmSync(tempStoreDir, { recursive: true, force: true });
  });

  describe("Schema and Type Guards", () => {
    it("recognizes v1, v2, and v3 schemas", () => {
      expect(isV5MarketCandidateMeta({ schema: V5_MARKET_CANDIDATE_V1_SCHEMA })).toBe(true);
      expect(isV5MarketCandidateMeta({ schema: V5_MARKET_CANDIDATE_V2_SCHEMA })).toBe(true);
      expect(isV5MarketCandidateMeta({ schema: V5_MARKET_CANDIDATE_V3_SCHEMA })).toBe(true);
      expect(isV5MarketCandidateMeta({ schema: "unknown.v9" })).toBe(false);
      expect(isV5MarketCandidateMeta(null)).toBe(false);
      expect(isV5MarketCandidateMeta("string")).toBe(false);
    });

    it("extracts evidenceBinding from v3 meta", () => {
      const v3Meta: V5MarketCandidateV3Meta = {
        schema: V5_MARKET_CANDIDATE_V3_SCHEMA,
        asin: "B00000JBNX",
        identity: { asin: "B00000JBNX", title: "Test Board", marketplace: "US" },
        marketplace: "US",
        provenance: [],
        marketProvenance: {
          scanId: "scan-1",
          marketSampleKey: "scan-1:B00000JBNX",
          sampleHash: "hash-scan",
          role: "benchmark",
        },
        sourceLayerCapture: {
          version: 1,
          evidenceId: "ev-123",
          contentHash: "hash-123",
          subjectKey: "amazon:US:B00000JBNX",
        },
        evidenceBinding: {
          subjectKey: "amazon:US:B00000JBNX",
          evidenceId: "ev-123",
          captureId: "cap-123",
          evidenceVersion: 1,
          contentHash: "hash-123",
          evidenceRefs: ["evidence:ev-123"],
          readiness: "READY",
        },
        evidenceRefs: ["evidence:ev-123"],
        factHash: "fact-hash-1",
        evidenceHash: "ev-hash-1",
      };

      const binding = extractCandidateEvidenceBinding(v3Meta);
      expect(binding).toEqual({
        subjectKey: "amazon:US:B00000JBNX",
        evidenceId: "ev-123",
        captureId: "cap-123",
        evidenceVersion: 1,
        contentHash: "hash-123",
        evidenceRefs: ["evidence:ev-123"],
        readiness: "READY",
      });
    });

    it("extracts and normalizes legacy v2 sourceLayerCapture into standard evidenceBinding shape", () => {
      const v2Meta: V5MarketCandidateV2Meta = {
        schema: V5_MARKET_CANDIDATE_V2_SCHEMA,
        asin: "B00000JBNX",
        identity: { asin: "B00000JBNX", title: "Test Board", marketplace: "US" },
        marketplace: "US",
        provenance: [],
        marketProvenance: {
          scanId: "scan-1",
          marketSampleKey: "scan-1:B00000JBNX",
          sampleHash: "hash-scan",
          role: "benchmark",
        },
        sourceLayerCapture: {
          version: 2,
          evidenceId: "ev-legacy-456",
          contentHash: "hash-legacy-456",
          subjectKey: "amazon:US:B00000JBNX",
        },
        factHash: "fact-hash-legacy",
        evidenceHash: "ev-hash-legacy",
      };

      const binding = extractCandidateEvidenceBinding(v2Meta);
      expect(binding).toEqual({
        subjectKey: "amazon:US:B00000JBNX",
        evidenceId: "ev-legacy-456",
        captureId: null,
        evidenceVersion: 2,
        contentHash: "hash-legacy-456",
        evidenceRefs: ["evidence:ev-legacy-456"],
        readiness: "READY",
      });
    });

    it("builds standard evidenceBinding and v3 meta with buildV5MarketCandidateEvidenceBinding and buildV5MarketCandidateV3Meta", () => {
      const binding = buildV5MarketCandidateEvidenceBinding({
        subjectKey: "amazon:US:B0TESTASIN",
        evidenceId: "ev-test-1",
        evidenceVersion: 1,
        contentHash: "ch-test-1",
      });

      expect(binding).toEqual({
        subjectKey: "amazon:US:B0TESTASIN",
        evidenceId: "ev-test-1",
        captureId: null,
        evidenceVersion: 1,
        contentHash: "ch-test-1",
        evidenceRefs: ["evidence:ev-test-1"],
        readiness: "READY",
      });

      const meta = buildV5MarketCandidateV3Meta({
        asin: "B0TESTASIN",
        title: "Test Title",
        marketplace: "US",
        marketProvenance: {
          scanId: "scan-test",
          marketSampleKey: "scan-test:B0TESTASIN",
          sampleHash: "sh-test",
          role: "benchmark",
        },
        evidenceBinding: binding,
        factHash: "fh-test",
        evidenceHash: "eh-test",
      });

      expect(meta.schema).toBe(V5_MARKET_CANDIDATE_V3_SCHEMA);
      expect(meta.asin).toBe("B0TESTASIN");
      expect(meta.identity).toEqual({
        asin: "B0TESTASIN",
        title: "Test Title",
        marketplace: "US",
      });
      expect(meta.evidenceBinding).toBe(binding);
      expect(meta.evidenceRefs).toEqual(["evidence:ev-test-1"]);
      expect(meta.sourceLayerCapture).toEqual({
        version: 1,
        evidenceId: "ev-test-1",
        contentHash: "ch-test-1",
        subjectKey: "amazon:US:B0TESTASIN",
      });
      expect(meta.provenance).toHaveLength(1);
      expect(meta.marketProvenance.scanId).toBe("scan-test");
    });
  });

  describe("P4 Read Path Verification & Binding Validation", () => {
    it("verifyCandidateFactBinding accepts matching v3 evidenceBinding", () => {
      const asin = "B0MATCHV3";
      const record = makeEvidenceRecord(asin, "1".repeat(64));
      const fact = {
        schema: "product-fact.v3" as const,
        subjectKey: `amazon:US:${asin}`,
        sourceProof: {
          source: "sellersprite_xlsx" as const,
          subjectKey: `amazon:US:${asin}`,
          evidenceId: record.evidenceId,
          captureId: record.captureId,
          version: 1,
          contentHash: record.contentHash,
          capturedAt: record.capturedAt,
          sourceUrl: record.sourceUrl,
          operator: "owner:v1",
        },
        basic: { asin: { value: asin, status: "present" as const, source: "sellersprite_xlsx" as const, confidence: 1, capturedAt: record.capturedAt, rawProofHash: null } },
        market: {},
        profit: {},
      };
      const binding = buildV5MarketCandidateEvidenceBinding({
        subjectKey: `amazon:US:${asin}`,
        evidenceId: record.evidenceId,
        captureId: record.captureId,
        evidenceVersion: 1,
        contentHash: record.contentHash,
      });
      const meta = buildV5MarketCandidateV3Meta({
        asin,
        title: "Match Title",
        marketplace: "US",
        marketProvenance: { scanId: "scan-m", marketSampleKey: `scan-m:${asin}`, sampleHash: "sh-m", role: "benchmark" },
        evidenceBinding: binding,
        factHash: "fh-m",
        evidenceHash: "eh-m",
      });

      const res = verifyCandidateFactBinding({ meta, productFact: fact as never });
      expect(res.valid).toBe(true);
    });

    it("verifyCandidateFactBinding accepts legacy v2 sourceLayerCapture", () => {
      const asin = "B0MATCHV2";
      const record = makeEvidenceRecord(asin, "2".repeat(64));
      const fact = {
        schema: "product-fact.v3" as const,
        subjectKey: `amazon:US:${asin}`,
        sourceProof: {
          source: "sellersprite_xlsx" as const,
          subjectKey: `amazon:US:${asin}`,
          evidenceId: record.evidenceId,
          captureId: record.captureId,
          version: 1,
          contentHash: record.contentHash,
          capturedAt: record.capturedAt,
          sourceUrl: record.sourceUrl,
          operator: "owner:v1",
        },
        basic: { asin: { value: asin, status: "present" as const, source: "sellersprite_xlsx" as const, confidence: 1, capturedAt: record.capturedAt, rawProofHash: null } },
        market: {},
        profit: {},
      };
      const meta = {
        schema: V5_MARKET_CANDIDATE_V2_SCHEMA,
        asin,
        sourceLayerCapture: {
          version: 1,
          evidenceId: record.evidenceId,
          contentHash: record.contentHash,
          subjectKey: `amazon:US:${asin}`,
        },
      };

      const res = verifyCandidateFactBinding({ meta, productFact: fact as never });
      expect(res.valid).toBe(true);
    });

    it("verifyCandidateFactBinding rejects legacy v1 namespace without an evidence binding", () => {
      const asin = "B0MATCHV1";
      const record = makeEvidenceRecord(asin, "3".repeat(64));
      const fact = {
        schema: "product-fact.v3" as const,
        subjectKey: `amazon:US:${asin}`,
        sourceProof: {
          source: "sellersprite_xlsx" as const,
          subjectKey: `amazon:US:${asin}`,
          evidenceId: record.evidenceId,
          captureId: record.captureId,
          version: 1,
          contentHash: record.contentHash,
          capturedAt: record.capturedAt,
          sourceUrl: record.sourceUrl,
          operator: "owner:v1",
        },
        basic: { asin: { value: asin, status: "present" as const, source: "sellersprite_xlsx" as const, confidence: 1, capturedAt: record.capturedAt, rawProofHash: null } },
        market: {},
        profit: {},
      };
      const meta = {
        schema: V5_MARKET_CANDIDATE_V1_SCHEMA,
        asin,
      };

      const res = verifyCandidateFactBinding({ meta, productFact: fact as never });
      expect(res).toMatchObject({ valid: false, code: "EVIDENCE_BINDING_MISSING" });
    });

    it("verifyCandidateFactBinding fails closed on EVIDENCE_NOT_CAPTURED", () => {
      const asin = "B0NOTCAP";
      const fact = {
        schema: "product-fact.v3" as const,
        subjectKey: `amazon:US:${asin}`,
        sourceProof: {
          source: "sellersprite_xlsx" as const,
          subjectKey: `amazon:US:${asin}`,
          evidenceId: "ev-notcap",
          captureId: "cap-notcap",
          version: 1,
          contentHash: "ch-notcap",
          capturedAt: "2026-09-20T00:00:00.000Z",
          sourceUrl: "url",
          operator: "owner:v1",
        },
        basic: { asin: { value: asin, status: "present" as const, source: "sellersprite_xlsx" as const, confidence: 1, capturedAt: "2026-09-20T00:00:00.000Z", rawProofHash: null } },
        market: {},
        profit: {},
      };
      const binding = buildV5MarketCandidateEvidenceBinding({
        subjectKey: `amazon:US:${asin}`,
        readiness: "NOT_CAPTURED",
      });
      const meta = {
        schema: V5_MARKET_CANDIDATE_V3_SCHEMA,
        asin,
        evidenceBinding: binding,
      };

      const res = verifyCandidateFactBinding({ meta, productFact: fact as never });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.code).toBe("EVIDENCE_NOT_CAPTURED");
      }
    });

    it("verifyCandidateFactBinding fails closed on contentHash mismatch (stale binding)", () => {
      const asin = "B0STALE";
      const fact = {
        schema: "product-fact.v3" as const,
        subjectKey: `amazon:US:${asin}`,
        sourceProof: {
          source: "sellersprite_xlsx" as const,
          subjectKey: `amazon:US:${asin}`,
          evidenceId: "ev-1",
          captureId: "cap-1",
          version: 1,
          contentHash: "hash-new",
          capturedAt: "2026-09-20T00:00:00.000Z",
          sourceUrl: "url",
          operator: "owner:v1",
        },
        basic: { asin: { value: asin, status: "present" as const, source: "sellersprite_xlsx" as const, confidence: 1, capturedAt: "2026-09-20T00:00:00.000Z", rawProofHash: null } },
        market: {},
        profit: {},
      };
      const binding = buildV5MarketCandidateEvidenceBinding({
        subjectKey: `amazon:US:${asin}`,
        evidenceId: "ev-1",
        contentHash: "hash-old-stale",
        evidenceVersion: 1,
      });
      const meta = {
        schema: V5_MARKET_CANDIDATE_V3_SCHEMA,
        asin,
        evidenceBinding: binding,
      };

      const res = verifyCandidateFactBinding({ meta, productFact: fact as never });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.code).toBe("CONTENT_HASH_MISMATCH");
      }
    });

    it("buildResearchInputBundle fails closed when evidence in store is not passed or not ready", async () => {
      const asin = "B0UNPASSED";
      const record = makeEvidenceRecord(asin, "u".repeat(64));
      record.validation = {
        verdict: "blocked",
        readyForResearch: false,
        issueCodes: ["INVALID_DATA"],
        checkedAt: "2026-09-20T00:00:00.000Z",
      };

      const store = createEvidenceStore("owner:v1");
      await store.appendEvidence({
        evidence: record,
        auditEntries: [],
        operator: "owner:v1",
        now: new Date(),
      });

      const candidateMock = {
        id: "cand-unpassed",
        link: `https://www.amazon.com/dp/${asin}`,
        convertedTaskId: "task-unpassed",
        sourceMetaJson: JSON.stringify({
          schema: V5_MARKET_CANDIDATE_V3_SCHEMA,
          asin,
          identity: { asin, title: "Unpassed Board", marketplace: "US" },
          marketplace: "US",
          evidenceBinding: {
            subjectKey: `amazon:US:${asin}`,
            evidenceId: record.evidenceId,
            captureId: record.captureId,
            evidenceVersion: 1,
            contentHash: record.contentHash,
            evidenceRefs: [`evidence:${record.evidenceId}`],
            readiness: "READY",
          },
          sourceLayerCapture: {
            version: 1,
            evidenceId: record.evidenceId,
            contentHash: record.contentHash,
            subjectKey: `amazon:US:${asin}`,
          },
          factHash: "fh-unpassed",
          evidenceHash: "eh-unpassed",
          productFact: {
            schema: "product-fact.v3",
            subjectKey: `amazon:US:${asin}`,
            sourceProof: {
              source: "sellersprite_xlsx",
              subjectKey: `amazon:US:${asin}`,
              evidenceId: record.evidenceId,
              captureId: record.captureId,
              version: 1,
              contentHash: record.contentHash,
              capturedAt: record.capturedAt,
              sourceUrl: record.sourceUrl,
              operator: "owner:v1",
            },
            basic: { asin: { value: asin, status: "present", source: "sellersprite_xlsx", confidence: 1, capturedAt: record.capturedAt, rawProofHash: null } },
            market: {},
            profit: {},
          },
        }),
      };

      const taskMock = {
        id: "task-unpassed",
        type: "workflow",
        decisionStatus: "pending",
        updatedAt: new Date(),
        resultJson: JSON.stringify({
          type: "v5-research",
          candidateToTask: { candidateId: "cand-unpassed" },
        }),
      };

      const { prisma } = await import("@/lib/server/db");
      const candFindSpy = (vi.spyOn(prisma.opportunityCandidate, "findUnique") as any).mockResolvedValue(candidateMock as never);
      const taskFindSpy = (vi.spyOn(prisma.viralAnalysisRecord, "findUnique") as any).mockResolvedValue(taskMock as never);

      try {
        await expect(
          buildResearchInputBundle({
            context: ownerContext,
            taskId: "task-unpassed",
            recordDiagnostic: false,
          }),
        ).rejects.toThrow("RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING");
      } finally {
        candFindSpy.mockRestore();
        taskFindSpy.mockRestore();
      }
    });
  });

  describe("Fact Recovery and Evidence Binding Lifecycle", () => {
    it("attaches ProductFact to v3 candidate and upgrades evidenceBinding to READY with resolved captureId", async () => {
      const asin = "B012345678";
      const record = makeEvidenceRecord(asin, "b".repeat(64));
      const store = createEvidenceStore("owner:v1");
      await store.appendEvidence({
        evidence: record,
        auditEntries: [],
        operator: "owner:v1",
        now: new Date(),
      });

      const candidateMock = {
        id: "cand-v3-test",
        link: `https://www.amazon.com/dp/${asin}`,
        sourceMetaJson: JSON.stringify({
          schema: V5_MARKET_CANDIDATE_V3_SCHEMA,
          asin,
          identity: { asin, title: "Initial Title", marketplace: "US" },
          marketplace: "US",
          evidenceBinding: {
            subjectKey: `amazon:US:${asin}`,
            evidenceId: record.evidenceId,
            captureId: null,
            evidenceVersion: 1,
            contentHash: record.contentHash,
            evidenceRefs: [`evidence:${record.evidenceId}`],
            readiness: "READY",
          },
          sourceLayerCapture: {
            version: 1,
            evidenceId: record.evidenceId,
            contentHash: record.contentHash,
            subjectKey: `amazon:US:${asin}`,
          },
          factHash: "fh-1",
          evidenceHash: "eh-1",
        }),
      };

      const { prisma } = await import("@/lib/server/db");
      const findUniqueSpy = (vi.spyOn(prisma.opportunityCandidate, "findUnique") as any).mockResolvedValue(candidateMock as never);
      let updatedSourceMeta: string | null = null;
      const updateSpy = (vi.spyOn(prisma.opportunityCandidate, "update") as any).mockImplementation(async ({ data }: { data: { sourceMetaJson?: string } }) => {
        updatedSourceMeta = data.sourceMetaJson ?? null;
        return { ...candidateMock, sourceMetaJson: updatedSourceMeta! } as never;
      });

      try {
        const result = await attachProductFactToExistingCandidate({
          candidateId: "cand-v3-test",
          context: ownerContext,
        });

        expect(result.alreadyAttached).toBe(false);
        expect(result.productFact.basic.asin.value).toBe(asin);
        expect(updatedSourceMeta).not.toBeNull();

        const updatedParsed = JSON.parse(updatedSourceMeta!);
        expect(updatedParsed.schema).toBe(V5_MARKET_CANDIDATE_V3_SCHEMA);
        expect(updatedParsed.evidenceBinding).toMatchObject({
          subjectKey: `amazon:US:${asin}`,
          evidenceId: record.evidenceId,
          captureId: record.captureId,
          evidenceVersion: 1,
          contentHash: record.contentHash,
          readiness: "READY",
          evidenceRefs: [`evidence:${record.evidenceId}`],
        });
        expect(updatedParsed.evidenceRefs).toEqual([`evidence:${record.evidenceId}`]);
        expect(updatedParsed.sourceLayerCapture).toMatchObject({
          version: 1,
          evidenceId: record.evidenceId,
          contentHash: record.contentHash,
        });
      } finally {
        findUniqueSpy.mockRestore();
        updateSpy.mockRestore();
      }
    });

    it("attaches ProductFact to legacy v2 candidate seamlessly (backward compatibility)", async () => {
      const asin = "B087654321";
      const record = makeEvidenceRecord(asin, "c".repeat(64));
      const store = createEvidenceStore("owner:v1");
      await store.appendEvidence({
        evidence: record,
        auditEntries: [],
        operator: "owner:v1",
        now: new Date(),
      });

      const candidateMock = {
        id: "cand-v2-legacy",
        link: `https://www.amazon.com/dp/${asin}`,
        sourceMetaJson: JSON.stringify({
          schema: V5_MARKET_CANDIDATE_V2_SCHEMA,
          asin,
          identity: { asin, title: "V2 Title", marketplace: "US" },
          marketplace: "US",
          sourceLayerCapture: {
            version: 1,
            evidenceId: record.evidenceId,
            contentHash: record.contentHash,
            subjectKey: `amazon:US:${asin}`,
          },
          factHash: "fh-v2",
          evidenceHash: "eh-v2",
        }),
      };

      const { prisma } = await import("@/lib/server/db");
      const findUniqueSpy = (vi.spyOn(prisma.opportunityCandidate, "findUnique") as any).mockResolvedValue(candidateMock as never);
      let updatedSourceMeta: string | null = null;
      const updateSpy = (vi.spyOn(prisma.opportunityCandidate, "update") as any).mockImplementation(async ({ data }: { data: { sourceMetaJson?: string } }) => {
        updatedSourceMeta = data.sourceMetaJson ?? null;
        return { ...candidateMock, sourceMetaJson: updatedSourceMeta! } as never;
      });

      try {
        const result = await attachProductFactToExistingCandidate({
          candidateId: "cand-v2-legacy",
          context: ownerContext,
        });

        expect(result.alreadyAttached).toBe(false);
        expect(result.productFact.basic.asin.value).toBe(asin);

        const updatedParsed = JSON.parse(updatedSourceMeta!);
        expect(updatedParsed.productFact).toBeDefined();
        expect(updatedParsed.productFact.subjectKey).toBe(`amazon:US:${asin}`);
        expect(updatedParsed.sourceLayerCapture.version).toBe(1);
      } finally {
        findUniqueSpy.mockRestore();
        updateSpy.mockRestore();
      }
    });
  });

  describe("End-to-End Market Candidate -> ResearchInputBundle Integration", () => {
    it("builds ResearchInputBundle without RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING when candidate has attached ProductFact", async () => {
      const asin = "B099999999";
      const record = makeEvidenceRecord(asin, "d".repeat(64));
      const store = createEvidenceStore("owner:v1");
      await store.appendEvidence({
        evidence: record,
        auditEntries: [],
        operator: "owner:v1",
        now: new Date(),
      });

      const candidateMock = {
        id: "cand-e2e-1",
        convertedTaskId: "task-e2e-1",
        name: "Test Product E2E",
        link: `https://www.amazon.com/dp/${asin}`,
        sourceMetaJson: JSON.stringify({
          schema: V5_MARKET_CANDIDATE_V3_SCHEMA,
          asin,
          identity: { asin, title: "Test Product E2E", marketplace: "US" },
          marketplace: "US",
          evidenceBinding: {
            subjectKey: `amazon:US:${asin}`,
            evidenceId: record.evidenceId,
            captureId: null,
            evidenceVersion: 1,
            contentHash: record.contentHash,
            evidenceRefs: [`evidence:${record.evidenceId}`],
            readiness: "READY",
          },
          sourceLayerCapture: {
            version: 1,
            evidenceId: record.evidenceId,
            contentHash: record.contentHash,
            subjectKey: `amazon:US:${asin}`,
          },
          factHash: "fh-e2e",
          evidenceHash: "eh-e2e",
        }),
      };

      const taskMock = {
        id: "task-e2e-1",
        type: "workflow",
        decisionStatus: "pending",
        updatedAt: new Date(),
        resultJson: JSON.stringify({
          type: "v5-research",
          candidateToTask: { candidateId: "cand-e2e-1" },
        }),
      };

      const { prisma } = await import("@/lib/server/db");
      let currentCand = { ...candidateMock };
      const candFindSpy = (vi.spyOn(prisma.opportunityCandidate, "findUnique") as any).mockImplementation(async () => currentCand as never);
      const candUpdateSpy = (vi.spyOn(prisma.opportunityCandidate, "update") as any).mockImplementation(async ({ data }: { data: { sourceMetaJson?: string } }) => {
        currentCand = { ...currentCand, sourceMetaJson: data.sourceMetaJson ?? currentCand.sourceMetaJson };
        return currentCand as never;
      });
      const taskFindSpy = vi.spyOn(prisma.viralAnalysisRecord, "findUnique").mockResolvedValue(taskMock as never);

      try {
        // 先恢复事实
        await attachProductFactToExistingCandidate({
          candidateId: "cand-e2e-1",
          context: ownerContext,
        });

        // 验证 buildResearchInputBundle 能正常通过，不报 RESEARCH_INPUT_BUNDLE_EVIDENCE_MISSING
        const bundle = await buildResearchInputBundle({
          context: ownerContext,
          taskId: "task-e2e-1",
          recordDiagnostic: false,
        });

        expect(bundle.subjectKey).toBe(`amazon:US:${asin}`);
        expect(bundle.productFact).not.toBeNull();
        expect(bundle.productFact?.basic.asin.value).toBe(asin);
        expect(bundle.sourceEvidenceRefs[0]).toMatchObject({
          refId: `evidence:${record.evidenceId}`,
          evidenceId: record.evidenceId,
          captureId: record.captureId,
          version: 1,
          contentHash: record.contentHash,
        });
      } finally {
        candFindSpy.mockRestore();
        candUpdateSpy.mockRestore();
        taskFindSpy.mockRestore();
      }
    });

    it("missing cache fails closed without Candidate writes; explicit recovery makes the same read succeed", async () => {
      const asin = "B0AUTORECOV";
      const record = makeEvidenceRecord(asin, "e".repeat(64));
      const store = createEvidenceStore("owner:v1");
      await store.appendEvidence({
        evidence: record,
        auditEntries: [],
        operator: "owner:v1",
        now: new Date(),
      });

      // 候选尚未附加 productFact
      const candidateMock = {
        id: "cand-autorecov",
        convertedTaskId: "task-autorecov",
        name: "Auto Recov Product",
        link: `https://www.amazon.com/dp/${asin}`,
        sourceMetaJson: JSON.stringify({
          schema: V5_MARKET_CANDIDATE_V3_SCHEMA,
          asin,
          identity: { asin, title: "Auto Recov Product", marketplace: "US" },
          marketplace: "US",
          evidenceBinding: {
            subjectKey: `amazon:US:${asin}`,
            evidenceId: record.evidenceId,
            captureId: null,
            evidenceVersion: 1,
            contentHash: record.contentHash,
            evidenceRefs: [`evidence:${record.evidenceId}`],
            readiness: "READY",
          },
          sourceLayerCapture: {
            version: 1,
            evidenceId: record.evidenceId,
            contentHash: record.contentHash,
            subjectKey: `amazon:US:${asin}`,
          },
          factHash: "fh-auto",
          evidenceHash: "eh-auto",
        }),
      };

      const taskMock = {
        id: "task-autorecov",
        type: "workflow",
        decisionStatus: "pending",
        updatedAt: new Date(),
        resultJson: JSON.stringify({
          type: "v5-research",
          candidateToTask: { candidateId: "cand-autorecov" },
        }),
      };

      const { prisma } = await import("@/lib/server/db");
      let currentCand = { ...candidateMock };
      const candFindSpy = (vi.spyOn(prisma.opportunityCandidate, "findUnique") as any).mockImplementation(async () => currentCand as never);
      const candUpdateSpy = (vi.spyOn(prisma.opportunityCandidate, "update") as any).mockImplementation(async ({ data }: { data: { sourceMetaJson?: string } }) => {
        currentCand = { ...currentCand, sourceMetaJson: data.sourceMetaJson ?? currentCand.sourceMetaJson };
        return currentCand as never;
      });
      const taskFindSpy = vi.spyOn(prisma.viralAnalysisRecord, "findUnique").mockResolvedValue(taskMock as never);

      try {
        // Recovery is an explicit write, never triggered by a Research read.
        const original = currentCand.sourceMetaJson;
        await expect(buildResearchInputBundle({ context: ownerContext, taskId: "task-autorecov", recordDiagnostic: false }))
          .rejects.toMatchObject({ code: "product_fact_missing", status: 409 });
        expect(candUpdateSpy).not.toHaveBeenCalled();
        expect(currentCand.sourceMetaJson).toBe(original);
        await attachProductFactToExistingCandidate({ context: ownerContext, candidateId: currentCand.id });
        const bundle = await buildResearchInputBundle({
          context: ownerContext,
          taskId: "task-autorecov",
          recordDiagnostic: false,
        });

        expect(bundle.subjectKey).toBe(`amazon:US:${asin}`);
        expect(bundle.productFact?.basic.asin.value).toBe(asin);
        expect(bundle.sourceEvidenceRefs[0].refId).toBe(`evidence:${record.evidenceId}`);
      } finally {
        candFindSpy.mockRestore();
        candUpdateSpy.mockRestore();
        taskFindSpy.mockRestore();
      }
    });

    it("handoffMarketToResearch writes v5-market-candidate.v3 with full evidenceBinding, evidenceRefs and marketProvenance", async () => {
      const asin = "B0HANDOFF3";
      const record = makeEvidenceRecord(asin, "f".repeat(64));
      const store = createEvidenceStore("owner:v1");
      await store.appendEvidence({
        evidence: record,
        auditEntries: [],
        operator: "owner:v1",
        now: new Date(),
      });

      const scanId = "scan-handoff-test";
      const marketSampleKey = `${scanId}:${asin}`;

      const snapshot = buildSampleSnapshot({
        nicheDefinition: FIXTURE_NICHE_DEFINITION,
        sampleDefinition: FIXTURE_SAMPLE_DEFINITION,
        metricsVersion: "market-metrics.v1",
        sample: [
          makeSampleInput({
            asin,
            title: "Handoff V3 Board",
            evidenceIdOverride: record.evidenceId,
            contentHash: record.contentHash,
            capturedAt: record.capturedAt,
          }),
          ...Array.from({ length: 29 }, (_, i) => makeSampleInput({
            asin: "B" + String(i + 10).padStart(9, "0"),
          })),
        ],
      });

      const metrics = {
        schemaVersion: "market-metrics.v1",
        sampleCount: 30,
        validSampleCount: 30,
        price: { status: "PRESENT", value: { median: 20, coveragePct: 100 }, sampleSize: 30, missingCount: 0, calculationVersion: "fixture.v1" },
        sales: { status: "PRESENT", value: { median: 100, coveragePct: 100 }, sampleSize: 30, missingCount: 0, calculationVersion: "fixture.v1" },
        brandConcentration: {
          brandCr5: { status: "PRESENT", value: { median: 50, coveragePct: 100 }, sampleSize: 30, missingCount: 0, calculationVersion: "fixture.v1" },
        },
        evidenceWindow: {
          earliestCapturedAt: "2026-09-28T00:00:00.000Z",
          latestCapturedAt: "2026-09-29T12:00:00.000Z",
          observedAtSource: "evidence_captured_at",
        },
      };

      const initialWorkflow = buildInitialMarketWorkflowMetadata({
        scanId,
        sampleHash: snapshot.sampleHash,
        metricsHash: hashJson(metrics),
        metricsVersion: "market-metrics.v1",
      });

      const workflowMeta = {
        ...initialWorkflow,
        marketGate: {
          ...initialWorkflow.marketGate,
          status: "PROCEED" as const,
          reason: "Approved for research",
          chosenAt: "2026-09-29T12:00:00.000Z",
          chosenBy: "owner:v1",
        },
        representatives: {
          ...initialWorkflow.representatives,
          selectedAt: "2026-09-29T12:00:00.000Z",
          selectedBy: "owner:v1",
          items: [{
            marketSampleKey,
            asin,
            subjectKey: `amazon:US:${asin}`,
            role: "benchmark" as const,
            note: "Benchmark test item",
            selectedAt: "2026-09-29T12:00:00.000Z",
            selectedBy: "owner:v1",
          }],
        },
      };

      const scanMock = {
        id: scanId,
        ownerScope: "owner:v1",
        scanName: "Test Handoff Scan",
        marketplace: "US",
        nicheKind: "keyword",
        nicheDefinitionJson: JSON.stringify(FIXTURE_NICHE_DEFINITION),
        sampleDefinitionJson: writeMarketWorkflowMetadata(JSON.stringify(FIXTURE_SAMPLE_DEFINITION), workflowMeta),
        sampleSnapshotJson: JSON.stringify(snapshot),
        metricsJson: JSON.stringify(metrics),
        sampleCount: 30,
        sampleHash: snapshot.sampleHash,
        metricsVersion: "market-metrics.v1",
        createdAt: new Date(),
        updatedAt: new Date(),
        archivedAt: null,
      };

      let createdCandidateData: Record<string, unknown> | null = null;
      let createdTaskData: Record<string, unknown> | null = null;

      const { prisma } = await import("@/lib/server/db");
      const scanFindSpy = vi.spyOn(prisma.marketScan, "findUnique").mockResolvedValue(scanMock as never);
      const lifecycleFindSpy = vi.spyOn(prisma.v5MarketSampleLifecycle, "findMany").mockResolvedValue([] as never);
      const receiptFindSpy = vi.spyOn(prisma.v5OperationReceipt, "findUnique").mockResolvedValue(null as never);
      const receiptCreateSpy = vi.spyOn(prisma.v5OperationReceipt, "create").mockResolvedValue({ id: "rec-1" } as never);
      const receiptUpdateSpy = vi.spyOn(prisma.v5OperationReceipt, "update").mockResolvedValue({ id: "rec-1" } as never);

      const txMock = {
        opportunityCandidate: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            createdCandidateData = data;
            return { id: "cand-handoff-created", ...data, convertedTaskId: null, createdAt: new Date(), updatedAt: new Date() };
          }),
          update: vi.fn(),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        viralAnalysisRecord: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
            createdTaskData = data;
            return { id: "task-handoff-created", ...data, createdAt: new Date(), updatedAt: new Date() };
          }),
        },
      };

      const txSpy = (vi.spyOn(prisma, "$transaction") as any).mockImplementation(async (callback: (tx: unknown) => unknown) => {
        return callback(txMock);
      });

      const candFindUniqueSpy = (vi.spyOn(prisma.opportunityCandidate, "findUnique") as any).mockImplementation(async () => {
        return { id: "cand-handoff-created", ...(createdCandidateData ?? {}) } as never;
      });
      const candUpdateSpy = (vi.spyOn(prisma.opportunityCandidate, "update") as any).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        createdCandidateData = { ...(createdCandidateData ?? {}), ...data };
        return { id: "cand-handoff-created", ...createdCandidateData } as never;
      });

      const { handoffMarketToResearch } = await import("@/lib/server/v5MarketService");

      try {
        const result = await handoffMarketToResearch({
          context: ownerContext,
          scanId,
          expectedScanHash: snapshot.sampleHash,
          selections: [{
            marketSampleKey,
            asin,
            subjectKey: `amazon:US:${asin}`,
            role: "benchmark",
          }],
          idempotencyKey: "test-handoff-key-1",
        });

        expect(result.items[0].outcome).not.toBe("failed");
        expect(createdCandidateData).not.toBeNull();

        const meta = JSON.parse(createdCandidateData!.sourceMetaJson as string);
        expect(meta.schema).toBe("v5-market-candidate.v3");
        expect(meta.asin).toBe(asin);
        expect(meta.identity).toEqual({
          asin,
          title: "Handoff V3 Board",
          marketplace: "US",
        });
        expect(meta.marketProvenance).toMatchObject({
          scanId,
          marketScanId: scanId,
          marketSampleKey,
          sampleHash: snapshot.sampleHash,
          role: "benchmark",
        });
        expect(meta.evidenceBinding).toMatchObject({
          subjectKey: `amazon:US:${asin}`,
          evidenceId: record.evidenceId,
          captureId: record.captureId,
          evidenceVersion: 1,
          contentHash: record.contentHash,
          readiness: "READY",
          evidenceRefs: [`evidence:${record.evidenceId}`],
        });
        expect(meta.evidenceRefs).toEqual([`evidence:${record.evidenceId}`]);
        expect(meta.sourceLayerCapture).toMatchObject({
          version: 1,
          evidenceId: record.evidenceId,
          contentHash: record.contentHash,
          subjectKey: `amazon:US:${asin}`,
        });
        expect(meta.productFact).toBeDefined();

        expect(createdTaskData).not.toBeNull();
        const taskResult = JSON.parse(createdTaskData!.resultJson as string);
        expect(taskResult.v5Research.evidenceRefs).toContain(`evidence:${record.evidenceId}`);
        // 任务身份必须是规范绑定：缺 version 会让人工决定 / VOC 证据路径判定为「无候选绑定」
        expect(taskResult.candidateToTask).toMatchObject({
          version: 1,
          candidateId: "cand-handoff-created",
          confirmation: "research_started",
        });
      } finally {
        scanFindSpy.mockRestore();
        lifecycleFindSpy.mockRestore();
        receiptFindSpy.mockRestore();
        receiptCreateSpy.mockRestore();
        receiptUpdateSpy.mockRestore();
        txSpy.mockRestore();
        candFindUniqueSpy.mockRestore();
        candUpdateSpy.mockRestore();
      }
    });
  });
});
