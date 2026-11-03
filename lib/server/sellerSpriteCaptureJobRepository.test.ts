import { describe, expect, it } from "vitest";

import { createSellerSpriteCaptureJobRepository } from "@/lib/server/sellerSpriteCaptureJobRepository";

type Row = Record<string, unknown> & {
  id: string; actorScope: string; operation: string; resourceKey: string; idempotencyKey: string;
  requestHash: string; status: string; responseJson: string | null; expiresAt: Date | null; updatedAt: Date;
};

function memoryDatabase() {
  const rows = new Map<string, Row>();
  const byId = (id: string) => [...rows.values()].find((row) => row.id === id) ?? null;
  const matches = (row: Row, where: Record<string, unknown>) => {
    for (const [key, expected] of Object.entries(where)) {
      if (key === "actorScope_operation_resourceKey_idempotencyKey") {
        const identity = expected as Record<string, string>;
        if (row.actorScope !== identity.actorScope || row.operation !== identity.operation
          || row.resourceKey !== identity.resourceKey || row.idempotencyKey !== identity.idempotencyKey) return false;
      } else if (key === "OR") {
        const filters = expected as Array<Record<string, unknown>>;
        if (!filters.some((filter) => matches(row, filter))) return false;
      } else if (key === "status" && typeof expected === "object" && expected !== null && "in" in expected) {
        if (!(expected.in as string[]).includes(row.status)) return false;
      } else if (key === "expiresAt" && typeof expected === "object" && expected !== null && "lte" in expected) {
        if (row.expiresAt && row.expiresAt > (expected.lte as Date)) return false;
      } else if (key === "expiresAt" && typeof expected === "object" && expected !== null && "gt" in expected) {
        if (!row.expiresAt || row.expiresAt <= (expected.gt as Date)) return false;
      } else if (row[key] !== expected) return false;
    }
    return true;
  };
  const delegate = {
    findUnique: async ({ where }: { where: Record<string, unknown> }) => where.id ? byId(String(where.id))
      : [...rows.values()].find((row) => matches(row, where.actorScope_operation_resourceKey_idempotencyKey as Record<string, unknown>)) ?? null,
    findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
      [...rows.values()].filter((row) => matches(row, where)).slice(0, take),
    create: async ({ data }: { data: Row }) => {
      if ([...rows.values()].some((row) => row.id === data.id || matches(row, {
        actorScope_operation_resourceKey_idempotencyKey: {
          actorScope: data.actorScope, operation: data.operation,
          resourceKey: data.resourceKey, idempotencyKey: data.idempotencyKey,
        },
      }))) throw new Error("UNIQUE");
      rows.set(data.id, { ...data, updatedAt: new Date(data.responseJson ? (JSON.parse(data.responseJson) as { updatedAt: string }).updatedAt : Date.now()) });
      return data;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const row = byId(String(where.id));
      if (!row || !matches(row, where)) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date((JSON.parse(String(data.responseJson)) as { updatedAt: string }).updatedAt) });
      return { count: 1 };
    },
  };
  return { v5OperationReceipt: delegate } as never;
}

