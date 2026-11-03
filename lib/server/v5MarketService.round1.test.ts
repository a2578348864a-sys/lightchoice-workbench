import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const scans = new Map<string, Record<string, unknown>>();
  return {
    scans,
    prisma: {
      // 人工范围确认（scopeStatus）走原生 SQL 读取；隔离夹具默认无人工范围行。
      $queryRaw: vi.fn(async () => []),
      marketScan: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => scans.get(where.id) ?? null),
        updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const current = scans.get(where.id);
          if (!current) throw new Error("fixture scan missing");
          const next = { ...current, ...data, updatedAt: new Date((current.updatedAt as Date).getTime() + 1_000) };
          scans.set(where.id, next);
          return { count: 1 };
        }),
      },
      v5MarketSampleLifecycle: {
        findMany: vi.fn(async () => []),
      },
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/db", () => ({ prisma: harness.prisma }));
vi.mock("@/lib/server/v5CoreCommon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/v5CoreCommon")>();
  return {
    ...actual,
    withV5Receipt: vi.fn(async (input: { execute: () => Promise<unknown> }) => ({
      value: await input.execute(),
      replayed: false,
      receiptId: "fixture-receipt",
    })),
  };
});

import { hashJson, V5CoreError } from "@/lib/server/v5CoreCommon";
import { evaluateMarketDecisionReadiness, marketProceedBlockReason } from "@/lib/marketScan/marketDecisionReadiness";
import {
  buildInitialMarketWorkflowMetadata,
  readMarketWorkflowMetadata,
  writeMarketWorkflowMetadata,
} from "@/lib/marketWorkflow/metadata";
import { buildSampleSnapshot } from "@/lib/marketScan/metrics";
import { makeSampleInput, FIXTURE_NICHE_DEFINITION, FIXTURE_SAMPLE_DEFINITION } from "@/lib/marketScan/__fixtures__/productFactFixture";
import { saveMarketGate } from "@/lib/server/v5MarketService";

const ownerContext = {
  mode: "owner" as const,
  token: "fixture-owner",
  isActive: true,
  isExpired: false,
  remainingAiCalls: 0,
};
const FIXTURE_TIME = "2026-09-29T12:00:00.000Z";
const SCAN_ID = "fixture-product-polish-r1-gate";
const SAMPLE_HASH = "a".repeat(64);
const METRICS_VERSION = "market-metrics.v1";
const REPRESENTATIVE = {
  marketSampleKey: `${SCAN_ID}:B0FIXTURE01`,
  asin: "B0FIXTURE01",
  subjectKey: "amazon:US:asin:B0FIXTURE01",
  role: "benchmark" as const,
  note: "TEST fixture representative; verify retention only.",
  selectedAt: FIXTURE_TIME,
  selectedBy: "owner:v1",
};

function metric(sampleSize: number, missingCount: number, status = "PRESENT") {
  return {
    status,
    value: status === "PRESENT" ? { median: 20, coveragePct: 100 } : null,
    sampleSize,
    missingCount,
    calculationVersion: "fixture.v1",
  };
}

function metricsOf(rawSampleCount: number, validSampleCount: number, criticalMissing = false) {
  const covered = criticalMissing ? Math.max(0, validSampleCount - 4) : validSampleCount;
  return {
    schemaVersion: "market-metrics.v1",
    sampleCount: rawSampleCount,
    validSampleCount,
    price: metric(validSampleCount, 0),
    sales: metric(covered, validSampleCount - covered, criticalMissing ? "NOT_AVAILABLE" : "PRESENT"),
    brandConcentration: {
      brandCr5: metric(covered, validSampleCount - covered, criticalMissing ? "NOT_AVAILABLE" : "PRESENT"),
    },
    evidenceWindow: {
      earliestCapturedAt: "2026-09-28T00:00:00.000Z",
      latestCapturedAt: FIXTURE_TIME,
      observedAtSource: "evidence_captured_at",
    },
  };
}

