import {
  PROVIDER_METRIC_EVIDENCE_SCHEMA,
  type ResearchInputBundleEvidenceRef,
  type ResearchProviderKeywordRow,
  type ResearchProviderMetric,
  type ResearchProviderMetricEvidence,
} from "@/lib/sourceLayer/v2/contracts";
import type { AdaptedV3Keyword } from "@/lib/server/research/v3EvidenceResearchAdapter";

/**
 * PH3：把已适配的 SellerSprite typed provider 行绑定进 ResearchInputBundle。
 *
 * 纯函数、只读、无副作用。铁律（全部 fail-closed，宁可缺也不猜）：
 *
 * 1. **来源必须是真实存在于 bundle 的附件引用**：`evidenceRefId` 必须在 `refs` 里存在
 *    且 `kind === "attachment"` 且 `attachmentId` 一致；否则整条 Provider 证据被丢弃。
 *    → 杜绝「Parser typedRows 直接进 bundle、没有对应 EvidenceStore 来源」。
 * 2. **不借用当前 Evidence 的 ID**：产物里**没有** evidenceId/evidenceVersion 字段 ——
 *    附件级来源就是 attachmentId + contentHash + capturedAt 三元组。
 * 3. **指标性质恒为 provider_***：任何非 provider_estimate / provider_observed 的指标整条丢弃，
 *    SellerSprite 估算绝不能被标成 Amazon confirmed。
 * 4. **未知不推断**：`observedAt` 只取证据自带的 provider 更新时间；`metricPeriod` 证据未声明
 *    则保持 null（当前 v3 证据包没有周期字段，故恒为 null）。
 * 5. **缺失保持 null**：数值缺失不转 0。
 * 6. **行级去重 + 稳定排序**：同一 keyword 保留首条，输出按 rowKey 排序，保证可复现。
 * 7. **附件自洽校验**：`attachmentId / contentHash / capturedAt` 必须与 bundle 中的附件引用一致。
 */
export function bindProviderMetricEvidence(input: {
  readonly adapted: readonly AdaptedV3Keyword[];
  readonly refs: readonly ResearchInputBundleEvidenceRef[];
  readonly subjectKey: string;
}): ResearchProviderMetricEvidence[] {
  const attachmentRefs = new Map(
    input.refs
      .filter((ref) => ref.kind === "attachment" && typeof ref.attachmentId === "string" && ref.attachmentId)
      .map((ref) => [`attachment:${ref.attachmentId}`, ref]),
  );

  const out: ResearchProviderMetricEvidence[] = [];
  for (const item of input.adapted) {
    const ref = attachmentRefs.get(item.evidenceRef);
    // (1) 没有对应的附件引用 → 整条丢弃（不允许无来源字段进入 Research）
    if (!ref || ref.attachmentId !== item.attachmentId) continue;
    // (7) 附件三元组必须与引用一致
    if (ref.contentHash !== item.contentHash || ref.capturedAt !== item.capturedAt) continue;
    // 身份必须与 bundle 主体一致，不允许跨 subject 混用
    if (item.subjectKey !== input.subjectKey) continue;

    const rows = normalizeRows(item);
    if (rows.length === 0) continue;

    out.push({
      schemaVersion: PROVIDER_METRIC_EVIDENCE_SCHEMA,
      provider: item.provider,
      module: item.module,
      subjectKey: item.subjectKey,
      queryIdentity: {
        subjectKey: item.subjectKey,
        marketplace: item.marketplace,
        asin: asinOf(item.subjectKey),
      },
      sourceType: item.sourceType,
      sourceSurface: item.sourceSurface,
      sourceUrl: item.sourceUrl,
      evidenceRefId: item.evidenceRef,
      attachmentId: item.attachmentId,
      contentHash: item.contentHash,
      capturedAt: item.capturedAt,
      // (4) 只使用证据自带的 provider 更新时间
      observedAt: isIsoDate(item.observedAt) ? item.observedAt : null,
      // v3 证据包不携带指标周期 → 恒为 null，不推断
      metricPeriod: null,
      metricNature: item.metricNature,
      limitations: [...item.limitations],
      rows,
    });
  }

  return out.sort((a, b) =>
    a.attachmentId.localeCompare(b.attachmentId)
    || a.module.localeCompare(b.module)
    || a.contentHash.localeCompare(b.contentHash));
}

function isIsoDate(value: string | null): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function asinOf(subjectKey: string): string | null {
  const asin = subjectKey.split(":").pop() ?? "";
  return /^[A-Z0-9]{10}$/u.test(asin) ? asin : null;
}

/** (6) 行级去重 + 指标规范化 + 稳定排序。 */
function normalizeRows(item: AdaptedV3Keyword): ResearchProviderKeywordRow[] {
  const byRowKey = new Map<string, ResearchProviderKeywordRow>();
  for (const row of item.typedRows) {
    const keyword = row.keyword?.trim();
    if (!keyword) continue; // 行必须携带明确 keyword（parser 已保证，二次防御）
    if (byRowKey.has(row.rowKey)) continue; // 同一 rowKey 只保留首条

    const metrics: ResearchProviderMetric[] = [];
    for (const [metric, typed] of Object.entries(row.metrics) as Array<[string, { raw: string | null; value: number | null; unit: string; metricNature: string; status: string }]>) {
      // (3) 指标性质只允许 provider_*；越界即丢弃该指标
      if (typed.metricNature !== "provider_estimate" && typed.metricNature !== "provider_observed") continue;
      metrics.push({
        metric,
        // (5) 缺失保持 null
        value: typeof typed.value === "number" && Number.isFinite(typed.value) ? typed.value : null,
        unit: normalizeUnit(typed.unit),
        metricNature: typed.metricNature,
        status: typed.status === "parsed" ? "parsed" : "unknown",
        raw: typed.raw ?? null,
      });
    }
    if (metrics.length === 0) continue; // 无合法指标的行走不进 Research 输入
    metrics.sort((a, b) => a.metric.localeCompare(b.metric));
    byRowKey.set(row.rowKey, {
      rowKey: row.rowKey,
      keyword,
      status: row.status === "valid" ? "valid" : "partial",
      metrics,
    });
  }
  return [...byRowKey.values()].sort((a, b) => a.rowKey.localeCompare(b.rowKey) || a.keyword.localeCompare(b.keyword));
}

function normalizeUnit(unit: string): ResearchProviderMetric["unit"] {
  switch (unit) {
    case "count":
    case "ratio":
    case "percent":
    case "currency":
      return unit;
    default:
      return "unknown";
  }
}
