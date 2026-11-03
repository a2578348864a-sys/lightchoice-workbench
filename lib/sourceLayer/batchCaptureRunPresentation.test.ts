import { describe, expect, it } from "vitest";

import {
  BATCH_CAPTURE_AUTO_MODULES,
  BATCH_CAPTURE_GAP_CATEGORY_LABELS,
  BATCH_CAPTURE_MODULE_ORDER,
  buildBatchCaptureModuleMatrix,
  buildGapTriage,
  checkStatusConsistency,
  describeBatchCaptureRun,
  wiringFor,
  type BatchCaptureRunView,
} from "./batchCaptureRunPresentation";

const ALL_MODULES = [
  "amazon_detail", "amazon_search_market", "sellersprite_product_market", "reverse_asin",
  "keyword_mining_trend", "variation", "review_voc", "historical_trend",
];
const NOT_WIRED = ["sellersprite_product_market", "reverse_asin", "keyword_mining_trend", "historical_trend"];
const ASINS = ["B000000001", "B000000002", "B000000003", "B000000004", "B000000005"];

function cell(module: string, asin: string, status: string, extra: Partial<BatchCaptureRunView["cells"][number]> = {}) {
  const backed = ["succeeded", "partial", "skipped_existing"].includes(status);
  return {
    asin, module, status, attempts: status === "pending" ? 0 : 1,
    evidenceId: backed ? `ev-${module}-${asin}` : null, lastErrorCode: null,
    sourceVerified: backed, fieldComplete: status === "succeeded" && module !== "amazon_search_market",
    researchConsumable: status === "succeeded" && BATCH_CAPTURE_AUTO_MODULES.includes(module),
    ...extra,
  };
}

function outcome(module: string, overrides: Partial<BatchCaptureRunView["moduleOutcomes"][number]> = {}) {
  const auto = BATCH_CAPTURE_AUTO_MODULES.includes(module);
  const search = module === "amazon_search_market";
  return {
    module, handling: "done",
    dataQuality: auto || search ? "has_valid" : "source_limited",
    completed: auto,
    itemsTotal: 5, itemsTerminal: 5, itemsSucceeded: auto || search ? 5 : 0,
    itemsPartial: 0, itemsHuman: 0, itemsFailed: 0, itemsSkipped: 0, itemsPending: 0,
    validEvidenceCount: auto || search ? 5 : 0, itemsFieldComplete: auto ? 5 : 0,
    itemsSourceLimited: auto || search ? 0 : 5, itemsResearchConsumable: auto ? 5 : 0,
    message: auto || search ? null : "该模块尚未接入自动采集，需要合法来源输入或人工会话。",
    errorCode: auto || search ? null : "SOURCE_INPUT_REQUIRED",
    ...overrides,
  };
}

/** RUNNING 且内部一致：详情全部处理完，变体 3/5，评论 1/5，仍有 pending。 */
function runningCells() {
  const cells: BatchCaptureRunView["cells"] = [];
  ASINS.forEach((asin, index) => {
    cells.push(cell("amazon_search_market", asin, "succeeded", { fieldComplete: false, researchConsumable: false }));
    cells.push(cell("amazon_detail", asin, "succeeded"));
    cells.push(cell("variation", asin, index < 3 ? "succeeded" : "pending",
      index < 3 ? {} : { evidenceId: null, sourceVerified: false, fieldComplete: false, researchConsumable: false }));
    cells.push(cell("review_voc", asin, index < 1 ? "succeeded" : "pending",
      index < 1 ? {} : { evidenceId: null, sourceVerified: false, fieldComplete: false, researchConsumable: false }));
    for (const moduleId of NOT_WIRED) {
      cells.push(cell(moduleId, asin, "source_input_required", {
        evidenceId: null, sourceVerified: false, fieldComplete: false, researchConsumable: false,
        lastErrorCode: "SOURCE_INPUT_REQUIRED",
      }));
    }
  });
  return cells;
}

function runningRun(overrides: Partial<BatchCaptureRunView> = {}): BatchCaptureRunView {
  const cells = runningCells();
  const byAsin = new Map<string, BatchCaptureRunView["cells"]>();
  for (const c of cells) byAsin.set(c.asin, [...(byAsin.get(c.asin) ?? []), c]);
  let uniqueItemsVisited = 0;
  for (const list of byAsin.values()) {
    if (list.some((c) => BATCH_CAPTURE_AUTO_MODULES.includes(c.module) && c.status !== "pending")) uniqueItemsVisited += 1;
  }
  return {
    runId: "run-01", batchId: "batch-01", runGeneration: 1, version: 7, status: "RUNNING",
    allowedModules: ALL_MODULES, maxItemsPerAdvance: 5, maxDriveSlices: 240, retryAuthorized: false,
    leaseOwner: null, leaseExpiresAt: null, cells,
    moduleOutcomes: ALL_MODULES.map((module) => outcome(module, {
      handling: module === "variation" || module === "review_voc" ? "in_progress" : "done",
      itemsPending: module === "variation" ? 2 : module === "review_voc" ? 4 : 0,
      itemsTerminal: module === "variation" ? 3 : module === "review_voc" ? 1 : 5,
      itemsSucceeded: module === "variation" ? 3 : module === "review_voc" ? 1 : (module === "amazon_detail" ? 5 : module === "amazon_search_market" ? 5 : 0),
      validEvidenceCount: module === "variation" ? 3 : module === "review_voc" ? 1 : (module === "amazon_detail" ? 5 : module === "amazon_search_market" ? 5 : 0),
      completed: module === "amazon_detail" || module === "amazon_search_market",
    })),
    progress: {
      itemsInBatch: 5, uniqueItemsVisited, detailSucceededItems: 5,
      pendingCells: 6, terminalCells: 34, totalCells: 40,
      validEvidenceCells: 14, fieldCompleteCells: 9, partialCells: 0, humanCells: 0,
      failedCells: 0, sourceLimitedCells: 20, researchConsumableCells: 9,
    },
    advances: 7, driveSlices: 7, lastErrorCode: null,
    lastMessage: "amazon_detail: 推进 5 商品；variation: 推进 3 商品",
    createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:05:00.000Z",
    startedAt: "2026-10-12T10:00:01.000Z", finishedAt: null, supersededRunId: null,
    ...overrides,
  };
}

const sampleGate = { sufficient: false, current: 5, required: 30 };
const deepItems = { ready: 0, total: 5 };

