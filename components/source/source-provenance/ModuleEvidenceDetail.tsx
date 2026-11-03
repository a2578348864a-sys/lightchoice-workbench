"use client";

import {
  AlertTriangle,
  ExternalLink,
  Loader2,
} from "lucide-react";

import type { ProductModuleStatus } from "@/lib/sourceLayer/moduleStatusPresentation";
import { MODULE_LIMITATION_LABELS } from "@/components/source/batch-workspace/modulePresentation";
import { moduleStatusLabel, PROVENANCE_MODULE_LABELS } from "./sourceProvenanceModel";
import {
  describeFieldProvenanceRelation,
  fieldLabel,
  fieldReasonLabel,
  fieldStatusLabel,
  fieldStatusTone,
  formatFieldValue,
  formatProvenanceTime,
  type FieldProvenanceEntry,
} from "./fieldProvenancePresentation";
import styles from "./ModuleEvidenceDetail.module.css";

type RegisteredField = {
  canonicalField?: string;
  priority?: string;
  fieldNature?: string;
  status?: string;
  value?: unknown;
  reason?: string | null;
  sourceTrace?: unknown;
};

type ModuleEvidence = {
  schemaVersion?: string;
  module?: string;
  subjectKey?: string;
  marketplace?: string;
  capturedAt?: string;
  provider?: string;
  sourceSurface?: string;
  sourceUrl?: string;
  providerUpdatedAt?: string | null;
  freshness?: { state?: string; ttlMs?: number; providerUpdatedAt?: string | null; ageMs?: number | null };
  acquisitionMode?: string;
  metricNature?: string;
  status?: string;
  limitations?: string[];
  identity?: Record<string, unknown>;
  data?: {
    registeredFields?: Record<string, RegisteredField>;
    payload?: unknown;
    pageFieldPresenceAudit?: unknown;
  };
  evidenceOnly?: boolean;
};

type ModuleEvidencePayload = {
  subjectKey?: string;
  modules?: ModuleEvidence[];
  attachmentCount?: number;
  rawArtifactCount?: number;
  downstream?: { readable?: boolean; evidenceOnly?: boolean };
};

const EVIDENCE_STATUS_LABELS: Record<string, string> = {
  VALIDATED_AVAILABLE: "已取得有效证据",
  AVAILABLE_WITH_LIMITATION: "有证据但受限",
  UNVERIFIED: "未验证",
  BLOCKED: "受阻",
  BLOCKED_WITH_EVIDENCE: "受阻（有证据）",
  CAPTURED_PARTIAL: "部分取得",
  HUMAN_ACTION_REQUIRED: "需要人工处理",
  NO_DATA: "无有效字段",
  PARTIAL: "部分证据",
};

const FIELD_ORDER = [
  "asin",
  "title",
  "brand",
  "price",
  "currency",
  "rating",
  "reviewCount",
  "bsr",
  "bsrRanks",
  "category",
  "categoryPath",
  "mainImage",
  "bulletPoints",
  "material",
  "packageDimensions",
  "packageWeight",
  "itemDimensions",
  "itemWeight",
  "color",
  "size",
  "dateFirstAvailable",
];

function asPayload(value: unknown): ModuleEvidencePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ModuleEvidencePayload;
}

function asRecord(value: unknown): Record<string, RegisteredField> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, RegisteredField>;
}

const MODULE_DATA_LABELS: Record<string, string> = {
  outcome: "结果",
  variationStatus: "变体状态",
  parentAsin: "父 ASIN",
  currentAsin: "当前 ASIN",
  variantAsins: "变体 ASIN",
  variants: "变体明细",
  dimensions: "变体维度",
  reviewCount: "评论数",
  reviews: "已读取评论",
  query: "查询词",
  page: "页码",
  position: "位置",
  sponsored: "广告位",
  observedProduct: "观测商品",
  error: "错误",
  captureDiagnostics: "采集诊断",
  identityProof: "身份校验",
  traceId: "Trace ID",
  sourceUrl: "来源链接",
  capturedAt: "采集时间",
  rawVariationSignals: "原始变体信号",
  rawVariationSignalsStatus: "原始信号状态",
};

