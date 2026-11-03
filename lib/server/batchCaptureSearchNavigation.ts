/**
 * 批次「搜索阶段导航消耗」的可信推导（P0 预算合同）。
 *
 * 背景：`searchNavigationUsed` 表示**此前搜索阶段已经真实发生的导航次数**。
 * 它必须计入 BatchCaptureRun 的同一共享导航预算，否则用户可以通过传入 0
 * 把已经发生的真实消耗清零，变相扩大总访问额度。
 *
 * 因此该值**不能**直接采信浏览器提交的任意数字，必须从服务端已持久化、
 * 具有来源身份的批次回执推导：
 *   - 批次 provenance 显示它不是 Amazon 搜索采集批次 ⇒ 可证明没有搜索阶段 ⇒ 0；
 *   - 批次 provenance 显示它是搜索采集批次 ⇒ 必须有搜索阶段导航回执，
 *     缺失即**返回明确的预算合同阻塞**，不伪造、不无条件默认 0。
 *
 * 本模块只读，不写入任何事实，也不访问外部来源。
 */

const AMAZON_SEARCH_SOURCE_TYPE = "amazon_search_capture";

export type BatchSearchNavigationResolution =
  | {
    known: true;
    used: number;
    provenance: "no_search_stage" | "search_stage_receipt";
    reason: string;
  }
  | {
    known: false;
    code: "BATCH_CAPTURE_SEARCH_NAVIGATION_PROVENANCE_MISSING";
    reason: string;
  };

type BatchProvenanceInput = {
  normalizedSnapshotJson?: string | null;
  manifestJson?: string | null;
  qualitySummaryJson?: string | null;
};

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 从批次自身持久化的 provenance 读取 sourceType；无法解析时返回 null（视为来源未知）。 */
export function readBatchSourceType(batch: BatchProvenanceInput): string | null {
  for (const raw of [batch.manifestJson, batch.normalizedSnapshotJson]) {
    const parsed = parseJsonObject(raw);
    const sourceType = parsed?.sourceType;
    if (typeof sourceType === "string" && sourceType.trim()) return sourceType.trim();
  }
  return null;
}

/**
 * 推导本批次应继承的搜索阶段导航消耗。
 *
 * 判定顺序（先证伪、后取证）：
 * 1. 批次 provenance 明确不是 Amazon 搜索采集批次 → 没有搜索阶段 → 0（可证明）；
 * 2. 批次 provenance 是搜索采集批次 → 读取质量摘要中的搜索导航回执；
 *    回执缺失或不合法 → `known: false`，调用方必须**阻断**而不是默认 0。
 */
export function resolveBatchSearchNavigationUsed(batch: BatchProvenanceInput): BatchSearchNavigationResolution {
  const sourceType = readBatchSourceType(batch);
  if (sourceType !== AMAZON_SEARCH_SOURCE_TYPE) {
    return {
      known: true,
      used: 0,
      provenance: "no_search_stage",
      reason: sourceType === null
        ? "批次 provenance 未声明搜索采集来源，也没有任何搜索阶段导航记录，因此没有需要继承的搜索导航消耗。"
        : `批次来源为 ${sourceType}，不是 Amazon 搜索采集批次，没有需要继承的搜索导航消耗。`,
    };
  }
  const quality = parseJsonObject(batch.qualitySummaryJson);
  const recorded = quality?.searchNavigationUsed;
  if (typeof recorded === "number" && Number.isSafeInteger(recorded) && recorded >= 1) {
    return {
      known: true,
      used: recorded,
      provenance: "search_stage_receipt",
      reason: `搜索阶段已发生的导航次数来自批次质量摘要回执：${recorded}。`,
    };
  }
  return {
    known: false,
    code: "BATCH_CAPTURE_SEARCH_NAVIGATION_PROVENANCE_MISSING",
    reason: "该批次由 Amazon 搜索采集产生，但缺少可核验的搜索阶段导航回执；"
      + "为避免把已发生的真实导航消耗清零，已阻断启动，不伪造已用次数也不默认 0。",
  };
}
