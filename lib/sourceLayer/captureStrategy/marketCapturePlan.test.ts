import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MARKET_CAPTURE_MODULE_IDS,
  MARKET_CAPTURE_PLAN_VERSION,
  MarketCapturePlanError,
  QUICK_SCAN_SAMPLE_MAX_ITEMS,
  buildMarketCapturePlan,
  classifyMarketCapturePlanModules,
  deriveAuthoritativeMarketCapturePlan,
  isMarketCaptureStrategyId,
  parseMarketCapturePlan,
  selectStratifiedSampleIndices,
  sha256Hex,
} from "@/lib/sourceLayer/captureStrategy/marketCapturePlan";
import { HARD_MAX_AUTHORIZED_ITEMS } from "@/lib/sourceLayer/captureBudgetConstants";

const BATCH = "batch-market-001";

function entryOf(plan: ReturnType<typeof buildMarketCapturePlan>, module: string) {
  const entry = plan.entries.find((candidate) => candidate.module === module);
  if (!entry) throw new Error(`missing module entry: ${module}`);
  return entry;
}

function fullPlan(overrides: Partial<Parameters<typeof buildMarketCapturePlan>[0]> = {}) {
  return buildMarketCapturePlan({
    strategyId: "full_market_capture",
    batchId: BATCH,
    marketTargetItemCount: 100,
    batchCapacity: 100,
    authorizedItemCount: 100,
    searchNavigationUsed: 2,
    ...overrides,
  });
}