describe("batch capture run presentation (P0 correction)", () => {
  it("always exposes eight modules and labels the four gaps as not-wired (not permission-limited)", () => {
    const matrix = buildBatchCaptureModuleMatrix(runningRun());
    expect(matrix).toHaveLength(8);
  });

  it("模块矩阵的字段完整分母排除复用单元（不把复用算成字段不完整）", () => {
    const base = runningRun();
    const moduleOutcomes = base.moduleOutcomes.map((row) => (row.module === "review_voc"
      ? {
        ...row, handling: "done" as const, itemsTotal: 30, itemsSkipped: 27, itemsFailed: 3,
        itemsPending: 0, itemsSucceeded: 0, itemsFieldComplete: 0, validEvidenceCount: 27,
      }
      : row));
    const matrix = buildBatchCaptureModuleMatrix({ ...base, moduleOutcomes });
    const review = matrix.find((row) => row.module === "review_voc");
    // 30 个单元里 27 个是复用（未重新校验字段完整性）→ 分母 3，而不是 30
    expect(review?.itemsTotal).toBe(30);
    expect(review?.itemsSkipped).toBe(27);
    expect(review?.fieldCompleteEligible).toBe(3);
    expect(review?.itemsFieldComplete).toBe(0);
  });

  it("生产形态：allowedModules 不含搜索阶段模块时，矩阵仍为八行且不把搜索模块吃掉", () => {
    // 真实运行：normalizeModules 会去掉 amazon_search_market（advance 白名单=7），
    // start 时再单独写入搜索单元格。矩阵不得因此只剩 7 行。
    const productionLike = runningRun({
      allowedModules: ALL_MODULES.filter((m) => m !== "amazon_search_market"),
      moduleOutcomes: ALL_MODULES.filter((m) => m !== "amazon_search_market").map((m) => outcome(m)),
    });
    const matrix = buildBatchCaptureModuleMatrix(productionLike);
    expect(matrix).toHaveLength(8);
    expect(matrix.map((r) => r.module)).toEqual([...BATCH_CAPTURE_MODULE_ORDER]);
    expect(matrix.find((r) => r.module === "amazon_search_market")?.wiring).toBe("search_phase");
    for (const moduleId of NOT_WIRED) {
      const row = matrix.find((entry) => entry.module === moduleId);
      expect(row?.wiring).toBe("not_wired");
      expect(row?.wiringLabel).toBe("尚未接入自动采集");
      expect(row?.completed).toBe(false);
    }
    expect(matrix.find((r) => r.module === "amazon_search_market")?.wiring).toBe("search_phase");
    expect(matrix.filter((r) => r.wiring === "auto_wired")).toHaveLength(3);
    expect(matrix.some((r) => r.wiring === "source_permission")).toBe(false);
  });

  it("only escalates a gap to source_permission when a real permission code exists", () => {
    expect(wiringFor("reverse_asin")).toBe("not_wired");
    expect(wiringFor("reverse_asin", "SOURCE_INPUT_REQUIRED")).toBe("not_wired");
    expect(wiringFor("reverse_asin", "PROVIDER_PLAN_LIMITED")).toBe("source_permission");
    const withPermission = buildBatchCaptureModuleMatrix(runningRun({
      moduleOutcomes: ALL_MODULES.map((module) => module === "reverse_asin"
        ? outcome(module, { errorCode: "PROVIDER_PLAN_LIMITED" })
        : outcome(module, {
            handling: "in_progress", itemsPending: 2, itemsTerminal: 3,
            itemsSucceeded: module === "amazon_detail" ? 5 : 3,
          })),
    }));
    expect(withPermission.find((row) => row.module === "reverse_asin")?.wiringLabel).toBe("来源权限受限");
  });

  it("presents blocked Review/VOC evidence as a human gate, not valid or consumable review content", () => {
    const base = runningRun();
    const evidenceId = "ev-review-human-gate";
    const cells = base.cells.map((entry) => entry.module === "review_voc" && entry.asin === ASINS[0]
      ? { ...entry, status: "blocked_human", evidenceId, sourceVerified: false, fieldComplete: false, researchConsumable: false }
      : entry);
    const moduleOutcomes = base.moduleOutcomes.map((entry) => entry.module === "review_voc"
      ? {
          ...entry,
          handling: "blocked",
          dataQuality: "blocked",
          completed: false,
          itemsTerminal: 1,
          itemsSucceeded: 0,
          itemsHuman: 1,
          itemsPending: 4,
          validEvidenceCount: 0,
          itemsFieldComplete: 0,
          itemsResearchConsumable: 0,
          errorCode: "HUMAN_GATE_PAUSE",
        }
      : entry);
    const run = runningRun({
      cells,
      moduleOutcomes,
      progress: {
        ...base.progress,
        validEvidenceCells: base.progress.validEvidenceCells - 1,
        fieldCompleteCells: base.progress.fieldCompleteCells - 1,
        researchConsumableCells: base.progress.researchConsumableCells - 1,
        humanCells: 1,
      },
    });

    const view = describeBatchCaptureRun({ run });
    const review = view.moduleMatrix.find((row) => row.module === "review_voc");
    expect(run.cells.find((entry) => entry.module === "review_voc" && entry.asin === ASINS[0])).toMatchObject({ evidenceId, status: "blocked_human" });
    expect(review).toMatchObject({ itemsHuman: 1, validEvidenceCount: 0, itemsFieldComplete: 0, itemsResearchConsumable: 0 });
    expect(view.progress.humanCells).toBe(1);
    expect(view.researchEligibility.evidenceCandidacy.consumableModules).not.toContain("review_voc");
  });

  it("reports layered progress instead of a single misleading 100%", () => {
    const view = describeBatchCaptureRun({ run: runningRun(), sampleGate, deepResearchItems: deepItems });
    const p = view.progress;
    expect(p.uniqueItemsVisited).toBe(5);
    expect(p.uniqueItemsPercent).toBe(100);
    expect(p.deepProcessedItems).toBe(1);
    expect(p.deepProcessedPercent).toBe(20);
    expect(p.autoCellsTerminal).toBe(9);
    expect(p.autoCellsTotal).toBe(15);
    expect(p.autoExecutionPercent).toBe(60);
    expect(p.validEvidenceCells).toBe(14);
    expect(p.evidenceCoveragePercent).toBe(35);
    // 本代次新采集口径：非搜索阶段且 succeeded 的单元 = 详情 5 + 变体 3 + 评论 1 = 9
    expect(p.capturedCells).toBe(9);
    expect(p.fieldCompleteCells).toBe(9);
    expect(p.fieldCompletenessPercent).toBe(100);
    expect(p.reusedEvidenceCells).toBe(0);
    expect(p.completedModules).toBe(2);
    expect(p.totalModules).toBe(8);
    // 标签必须说明每个百分比是什么进度
    expect(p.labels.uniqueItems).toContain("商品已访问");
    expect(p.labels.deepProcessed).toContain("深度处理完成");
    expect(p.labels.evidenceCoverage).toContain("有效证据覆盖");
    expect(p.labels.fieldCompleteness).toContain("字段完整度");
  });

  it("复用证据不计入字段完整度分母，也不被算成缺失（覆盖率仍计入）", () => {
    const base = runningRun();
    // 把自动模块全部改成「复用已有证据」，模拟再次确认后的同一批次
    const cells = base.cells.map((cell) => (cell.module === "amazon_search_market"
      ? cell
      : {
        ...cell,
        status: "skipped_existing" as const,
        attempts: 1,
        evidenceId: `ev-reuse-${cell.asin}-${cell.module}`,
        sourceVerified: true,
        fieldComplete: false,
      }));
    const view = describeBatchCaptureRun({
      run: { ...base, status: "PARTIAL", cells, progress: { ...base.progress, validEvidenceCells: 35, pendingCells: 0 } },
    });
    const p = view.progress;
    // 复用单元没有重新采集 → 不进字段完整度分母
    expect(p.capturedCells).toBe(0);
    expect(p.reusedEvidenceCells).toBe(35);
    // 但它们仍是有效证据，不能算成缺失
    expect(p.validEvidenceCells).toBe(35);
    expect(p.evidenceCoveragePercent).toBeGreaterThan(0);
    // 缺口说明不得把这些单元描述成「字段不完整/采集失败」
    expect(view.gaps.some((gap) => /字段不完整|采集失败/.test(gap))).toBe(false);
  });

  it("评论抽取为空写成分辨得清的缺口，不冒充「该商品没有评论」", () => {
    const base = runningRun();
    const cells = base.cells.map((cell) => (cell.module === "review_voc"
      ? { ...cell, status: "failed_retryable" as const, attempts: 3, lastErrorCode: "REVIEW_EXTRACTION_EMPTY" }
      : cell));
    const moduleOutcomes = base.moduleOutcomes.map((row) => (row.module === "review_voc"
      ? { ...row, handling: "done" as const, itemsFailed: 5, itemsPending: 0, itemsSucceeded: 0, validEvidenceCount: 0, dataQuality: "blocked" as const }
      : row));
    const view = describeBatchCaptureRun({
      run: {
        ...base, status: "PARTIAL", cells, moduleOutcomes,
        progress: { ...base.progress, pendingCells: 0, failedCells: 5 },
      },
    });
    const reviewGap = view.gaps.find((gap) => gap.includes("评论抽取为空")) ?? "";
    expect(reviewGap).toContain("待核实");
    expect(reviewGap).toContain("不是采集成功");
    expect(view.gaps.some((gap) => /没有评论|无评论/.test(gap))).toBe(false);
  });

  it("flags an inconsistent RUNNING + zero-pending state instead of hiding it", () => {
    const inconsistent = runningRun({
      progress: { ...runningRun().progress, pendingCells: 0, terminalCells: 40 },
    });
    const consistency = checkStatusConsistency(inconsistent);
    expect(consistency.consistent).toBe(false);
    expect(consistency.issues.join(" ")).toContain("没有任何待处理单元");
    const view = describeBatchCaptureRun({ run: inconsistent });
    expect(view.gaps.some((gap) => gap.includes("状态一致性"))).toBe(true);
    // 一致的数据不产生该问题
    expect(checkStatusConsistency(runningRun()).consistent).toBe(true);
  });

  it("keeps market-research sample gate and product deep-research readiness as separate gates", () => {
    const view = describeBatchCaptureRun({ run: runningRun(), sampleGate, deepResearchItems: deepItems });
    const r = view.researchEligibility;
    // 不提供统一的 satisfied 字段
    expect(Object.prototype.hasOwnProperty.call(r, "satisfied")).toBe(false);
    expect(r.evidenceCandidacy.satisfied).toBe(true);
    expect(r.evidenceCandidacy.consumableCells).toBe(9);
    expect(r.marketSampleGate.known).toBe(true);
    expect(r.marketSampleGate.satisfied).toBe(false);
    expect(r.marketSampleGate.current).toBe(5);
    expect(r.marketSampleGate.required).toBe(30);
    expect(r.marketSampleGate.reason).toContain("至少需要 30");
    expect(r.deepResearchReadiness.readyItems).toBe(0);
    expect(r.deepResearchReadiness.totalItems).toBe(5);
    expect(r.researchReportConsumption.tracked).toBe(false);
  });

  it("does not invent a sample gate when the server value is missing", () => {
    const view = describeBatchCaptureRun({ run: runningRun() });
    expect(view.researchEligibility.marketSampleGate.known).toBe(false);
    expect(view.researchEligibility.marketSampleGate.satisfied).toBeNull();
    expect(view.researchEligibility.deepResearchReadiness.known).toBe(false);
  });

  it("separates search sample completion from product detail capture completion", () => {
    const view = describeBatchCaptureRun({ run: runningRun() });
    expect(view.searchSampleComplete).toBe(true);
    expect(view.detailCaptureComplete).toBe(false);
  });

  it("separates module execution completion from data quality", () => {
    const zeroFields = describeBatchCaptureRun({
      run: runningRun({
        status: "PARTIAL",
        moduleOutcomes: ALL_MODULES.map((module) => BATCH_CAPTURE_AUTO_MODULES.includes(module)
          ? outcome(module, {
              handling: "done", dataQuality: "empty", completed: false, itemsSucceeded: 0,
              validEvidenceCount: 0, itemsFieldComplete: 0, itemsResearchConsumable: 0,
              message: "全部商品已处理，但未取得有效证据字段。", errorCode: "MODULE_NO_VALID_EVIDENCE",
            })
          : outcome(module)),
      }),
    });
    const detail = zeroFields.moduleMatrix.find((row) => row.module === "amazon_detail");
    expect(detail?.handlingLabel).toBe("执行结束");
    expect(detail?.dataQualityLabel).toBe("无有效字段");
    expect(zeroFields.gaps.some((gap) => gap.includes("执行已结束但未取得有效字段"))).toBe(true);
  });

  it("renders a safe no-run state without inventing progress", () => {
    const view = describeBatchCaptureRun({ run: null, legacyJob: { status: "PENDING", total: 60, processed: 0 }, sampleGate });
    expect(view.hasRun).toBe(false);
    expect(view.statusLabel).toBe("未启动自动采集");
    expect(view.progress.itemsInBatch).toBe(0);
    expect(view.moduleMatrix).toHaveLength(8);
    expect(view.researchEligibility.evidenceCandidacy.satisfied).toBe(false);
    expect(view.researchEligibility.marketSampleGate.satisfied).toBe(false);
    expect(view.legacyJobNotice).toContain("历史");
    expect(view.actions.canDrive).toBe(false);
  });

it("P0-1) never reports an un-wired module as executed", () => {
    const matrix = buildBatchCaptureModuleMatrix(runningRun());
    for (const moduleId of NOT_WIRED) {
      const row = matrix.find((entry) => entry.module === moduleId);
      expect(row?.executed).toBe(false);
      expect(row?.handlingLabel).toBe("未执行");
      expect(row?.handlingLabel).not.toBe("执行结束");
      expect(row?.wiringLabel).toBe("尚未接入自动采集");
    }
    for (const moduleId of ["amazon_detail", "variation", "review_voc"]) {
      const row = matrix.find((entry) => entry.module === moduleId);
      expect(row?.executed).toBe(true);
      expect(row?.handlingLabel).not.toBe("未执行");
    }
    expect(matrix.find((entry) => entry.module === "amazon_search_market")?.executed).toBe(true);
  });

  it("P0-1) a permission-limited module is also shown as not executed", () => {
    const matrix = buildBatchCaptureModuleMatrix(runningRun({
      moduleOutcomes: ALL_MODULES.map((module) => module === "reverse_asin"
        ? outcome(module, { errorCode: "PROVIDER_PLAN_LIMITED" })
        : outcome(module, { handling: "in_progress", itemsPending: 2, itemsTerminal: 3 })),
    }));
    const row = matrix.find((entry) => entry.module === "reverse_asin");
    expect(row?.wiring).toBe("source_permission");
    expect(row?.executed).toBe(false);
    expect(row?.handlingLabel).toBe("未执行");
  });

  it("P0-2) completed with un-wired modules is worded as '本轮自动采集已结束' plus an explicit hint", () => {
    const view = describeBatchCaptureRun({ run: runningRun({ status: "COMPLETED" }), sampleGate, deepResearchItems: deepItems });
    expect(view.status).toBe("COMPLETED");
    expect(view.statusLabel).toBe("本轮自动采集已结束");
    expect(view.statusLabel).not.toBe("已完成");
    expect(view.completionHint).toContain("八模块数据尚未采齐");
    expect(view.completionHint).toContain("不属于本轮自动采集范围");
    expect(view.statusExplanation).toContain("八模块数据尚未采齐");
  });

  it("P0-2) keeps the plain completed wording when every module is wired and executed", () => {
    const fullyWired = describeBatchCaptureRun({
      run: runningRun({
        status: "COMPLETED",
        allowedModules: ["amazon_search_market", "amazon_detail", "variation", "review_voc"],
        moduleOutcomes: ["amazon_search_market", "amazon_detail", "variation", "review_voc"].map((module) => outcome(module)),
      }),
    });
    expect(fullyWired.statusLabel).toBe("已完成");
    expect(fullyWired.completionHint).toBeNull();
  });

  it("P0-2) does not claim completion while units are still pending", () => {
    const view = describeBatchCaptureRun({ run: runningRun(), sampleGate });
    expect(view.statusLabel).toBe("采集中");
    expect(view.completionHint).toBeNull();
    expect(view.progress.pendingCells).toBeGreaterThan(0);
  });

  it("exposes real pause/resume/cancel affordances by status", () => {
    expect(describeBatchCaptureRun({ run: runningRun() }).actions).toMatchObject({
      canDrive: true, canPause: true, canResume: false, canCancel: true,
    });
    expect(describeBatchCaptureRun({ run: runningRun({ status: "PAUSED" }) }).actions).toMatchObject({
      canDrive: true, canPause: false, canResume: true, canCancel: true,
    });
    const completed = describeBatchCaptureRun({ run: runningRun({ status: "COMPLETED" }) });
    expect(completed.actions.canDrive).toBe(false);
    expect(completed.actions.disabledReason).toContain("已完成");
  });

  it("PARTIAL + 失败单元达到上限：不显示重试/推进按钮，并解释原因（避免点了没反应）", () => {
    const base = runningRun();
    const cells = base.cells.map((cell) => (cell.module === "review_voc"
      ? { ...cell, status: "failed_retryable" as const, attempts: 3, lastErrorCode: "REVIEW_EXTRACTION_EMPTY" }
      : cell.status === "pending"
        ? { ...cell, status: "skipped_existing" as const, evidenceId: `ev-${cell.asin}-${cell.module}` }
        : cell));
    const view = describeBatchCaptureRun({
      run: { ...base, status: "PARTIAL", cells, progress: { ...base.progress, pendingCells: 0, failedCells: 5 } },
    });
    expect(view.actions.canRetry).toBe(false);
    expect(view.actions.canDrive).toBe(false);
    expect(view.actions.hasRetryableFailures).toBe(false);
    expect(view.actions.retryExhaustedFailures).toBe(true);
    expect(view.actions.disabledReason).toContain("上限");
  });

  it("PARTIAL + 仍有未达上限的失败：重试与继续都可用", () => {
    const base = runningRun();
    const cells = base.cells.map((cell) => (cell.module === "review_voc"
      ? { ...cell, status: "failed_retryable" as const, attempts: 1, lastErrorCode: "TRANSIENT_NETWORK" }
      : cell.status === "pending"
        ? { ...cell, status: "skipped_existing" as const, evidenceId: `ev-${cell.asin}-${cell.module}` }
        : cell));
    const view = describeBatchCaptureRun({
      run: { ...base, status: "PARTIAL", cells, progress: { ...base.progress, pendingCells: 0, failedCells: 5 } },
    });
    expect(view.actions.hasRetryableFailures).toBe(true);
    expect(view.actions.canRetry).toBe(true);
    expect(view.actions.canDrive).toBe(true);
    expect(view.actions.retryExhaustedFailures).toBe(false);
  });

  it("PARTIAL + 仍有待处理单元：可继续推进，但没有可重试失败时不给重试", () => {
    const base = runningRun();
    const view = describeBatchCaptureRun({
      run: { ...base, status: "PARTIAL", progress: { ...base.progress, failedCells: 0 } },
    });
    expect(view.actions.canDrive).toBe(true);
    expect(view.actions.canRetry).toBe(false);
    expect(view.actions.retryExhaustedFailures).toBe(false);
  });
});

