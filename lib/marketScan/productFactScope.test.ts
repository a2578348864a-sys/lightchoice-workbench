import { describe, expect, it, vi } from "vitest";

import { makeProductFact } from "@/lib/marketScan/__fixtures__/productFactFixture";
import { projectProductFactsFromEvidence } from "@/lib/marketScan/productFactSource";

const evidenceState = vi.hoisted(() => ({
  entries: [] as Array<{ subjectKey: string; displayTitle: string | null }>,
  records: new Map<string, { versions: readonly unknown[] }>(),
}));

vi.mock("@/lib/sourceLayer/server/evidenceStore", () => ({
  createEvidenceStore: () => ({
    listSubjects: async () => evidenceState.entries,
    getSubject: async (subjectKey: string) => evidenceState.records.get(subjectKey) ?? null,
  }),
}));

vi.mock("@/lib/sourceLayer/fact/productFactAdapter", () => ({
  adaptEvidenceToProductFact: ({ evidence }: { evidence: { productFact: unknown } }) => evidence.productFact,
}));

function addEvidence(input: {
  asin: string;
  marketplace: string;
  source: "sellersprite_xlsx" | "sellersprite_plugin" | "manual";
  sourceRecordRef?: string;
  price?: number;
}) {
  const subjectKey = `amazon:${input.marketplace}:${input.asin}`;
  const productFact = makeProductFact({
    asin: input.asin,
    subjectKey,
    source: input.source,
    price: input.price ?? 19.99,
    contentHash: `${input.asin.toLowerCase().replace(/[^a-z0-9]/gu, "0")}`.padEnd(64, "0").slice(0, 64),
    evidenceId: `evidence-${input.asin}-${input.source}`,
  });
  const evidence = {
    subjectKey,
    version: 1,
    evidenceId: productFact.sourceProof.evidenceId,
    sourceType: input.source === "manual" ? "manual_entry" : input.source,
    capturedAt: productFact.sourceProof.capturedAt,
    contentHash: productFact.sourceProof.contentHash,
    pkg: {
      marketplace: input.marketplace,
      sourceProof: { sourceRecordRef: input.sourceRecordRef ?? null },
    },
    validation: { verdict: "ready", readyForResearch: true, issueCodes: [], checkedAt: "2026-08-01T00:00:00.000Z" },
    productFact,
  };
  evidenceState.entries.push({ subjectKey, displayTitle: input.asin });
  evidenceState.records.set(subjectKey, { versions: [evidence] });
}

describe("MarketScan sample scope filters", () => {
  it("filters mixed sourceTypes and marketplaces before requestedLimit", async () => {
    evidenceState.entries = [];
    evidenceState.records.clear();

    // These sort first but must be excluded before the limit is applied.
    addEvidence({ asin: "B0SCOP0001", marketplace: "JP", source: "sellersprite_xlsx" });
    addEvidence({ asin: "B0SCOP0002", marketplace: "US", source: "manual" });
    addEvidence({ asin: "B0SCOP0003", marketplace: "US", source: "sellersprite_xlsx" });
    addEvidence({ asin: "B0SCOP0004", marketplace: "US", source: "sellersprite_xlsx" });
    addEvidence({ asin: "B0SCOP0005", marketplace: "US", source: "sellersprite_xlsx" });

    const projections = await projectProductFactsFromEvidence({
      operator: "owner:v1",
      marketplace: "US",
      sourceTypes: ["sellersprite_xlsx"],
      limit: 2,
    });

    expect(projections).toHaveLength(2);
    expect(projections.map((projection) => projection.asin)).toEqual([
      "B0SCOP0003",
      "B0SCOP0004",
    ]);
    expect(projections.every((projection) => projection.marketplace === "US")).toBe(true);
    expect(projections.every((projection) => projection.sourceType === "sellersprite_xlsx")).toBe(true);
  });

  it("uses sourceRecordRefs to keep two batches with the same ASIN separate", async () => {
    evidenceState.entries = [];
    evidenceState.records.clear();
    const subjectKey = "amazon:US:B0BATC0001";
    const first = makeProductFact({
      asin: "B0BATC0001",
      subjectKey,
      source: "sellersprite_xlsx",
      price: 10,
      evidenceId: "evidence-batch-a",
      contentHash: "a".repeat(64),
    });
    const second = makeProductFact({
      asin: "B0BATC0001",
      subjectKey,
      source: "sellersprite_xlsx",
      price: 99,
      evidenceId: "evidence-batch-b",
      contentHash: "b".repeat(64),
    });
    evidenceState.entries.push({ subjectKey, displayTitle: "same ASIN in two batches" });
    evidenceState.records.set(subjectKey, {
      versions: [
        { subjectKey, version: 1, evidenceId: first.sourceProof.evidenceId, sourceType: "sellersprite_xlsx", capturedAt: first.sourceProof.capturedAt, contentHash: first.sourceProof.contentHash, pkg: { marketplace: "US", sourceProof: { sourceRecordRef: "batch-item-a" } }, validation: { verdict: "ready", readyForResearch: true, issueCodes: [], checkedAt: "2026-08-01T00:00:00.000Z" }, productFact: first },
        { subjectKey, version: 2, evidenceId: second.sourceProof.evidenceId, sourceType: "sellersprite_xlsx", capturedAt: second.sourceProof.capturedAt, contentHash: second.sourceProof.contentHash, pkg: { marketplace: "US", sourceProof: { sourceRecordRef: "batch-item-b" } }, validation: { verdict: "ready", readyForResearch: true, issueCodes: [], checkedAt: "2026-08-02T00:00:00.000Z" }, productFact: second },
      ],
    });

    const projections = await projectProductFactsFromEvidence({
      operator: "owner:v1",
      marketplace: "US",
      sourceTypes: ["sellersprite_xlsx"],
      sourceRecordRefs: { [subjectKey]: "batch-item-a" },
    });

    expect(projections).toHaveLength(1);
    expect(projections[0].evidenceVersion).toBe(1);
    expect(projections[0].productFact.basic.price.value?.amount).toBe(10);
  });
});
