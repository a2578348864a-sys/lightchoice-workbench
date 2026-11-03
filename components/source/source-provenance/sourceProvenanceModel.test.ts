import { describe, expect, it } from "vitest";

import {
  summarizeModuleCoverageTotals,
  summarizeSourceModuleCoverage,
} from "@/lib/sourceLayer/moduleCoverageSummary";
import type { BatchCaptureRunSnapshot } from "@/lib/sourceLayer/batchCaptureRunSnapshot";
import type { BatchCaptureRunPresentation, BatchCaptureRunView } from "@/lib/sourceLayer/batchCaptureRunPresentation";
import {
  buildBatchProvenanceSummary,
  buildCoverageRows,
  buildProvenanceTimeline,
  type ProvenanceItem,
} from "./sourceProvenanceModel";

function moduleEntry(
  module: string,
  status: string,
  options: {
    evidenceId?: string | null;
    capturedAt?: string | null;
    attemptAt?: string | null;
    attemptStatus?: string;
    attemptMessage?: string;
    errorCode?: string | null;
  } = {},
) {
  return {
    module,
    label: module,
    status: status as never,
    capturedAt: options.capturedAt ?? null,
    evidenceId: options.evidenceId ?? null,
    contentHash: options.evidenceId ? "a".repeat(64) : null,
    limitations: [],
    errorCode: options.errorCode ?? null,
    retryable: null,
    latestAttempt: options.attemptAt
      ? {
          status: options.attemptStatus ?? "failed",
          message: options.attemptMessage ?? "attempt",
          errorCode: options.errorCode ?? null,
          attemptedAt: options.attemptAt,
        }
      : null,
  };
}

function item(index: number, modules: ReturnType<typeof moduleEntry>[]): ProvenanceItem {
  return {
    id: `item-${index}`,
    asin: `B0TEST000${index}`,
    archivedAt: null,
    evidenceRefs: [],
    moduleCoverage: modules,
  };
}

const ITEMS: ProvenanceItem[] = [
  item(1, [
    moduleEntry("amazon_detail", "COMPLETE", { evidenceId: "ev-1", capturedAt: "2026-10-22T01:00:00.000Z" }),
    moduleEntry("amazon_search_market", "AVAILABLE_WITH_LIMITATION", { evidenceId: "ev-2", capturedAt: "2026-10-22T01:10:00.000Z" }),
    moduleEntry("variation", "COMPLETE", { evidenceId: "ev-3", capturedAt: "2026-10-22T01:20:00.000Z" }),
    moduleEntry("review_voc", "COMPLETE", { evidenceId: "ev-4", capturedAt: "2026-10-22T01:30:00.000Z" }),
    moduleEntry("sellersprite_product_market", "NOT_COLLECTED"),
    moduleEntry("reverse_asin", "NOT_COLLECTED"),
    moduleEntry("keyword_mining_trend", "NOT_COLLECTED"),
    moduleEntry("historical_trend", "NOT_COLLECTED"),
  ]),
  item(2, [
    moduleEntry("amazon_detail", "CAPTURED_PARTIAL", {
      evidenceId: "ev-5",
      capturedAt: "2026-10-22T02:00:00.000Z",
      attemptAt: "2026-10-22T03:00:00.000Z",
      attemptStatus: "failed",
      attemptMessage: "variation_mapping_incomplete",
      errorCode: "VARIATION_EXTRACTION_EMPTY",
    }),
    moduleEntry("amazon_search_market", "AVAILABLE_WITH_LIMITATION", { evidenceId: "ev-6", capturedAt: "2026-10-22T02:10:00.000Z" }),
    moduleEntry("variation", "COMPLETE", { evidenceId: "ev-7", capturedAt: "2026-10-22T02:20:00.000Z" }),
    moduleEntry("review_voc", "HUMAN_ACTION_REQUIRED", {
      evidenceId: "ev-8",
      attemptAt: "2026-10-22T04:00:00.000Z",
      attemptStatus: "human_required",
      attemptMessage: "captcha_requires_human",
    }),
    moduleEntry("sellersprite_product_market", "NOT_COLLECTED"),
    moduleEntry("reverse_asin", "NOT_COLLECTED"),
    moduleEntry("keyword_mining_trend", "NOT_COLLECTED"),
    moduleEntry("historical_trend", "NOT_COLLECTED"),
  ]),
  item(3, [
    moduleEntry("amazon_detail", "COMPLETE", { evidenceId: "ev-9", capturedAt: "2026-10-22T02:30:00.000Z" }),
    moduleEntry("amazon_search_market", "AVAILABLE_WITH_LIMITATION", { evidenceId: "ev-10", capturedAt: "2026-10-22T02:40:00.000Z" }),
    moduleEntry("variation", "NOT_COLLECTED"),
    moduleEntry("review_voc", "COMPLETE", { evidenceId: "ev-11", capturedAt: "2026-10-22T02:50:00.000Z" }),
    moduleEntry("sellersprite_product_market", "NOT_COLLECTED"),
    moduleEntry("reverse_asin", "NOT_COLLECTED"),
    moduleEntry("keyword_mining_trend", "NOT_COLLECTED"),
    moduleEntry("historical_trend", "NOT_COLLECTED"),
  ]),
];