describe("执行器状态（P0 安全事实：租约到期 ≠ 执行器已停止）", () => {
  it("租约有效时显示执行中", () => {
    const view = describeBatchCaptureRun({
      run: runningRun({ leaseOwner: "drive-1", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), executionEpoch: 1, acknowledgedEpoch: 0 }),
    });
    expect(view.executorState).toBe("running");
    expect(view.executorStateLabel).toBe("执行中");
    expect(view.recoveryTarget).toBeNull();
  });

  it("执行代次已获确认时显示执行器已确认退出", () => {
    const view = describeBatchCaptureRun({
      run: runningRun({
        status: "PAUSED", leaseOwner: null, leaseExpiresAt: null,
        executionEpoch: 2, acknowledgedEpoch: 2, stopConfirmedBy: "executor",
      }),
    });
    expect(view.executorState).toBe("stopped_confirmed");
    expect(view.executorStateHint).toContain("执行代次 2");
    expect(view.recoveryTarget).toBeNull();
  });

  it("租约已过期但执行代次未确认时显示状态未知，并给出人工确认所需的精确身份", () => {
    const view = describeBatchCaptureRun({
      run: runningRun({
        status: "CANCELLED", runId: "run-cancel-01", runGeneration: 3,
        leaseOwner: null, leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        executionEpoch: 4, acknowledgedEpoch: 3, stopAcknowledgedAt: null,
      }),
    });
    expect(view.executorState).toBe("unknown_needs_confirmation");
    expect(view.executorStateLabel).toBe("执行器状态未知，需要确认");
    expect(view.executorStateHint).toContain("租约超时不能证明旧执行器已停止");
    expect(view.recoveryTarget).toEqual({ runId: "run-cancel-01", runGeneration: 3, executionEpoch: 4 });
  });

  it("人工确认来源会被明确标注，不与执行器自身确认混淆", () => {
    const view = describeBatchCaptureRun({
      run: runningRun({
        status: "CANCELLED", executionEpoch: 1, acknowledgedEpoch: 1,
        stopConfirmedBy: "operator", stopRecoveryReason: "已核对旧采集进程不再存活",
      }),
    });
    expect(view.executorState).toBe("stopped_confirmed");
    expect(view.stopConfirmedBy).toBe("operator");
    expect(view.executorStateHint).toContain("人工核对后确认退出");
    expect(view.executorStateHint).toContain("已核对旧采集进程不再存活");
  });

  it("D2-1E：从未启动过执行的任务被中止/暂停时显示干净终态，不得显示「等待超时或需要检查」", () => {
    // 真实场景：创建任务后执行器被环境门禁拒绝（从未取得租约、执行代次为 0），用户随后中止。
    const cancelled = describeBatchCaptureRun({
      run: runningRun({
        status: "CANCELLED", executionEpoch: 0, acknowledgedEpoch: 0,
        cancelRequestedAt: "2026-10-16T20:01:30.000Z",
        leaseOwner: null, leaseExpiresAt: null, lastLeaseOwner: null,
        stopAcknowledgedAt: null,
      }),
    });
    expect(cancelled.pausePhase).toBe("acknowledged");
    expect(cancelled.statusLabel).toBe("已中止");
    expect(cancelled.pauseHint).toBeNull();
    expect(cancelled.pauseFacts.workerStopped).toBe(true);
    expect(cancelled.executorState).toBe("none");

    const paused = describeBatchCaptureRun({
      run: runningRun({
        status: "PAUSED", executionEpoch: 0, acknowledgedEpoch: 0,
        pauseRequestedAt: "2026-10-16T20:03:00.000Z",
        leaseOwner: null, leaseExpiresAt: null, lastLeaseOwner: null,
        stopAcknowledgedAt: null,
      }),
    });
    expect(paused.pausePhase).toBe("acknowledged");
    expect(paused.statusLabel).toBe("已暂停");
    expect(paused.pauseHint).toBeNull();
  });

  it("D2-1E：有过执行历史（曾经持租约）的任务，中止后仍按三事实要求等待退出确认", () => {
    const view = describeBatchCaptureRun({
      run: runningRun({
        status: "CANCELLED", executionEpoch: 3, acknowledgedEpoch: 2,
        cancelRequestedAt: "2026-10-16T20:01:30.000Z",
        leaseOwner: null, leaseExpiresAt: null, lastLeaseOwner: "drive-crashed",
        stopAcknowledgedAt: null,
      }),
    });
    // 曾有执行器 → 不能因为租约空了就宣称已停止；保持超时/需检查语义。
    expect(view.pausePhase).toBe("waiting_timeout");
    expect(view.pauseHint).toContain("租约到期不等于执行器已停止");
  });
});