function seedScan(input: {
  readonly metrics: ReturnType<typeof metricsOf>;
  readonly gateStatus?: "PENDING" | "PROCEED" | "PAUSE";
  readonly withRepresentative?: boolean;
}) {
  const snapshot = buildSampleSnapshot({ nicheDefinition: FIXTURE_NICHE_DEFINITION, sampleDefinition: FIXTURE_SAMPLE_DEFINITION, metricsVersion: METRICS_VERSION,
    sample: Array.from({ length: input.metrics.sampleCount }, (_, i) => makeSampleInput({ asin: "B" + String(i + 1).padStart(9, "0") })) });
  const frozen = { ...snapshot, items: snapshot.items.map((item, i) => i < input.metrics.validSampleCount ? item : { ...item, evidenceStatus: "blocked" }) };
  const metricsJson = JSON.stringify(input.metrics);
  const initial = buildInitialMarketWorkflowMetadata({
    scanId: SCAN_ID,
    sampleHash: SAMPLE_HASH,
    metricsHash: hashJson(input.metrics),
    metricsVersion: METRICS_VERSION,
  });
  const workflow = {
    ...initial,
    marketGate: {
      ...initial.marketGate,
      status: input.gateStatus ?? "PENDING",
      reason: input.gateStatus === "PROCEED" ? "TEST fixture initial gate." : null,
      chosenAt: input.gateStatus === "PROCEED" ? FIXTURE_TIME : null,
      chosenBy: input.gateStatus === "PROCEED" ? "owner:v1" : null,
    },
    representatives: {
      ...initial.representatives,
      selectedAt: input.withRepresentative ? FIXTURE_TIME : null,
      selectedBy: input.withRepresentative ? "owner:v1" : null,
      items: input.withRepresentative ? [REPRESENTATIVE] : [],
    },
  };
  const now = new Date(FIXTURE_TIME);
  harness.scans.set(SCAN_ID, {
    id: SCAN_ID,
    ownerScope: "owner:v1",
    scanName: "TEST:fixture-product-polish-r1-gate",
    marketplace: "US",
    nicheKind: "keyword",
    nicheDefinitionJson: JSON.stringify({ schemaVersion: "market-niche.v1", kind: "keyword", label: "fixture" }),
    sampleDefinitionJson: writeMarketWorkflowMetadata(JSON.stringify({ schemaVersion: "market-sample-definition.v1" }), workflow),
    sampleSnapshotJson: JSON.stringify(frozen),
    metricsJson,
    sampleCount: input.metrics.sampleCount,
    metricsVersion: METRICS_VERSION,
    sampleHash: SAMPLE_HASH,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
}

function gate(status: "PROCEED" | "PAUSE", idempotencyKey: string, missingDataAcknowledged?: boolean) {
  const scan = harness.scans.get(SCAN_ID)!;
  return saveMarketGate({
    context: ownerContext,
    scanId: SCAN_ID,
    status,
    reason: "TEST fixture transaction guard verification.",
    missingDataAcknowledged,
    expectedScanHash: SAMPLE_HASH,
    expectedVersion: (scan.updatedAt as Date).toISOString(),
    idempotencyKey,
  });
}

function workflowFromSeededScan() {
  const scan = harness.scans.get(SCAN_ID)!;
  return readMarketWorkflowMetadata(JSON.parse(scan.sampleDefinitionJson as string), {
    scanId: SCAN_ID,
    sampleHash: SAMPLE_HASH,
    metricsHash: hashJson(JSON.parse(scan.metricsJson as string)),
    metricsVersion: METRICS_VERSION,
  });
}

beforeEach(() => {
  harness.scans.clear();
  vi.clearAllMocks();
});

describe("Round 1 isolated Market transaction guards", () => {
  it("R1-T01 blocks PROCEED at 29 valid samples with the exact business error", async () => {
    seedScan({ metrics: metricsOf(29, 29) });

    await expect(gate("PROCEED", "fixture-r1-t01"))
      .rejects.toMatchObject({ code: "MARKET_SAMPLE_INSUFFICIENT", status: 409 } satisfies Partial<V5CoreError>);
    expect(harness.prisma.marketScan.updateMany).not.toHaveBeenCalled();
  });

  it("R1-T02 treats 30 valid samples as sufficient without conflating readiness", () => {
    const readiness = evaluateMarketDecisionReadiness(metricsOf(30, 30));
    expect(readiness.sampleSufficiency).toBe("SAMPLE_SUFFICIENT");
    expect(readiness.status).toBe("READY");
    expect(readiness.validSampleCount).toBe(30);
  });

  it("R1-T03 blocks RAW 35 / VALID 28 at the server Gate", async () => {
    seedScan({ metrics: metricsOf(35, 28) });

    await expect(gate("PROCEED", "fixture-r1-t03"))
      .rejects.toMatchObject({ code: "MARKET_SAMPLE_INSUFFICIENT", status: 409 } satisfies Partial<V5CoreError>);
    expect(harness.prisma.marketScan.updateMany).not.toHaveBeenCalled();
  });

  it("R1-T04 reports RAW 50 / VALID 34 as sample-sufficient", () => {
    const readiness = evaluateMarketDecisionReadiness(metricsOf(50, 34));
    expect(readiness.rawSampleCount).toBe(50);
    expect(readiness.validSampleCount).toBe(34);
    expect(readiness.sampleSufficiency).toBe("SAMPLE_SUFFICIENT");
  });

  it("R1-T05 rejects PROCEED on 60 valid samples without missing data ack, but allows with explicit ack", async () => {
    const metrics = metricsOf(60, 60, true);
    seedScan({ metrics });
    const readiness = evaluateMarketDecisionReadiness(metrics);
    expect(readiness.sampleSufficiency).toBe("SAMPLE_SUFFICIENT");
    expect(readiness.status).toBe("READY_WITH_MISSING_DATA_CONFIRMATION");
    expect(marketProceedBlockReason(readiness)).toBe("MISSING_ACK_REQUIRED");

    // Call without acknowledgment -> rejects with MARKET_MISSING_DATA_ACK_REQUIRED (409)
    await expect(gate("PROCEED", "fixture-r1-t05-no-ack"))
      .rejects.toMatchObject({ code: "MARKET_MISSING_DATA_ACK_REQUIRED", status: 409 } satisfies Partial<V5CoreError>);
    expect(harness.prisma.marketScan.updateMany).not.toHaveBeenCalled();

    // Call with missingDataAcknowledged = true -> succeeds and records metadata
    const result = await gate("PROCEED", "fixture-r1-t05-with-ack", true);
    expect(harness.prisma.marketScan.updateMany).toHaveBeenCalled();
    const workflow = workflowFromSeededScan();
    expect(workflow.metadata.marketGate.missingDataAcknowledged).toBe(true);
    expect(workflow.metadata.marketGate.missingDataCodes).toEqual(["DEMAND_NOT_COMPLETE", "BRAND_CR5_NOT_COMPUTABLE"]);
    expect(workflow.effectiveGateStatus).toBe("PROCEED");
    expect((result.marketGate as { effectiveStatus?: string }).effectiveStatus).toBe("PROCEED");
  });

  it("R1-T05b hard blocks PROCEED when price is missing even if user attempts missingDataAcknowledged", async () => {
    const metrics = {
      ...metricsOf(60, 60),
      price: metric(0, 60, "NOT_AVAILABLE"),
    };
    seedScan({ metrics });
    const readiness = evaluateMarketDecisionReadiness(metrics);
    expect(readiness.status).toBe("NOT_READY");
    expect(marketProceedBlockReason(readiness, { missingDataAcknowledged: true })).toBe("NOT_READY");

    await expect(gate("PROCEED", "fixture-r1-t05b", true))
      .rejects.toMatchObject({ code: "MARKET_DECISION_NOT_READY", status: 409 } satisfies Partial<V5CoreError>);
    expect(harness.prisma.marketScan.updateMany).not.toHaveBeenCalled();
  });

  it("R1-T06/T07 preserves the saved representative through PROCEED → PAUSE → PROCEED", async () => {
    seedScan({ metrics: metricsOf(34, 34), gateStatus: "PROCEED", withRepresentative: true });
    const before = workflowFromSeededScan().metadata.representatives.items;

    await gate("PAUSE", "fixture-r1-t06");
    const paused = workflowFromSeededScan();
    expect(paused.effectiveGateStatus).toBe("PAUSE");
    expect(paused.metadata.representatives.items).toEqual(before);

    const resumed = await gate("PROCEED", "fixture-r1-t07");
    const after = workflowFromSeededScan();
    expect((resumed.marketGate as { effectiveStatus?: string }).effectiveStatus).toBe("PROCEED");
    expect(after.metadata.representatives.items).toEqual(before);
    expect(after.metadata.representatives.items[0]).toMatchObject({ asin: "B0FIXTURE01", role: "benchmark" });
  });
});
