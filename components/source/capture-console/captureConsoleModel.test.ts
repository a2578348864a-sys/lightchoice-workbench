import { describe, expect, it } from "vitest";

import { describeBatchCaptureRun, type BatchCaptureCellView, type BatchCaptureModuleOutcomeView, type BatchCaptureRunView } from "@/lib/sourceLayer/batchCaptureRunPresentation";
import { buildConsoleModel, formatSnapshotTime } from "./captureConsoleModel";
import { describeCaptureRunPresence } from "@/lib/sourceLayer/batchCaptureRunSnapshot";

/**
 * 真实批次 1607279a（halloween decorations，2026/10/22）的分布快照：
 * - 30 件商品，120 个单元
 * - 成功 84、部分 13、失败 15（均达 3 次上限）、复用 8 → 有效证据 105
 * - 模块：搜索 30/30、详情 30/30（完整 18）、变体 20/30（失败 10）、评论 25/30（失败 5）
 * 该分布来自隔离预览库的真实 BatchCaptureRun 回执；测试只锁定展示投影，不产生业务事实。
 */
const ASINS = Array.from({ length: 30 }, (_, index) => `B0TEST${String(index + 1).padStart(4, "0")}`);

function cell(asin: string, module: string, status: string, attempts = 1): BatchCaptureCellView {
  return {
    asin,
    module,
    status,
    attempts,
    evidenceId: status === "succeeded" || status === "partial" || status === "skipped_existing" ? `ev-${asin}-${module}` : null,
    lastErrorCode: status === "failed_retryable" ? "VARIATION_EXTRACTION_EMPTY" : null,
    sourceVerified: status === "succeeded" || status === "partial",
    fieldComplete: status === "succeeded",
    researchConsumable: status === "succeeded",
  };
}

function outcome(module: string, input: Partial<BatchCaptureModuleOutcomeView>): BatchCaptureModuleOutcomeView {
  return {
    module,
    handling: "done",
    dataQuality: "has_valid",
    completed: true,
    itemsTotal: 30,
    itemsTerminal: 30,
    itemsSucceeded: 0,
    itemsPartial: 0,
    itemsHuman: 0,
    itemsFailed: 0,
    itemsSkipped: 0,
    itemsPending: 0,
    validEvidenceCount: 0,
    itemsFieldComplete: 0,
    itemsSourceLimited: 0,
    itemsResearchConsumable: 0,
    message: null,
    errorCode: null,
    ...input,
  };
}

function buildRealRun(): BatchCaptureRunView {
  const cells: BatchCaptureCellView[] = [];
  ASINS.forEach((asin, index) => {
    cells.push(cell(asin, "amazon_search_market", "succeeded"));
    cells.push(cell(asin, "amazon_detail", index < 18 ? "succeeded" : "partial"));
    if (index < 19) cells.push(cell(asin, "variation", "succeeded"));
    else if (index === 19) cells.push(cell(asin, "variation", "partial"));
    else cells.push(cell(asin, "variation", "failed_retryable", 3));
    if (index < 17) cells.push(cell(asin, "review_voc", "succeeded"));
    else if (index < 22) cells.push(cell(asin, "review_voc", "failed_retryable", 3));
    else cells.push(cell(asin, "review_voc", "skipped_existing"));
  });

  return {
    runId: "bb2116e1-25fe-40ae-8e2a-5142404c0070",
    batchId: "1607279a-f916-43aa-8e58-4fda88f07f49",
    runGeneration: 1,
    version: 63,
    status: "PARTIAL",
    allowedModules: ["amazon_detail", "variation", "review_voc"],
    authorizedItemLimit: 30,
    maxItemsPerAdvance: 5,
    maxDriveSlices: 240,
    retryAuthorized: true,
    navigationBudget: { limit: 133, used: 120, reserved: 0, updatedAt: "2026-10-22T10:02:55.082Z" },
    leaseOwner: null,
    leaseExpiresAt: null,
    cells,
    moduleOutcomes: [
      outcome("amazon_search_market", { itemsSucceeded: 30, validEvidenceCount: 30, itemsFieldComplete: 0 }),
      outcome("amazon_detail", { itemsSucceeded: 18, itemsPartial: 12, validEvidenceCount: 30, itemsFieldComplete: 18 }),
      outcome("variation", { itemsSucceeded: 19, itemsPartial: 1, itemsFailed: 10, validEvidenceCount: 20, itemsFieldComplete: 19 }),
      outcome("review_voc", { itemsSucceeded: 17, itemsFailed: 5, itemsSkipped: 8, validEvidenceCount: 25, itemsFieldComplete: 17 }),
    ],
    productMarketQueries: [],
    keywordMiningQueries: [],
    progress: {
      itemsInBatch: 30,
      uniqueItemsVisited: 30,
      detailSucceededItems: 18,
      pendingCells: 0,
      terminalCells: 120,
      totalCells: 120,
      validEvidenceCells: 105,
      fieldCompleteCells: 54,
      partialCells: 13,
      humanCells: 0,
      failedCells: 15,
      sourceLimitedCells: 0,
      researchConsumableCells: 54,
    },
    advances: 18,
    driveSlices: 120,
    lastErrorCode: null,
    lastMessage: "任务已部分完成且当前没有可推进的单元（无 pending；失败单元均已达到重试上限）；如需补采请使用「重试可重试失败」或重新确认计划。",
    createdAt: "2026-10-21T18:22:01.021Z",
    updatedAt: "2026-10-22T10:03:02.915Z",
    startedAt: "2026-10-21T18:22:01.227Z",
    finishedAt: "2026-10-22T09:05:31.798Z",
    supersededRunId: null,
    executionEpoch: 9,
    acknowledgedEpoch: 9,
  };
}