describe("D2-1H: human-required and exited-executor states are explicit", () => {
  it("停止请求无回执但执行代次已关闭：显示已确认退出，不得自锁为「需要核对」", () => {
    /**
     * 正式批次 944e1e2c 的真实形态：暂停请求写入后执行器早已退出（代次 4 已关闭、无租约），
     * 只有 pauseAcknowledgedAt/stopAcknowledgedAt 为空。代次关闭已证明无在途执行，
     * 必须显示已确认退出；否则页面与后端判定相反，用户被永久挡在人工确认里。
     */
    const view = describeBatchCaptureRun({
      run: runningRun({
        status: "PAUSED",
        leaseOwner: null, leaseExpiresAt: null,
        executionEpoch: 4, acknowledgedEpoch: 4,
        pauseRequestedAt: "2026-10-17T08:47:44.192Z",
        pauseAcknowledgedAt: null,
        stopAcknowledgedAt: null,
        stopConfirmedBy: null,
      }),
    });
    expect(view.executorState).toBe("stopped_confirmed");
    expect(view.executorStateHint).toContain("不存在在途采集操作");
    expect(view.recoveryTarget).toBeNull();
    // 「继续」必须真的可用：不得再被「执行器状态未知」挡住（这正是反复点击无响应的形态）
    expect(view.actions.canResume).toBe(true);
    expect(view.actions.disabledReason).toBeNull();
    expect(view.pausePhase).toBe("acknowledged");
    expect(view.pauseFacts.workerStopped).toBe(true);
    // 历史回执（「正在等待在途采集退出」）与当前判定不得互相矛盾：必须当场解释
    expect(view.statusExplanation).toContain("已没有在途采集操作");
  });

  it("暂停时没有在途执行：控制操作当场给出停止确认", () => {
    const view = describeBatchCaptureRun({
      run: runningRun({
        status: "PAUSED",
        leaseOwner: null, leaseExpiresAt: null,
        executionEpoch: 2, acknowledgedEpoch: 2,
        pauseRequestedAt: "2026-10-17T08:47:44.192Z",
        pauseAcknowledgedAt: "2026-10-17T08:47:44.192Z",
        stopAcknowledgedAt: "2026-10-17T08:47:44.192Z",
        stopConfirmedBy: "control",
      }),
    });
    expect(view.executorState).toBe("stopped_confirmed");
    expect(view.executorStateHint).toContain("没有在途采集操作");
    expect(view.pausePhase).toBe("acknowledged");
    expect(view.statusLabel).toBe("已暂停");
  });

  it("HUMAN_REQUIRED renders as an explicit state with guidance and a resumable action", () => {
    const view = describeBatchCaptureRun({
      run: runningRun({
        status: "HUMAN_REQUIRED",
        leaseOwner: null, leaseExpiresAt: null,
        executionEpoch: 1, acknowledgedEpoch: 1,
      }),
    });
    expect(view.statusLabel).toBe("需要人工处理");
    expect(view.pausePhase).toBe("human_required");
    expect(view.pausePhaseLabel).toBe("需要人工处理");
    expect(view.pauseHint).toContain("人工");
    expect(view.pauseHint).toContain("继续");
    // 人工处理完成后允许通过同一「继续」按钮恢复（服务端会重新检查）
    expect(view.actions.canResume).toBe(true);
  });

  it("RUNNING with an exited executor carries an explicit explanation instead of silent contradiction", () => {
    const view = describeBatchCaptureRun({
      run: runningRun({
        status: "RUNNING",
        leaseOwner: null, leaseExpiresAt: null,
        executionEpoch: 1, acknowledgedEpoch: 1,
      }),
    });
    expect(view.statusLabel).toBe("采集中");
    expect(view.executorState).toBe("stopped_confirmed");
    expect(view.statusExplanation).toContain("执行器已确认退出");
    expect(view.statusExplanation).toContain("继续");
  });
});