const OUTCOME_LABELS: Record<string, string> = {
  COMPLETE: "已完成",
  PARTIAL: "部分完成",
  FAILED_HUMAN: "需要人工处理",
  FAILED_RETRYABLE: "可重试失败",
  FAILED_PERMANENT: "失败",
  BLOCKED: "受阻",
  BLOCKED_WITH_EVIDENCE: "受阻（有证据）",
  CAPTURED_PARTIAL: "部分取得",
  HUMAN_ACTION_REQUIRED: "需要人工处理",
  NO_DATA: "无有效数据",
  NOT_COLLECTED: "未采集",
};

const EVIDENCE_ERROR_LABELS: Record<string, string> = {
  LOCAL_ENVIRONMENT_REQUIRED: "需要本机采集环境，请检查原采集浏览器与启动配置",
  CAPTCHA_DETECTED: "检测到验证码，需要人工处理",
  CAPTCHA_REQUIRES_HUMAN: "需要人工处理验证码",
  VARIATION_EXTRACTION_EMPTY: "页面未返回可验证的变体数据",
  REVIEW_EXTRACTION_EMPTY: "页面未提取到可验证评论",
  PAGE_ASIN_ANCHOR_MISMATCH: "页面与目标商品身份不匹配",
  MODULE_NO_VALID_EVIDENCE: "未取得有效证据字段",
  HUMAN_ACTION_REQUIRED: "需要人工处理页面提示",
};

function formatLimitation(value: string): string {
  if (value.toLowerCase() === "local_environment_required") return "需要本机采集环境";
  return MODULE_LIMITATION_LABELS[value] ?? MODULE_LIMITATION_LABELS[value.toLowerCase()] ?? "来源限制（原始原因见高级信息）";
}

function formatEvidenceError(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return EVIDENCE_ERROR_LABELS[value] ?? "采集未完成（原始原因见高级信息）";
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : null;
    if (code && EVIDENCE_ERROR_LABELS[code]) return EVIDENCE_ERROR_LABELS[code];
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  }
  return "采集未完成（原始原因见高级信息）";
}

const GENERIC_SKIP_KEYS = new Set([
  "traceId", "captureDiagnostics", "identityProof", "sourceUrl", "capturedAt",
  "rawVariationSignals", "rawVariationSignalsStatus", "error",
]);

function genericValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    const first = value[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const record = first as Record<string, unknown>;
      const label = record.asin ?? record.rating ?? record.title ?? null;
      return `${value.length} 项${label ? ` · 首项 ${String(label).slice(0, 60)}` : ""}`;
    }
    return `${value.length} 项 · ${value.slice(0, 3).map((entry) => String(entry)).join("、")}`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.asin === "string") {
      const title = typeof record.title === "string" ? ` · ${record.title}` : "";
      return `${record.asin}${title}`.slice(0, 160);
    }
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }
  return String(value);
}

function genericRows(data: Record<string, unknown> | undefined): Array<{ key: string; label: string; value: string }> {
  if (!data) return [];
  return Object.entries(data)
    .filter(([key]) => !GENERIC_SKIP_KEYS.has(key))
    .map(([key, value]) => {
      const display = key === "outcome" && typeof value === "string"
        ? OUTCOME_LABELS[value] ?? "结果状态待核对"
        : key === "sponsored" && typeof value === "boolean"
          ? (value ? "是" : "否")
          : genericValue(value);
      return { key, label: MODULE_DATA_LABELS[key] ?? fieldLabel(key), value: display };
    })
    .filter((row) => row.value !== "—")
    .slice(0, 10);
}

function statusTone(status: string | undefined): "ok" | "warn" | "fail" | "off" | "info" {
  const tone = fieldStatusTone(status);
  return tone === "info" ? "info" : tone;
}

function sortFields(entries: Array<{ key: string; field: RegisteredField }>): Array<{ key: string; field: RegisteredField }> {
  return [...entries].sort((a, b) => {
    const ai = FIELD_ORDER.indexOf(a.key);
    const bi = FIELD_ORDER.indexOf(b.key);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.key.localeCompare(b.key);
  });
}

export type ModuleEvidenceDetailProps = {
  item: {
    asin: string;
    title?: string | null;
    enrichmentFieldProvenance?: FieldProvenanceEntry[];
  };
  module: string;
  coverage?: {
    status: ProductModuleStatus;
    evidenceId: string | null;
    contentHash: string | null;
    capturedAt: string | null;
    limitations: string[];
    errorCode: string | null;
  } | null;
  data: unknown;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
};

