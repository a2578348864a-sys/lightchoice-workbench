import { describe, expect, it } from "vitest";
import { decideHistoryTrendSource } from "./historyTrend";

describe("history trend source gate", () => {
  it("formally blocks when no reliable structured time-series source exists", () => {
    expect(decideHistoryTrendSource({ decidedAt: "2026-09-21T00:00:00.000Z" })).toEqual({
      status: "blocked",
      code: "NO_RELIABLE_SOURCE_IN_REPO",
      reason: "当前仓库没有可验证、结构化、可追溯的历史时序来源；不使用 OCR、截图推断或 AI 补齐趋势。",
      decidedAt: "2026-09-21T00:00:00.000Z",
      candidates: [],
    });
  });

  it("does not treat an unstructured or unreliable candidate as a source", () => {
    const result = decideHistoryTrendSource({
      decidedAt: "2026-09-21T00:00:00.000Z",
      candidates: [
        { sourceId: "screenshot", sourceType: "manual", reliable: true, hasStructuredTimeSeries: false },
        { sourceId: "provider-export", sourceType: "official_export", reliable: false, hasStructuredTimeSeries: true },
      ],
    });
    expect(result.status).toBe("blocked");
    expect(result.code).toBe("NO_RELIABLE_SOURCE_IN_REPO");
  });

  it("only opens the gate for a reliable structured source", () => {
    expect(decideHistoryTrendSource({
      decidedAt: "2026-09-21T00:00:00.000Z",
      candidates: [{ sourceId: "official-v1", sourceType: "official_api", reliable: true, hasStructuredTimeSeries: true }],
    })).toMatchObject({ status: "ready", sourceId: "official-v1" });
  });
});