/* ─────────────────────────────────────────────────────────────
 * E-1C 采集缺口分诊：五类分类 + 查询级文案 + 开关关闭 + 计数不变
 * ───────────────────────────────────────────────────────────── */

type QueryUnitOf<K extends "productMarketQueries" | "keywordMiningQueries"> =
  NonNullable<BatchCaptureRunView[K]>[number];

const BATCH_ASINS = Array.from({ length: 30 }, (_, index) => `B0${String(index).padStart(8, "0")}`);
const BASE_URL = "2026-10-17T00:00:00.000Z";

const productMarketQuery = (
  overrides: Partial<QueryUnitOf<"productMarketQueries">> = {},
): QueryUnitOf<"productMarketQueries"> => ({
  queryId: "query-product-market-01",
  category: "Kitchen & Dining",
  marketplace: "US",
  filters: {},
  status: "pending",
  querySubjectKey: null,
  evidenceAttachmentId: null,
  evidenceContentHash: null,
  rowsObserved: 0,
  productAssociations: [],
  errorCode: null,
  updatedAt: BASE_URL,
  ...overrides,
});

const keywordMiningQuery = (
  overrides: Partial<QueryUnitOf<"keywordMiningQueries">> = {},
): QueryUnitOf<"keywordMiningQueries"> => ({
  queryId: "query-keyword-mining-01",
  seedKeyword: "silicone baking mat",
  marketplace: "US",
  conditions: {},
  status: "pending",
  querySubjectKey: `sellersprite:US:keyword-mining:${"a".repeat(64)}`,
  queryFingerprint: "a".repeat(64),
  evidenceAttachmentId: null,
  evidenceContentHash: null,
  rowsObserved: 0,
  errorCode: null,
  updatedAt: BASE_URL,
  ...overrides,
});