describe("SellerSprite capture receipt repository", () => {
  it("persists source-limit history and atomically admits only one explicit recheck", async () => {
    const repository=createSellerSpriteCaptureJobRepository(memoryDatabase());
    const now=new Date("2026-10-24T00:00:00Z");
    const {job}=await repository.ensure({module:"reverse_asin",marketplace:"US",query:{targetAsin:"B012345678"},accessScope:"owner"},now);
    const claim=(await repository.claim(job.jobId,"initial",now))!;
    await repository.saveProgress(job.jobId,"initial",claim.fence,{now:new Date(now.getTime()+1),rowKeys:[],structuredValidRowKeys:[],persistedRowKeys:[],evidenceRefs:["existing"],cursor:null,counters:{},status:"PARTIAL",limitationReason:"source_limit_declared",lastErrorCode:"PLAN_LIMIT"});
    const later=new Date(now.getTime()+2);
    const claims=await Promise.all([repository.claimSourceRecheck(job.jobId,"recheck-a",later),repository.claimSourceRecheck(job.jobId,"recheck-b",later)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const restored=(await repository.getById(job.jobId))!;
    expect(restored.windowBudget).toBe(1);
    expect(restored.limitationReason).toBe("source_limit_declared");
    expect(restored.evidenceRefs).toEqual(["existing"]);
    expect(restored.sourceRechecks).toHaveLength(1);
    expect(restored.sourceRechecks?.[0]).toMatchObject({status:"PARTIAL",limitationReason:"source_limit_declared",lastErrorCode:"PLAN_LIMIT"});
    expect(await repository.retry(job.jobId,later)).toBeNull();
  });
  it("reuses the same durable job for the same query and persists a fenced checkpoint", async () => {
    const repository = createSellerSpriteCaptureJobRepository(memoryDatabase());
    const input = { module: "reverse_asin" as const, marketplace: "US" as const, query: { targetAsin: "B01L9X99GC" }, accessScope: "owner" };
    const first = await repository.ensure(input, new Date("2026-10-08T10:00:00.000Z"));
    const same = await repository.ensure(input, new Date("2026-10-08T10:01:00.000Z"));
    expect(first.created).toBe(true);
    expect(same.created).toBe(false);
    expect(same.job.jobId).toBe(first.job.jobId);
    const budgetUpdated = await repository.ensure({
      ...input,
      windowBudget: 2,
    }, new Date("2026-10-08T10:01:30.000Z"));
    expect(budgetUpdated.job.jobId).toBe(first.job.jobId);
    expect(budgetUpdated.job.windowBudget).toBe(2);

    const claim = await repository.claim(first.job.jobId, "worker-a", new Date("2026-10-08T10:02:00.000Z"), 30_000);
    expect(claim?.fence).toBe(1);
    const ignoredRunningBudgetChange = await repository.ensure({
      ...input,
      windowBudget: 3,
    }, new Date("2026-10-08T10:02:00.500Z"));
    expect(ignoredRunningBudgetChange.job.windowBudget).toBe(2);
    const saved = await repository.saveProgress(first.job.jobId, "worker-a", 1, {
      now: new Date("2026-10-08T10:02:01.000Z"),
      rowKeys: ["keyword:desk lamp"], structuredValidRowKeys: ["keyword:desk lamp"], persistedRowKeys: ["keyword:desk lamp"], evidenceRefs: ["evidence-row-1"], cursor: { page: 1, scrollY: 500 },
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
    });
    expect(saved?.rowKeys).toEqual(["keyword:desk lamp"]);
    expect((await repository.getById(first.job.jobId))?.evidenceRefs).toEqual(["evidence-row-1"]);
    expect(await repository.saveProgress(first.job.jobId, "stale-worker", 0, {
      now: new Date("2026-10-08T10:02:02.000Z"),
      rowKeys: ["keyword:wrong"], structuredValidRowKeys: ["keyword:wrong"], evidenceRefs: [], cursor: { page: 1, scrollY: 600 },
      counters: { capturedUniqueRows: 2, structuredValidRows: 2, persistedEvidenceRows: 1 },
    })).toBeNull();
  });

  it("persists pause, resume generation and restart recovery through expired leases", async () => {
    const repository = createSellerSpriteCaptureJobRepository(memoryDatabase());
    const { job } = await repository.ensure({
      module: "keyword_mining_trend", marketplace: "US", query: { seedKeyword: "desk lamp" }, accessScope: "owner",
    }, new Date("2026-10-08T10:00:00.000Z"));
    const claim = await repository.claim(job.jobId, "worker-a", new Date("2026-10-08T10:01:00.000Z"), 1_000);
    const paused = await repository.pause(job.jobId, "owner", new Date("2026-10-08T10:01:01.000Z"));
    expect(paused?.status).toBe("PAUSED");
    expect(await repository.claim(job.jobId, "worker-b", new Date("2026-10-08T10:01:02.000Z"))).toBeNull();
    const resumed = await repository.resume(job.jobId, "owner", new Date("2026-10-08T10:01:03.000Z"));
    expect(resumed?.attemptGeneration).toBe(2);
    const reclaimed = await repository.claim(job.jobId, "worker-b", new Date("2026-10-08T10:01:04.000Z"));
    expect(reclaimed?.fence).toBe(2);

    const { job: secondJob } = await repository.ensure({
      module: "sellersprite_product_market", marketplace: "US", query: { category: "lighting" }, accessScope: "owner",
    }, new Date("2026-10-08T10:02:00.000Z"));
    await repository.claim(secondJob.jobId, "worker-crashed", new Date("2026-10-08T10:03:00.000Z"), 100);
    const resumedAfterRestart = await repository.claim(secondJob.jobId, "recovery", new Date("2026-10-08T10:03:00.100Z"));
    expect(resumedAfterRestart?.fence).toBe(2);
    expect(resumedAfterRestart?.job.attemptGeneration).toBe(2);
    expect(claim?.fence).toBe(1);
  });
});