const SNAPSHOT = {
  state: "present",
  run: { allowedModules: ["amazon_detail", "variation", "review_voc", "reverse_asin"] } as unknown as BatchCaptureRunView,
  view: {
    progress: { uniqueItemsVisited: 3, itemsInBatch: 3, validEvidenceCells: 11, totalCells: 24 },
    statusLabel: "部分完成",
    tone: "amber",
  } as unknown as BatchCaptureRunPresentation,
  at: 1,
} as BatchCaptureRunSnapshot;

describe("T04 资料覆盖投影", () => {
  const summary = summarizeSourceModuleCoverage(ITEMS);
  const totals = summarizeModuleCoverageTotals(summary);
  const rows = buildCoverageRows({
    summary,
    activeItemCount: ITEMS.length,
    runScopeKnown: true,
    allowedModules: ["amazon_detail", "variation", "review_voc", "reverse_asin"],
  });

  it("基础 4 类状态分别反映完整/部分/受限/需人工", () => {
    const byModule = new Map(rows.basic.map((row) => [row.module, row]));
    expect(byModule.get("amazon_detail")?.status).toBe("partial");
    expect(byModule.get("amazon_detail")?.evidenceCount).toBe(3);
    expect(byModule.get("amazon_search_market")?.status).toBe("limited");
    expect(byModule.get("variation")?.status).toBe("partial");
    expect(byModule.get("variation")?.evidenceCount).toBe(2);
    expect(byModule.get("review_voc")?.status).toBe("human");
  });

  it("补充来源区分未纳入本轮与已授权但未采集", () => {
    const byModule = new Map(rows.supplementary.map((row) => [row.module, row]));
    expect(byModule.get("sellersprite_product_market")?.status).toBe("not_in_scope");
    expect(byModule.get("sellersprite_product_market")?.statusLabel).toBe("未纳入本轮");
    expect(byModule.get("reverse_asin")?.status).toBe("not_collected");
    expect(byModule.get("reverse_asin")?.statusLabel).toBe("未采集");
    expect(byModule.get("historical_trend")?.status).toBe("not_in_scope");
  });

  it("总览同时保留运行口径与商品×模块口径，不合并", () => {
    const result = buildBatchProvenanceSummary({
      items: ITEMS,
      summary,
      totals,
      rows,
      captureRunSnapshot: SNAPSHOT,
    });
    expect(result.totalItems).toBe(3);
    expect(result.activeItems).toBe(3);
    expect(result.evidenceModules).toBe(4);
    expect(result.evidenceCells).toBe(11);
    expect(result.totalCells).toBe(24);
    expect(result.lastEvidenceAt).toBe("2026-10-22T02:50:00.000Z");
    expect(result.runScope.known).toBe(true);
    expect(result.runScope.label).toContain("商品处理 3/3");
    expect(result.runScope.label).toContain("资料证据 11/24 单元");
    expect(result.scopeNote).toContain("11/24");
    expect(result.scopeNote).toContain("不能直接比较");
  });

  it("运行状态未知时不冒充 0，也不判定补充来源未授权", () => {
    const unknownRows = buildCoverageRows({
      summary,
      activeItemCount: ITEMS.length,
      runScopeKnown: false,
      allowedModules: null,
    });
    const result = buildBatchProvenanceSummary({
      items: ITEMS,
      summary,
      totals,
      rows: unknownRows,
      captureRunSnapshot: { state: "error", message: "controlled", at: 1 },
    });
    expect(result.runScope.known).toBe(false);
    expect(result.runScope.label).toContain("读取失败");
    expect(unknownRows.supplementary.every((row) => row.status !== "not_in_scope")).toBe(true);
    expect(result.scopeNote).toContain("读取失败");
  });
});

describe("T04 最近事件时间线", () => {
  it("只使用真实 capturedAt / attemptedAt，取较新事件并按时间倒序", () => {
    const { events, total } = buildProvenanceTimeline(ITEMS, 8);
    expect(total).toBeGreaterThan(0);
    expect(events[0].title).toBe("需要人工处理");
    expect(events[0].at).toBe("2026-10-22T04:00:00.000Z");
    expect(events[1].title).toBe("采集尝试未完成");
    expect(events[1].at).toBe("2026-10-22T03:00:00.000Z");
    expect(events.some((event) => event.title === "已保存证据" && event.at === "2026-10-22T02:50:00.000Z")).toBe(true);
    expect(events.every((event, index) => index === 0 || Date.parse(events[index - 1].at) >= Date.parse(event.at))).toBe(true);
  });

  it("没有真实时间戳时不生成事件", () => {
    const noTimeItems = [item(9, [moduleEntry("amazon_detail", "NOT_COLLECTED")])];
    const { events, total } = buildProvenanceTimeline(noTimeItems, 8);
    expect(events).toEqual([]);
    expect(total).toBe(0);
  });

  it("事件只引用真实证据 ID；没有附件的事件不提供查看证据", () => {
    const { events } = buildProvenanceTimeline(ITEMS, 20);
    const attempt = events.find((event) => event.title === "采集尝试未完成");
    expect(attempt?.canViewEvidence).toBe(true);
    expect(attempt?.evidenceId).toBe("ev-5");
    const noEvidenceItems = [item(10, [moduleEntry("amazon_detail", "BLOCKED_WITH_EVIDENCE", {
      attemptAt: "2026-10-22T05:00:00.000Z",
      attemptStatus: "failed",
    })])];
    const noEvidence = buildProvenanceTimeline(noEvidenceItems, 8).events[0];
    expect(noEvidence.canViewEvidence).toBe(false);
    expect(noEvidence.evidenceId).toBeNull();
  });
});