/** 生产形态：30 商品 × 8 模块 = 240 单元；117 有效证据 / 120 来源受限 / 3 采集失败。 */
function baselineCells(asins: readonly string[] = BATCH_ASINS): BatchCaptureRunView["cells"] {
  const cells: BatchCaptureRunView["cells"] = [];
  for (const asin of asins) {
    cells.push(cell("amazon_search_market", asin, "succeeded", { fieldComplete: false, researchConsumable: false }));
    cells.push(cell("amazon_detail", asin, "succeeded"));
    cells.push(cell("variation", asin, "succeeded"));
    cells.push(cell("review_voc", asin, "partial", { fieldComplete: false, researchConsumable: false }));
    for (const moduleId of NOT_WIRED) {
      cells.push(cell(moduleId, asin, "source_input_required", {
        evidenceId: null, sourceVerified: false, fieldComplete: false, researchConsumable: false,
        lastErrorCode: "SOURCE_INPUT_REQUIRED",
      }));
    }
  }
  const failedDetailAsins = new Set(asins.slice(-3));
  return cells.map((entry) => (entry.module === "amazon_detail" && failedDetailAsins.has(entry.asin)
    ? {
      ...entry, status: "failed_retryable" as const, attempts: 3, lastErrorCode: "ENRICH_EMPTY_RESULT",
      evidenceId: null, sourceVerified: false, fieldComplete: false, researchConsumable: false,
    }
    : entry));
}

function baselineOutcomes(): BatchCaptureRunView["moduleOutcomes"] {
  const row = (module: string, overrides: Partial<BatchCaptureRunView["moduleOutcomes"][number]>) => ({
    module, handling: "done" as const, dataQuality: "has_valid" as const, completed: true,
    itemsTotal: 30, itemsTerminal: 30, itemsSucceeded: 0, itemsPartial: 0, itemsHuman: 0,
    itemsFailed: 0, itemsSkipped: 0, itemsPending: 0, validEvidenceCount: 0,
    itemsFieldComplete: 0, itemsSourceLimited: 0, itemsResearchConsumable: 0,
    message: null, errorCode: null,
    ...overrides,
  });
  return [
    row("amazon_search_market", { itemsSucceeded: 30, validEvidenceCount: 30 }),
    row("amazon_detail", {
      itemsSucceeded: 27, itemsFailed: 3, validEvidenceCount: 27,
      itemsFieldComplete: 27, itemsResearchConsumable: 27,
    }),
    row("variation", { itemsSucceeded: 30, validEvidenceCount: 30, itemsFieldComplete: 30, itemsResearchConsumable: 30 }),
    row("review_voc", { itemsPartial: 30, validEvidenceCount: 30 }),
    ...NOT_WIRED.map((module) => row(module, {
      dataQuality: "source_limited" as const, completed: false, itemsSourceLimited: 30,
      message: "该模块尚未接入自动采集，需要合法来源输入或人工会话。",
      errorCode: "SOURCE_INPUT_REQUIRED",
    })),
  ];
}

function baselineRun(overrides: Partial<BatchCaptureRunView> = {}): BatchCaptureRunView {
  return {
    runId: "run-e1c", batchId: "batch-e1c", runGeneration: 1, version: 9, status: "PARTIAL",
    allowedModules: ALL_MODULES, maxItemsPerAdvance: 30, maxDriveSlices: 240, retryAuthorized: false,
    leaseOwner: null, leaseExpiresAt: null,
    cells: baselineCells(), moduleOutcomes: baselineOutcomes(),
    productMarketQueries: [], keywordMiningQueries: [],
    progress: {
      itemsInBatch: 30, uniqueItemsVisited: 30, detailSucceededItems: 27,
      pendingCells: 0, terminalCells: 240, totalCells: 240,
      validEvidenceCells: 117, fieldCompleteCells: 57, partialCells: 30, humanCells: 0,
      failedCells: 3, sourceLimitedCells: 120, researchConsumableCells: 57,
    },
    advances: 8, driveSlices: 8, lastErrorCode: null,
    lastMessage: "detail: 推进 30 商品；variation: 推进 30 商品；review_voc: 推进 30 商品",
    createdAt: BASE_URL, updatedAt: BASE_URL, startedAt: BASE_URL, finishedAt: BASE_URL,
    supersededRunId: null,
    ...overrides,
  };
}

function withReverseAsinCode(
  cells: BatchCaptureRunView["cells"],
  code: string,
  asins: readonly string[] = BATCH_ASINS,
): BatchCaptureRunView["cells"] {
  const scope = new Set(asins);
  return cells.map((entry) => (entry.module === "reverse_asin" && scope.has(entry.asin)
    ? { ...entry, lastErrorCode: code }
    : entry));
}