export function ModuleEvidenceDetail({
  item,
  module,
  coverage,
  data,
  loading,
  error,
  onRetry,
}: ModuleEvidenceDetailProps) {
  const moduleLabel = PROVENANCE_MODULE_LABELS[module] ?? module;

  if (loading) {
    return (
      <div className={`${styles.root} ${styles.loading}`} data-testid="module-evidence-detail" role="status">
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        正在读取正式证据…
      </div>
    );
  }

  if (error) {
    return (
      <div className={`${styles.root} ${styles.error}`} data-testid="module-evidence-detail" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <strong>正式证据读取失败</strong>
        <p>{error}</p>
        <p className={styles.note}>读取失败不等于没有证据；请重新读取，仍失败时保留当前状态，不做推断。</p>
        {onRetry ? (
          <button type="button" className={styles.retryBtn} onClick={onRetry}>
            重新读取
          </button>
        ) : null}
      </div>
    );
  }

  const payload = asPayload(data);
  const moduleData = payload?.modules?.find((entry) => entry.module === module) ?? payload?.modules?.[0] ?? null;
  if (!payload || !moduleData) {
    return (
      <div className={`${styles.root} ${styles.quiet}`} data-testid="module-evidence-detail" role="status">
        <i className={styles.quietDot} aria-hidden="true" />
        当前模块没有可读取的正式证据记录；这不等于已取得数据。
      </div>
    );
  }

  const fields = sortFields(Object.entries(asRecord(moduleData.data?.registeredFields)).map(([key, field]) => ({ key, field })));
  const total = fields.length;
  const observed = fields.filter(({ field }) => field.status === "observed").length;
  const ambiguous = fields.filter(({ field }) => field.status === "ambiguous").length;
  const missing = fields.filter(({ field }) => field.status === "missing").length;
  const other = Math.max(0, total - observed - ambiguous - missing);
  const problemFields = fields.filter(({ field }) => field.status !== "observed" || field.reason)
    .sort((a, b) => Number(b.field.status === "ambiguous") - Number(a.field.status === "ambiguous"));
  const capturedAt = coverage?.capturedAt ?? moduleData.capturedAt ?? null;
  const evidenceStatus = moduleData.status ? EVIDENCE_STATUS_LABELS[moduleData.status] ?? "已读取证据" : "证据状态未知";
  const statusLabel = coverage ? moduleStatusLabel(coverage.status) : "状态未知";
  const limitations = moduleData.limitations ?? coverage?.limitations ?? [];
  const provenance = item.enrichmentFieldProvenance ?? [];
  const hasRegisteredFields = total > 0;
  const moduleRecords = payload.modules?.length ?? 1;
  const moduleDataRecord = moduleData.data as unknown as Record<string, unknown> | undefined;
  const generic = genericRows(moduleDataRecord);
  const moduleError = moduleDataRecord?.error;


  return (
    <div className={styles.root} data-testid="module-evidence-detail">
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h3 className={styles.title}>{moduleLabel} · {item.asin}</h3>
          <p className={styles.meta}>
            <span>采集时间 {formatProvenanceTime(capturedAt)}</span>
          </p>
          <div className={styles.chips}>
            <span className={styles.chip} data-tone={coverage?.status === "COMPLETE" ? "ok" : coverage?.status === "NOT_COLLECTED" ? "off" : "warn"}>{statusLabel}</span>
            {moduleData.evidenceOnly ? <span className={styles.chip} data-tone="info">仅证据参考</span> : null}
          </div>
        </div>
        {moduleData.sourceUrl ? (
          <a className={styles.sourceLink} href={moduleData.sourceUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={14} aria-hidden="true" />
            查看原始来源
          </a>
        ) : null}
      </header>

      {hasRegisteredFields ? (
        <>
      <section className={styles.section} aria-labelledby="module-evidence-summary">
        <div className={styles.sectionHead}>
          <h4 className={styles.sectionTitle} id="module-evidence-summary">字段取得情况</h4>
          <span className={styles.hint}>共 {total} 个登记字段</span>
        </div>
        <div className={styles.summary}>
          <p className={styles.acquisition}><b>{observed}/{total}</b> 字段已取得<span>待核对 {ambiguous} · 缺失 / 其他 {missing + other}</span></p>
          {limitations.length > 0 ? (
            <p className={styles.note} style={{ color: "#8a6420" }}>
              来源限制：{limitations.map(formatLimitation).join("；")}
            </p>
          ) : null}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="module-evidence-problems">
        <div className={styles.sectionHead}>
          <h4 className={styles.sectionTitle} id="module-evidence-problems">需要核对 / 缺失的字段</h4>
          <span className={styles.hint}>共 {problemFields.length} 项 · 优先显示 2 项</span>
        </div>
        {problemFields.length > 0 ? (
          <>
            <div className={styles.problemList}>
              {problemFields.slice(0, 2).map(({ key, field }) => {
                const tone = statusTone(field.status);
                const reason = fieldReasonLabel(field.reason)
                  ?? (field.status === "missing" ? "页面未提供该字段" : "需要核对（原始原因见高级信息）");
                const value = formatFieldValue(field.value, 80);
                return (
                  <div key={key} className={styles.problemRow} data-tone={tone === "ok" ? "off" : tone}>
                    <span className={styles.problemField}>{fieldLabel(key)}</span>
                    <span className={styles.statusPill} data-tone={tone}>{fieldStatusLabel(field.status)}</span>
                    <span className={styles.problemReason}>
                      {reason}
                      {value !== "—" ? <span className={styles.problemValue}> · 当前值 {value}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
            {problemFields.length > 2 ? (
              <details className={styles.advanced} style={{ marginTop: 8 }}>
                <summary>查看其余 {problemFields.length - 2} 项关注记录</summary>
                <div className={styles.advancedBody}>
                  <ul className={styles.provenanceList}>
                    {problemFields.slice(2).map(({ key, field }) => (
                      <li key={key} className={styles.provenanceRow}>
                        <span className={styles.provenanceField}>{fieldLabel(key)}</span>
                        <span className={styles.provenanceMeta}>{fieldReasonLabel(field.reason) ?? "需要核对"}</span>
                        <span className={styles.provenanceId}>{fieldStatusLabel(field.status)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            ) : null}
          </>
        ) : (
          <div className={styles.quiet}>
            <i className={styles.quietDot} aria-hidden="true" />
            当前模块没有待核对或缺失字段；仍以来源证据与人工判断为准。
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="module-evidence-fields">
        <details className={styles.advanced}>
          <summary>全部字段（{total}）· 已取得 {observed} · 待核对 {ambiguous} · 缺失 {missing + other}</summary>
          <div className={styles.advancedBody}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th>字段</th><th>状态</th><th>值</th><th>说明</th></tr>
                </thead>
                <tbody>
                  {fields.map(({ key, field }) => (
                    <tr key={key} data-testid={`module-evidence-field-${key}`}>
                      <td>{fieldLabel(key)}</td>
                      <td><span className={styles.statusPill} data-tone={statusTone(field.status)}>{fieldStatusLabel(field.status)}</span></td>
                      <td className={styles.value} title={formatFieldValue(field.value, 400)}>{formatFieldValue(field.value)}</td>
                      <td className={styles.reason}>{fieldReasonLabel(field.reason) ?? (field.status === "observed" ? "—" : field.status === "missing" ? "页面未提供" : "需要核对")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      </section>
        </>
      ) : (
        <section className={styles.section} aria-labelledby="module-evidence-generic">
          <div className={styles.sectionHead}>
            <h4 className={styles.sectionTitle} id="module-evidence-generic">证据内容</h4>
            <span className={styles.hint}>{moduleRecords} 条证据记录</span>
          </div>
          <div className={styles.summary}>
            {generic.length > 0 ? (
              <div className={styles.techGrid}>
                {generic.map((row) => (
                  <div key={row.key}>
                    <span>{row.label}</span>
                    <b>{row.value}</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.quiet}>
                <i className={styles.quietDot} aria-hidden="true" />
                当前模块没有可读的内容摘要；请查看原始记录。
              </div>
            )}
            {limitations.length > 0 ? (
              <p className={styles.note} style={{ color: "#8a6420" }}>
                来源限制：{limitations.map(formatLimitation).join("；")}
              </p>
            ) : null}
            {moduleError ? (
              <p className={styles.note} style={{ color: "#8a6420" }}>
                采集问题：{formatEvidenceError(moduleError)}
              </p>
            ) : null}
            {moduleRecords > 1 ? (
              <p className={styles.note}>共 {moduleRecords} 条证据记录；摘要展示首条，完整记录在高级信息。</p>
            ) : null}

          </div>
        </section>
      )}

      {module === "amazon_detail" ? (
      <details className={styles.advanced} data-testid="module-evidence-field-sources">
        <summary>字段来源 · {provenance.length} 条｜查看</summary>
        <div className={styles.advancedBody}>
        <div className={styles.sectionHead}>
          <h4 className={styles.sectionTitle} id="module-evidence-provenance">字段级来源（来自详情补齐）</h4>
          <span className={styles.hint}>{provenance.length} 个字段有来源记录</span>
        </div>
        {provenance.length > 0 ? (
          <div className={styles.summary}>
            <div className={styles.provenanceList} data-testid="module-evidence-provenance-list">
              {provenance.slice(0, 8).map((entry) => (
                <div key={`${entry.field}:${entry.evidenceId}:${entry.evidenceVersion}`} className={styles.provenanceRow}>
                  <span className={styles.provenanceField}>{fieldLabel(entry.field)}</span>
                  <span className={styles.provenanceMeta}>版本 {entry.evidenceVersion} · {formatProvenanceTime(entry.capturedAt)}</span>
                  <span className={styles.provenanceId}>{entry.evidenceId.slice(-14)}</span>
                </div>
              ))}
            </div>
            {provenance.length > 8 ? (
              <p className={styles.note}>另有 {provenance.length - 8} 个字段来源记录，详见下方原始记录。</p>
            ) : null}
            <p className={styles.note} data-testid="module-evidence-provenance-note">
              {describeFieldProvenanceRelation(provenance[0])}
            </p>
          </div>
        ) : (
          <p className={styles.note} data-testid="module-evidence-provenance-empty">
            当前商品没有字段级来源记录；这不等于没有模块证据，可查看下方原始记录与模块证据。
          </p>
        )}
        </div>
      </details>
      ) : null}

      <details className={styles.advanced} data-testid="module-evidence-advanced">
        <summary>原始记录与技术信息</summary>
        <div className={styles.advancedBody}>
          <div className={styles.techGrid}>
            <div><span>来源</span><b>{moduleData.provider ?? "—"} · {moduleData.sourceSurface ?? "—"}</b></div>
            <div><span>证据可用状态</span><b>{evidenceStatus}</b></div>
            <div><span>来源更新时间</span><b>{moduleData.providerUpdatedAt ? formatProvenanceTime(moduleData.providerUpdatedAt) : "来源页未提供更新时间"}</b></div>
            <div><span>商品 ASIN</span><b>{item.asin}</b></div>
            <div><span>模块</span><b>{module}</b></div>
            <div><span>主体</span><b>{moduleData.subjectKey ?? payload.subjectKey ?? "—"}</b></div>
            <div><span>证据状态</span><b>{moduleData.status ?? "—"}</b></div>
            <div><span>证据附件 ID</span><b>{coverage?.evidenceId ?? "—"}</b></div>
            <div><span>内容哈希</span><b>{coverage?.contentHash ?? "—"}</b></div>
            <div><span>采集模式</span><b>{moduleData.acquisitionMode ?? "—"}</b></div>
            <div><span>指标性质</span><b>{moduleData.metricNature ?? "—"}</b></div>
            <div><span>来源新鲜度</span><b>{moduleData.freshness?.state ?? "—"}</b></div>
            <div><span>附件数 / 原始文件</span><b>{payload.attachmentCount ?? 0} / {payload.rawArtifactCount ?? 0}</b></div>
          </div>
          <p className={styles.note}>
            原始记录只读；查看不会产生人工确认、提档或采集请求。字段级来源记录指向具体证据版本，
            当前接口按商品 + 模块读取最新模块，历史版本内容暂不可直接读取。
          </p>
          <pre className={styles.rawPre}>{JSON.stringify(payload, null, 2)}</pre>
        </div>
      </details>
    </div>
  );
}