describe("marketCapturePlan（市场采集策略层 v2）", () => {
  it("默认仅纳入四项基础能力，补充能力需显式选择", () => {
    const plan = fullPlan();
    expect(plan.schemaVersion).toBe(MARKET_CAPTURE_PLAN_VERSION);
    expect(plan.strategyId).toBe("full_market_capture");
    expect([...plan.entries.map((entry) => entry.module)].sort()).toEqual(
      ["amazon_search_market", "amazon_detail", "variation", "review_voc"].sort(),
    );
    expect(plan.entries).toHaveLength(4);

    for (const moduleId of ["amazon_detail", "variation", "review_voc"]) {
      const entry = entryOf(plan, moduleId);
      expect(entry.autoExecutable).toBe(true);
      expect(entry.status).toBe("scheduled_auto");
      expect(entry.budget.plannedItems).toBe(100);
    }
    expect(entryOf(plan, "amazon_search_market").querySubjectKind).toBe("market_query");
    expect(plan.autoExecutableModuleCount).toBe(4);
    expect(plan.notCovered).toEqual([]);
  });

  it("显式选择补充能力后才进入计划矩阵", () => {
    const plan = fullPlan({ includedSupplementalModules: ["reverse_asin", "keyword_mining_trend"] });
    expect(plan.entries.map((entry) => entry.module).sort()).toEqual(
      ["amazon_search_market", "amazon_detail", "variation", "review_voc", "reverse_asin", "keyword_mining_trend"].sort(),
    );
    expect(entryOf(plan, "reverse_asin").autoExecutable).toBe(false);
    expect(entryOf(plan, "reverse_asin").reasonCode).not.toBeNull();
    expect(plan.notCovered.map((item) => item.module).sort()).toEqual(
      ["keyword_mining_trend", "reverse_asin"].sort(),
    );
    expect(plan.autoExecutableModuleCount).toBe(4);
  });

  it("市场级与关键词级证据不被复制成逐 ASIN 完成", () => {
    const plan = fullPlan({ includedSupplementalModules: ["sellersprite_product_market", "keyword_mining_trend", "historical_trend"] });
    for (const moduleId of ["sellersprite_product_market", "keyword_mining_trend"]) {
      const entry = entryOf(plan, moduleId);
      expect(entry.querySubjectKind === "market_query" || entry.querySubjectKind === "keyword_query").toBe(true);
      expect(entry.budget.plannedItems).toBe(0);
    }
    expect(entryOf(plan, "historical_trend").querySubjectKind).toBe("user_supplied_file");
    expect(entryOf(plan, "historical_trend").budget.plannedItems).toBe(100);
  });

  it("附件类模块保留 amazon_detail 前置", () => {
    for (const strategyId of ["full_market_capture", "quick_market_scan"] as const) {
      const plan = buildMarketCapturePlan({
        strategyId, batchId: BATCH, marketTargetItemCount: 50, batchCapacity: 50, authorizedItemCount: 50,
        includedSupplementalModules: ["keyword_mining_trend"],
      });
      for (const moduleId of ["variation", "review_voc", "keyword_mining_trend"] as const) {
        expect(entryOf(plan, moduleId).requiresBefore).toContain("amazon_detail");
      }
    }
  });

  it("快速市场扫描：抽样规模由服务端推导，且不取列表前 N 件", () => {
    const plan = buildMarketCapturePlan({
      strategyId: "quick_market_scan", batchId: BATCH, marketTargetItemCount: 100, batchCapacity: 100, authorizedItemCount: 100,
    });
    const review = entryOf(plan, "review_voc");
    expect(review.status).toBe("scheduled_sampled");
    expect(review.sampled).toBe(true);
    expect(review.sampleBasis).toBe("deterministic_stratified");
    expect(review.budget.plannedItems).toBeGreaterThan(0);
    expect(review.budget.plannedItems).toBeLessThanOrEqual(QUICK_SCAN_SAMPLE_MAX_ITEMS);
    expect(review.sampleNote).toContain("不取列表前 N 件");
    // 详情与变体仍然全量
    expect(entryOf(plan, "amazon_detail").budget.plannedItems).toBe(100);
    expect(entryOf(plan, "variation").budget.plannedItems).toBe(100);
  });

  it("确定性分层抽样：不偏向头部、可复现、不越界", () => {
    const small = selectStratifiedSampleIndices(10, 3);
    expect(small).toEqual([1, 5, 8]);
    expect(selectStratifiedSampleIndices(10, 3)).toEqual(small);
    const large = selectStratifiedSampleIndices(100, 15);
    expect(large[0]).toBeGreaterThan(0);
    expect(large[large.length - 1]).toBeLessThan(99);
    expect(new Set(large).size).toBe(large.length);
    expect(large.every((index) => index >= 0 && index < 100)).toBe(true);
    expect(selectStratifiedSampleIndices(0, 5)).toEqual([]);
    expect(selectStratifiedSampleIndices(5, 0)).toEqual([]);
    expect(selectStratifiedSampleIndices(3, 10)).toEqual([0, 1, 2]);
  });

  it("数量合同：目标 / 容量 / 授权三者分开，超硬上限不静默截断", () => {
    const plan = fullPlan({ marketTargetItemCount: 300, batchCapacity: 300, authorizedItemCount: HARD_MAX_AUTHORIZED_ITEMS });
    expect(plan.marketTargetItemCount).toBe(300);
    expect(plan.batchCapacity).toBe(300);
    expect(plan.authorizedItemCount).toBe(HARD_MAX_AUTHORIZED_ITEMS);
    expect(plan.deferredItemCount).toBe(100);
    expect(plan.batching.requiresMultipleRuns).toBe(true);
    expect(plan.batching.plannedRuns).toBe(2);
    expect(plan.batching.note).toContain("跨批次聚合当前未支持");
    expect(plan.preconditions.some((line) => line.includes("跨批次聚合当前未支持"))).toBe(true);
  });

  it("授权数量不得超过批次容量，且授权 0 一律拒绝", () => {
    const plan = fullPlan({ batchCapacity: 40, authorizedItemCount: 60, marketTargetItemCount: 60 });
    expect(plan.authorizedItemCount).toBe(40);
    expect(plan.deferredItemCount).toBe(20);
    expect(() => fullPlan({ authorizedItemCount: 0 })).toThrow(MarketCapturePlanError);
    expect(() => fullPlan({ marketTargetItemCount: -1 })).toThrow(MarketCapturePlanError);
    expect(() => fullPlan({ authorizedItemCount: HARD_MAX_AUTHORIZED_ITEMS + 1 })).toThrow(MarketCapturePlanError);
    expect(() => fullPlan({ batchCapacity: 0, authorizedItemCount: 1 })).toThrow(MarketCapturePlanError);
  });

  it("导航预算与前端可见数字同源，且搜索已用额度不得超过上限", () => {
    const plan = fullPlan({ authorizedItemCount: 40, marketTargetItemCount: 40, batchCapacity: 40, searchNavigationUsed: 2 });
    expect(plan.budget.searchPages).toBe(2);
    expect(plan.budget.navigationLimit).toBe(Math.max(30, 40 * 4 + 2));
    expect(plan.budget.hardMaxAuthorizedItems).toBe(HARD_MAX_AUTHORIZED_ITEMS);
    expect(() => fullPlan({ searchNavigationUsed: 99999 })).toThrow(MarketCapturePlanError);
  });

  it("服务端权威推导：只接受策略 + 目标数量，其余服务端重算", () => {
    const plan = deriveAuthoritativeMarketCapturePlan({
      strategyId: "full_market_capture",
      batchId: BATCH,
      batchCapacity: 20,
      marketTargetItemCount: 200,
      searchNavigationUsed: 1,
    });
    expect(plan.authorizedItemCount).toBe(20);
    expect(plan.deferredItemCount).toBe(180);

    const fallback = deriveAuthoritativeMarketCapturePlan({
      strategyId: "quick_market_scan",
      batchId: BATCH,
      batchCapacity: 12,
      marketTargetItemCount: undefined,
      searchNavigationUsed: 1,
    });
    expect(fallback.marketTargetItemCount).toBe(12);
    expect(fallback.authorizedItemCount).toBe(12);

    expect(() => deriveAuthoritativeMarketCapturePlan({
      strategyId: "not_a_strategy",
      batchId: BATCH,
      batchCapacity: 12,
      marketTargetItemCount: 5,
      searchNavigationUsed: 0,
    })).toThrow(MarketCapturePlanError);
  });

  it("严格解析 fail-closed：篡改任一执行范围字段都会失败", () => {
    const plan = fullPlan({ marketTargetItemCount: 60, batchCapacity: 60, authorizedItemCount: 60 });
    const json = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
    const parsed = parseMarketCapturePlan(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.planFingerprint).toBe(plan.planFingerprint);

    const tamperCases: Array<(clone: Record<string, unknown>) => void> = [
      (clone) => { clone.authorizedItemCount = 120; },
      (clone) => { clone.marketTargetItemCount = 999; },
      (clone) => { clone.batchId = "batch-other"; },
      (clone) => { clone.strategyId = "quick_market_scan"; },
      (clone) => { (clone.budget as Record<string, unknown>).navigationLimit = 1; },
      (clone) => { ((clone.entries as Record<string, unknown>[])[0].budget as Record<string, unknown>).plannedItems = 1; },
      (clone) => { ((clone.entries as Record<string, unknown>[])[0]).autoExecutable = false; },
      (clone) => { clone.planFingerprint = "0".repeat(64); },
      (clone) => { clone.schemaVersion = "market-capture-plan.v1"; },
      // 分批合同字段必须与目标/容量自洽：篡改轮次数或待补样本数一律拒绝。
      (clone) => { ((clone.batching as Record<string, unknown>)).plannedRuns = 7; },
      (clone) => { ((clone.batching as Record<string, unknown>)).itemsAwaitingSourceSamples = 999; },
      (clone) => { ((clone.batching as Record<string, unknown>)).requiresMultipleRuns = true; },
    ];
    for (const tamper of tamperCases) {
      const clone = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
      tamper(clone);
      expect(parseMarketCapturePlan(clone)).toBeNull();
    }
  });

  it("严格解析拒绝重复模块、负预算与非法枚举", () => {
    const plan = fullPlan();
    const base = JSON.parse(JSON.stringify(plan)) as { entries: Record<string, unknown>[] };

    const duplicated = JSON.parse(JSON.stringify(base)) as { entries: Record<string, unknown>[] };
    duplicated.entries[1] = { ...duplicated.entries[0] };
    expect(parseMarketCapturePlan(duplicated)).toBeNull();

    const negative = JSON.parse(JSON.stringify(base)) as { entries: Record<string, unknown>[] };
    (negative.entries[0].budget as Record<string, unknown>).plannedQueries = -1;
    expect(parseMarketCapturePlan(negative)).toBeNull();

    const badStatus = JSON.parse(JSON.stringify(base)) as { entries: Record<string, unknown>[] };
    badStatus.entries[0].status = "completed";
    expect(parseMarketCapturePlan(badStatus)).toBeNull();

    const fakeSampling = JSON.parse(JSON.stringify(base)) as { entries: Record<string, unknown>[] };
    fakeSampling.entries[0].sampled = true;
    fakeSampling.entries[0].sampleBasis = "deterministic_stratified";
    expect(parseMarketCapturePlan(fakeSampling)).toBeNull();

    const missingModule = JSON.parse(JSON.stringify(base)) as { entries: Record<string, unknown>[] };
    missingModule.entries = missingModule.entries.slice(1);
    expect(parseMarketCapturePlan(missingModule)).toBeNull();

    expect(parseMarketCapturePlan(null)).toBeNull();
    expect(parseMarketCapturePlan({})).toBeNull();
  });

  it("指纹实现与 node:crypto 的 SHA-256 完全一致（跨端一致性）", () => {
    for (const sample of ["", "abc", "采集计划-market-capture", JSON.stringify({ a: 1, b: "中文" })]) {
      expect(sha256Hex(sample)).toBe(createHash("sha256").update(sample, "utf8").digest("hex"));
    }
  });

  it("策略标识与模块标识校验只接受已冻结枚举", () => {
    expect(isMarketCaptureStrategyId("full_market_capture")).toBe(true);
    expect(isMarketCaptureStrategyId("quick_market_scan")).toBe(true);
    expect(isMarketCaptureStrategyId("market_scan")).toBe(false);
    expect(isMarketCaptureStrategyId(null)).toBe(false);
  });

  it("计划不含第二事实库语义：不携带任何证据引用字段", () => {
    const serialized = JSON.stringify(fullPlan());
    for (const forbidden of ["evidenceId", "contentHash", "subjectKey", "attachmentId", "evidenceRef"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