describe("E-1C 采集缺口分诊：五类分类与恢复条件", () => {
  it("同一次运行可区分五类缺口，每条都有文案与恢复条件", () => {
    const run = baselineRun({
      cells: withReverseAsinCode(baselineCells(), "SELLERSPRITE_REVERSE_ASIN_BCR_DISABLED"),
      productMarketQueries: [productMarketQuery({
        status: "failed", errorCode: "SELLERSPRITE_QUERY_NAVIGATION_BUDGET_INSUFFICIENT",
      })],
      keywordMiningQueries: [keywordMiningQuery({
        status: "blocked", errorCode: "SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED",
      })],
    });
    const view = describeBatchCaptureRun({ run });
    const categories = new Set(view.gapTriage.map((gap) => gap.category));
    expect(categories.has("batch_query_not_executed")).toBe(true);
    expect(categories.has("source_switch_disabled")).toBe(true);
    expect(categories.has("human_input_required")).toBe(true);
    expect(categories.has("product_capture_failed")).toBe(true);
    expect(categories.has("product_field_incomplete")).toBe(true);
    for (const gap of view.gapTriage) {
      expect(gap.categoryLabel).toBe(BATCH_CAPTURE_GAP_CATEGORY_LABELS[gap.category]);
      expect(gap.detail.length).toBeGreaterThan(0);
      expect(gap.recovery.length).toBeGreaterThan(0);
      expect(gap.text).toContain(gap.detail);
      expect(gap.text).toContain(gap.recovery);
      // 结构化分诊与旧 gaps 列表同源：每条 text 都在 gaps 中，供面板去重后渲染剩余条目。
      expect(view.gaps).toContain(gap.text);
    }
  });

  it("商品/关键词有查询单元时写成「1 个批次级查询」，不再说成 30 个商品未接入", () => {
    const view = describeBatchCaptureRun({
      run: baselineRun({
        productMarketQueries: [productMarketQuery({ status: "blocked", errorCode: "SELLERSPRITE_PRODUCT_MARKET_BCR_DISABLED" })],
        keywordMiningQueries: [keywordMiningQuery({ status: "blocked", errorCode: "SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED" })],
      }),
    });
    const productGap = view.gaps.find((gap) => gap.includes("1 个批次级查询：类目 Kitchen & Dining")) ?? "";
    expect(productGap).toContain("状态 前置条件阻止");
    expect(productGap).toContain("SELLERSPRITE_PRODUCT_MARKET_BCR_DISABLED");
    const keywordGap = view.gaps.find((gap) => gap.includes("1 个批次级查询：seedKeyword silicone baking mat")) ?? "";
    expect(keywordGap).toContain("SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED");
    // 不允许再出现「N 个商品尚未接入自动采集」这种把批次级查询说成商品级缺口的表述。
    expect(view.gaps.some((gap) => /卖家精灵商品市场：30 个商品/.test(gap))).toBe(false);
    expect(view.gaps.some((gap) => /关键词挖掘与趋势：30 个商品/.test(gap))).toBe(false);
    expect(view.gaps.some((gap) => /卖家精灵|关键词挖掘/.test(gap) && gap.includes("个商品尚未接入自动采集"))).toBe(false);
    // 商品单元仍如实记为来源受限：文案改写不改变任何计数口径。
    expect(view.moduleMatrix.find((row) => row.module === "sellersprite_product_market")?.itemsSourceLimited).toBe(30);
    expect(view.moduleMatrix.find((row) => row.module === "keyword_mining_trend")?.itemsSourceLimited).toBe(30);
    expect(view.progress.sourceLimitedCells).toBe(120);
    expect(view.progress.validEvidenceCells).toBe(117);
    expect(view.progress.totalCells).toBe(240);
    expect(view.moduleMatrix).toHaveLength(8);
    expect(view.moduleMatrix.filter((row) => row.wiring === "auto_wired")).toHaveLength(3);
  });

  it("没有创建任何批次级查询时，按批次查询如实说明（不退化成「30 个商品未接入」）", () => {
    const view = describeBatchCaptureRun({ run: baselineRun() });
    const productGap = view.gaps.find((gap) => gap.includes("卖家精灵商品市场")) ?? "";
    const keywordGap = view.gaps.find((gap) => gap.includes("关键词挖掘与趋势")) ?? "";
    // 这两个模块在计划里就是 1 个批次级查询；本批次一个查询单元都没有 → 说的是「0/1 查询未执行」
    expect(productGap).toContain("没有创建批次级查询");
    expect(keywordGap).toContain("没有创建批次级查询");
    expect(productGap).not.toContain("30 个商品");
    expect(keywordGap).not.toContain("30 个商品");
    // 查询型模块不得出现「N 个商品尚未接入自动采集」的商品级表述（其它模块仍可有）
    expect(view.gaps.some((gap) => /(卖家精灵商品市场|关键词挖掘与趋势)[^。]*个商品尚未接入/.test(gap))).toBe(false);
    // 分诊归类为「批次级查询未执行」，且计数口径完全不变
    expect(view.gapTriage.filter((gap) => gap.category === "batch_query_not_executed").length).toBe(2);
    expect(view.progress.sourceLimitedCells).toBe(120);
    expect(view.progress.validEvidenceCells).toBe(117);
    expect(view.moduleMatrix.find((row) => row.module === "sellersprite_product_market")?.itemsSourceLimited).toBe(30);
  });

  it("来源开关关闭按真实错误码归类，并给出对应的开关恢复条件", () => {
    const view = describeBatchCaptureRun({
      run: baselineRun({
        cells: withReverseAsinCode(baselineCells(), "SELLERSPRITE_REVERSE_ASIN_BCR_DISABLED"),
        productMarketQueries: [productMarketQuery({ status: "blocked", errorCode: "SELLERSPRITE_PRODUCT_MARKET_BCR_DISABLED" })],
        keywordMiningQueries: [keywordMiningQuery({ status: "blocked", errorCode: "SELLERSPRITE_KEYWORD_MINING_BCR_DISABLED" })],
      }),
    });
    const switchGaps = view.gapTriage.filter((gap) => gap.category === "source_switch_disabled");
    const reverseGap = switchGaps.find((gap) => gap.module === "reverse_asin");
    expect(reverseGap?.reasonCode).toBe("SELLERSPRITE_REVERSE_ASIN_BCR_DISABLED");
    expect(reverseGap?.detail).toContain("反查 ASIN");
    expect(reverseGap?.detail).toContain("没有打开浏览器");
    expect(reverseGap?.affectedCount).toBe(30);
    expect(reverseGap?.recovery).toContain("SELLERSPRITE_REVERSE_ASIN_BCR_ENABLED");
    const productGap = switchGaps.find((gap) => gap.module === "sellersprite_product_market");
    expect(productGap?.detail).toContain("1 个批次级查询：类目 Kitchen & Dining");
    expect(productGap?.recovery).toContain("SELLERSPRITE_PRODUCT_MARKET_BCR_ENABLED");
    const keywordGap = switchGaps.find((gap) => gap.module === "keyword_mining_trend");
    expect(keywordGap?.recovery).toContain("SELLERSPRITE_KEYWORD_MINING_BCR_ENABLED");
    // 反查 ASIN 的重试上限/未接线文案不得与「开关关闭」重复计数。
    expect(view.gaps.some((gap) => /反查 ASIN：30 个商品尚未接入自动采集/.test(gap))).toBe(false);
  });

  it("反查 ASIN 没有开关错误码时归到「商品级未采集」，不冒充来源开关关闭", () => {
    const view = describeBatchCaptureRun({ run: baselineRun() });
    const reverseGap = view.gapTriage.find((gap) => gap.module === "reverse_asin");
    expect(reverseGap?.category).toBe("product_not_captured");
    expect(reverseGap?.affectedCount).toBe(30);
    expect(view.gapTriage.some((gap) => gap.category === "source_switch_disabled")).toBe(false);
  });

  it("商品级失败/字段不完整分别计数，且不改变 progress 与模块矩阵", () => {
    const view = describeBatchCaptureRun({ run: baselineRun() });
    const failedGaps = view.gapTriage.filter((gap) => gap.category === "product_capture_failed");
    expect(failedGaps).toHaveLength(1);
    expect(failedGaps[0]).toMatchObject({ module: "amazon_detail", affectedCount: 3, reasonCode: "ENRICH_EMPTY_RESULT" });
    expect(failedGaps[0].detail).toContain("3 个商品采集失败");
    const partialGaps = view.gapTriage.filter((gap) => gap.category === "product_field_incomplete");
    expect(partialGaps.reduce((sum, gap) => sum + gap.affectedCount, 0)).toBe(view.progress.partialCells);
    expect(view.progress.partialCells).toBe(30);
    expect(view.progress.failedCells).toBe(3);
    expect(view.moduleMatrix.find((row) => row.module === "review_voc")?.itemsPartial).toBe(30);
  });

  it("同一批单元/同一 progress：只改查询状态与文案，所有计数与矩阵完全不变", () => {
    const cells = baselineCells();
    const pending = describeBatchCaptureRun({
      run: baselineRun({ cells, productMarketQueries: [productMarketQuery({ status: "pending" })] }),
    });
    const blocked = describeBatchCaptureRun({
      run: baselineRun({
        cells,
        productMarketQueries: [productMarketQuery({ status: "blocked", errorCode: "SELLERSPRITE_PRODUCT_MARKET_BASE_EVIDENCE_MISSING" })],
      }),
    });
    expect(blocked.progress).toEqual(pending.progress);
    expect(blocked.moduleMatrix).toEqual(pending.moduleMatrix);
    expect(blocked.gaps).not.toEqual(pending.gaps);
    expect(pending.gapTriage.find((gap) => gap.scope === "batch_query")?.detail).toContain("原因（未返回错误码）");
    expect(blocked.gapTriage.find((gap) => gap.scope === "batch_query")?.reasonCode)
      .toBe("SELLERSPRITE_PRODUCT_MARKET_BASE_EVIDENCE_MISSING");
    expect(blocked.progress.sourceLimitedCells).toBe(pending.progress.sourceLimitedCells);
    expect(blocked.progress.validEvidenceCells).toBe(pending.progress.validEvidenceCells);
  });

  it("查询已成功保存时不生成批次级缺口，也不退回商品级未采集表述", () => {
    const view = describeBatchCaptureRun({
      run: baselineRun({
        productMarketQueries: [productMarketQuery({
          status: "captured",
          querySubjectKey: `sellersprite:US:product-market:${"b".repeat(64)}`,
          evidenceAttachmentId: "attachment-pm",
          evidenceContentHash: "c".repeat(64),
          rowsObserved: 40,
        })],
      }),
    });
    expect(view.gaps.some((gap) => gap.includes("卖家精灵商品市场"))).toBe(false);
    expect(view.gapTriage.some((gap) => gap.module === "sellersprite_product_market" && gap.scope === "batch_query")).toBe(false);
    // 商品级单元仍是来源受限，矩阵计数保持真实。
    expect(view.moduleMatrix.find((row) => row.module === "sellersprite_product_market")?.itemsSourceLimited).toBe(30);
  });

  it("无运行状态不虚构缺口分类，但仍给出证据去向说明", () => {
    const view = describeBatchCaptureRun({ run: null });
    expect(view.gapTriage).toEqual([]);
    expect(view.gaps).toEqual(["自动采集执行器尚未启动。"]);
    expect(view.evidenceDestination.queryLevel).toContain("不进入 ResearchInputBundle");
    expect(view.evidenceDestination.productLevel).toContain("按既有边界进入研究输入");
  });

  it("buildGapTriage 是纯函数：重复调用返回相同结构，不修改 run", () => {
    const run = baselineRun({
      productMarketQueries: [productMarketQuery({ status: "blocked", errorCode: "SELLERSPRITE_PRODUCT_MARKET_BCR_DISABLED" })],
    });
    const snapshot = JSON.stringify(run);
    const matrix = buildBatchCaptureModuleMatrix(run);
    const first = buildGapTriage(run, matrix);
    const second = buildGapTriage(run, matrix);
    expect(second).toEqual(first);
    expect(JSON.stringify(run)).toBe(snapshot);
  });
});