const SAMPLE_GATE = { sufficient: true, current: 30, required: 30 };

describe("T03 采集控制台投影（真实批次分布）", () => {
  const view = describeBatchCaptureRun({ run: buildRealRun(), sampleGate: SAMPLE_GATE });
  const model = buildConsoleModel({ view, run: buildRealRun(), now: new Date(2026, 9, 22, 18, 10) });

  it("状态 Hero 使用部分完成的真实事实，不宣称资料完整", () => {
    expect(model.hasRun).toBe(true);
    expect(model.hero.title).toBe("本轮采集部分完成");
    expect(model.hero.tone).toBe("warn");
    expect(model.hero.subtitle).toContain("本轮已处理 30/30 件（本次授权范围）");
    expect(model.hero.subtitle).toContain("15 个单元失败");
    expect(model.hero.subtitle).toContain("13 个单元只有部分数据");
    // 批次已达研究门槛 ≠ 本轮全部成功：PARTIAL 必须显式澄清两个口径。
    expect(model.hero.subtitle).toContain("批次有效样本 30/30 已达研究门槛");
    expect(model.hero.subtitle).toContain("不代表本轮采集已全部成功");
    expect(model.hero.issueLabel).toBe("15 个单元失败");
    expect(model.hero.suggestion).toContain("重试上限");
  });

  it("商品处理与资料证据分开，处理 30/30 不等于证据 100%", () => {
    expect(model.progress.value).toBe(30);
    expect(model.progress.total).toBe(30);
    expect(model.progress.state).toBe("partial");
    expect(model.progress.stateWord).toBe("本轮部分完成 · 已处理 30/30 件");
    expect(model.evidence.value).toBe(105);
    expect(model.evidence.total).toBe(120);
    expect(model.evidence.percent).toBe(88);
    expect(model.evidence.failed).toBe(15);
    expect(model.evidence.partial).toBe(13);
  });

  it("四项基础能力按有效证据展示，且与证据环同口径", () => {
    const byModule = new Map(model.basic.map((row) => [row.module, row]));
    expect(byModule.get("amazon_search_market")?.stateLabel).toBe("已完成");
    expect(byModule.get("amazon_detail")?.stateLabel).toBe("部分完成");
    expect(byModule.get("variation")?.stateLabel).toBe("部分完成");
    expect(byModule.get("review_voc")?.stateLabel).toBe("部分完成");
    expect(byModule.get("amazon_detail")?.evidenceCount).toBe(30);
    expect(byModule.get("variation")?.evidenceCount).toBe(20);
    expect(byModule.get("review_voc")?.evidenceCount).toBe(25);
    const sum = model.basic.reduce((total, row) => total + row.evidenceCount, 0);
    expect(sum).toBe(model.evidence.value);
    expect(model.basicSummary).toBe("1 项完成 · 3 项需关注");
  });

  it("补充能力本轮未授权，不伪装成未采集或失败", () => {
    expect(model.supplementary).toHaveLength(4);
    expect(model.supplementary.every((row) => row.stateLabel === "未授权")).toBe(true);
    expect(model.supplementarySummary).toBe("4 项 · 本轮未授权");
  });

  it("问题区先给失败重试上限，再给分诊缺口；动作指向真实区域", () => {
    expect(model.issues.length).toBeGreaterThan(0);
    expect(model.issues[0].title).toBe("15 个单元失败 · 已达重试上限");
    expect(model.issues[0].description).toContain("父子变体 10");
    expect(model.issues[0].description).toContain("评论 / 买家声音 5");
    expect(model.issues[0].action).toEqual({ kind: "scroll", label: "查看缺口", target: "gaps" });
  });

  it("计划摘要来自 run 的授权字段与导航预算", () => {
    expect(model.plan.scope).toBe("Amazon 详情 · 父子变体 · 评论 / 买家声音");
    expect(model.plan.authorized).toBe("30 件");
    expect(model.plan.navigation).toBe("120 / 133");
    expect(model.plan.navigationDetail).toBe("剩余 13（预留 0）");
  });

  it("有效样本门槛来自服务端权威判定，不随处理进度变化", () => {
    expect(model.sample.current).toBe(30);
    expect(model.sample.required).toBe(30);
    expect(model.sample.sufficient).toBe(true);
    expect(model.sample.label).toBe("已达研究门槛");
    expect(model.sample.note).toBe("整个来源批次满足研究条件的商品数；与本轮处理的件数是两个口径");
  });

  it("快照时间：当天只显示时分，跨天显示月/日", () => {
    const now = new Date("2026-10-22T10:10:00+08:00");
    expect(formatSnapshotTime(new Date(2026, 9, 22, 18, 3, 2, 915).toISOString(), now)).toBe("18:03");
    expect(formatSnapshotTime(new Date(2026, 9, 21, 18, 3).toISOString(), now)).toBe("10/21 18:03");
    expect(formatSnapshotTime(null, now)).toBeNull();
  });
});

