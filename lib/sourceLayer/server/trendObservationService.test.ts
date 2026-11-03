import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccessContext } from "@/lib/server/accessPassword";
import { captureThroughGateway } from "@/lib/sourceLayer/server/captureGateway";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { recordHistoryTrendDecision } from "@/lib/sourceLayer/server/trendObservationService";
import { decideHistoryTrendSource } from "@/tools/collectors/recipes/historyTrend";

const CONTEXT: AccessContext = { mode: "owner", token: "" };

describe("history trend decision audit", () => {
  let tempRoot = "";
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "trend-decision-"));
    process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "store");
  });
  afterEach(() => {
    delete process.env.SOURCE_LAYER_STORE_DIR;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("persists a BLOCKED decision as an audit event without creating a fake trend point", async () => {
    await captureThroughGateway({
      context: CONTEXT,
      source: "manual",
      payload: {
        asin: "B0TREND001",
        title: "Trend audit fixture",
        productUrl: "https://www.amazon.com/dp/B0TREND001",
        images: ["https://example.com/image.jpg"],
        price: 10,
        currency: "USD",
      },
      now: new Date("2026-09-21T00:00:00.000Z"),
    });
    const decision = decideHistoryTrendSource({ decidedAt: "2026-09-21T00:00:01.000Z" });
    const result = await recordHistoryTrendDecision({
      context: CONTEXT,
      subjectKey: "amazon:US:B0TREND001",
      decision,
      traceId: "trace-trend-fixture",
      now: new Date("2026-09-21T00:00:02.000Z"),
    });
    expect(decision.status).toBe("blocked");
    expect(result.traceId).toBe("trace-trend-fixture");
    const store = createEvidenceStore("owner:v1");
    expect(await store.listTrendObservations?.("amazon:US:B0TREND001")).toEqual([]);
    const audit = await store.getAudit("amazon:US:B0TREND001");
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        traceId: "trace-trend-fixture",
        module: "TREND_OBSERVATION",
        eventType: "trend_source_blocked",
        errorCode: "NO_EVIDENCE",
        humanRequired: true,
      }),
    ]));
  });
});