describe("变体抽取为空的口径", () => {
  it("不把「抽取为空」写成「该商品没有变体」，并要求人工核实", () => {
    const base = runningRun();
    const cells = base.cells.map((cell) => (cell.module === "variation"
      ? { ...cell, status: "failed_retryable" as const, attempts: 3, lastErrorCode: "VARIATION_EXTRACTION_EMPTY" }
      : cell));
    const moduleOutcomes = base.moduleOutcomes.map((row) => (row.module === "variation"
      ? { ...row, handling: "done" as const, itemsFailed: 4, itemsPending: 0, itemsSucceeded: 1, validEvidenceCount: 0, dataQuality: "blocked" as const }
      : row));
    const view = describeBatchCaptureRun({
      run: {
        ...base, status: "PARTIAL", cells, moduleOutcomes,
        progress: { ...base.progress, pendingCells: 0, failedCells: 4 },
      },
    });
    const gap = view.gaps.find((item) => item.includes("变体抽取为空")) ?? "";
    expect(gap).toContain("待人工核实");
    expect(gap).toContain("未发现变体根元素");
    // 关键反向断言：不得出现「没有变体」这种把未知当结论的表述
    expect(gap).not.toContain("该商品没有变体");
    expect(gap).toContain("不是已确认的空数据");
  });
});