describe("T03 采集控制台投影（无运行）", () => {
  const view = describeBatchCaptureRun({ run: null, sampleGate: SAMPLE_GATE });
  const model = buildConsoleModel({ view, run: null });

  it("不伪造进度与证据", () => {
    expect(model.hasRun).toBe(false);
    expect(model.hero.title).toBe("尚未开始采集");
    expect(model.progress.value).toBe(0);
    expect(model.evidence.value).toBe(0);
    expect(model.basic.every((row) => row.stateLabel === "未授权")).toBe(true);
    expect(model.issues).toEqual([]);
    expect(model.noRunGuidance?.title).toBe("尚未创建采集任务");
  });
});

describe("T03 运行快照 tri-state（读取失败 ≠ 无任务）", () => {
  it("unknown / loading / created / absent / error 分别表达", () => {
    expect(describeCaptureRunPresence(undefined).label).toBe("尚未读取");
    expect(describeCaptureRunPresence({ state: "loading" }).label).toBe("正在读取");
    expect(describeCaptureRunPresence({ state: "created", runStatus: "WAITING", at: 1 }).label).toBe("已创建 · 状态读取中");
    expect(describeCaptureRunPresence({ state: "absent", at: 1 }).label).toContain("无（已确认读取成功）");
    const error = describeCaptureRunPresence({ state: "error", message: "HTTP 500", at: 1 });
    expect(error.label).toContain("读取失败");
    expect(error.label).not.toBe("无");
    expect(error.tone).toBe("fail");
  });

  it("present 使用运行状态标签，而不是布尔存在", () => {
    const view = describeBatchCaptureRun({ run: buildRealRun() });
    const presence = describeCaptureRunPresence({ state: "present", run: buildRealRun(), view, at: 1 });
    expect(presence.label).toBe("存在 · 部分完成");
    expect(presence.tone).toBe("warn");
  });
});

describe("T03 状态 Hero 与进度四态", () => {
  function withStatus(status: BatchCaptureRunView["status"], extra: Partial<BatchCaptureRunView> = {}): BatchCaptureRunView {
    return { ...buildRealRun(), status, ...extra };
  }

  it("等待启动：不伪造当前商品，进度条进入运行态", () => {
    const run = withStatus("WAITING", { cells: [], moduleOutcomes: [] });
    const view = describeBatchCaptureRun({ run });
    const model = buildConsoleModel({ view, run });
    expect(model.hero.title).toBe("等待执行器启动");
    expect(model.hero.subtitle).toContain("服务端持久化快照");
    expect(model.progress.state).toBe("running");
    expect(model.progress.value).toBe(0);
  });

  it("暂停请求中：进度停在真实值，不显示为已完成", () => {
    const run = withStatus("PAUSED", {
      pauseRequestedAt: "2026-10-22T10:00:00.000Z",
      leaseOwner: "executor-1",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      executionEpoch: 10,
      acknowledgedEpoch: 9,
    });
    const view = describeBatchCaptureRun({ run });
    const model = buildConsoleModel({ view, run });
    expect(model.hero.title).toBe("采集已暂停");
    expect(model.progress.state).toBe("paused");
    expect(model.progress.stateWord).toBe("本轮已暂停 · 已处理 30/30 件");
    expect(model.hero.subtitle).toContain("暂停请求已收到");
  });

  it("需要人工：给出登录/验证恢复说明，不合并为普通失败", () => {
    const run = withStatus("HUMAN_REQUIRED");
    const view = describeBatchCaptureRun({ run });
    const model = buildConsoleModel({ view, run });
    expect(model.hero.title).toBe("需要人工处理");
    expect(model.hero.suggestion).toContain("登录");
    expect(model.issues.some((issue) => issue.title.includes("人工"))).toBe(true);
  });

  it("采集中：显示持久化断点推导的当前 ASIN 与模块", () => {
    const run = withStatus("RUNNING", {
      leaseOwner: "executor-1",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      cells: [...buildRealRun().cells, {
        asin: "B0PENDING01", module: "amazon_detail", status: "pending", attempts: 0,
        evidenceId: null, lastErrorCode: null, sourceVerified: false, fieldComplete: false, researchConsumable: false,
      }],
      progress: { ...buildRealRun().progress, pendingCells: 1, terminalCells: 120, uniqueItemsVisited: 30 },
    });
    const view = describeBatchCaptureRun({ run });
    const model = buildConsoleModel({ view, run });
    expect(model.hero.title).toBe("正在采集");
    expect(model.hero.subtitle).toContain("B0PENDING01");
    expect(model.hero.subtitle).toContain("Amazon 商品详情");
    expect(model.progress.state).toBe("running");
  });
});
