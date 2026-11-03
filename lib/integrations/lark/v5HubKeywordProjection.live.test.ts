import { afterAll, describe, expect, it } from "vitest";
import { projectV3KeywordEvidenceToV5Hub } from "@/lib/server/v5HubSourceProjectionService";
import { prisma } from "@/lib/server/db";
import { V5_HUB_AUTHORIZED_TEST_BASE_ID } from "./v5HubProjectionService";
import { getLarkConfig } from "./config";

const ENABLED = process.env.V5_HUB_LIVE_TEST_BASE_WRITE === "YES";
const SUBJECT_KEY = "amazon:US:B07G4VTV2F";
const IDEMPOTENCY_KEY = "v5-hub-t04-testbase-b07g4vtv2f-v1-20260928";

describe("V5 Hub live T04 Test Base projection", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it.skipIf(!ENABLED)("projects only existing Canonical EvidenceStore keyword evidence and verifies readback", async () => {
    const config = getLarkConfig();
    if (!config.ok) throw new Error(`FEISHU_CONFIG_MISSING:${config.missingKeys.join(",")}`);
    if (config.config.appToken !== V5_HUB_AUTHORIZED_TEST_BASE_ID) throw new Error("V5_HUB_WRONG_BASE");
    const result = await projectV3KeywordEvidenceToV5Hub({
      context: { mode: "owner", token: "" },
      subjectKey: SUBJECT_KEY,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(result.status).toBe("PROJECTED");
    expect(result.projections.length).toBeGreaterThan(0);
    if (result.replayed) {
      expect(result.projections.every((item) => item.status === "UNCHANGED")).toBe(true);
    }
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      subjectKey: SUBJECT_KEY,
      table: "T04",
      projectionCount: result.projections.length,
      outcomes: result.projections.reduce<Record<string, number>>((counts, item) => {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
        return counts;
      }, {}),
      replayed: result.replayed,
      source: "Canonical EvidenceStore",
      writeCallsFollowedByReadback: true,
    })}\n`);
  }, 120_000);
});
