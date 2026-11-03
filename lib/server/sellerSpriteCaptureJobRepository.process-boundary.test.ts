import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { createSellerSpriteCaptureJobRepository } from "@/lib/server/sellerSpriteCaptureJobRepository";

function databaseUrl(path: string): string {
  return "file:" + path.replaceAll("\\", "/");
}

const processBoundaryEnabled = process.env.SELLERSPRITE_CAPTURE_JOB_PROCESS_BOUNDARY === "1";

describe.skipIf(!processBoundaryEnabled)("SellerSprite capture job process-boundary writer", () => {
  it("persists an active checkpoint and exits without pausing the job", async () => {
    const dbPath = process.env.SELLERSPRITE_CAPTURE_JOB_PROCESS_BOUNDARY_DB;
    const nowValue = process.env.SELLERSPRITE_CAPTURE_JOB_PROCESS_BOUNDARY_NOW;
    const leaseMsValue = Number(process.env.SELLERSPRITE_CAPTURE_JOB_PROCESS_BOUNDARY_LEASE_MS);
    if (!dbPath || !nowValue || !Number.isSafeInteger(leaseMsValue) || leaseMsValue < 1) {
      throw new Error("PROCESS_BOUNDARY_FIXTURE_CONFIGURATION_INVALID");
    }

    const client = new PrismaClient({ datasources: { db: { url: databaseUrl(dbPath) } } });
    try {
      const repository = createSellerSpriteCaptureJobRepository(client);
      const ensured = await repository.ensure({
        module: "reverse_asin",
        marketplace: "US",
        query: { subjectKey: "amazon:US:B01L9X99GC", targetAsin: "B01L9X99GC" },
        accessScope: "owner",
      }, new Date(nowValue));
      const claim = await repository.claim(ensured.job.jobId, "process-boundary-writer", new Date(nowValue), leaseMsValue);
      if (!claim) throw new Error("PROCESS_BOUNDARY_JOB_CLAIM_FAILED");

      const bound = await repository.bindSnapshot(ensured.job.jobId, claim.job.leaseOwner!, claim.fence, {
        snapshotFingerprint: "8".repeat(64),
        reportedTotalRows: 100,
        accessibleRows: null,
        unavailableRows: null,
      }, new Date(new Date(nowValue).getTime() + 100));
      if (!bound) throw new Error("PROCESS_BOUNDARY_SNAPSHOT_BIND_FAILED");

      const rowKeys = ["generation:1:keyword-lamp", "generation:1:keyword-mug"];
      const saved = await repository.saveProgress(ensured.job.jobId, claim.job.leaseOwner!, claim.fence, {
        now: new Date(new Date(nowValue).getTime() + 200),
        rowKeys,
        structuredValidRowKeys: rowKeys,
        persistedRowKeys: rowKeys,
        evidenceRefs: ["attachment:window-1", "raw-artifact:window-1"],
        cursor: { page: 3, scrollY: 720, scrollTarget: "table" },
        cursorWindowFingerprint: "9".repeat(64),
        counters: { capturedUniqueRows: 2, structuredValidRows: 2, persistedEvidenceRows: 2 },
        diagnostics: { actualVisibleRows: 20, duplicatesRejected: 4, windowsProcessed: 3 },
        status: "RUNNING",
        limitationReason: "unknown",
      });
      expect(saved).toMatchObject({ status: "RUNNING", cursor: { page: 3, scrollY: 720, scrollTarget: "table" } });
    } finally {
      await client.$disconnect();
    }
  });
});
