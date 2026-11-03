import "server-only";

import { createHash } from "node:crypto";

import type { SourceEvidenceAttachment } from "@/lib/sourceLayer/evidenceAttachment";
import { parseV3ModuleEvidence, type V3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";
import type {
  ProductFactKeywordEvidenceInput,
  ProductFactKeywordRow,
} from "@/lib/sourceLayer/fact/types";
import type {
  ReviewEvidenceSample,
  ReviewEvidenceSummaryItem,
  ResearchEvidenceRef,
} from "@/lib/research/researchContracts";
import {
  type TrendObservation,
  buildTrendObservation,
} from "@/lib/sourceLayer/v2/contracts";
import {
  parseSellerSpriteKeywordTable,
  type SellerSpriteKeywordPage,
  type SellerSpriteTypedKeywordRow,
} from "@/lib/sourceLayer/sellerSpriteKeywordTable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractAsinFromSubjectKey(subjectKey: string): string | null {
  const match = /^amazon:[A-Z]{2}:([A-Z0-9]{10})$/u.exec(subjectKey.trim());
  return match ? match[1] : null;
}

// ============================================================================
// 1. Review VOC Adapter
// ============================================================================

export type AdaptedV3Review = {
  readonly attachmentId: string;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly sourceUrl: string | null;
  readonly evidenceRef: string;
  readonly asin: string;
  readonly samples: readonly ReviewEvidenceSample[];
  readonly summaryItem: ReviewEvidenceSummaryItem;
  readonly evidenceRefRecord: ResearchEvidenceRef;
};

/**
 * 纯读取、纯转换的 V3 Review VOC 适配器。
 * 
 * 铁律：
 * - 只接受 v3_review_voc_v1 附件；
 * - 必须通过 parseV3ModuleEvidence() 强校验；
 * - 状态为 BLOCKED_WITH_EVIDENCE 或非可用状态时 fail-closed 返回 null；
 * - subjectKey / identity 校验不通过时 fail-closed；
 * - 评论属于 review_observation，绝不写入 ProductFact；
 * - 保留 attachmentId, contentHash, capturedAt, sourceUrl, evidenceRef。
 */
export function adaptV3ReviewAttachment(
  attachment: SourceEvidenceAttachment,
  expectedSubjectKey?: string,
): AdaptedV3Review | null {
  if (attachment.kind !== "v3_review_voc_v1") return null;

  const parsed = parseV3ModuleEvidence(attachment.payload);
  if (!parsed || parsed.module !== "review_voc") return null;

  // 状态门禁：BLOCKED 或非可用状态必须 fail closed
  if (parsed.status !== "VALIDATED_AVAILABLE" && parsed.status !== "AVAILABLE_WITH_LIMITATION") {
    return null;
  }

  // 主体与 Identity 校验
  if (expectedSubjectKey && parsed.subjectKey !== expectedSubjectKey) {
    return null;
  }

  const subjectAsin = extractAsinFromSubjectKey(parsed.subjectKey);
  const identityAsin = parsed.identity.asin ?? null;
  if (identityAsin && subjectAsin && identityAsin !== subjectAsin) {
    return null;
  }
  const resolvedAsin = identityAsin ?? subjectAsin ?? parsed.subjectKey;

  // 提取真实 reviews 数组
  const data = parsed.data;
  if (!isRecord(data) || !Array.isArray(data.reviews) || data.reviews.length === 0) {
    return null;
  }

  const samples: ReviewEvidenceSample[] = [];
  for (const raw of data.reviews) {
    if (samples.length >= 20) break;
    if (!isRecord(raw)) continue;

    const rawText = typeof raw.body === "string" && raw.body.trim()
      ? raw.body.trim()
      : typeof raw.reviewText === "string" && raw.reviewText.trim()
      ? raw.reviewText.trim()
      : typeof raw.text === "string" && raw.text.trim()
      ? raw.text.trim()
      : null;

    if (!rawText) continue;

    const rawTitle = typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim()
      : typeof raw.reviewTitle === "string" && raw.reviewTitle.trim()
      ? raw.reviewTitle.trim()
      : null;

    const rating = typeof raw.rating === "number" && Number.isFinite(raw.rating)
      ? Math.round(raw.rating)
      : null;

    const verifiedPurchase = typeof raw.verifiedPurchase === "boolean"
      ? raw.verifiedPurchase
      : null;

    samples.push({
      rating,
      title: rawTitle ? rawTitle.slice(0, 100) : null,
      text: rawText.slice(0, 500),
      verifiedPurchase,
    });
  }

  if (samples.length === 0) return null;

  const refId = `attachment:${attachment.attachmentId}`;
  const summaryItem: ReviewEvidenceSummaryItem = {
    refId,
    asin: resolvedAsin,
    sampleReviews: samples,
  };

  const evidenceRefRecord: ResearchEvidenceRef = {
    refId,
    source: "amazon_dom",
    captureId: attachment.attachmentId,
    evidenceId: attachment.attachmentId,
    subjectKey: parsed.subjectKey,
    capturedAt: attachment.capturedAt,
    contentHash: attachment.contentHash,
    sourceUrl: attachment.sourceUrl ?? parsed.sourceUrl ?? null,
  };

  return {
    attachmentId: attachment.attachmentId,
    contentHash: attachment.contentHash,
    capturedAt: attachment.capturedAt,
    sourceUrl: attachment.sourceUrl ?? parsed.sourceUrl ?? null,
    evidenceRef: refId,
    asin: resolvedAsin,
    samples,
    summaryItem,
    evidenceRefRecord,
  };
}

// ============================================================================
// 2. Keyword Adapter
// ============================================================================

export type AdaptedV3Keyword = {
  readonly attachmentId: string;
  readonly evidenceRef: string;
  readonly capturedAt: string;
  readonly contentHash: string;
  readonly metricNature: "provider_observed" | "provider_estimate";
  readonly provider: string;
  readonly sourceUrl: string | null;
  readonly module: SellerSpriteKeywordPage;
  /** PH3：来源身份与许可限制（只读透出，供 ResearchInputBundle 绑定字段级来源）。 */
  readonly subjectKey: string;
  readonly marketplace: string;
  readonly sourceType: string;
  readonly sourceSurface: string;
  /** Provider 自身更新时间；证据未提供时为 null（不推断）。 */
  readonly observedAt: string | null;
  readonly limitations: readonly string[];
  readonly rows: readonly ProductFactKeywordRow[];
  readonly typedRows: readonly SellerSpriteTypedKeywordRow[];
  readonly keywordInput: ProductFactKeywordEvidenceInput;
};

function parseExplicitCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d[\d,]*)\b/u.exec(value.normalize("NFKC"));
  if (!match) return null;
  const number = Number(match[1].replace(/,/gu, ""));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * 纯读取、纯转换的 V3 Keyword 适配器（reverse_asin / keyword_mining_trend）。
 *
 * 铁律：
 * - 只接受 v3_reverse_asin_v1 与 v3_keyword_mining_trend_v1；
 * - 必须通过 parseV3ModuleEvidence() 强校验；
 * - 状态为 BLOCKED_WITH_EVIDENCE 或非可用状态时 fail-closed 返回 null；
 * - 所有数值保持 provider_observed / provider_estimate，绝不升格为 confirmed 或 source_observed；
 * - 必须保留 attachmentId, contentHash, capturedAt, sourceUrl, evidenceRef。
 */
export function adaptV3KeywordAttachment(
  attachment: SourceEvidenceAttachment,
  expectedSubjectKey?: string,
): AdaptedV3Keyword | null {
  if (attachment.kind !== "v3_reverse_asin_v1" && attachment.kind !== "v3_keyword_mining_trend_v1") {
    return null;
  }

  const parsed = parseV3ModuleEvidence(attachment.payload);
  if (!parsed || (parsed.module !== "reverse_asin" && parsed.module !== "keyword_mining_trend")) {
    return null;
  }

  if (parsed.status !== "VALIDATED_AVAILABLE" && parsed.status !== "AVAILABLE_WITH_LIMITATION") {
    return null;
  }

  if (expectedSubjectKey && parsed.subjectKey !== expectedSubjectKey) {
    return null;
  }

  const subjectAsin = extractAsinFromSubjectKey(parsed.subjectKey);
  const identityAsin = parsed.identity.asin ?? null;
  if (identityAsin && subjectAsin && identityAsin !== subjectAsin) {
    return null;
  }

  // 严格保持性质：第三方数据仅允许 provider_observed / provider_estimate
  const metricNature = parsed.metricNature === "provider_observed" ? "provider_observed" : "provider_estimate";

  const data = parsed.data;
  if (!isRecord(data)) return null;
  if (data.rowScope === "traversal_checkpoint_only") return null;

  const pageModule = parsed.module;
  const typedRows: SellerSpriteTypedKeywordRow[] = [];
  // 已持久化的可见表格可能位于三种既有形状之一：
  // - `data.tables`          历史/通用序列化
  // - `data.visibleSnapshot` PH2 单次查询适配器
  // - `data.visibleDom`      SellerSprite 可见浏览器采集
  const visibleSnapshot = isRecord(data.visibleSnapshot) ? data.visibleSnapshot : null;
  const visibleDom = isRecord(data.visibleDom) ? data.visibleDom : null;
  const sourceTables = Array.isArray(data.tables) ? data.tables
    : Array.isArray(visibleSnapshot?.tables) ? visibleSnapshot?.tables
      : Array.isArray(visibleDom?.tables) ? visibleDom?.tables
        : undefined;
  if (Array.isArray(sourceTables)) {
    for (const rawTable of sourceTables) {
      if (!isRecord(rawTable) || !Array.isArray(rawTable.headers) || !Array.isArray(rawTable.rows)) continue;
      if (!rawTable.headers.every((header) => typeof header === "string")) continue;
      const rows = rawTable.rows.filter((row): row is (string | null)[] => Array.isArray(row)
        && row.every((cell) => cell === null || typeof cell === "string"));
      const result = parseSellerSpriteKeywordTable({
        page: pageModule,
        table: { headers: rawTable.headers as string[], rows },
      });
      typedRows.push(...result.rows);
    }
  }
  const uniqueTypedRows = [...new Map(typedRows.map((row) => [row.rowKey, row])).values()];

  // Structured row objects are retained only when they carry an explicit `keyword` key.
  // A table with unidentified headers never falls back to positional column guesses.
  if (uniqueTypedRows.length === 0 && Array.isArray(data.rows) && data.rows.length > 0) {
    for (const rawItem of data.rows) {
      if (!isRecord(rawItem) || typeof rawItem.keyword !== "string" || !rawItem.keyword.trim()) continue;
      const keyword = rawItem.keyword.normalize("NFC").split("\n", 1)[0]?.trim() ?? "";
      if (!keyword) continue;
      const monthlySearches = parseExplicitCount(rawItem.monthlySearches);
      const rowNumber = parseExplicitCount(rawItem.rowNumber ?? rawItem.rank);
      const rowKey = createHash("sha256").update(JSON.stringify({
        page: pageModule,
        keyword: keyword.toLocaleLowerCase(),
        monthlySearches,
        rowNumber,
      })).digest("hex");
      uniqueTypedRows.push({
        rowKey,
        keyword,
        rawCells: {
          keyword: rawItem.keyword,
          ...(rawItem.monthlySearches !== undefined ? { monthlySearches: typeof rawItem.monthlySearches === "string" ? rawItem.monthlySearches : null } : {}),
        },
        metrics: {
          ...(rawItem.monthlySearches !== undefined ? { searchVolume: {
            raw: typeof rawItem.monthlySearches === "string" ? rawItem.monthlySearches : String(rawItem.monthlySearches),
            value: monthlySearches,
            unit: "count",
            metricNature: "provider_estimate",
            status: monthlySearches === null ? "unknown" : "parsed",
          } as const } : {}),
        },
        status: monthlySearches === null ? "partial" : "valid",
      });
    }
  }
  if (uniqueTypedRows.length === 0) return null;
  const rows: ProductFactKeywordRow[] = uniqueTypedRows.map((row) => ({
    keyword: row.keyword,
    monthlySearches: row.metrics.searchVolume?.value ?? null,
    rowNumber: null,
  }));

  const evidenceRef = `attachment:${attachment.attachmentId}`;
  const keywordInput: ProductFactKeywordEvidenceInput = {
    rows,
    evidenceRef,
    capturedAt: attachment.capturedAt,
    sourceMethod: (parsed.provider || "sellersprite").toLowerCase(),
  };

  return {
    attachmentId: attachment.attachmentId,
    evidenceRef,
    capturedAt: attachment.capturedAt,
    contentHash: attachment.contentHash,
    metricNature,
    provider: parsed.provider,
    sourceUrl: attachment.sourceUrl ?? parsed.sourceUrl ?? null,
    module: pageModule,
    subjectKey: parsed.subjectKey,
    marketplace: parsed.marketplace,
    sourceType: attachment.sourceType,
    sourceSurface: parsed.sourceSurface,
    observedAt: parsed.providerUpdatedAt ?? null,
    limitations: parsed.limitations,
    rows,
    typedRows: uniqueTypedRows,
    keywordInput,
  };
}

export type AdaptedV3ProductMarketMetric = {
  readonly metric: string;
  readonly value: number;
  readonly unit: "count" | "currency" | "unknown";
  readonly currency?: string;
  readonly metricNature: "provider_observed" | "provider_estimate";
  readonly status: "parsed";
  readonly raw: string;
  /** BSR category or other explicit scope supplied by the source. */
  readonly scope?: string;
};

export type AdaptedV3ProductMarket = {
  readonly attachmentId: string;
  readonly evidenceRef: string;
  readonly capturedAt: string;
  readonly contentHash: string;
  readonly metricNature: "provider_observed" | "provider_estimate";
  readonly provider: string;
  readonly sourceUrl: string | null;
  readonly module: "sellersprite_product_market";
  readonly subjectKey: string;
  readonly marketplace: string;
  readonly asin: string;
  readonly parentAsin: string | null;
  readonly sourceType: string;
  readonly sourceSurface: string;
  readonly observedAt: string | null;
  readonly limitations: readonly string[];
  readonly productMetrics: readonly AdaptedV3ProductMarketMetric[];
};

/**
 * 纯读取的 SellerSprite exact-subject 商品市场观察适配器。
 *
 * 只读取证据中具名的 BSR / 类目、价格、评分和评论数；不猜测缺失表头的行列，
 * 不把 query-level 行或父体销量并入当前 ASIN。来源性质、身份及附件追溯原样保留。
 */
export function adaptV3ProductMarketAttachment(
  attachment: SourceEvidenceAttachment,
  expectedSubjectKey?: string,
): AdaptedV3ProductMarket | null {
  if (attachment.kind !== "v3_sellersprite_product_market_v1"
    || attachment.sourceType !== "sellersprite_plugin") return null;

  const parsed = parseV3ModuleEvidence(attachment.payload);
  if (!parsed || parsed.module !== "sellersprite_product_market") return null;
  if (parsed.status !== "VALIDATED_AVAILABLE" && parsed.status !== "AVAILABLE_WITH_LIMITATION") return null;
  if (parsed.metricNature !== "provider_observed" && parsed.metricNature !== "provider_estimate") return null;
  if (parsed.provider.trim().toLowerCase() !== "sellersprite") return null;
  if (attachment.subjectKey !== parsed.subjectKey || attachment.capturedAt !== parsed.capturedAt) return null;
  if (attachment.sourceUrl && parsed.sourceUrl && attachment.sourceUrl !== parsed.sourceUrl) return null;
  if (expectedSubjectKey && parsed.subjectKey !== expectedSubjectKey) return null;

  const asin = extractAsinFromSubjectKey(parsed.subjectKey);
  const identityAsin = parsed.identity.asin ?? null;
  const parentAsin = parsed.identity.parentAsin ?? null;
  if (!asin || identityAsin !== asin || parsed.marketplace.toUpperCase() !== parsed.subjectKey.split(":")[1]) return null;
  if (parentAsin !== null && (!/^[A-Z0-9]{10}$/u.test(parentAsin) || parentAsin === asin)) return null;

  const data = parsed.data;
  if (!isRecord(data) || data.rowScope === "traversal_checkpoint_only") return null;

  const productMetrics: AdaptedV3ProductMarketMetric[] = [];
  if (isRecord(data.bsr)) {
    const rank = data.bsr.rank;
    const category = typeof data.bsr.category === "string" ? data.bsr.category.normalize("NFKC").trim() : "";
    if (typeof rank === "number" && Number.isSafeInteger(rank) && rank > 0 && category.length > 0) {
      productMetrics.push({
        metric: "bsrRank",
        value: rank,
        // A rank is ordinal; do not label it as a count.
        unit: "unknown",
        metricNature: parsed.metricNature,
        status: "parsed",
        raw: `${rank} (${category})`,
        scope: category,
      });
    }
  }

  if (isRecord(data.price)) {
    const amount = data.price.amount;
    const currency = typeof data.price.currency === "string" ? data.price.currency.trim().toUpperCase() : "";
    if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && /^[A-Z]{3}$/u.test(currency)) {
      productMetrics.push({
        metric: "price",
        value: amount,
        unit: "currency",
        currency,
        metricNature: parsed.metricNature,
        status: "parsed",
        raw: `${amount} ${currency}`,
      });
    }
  }

  const rating = data.rating;
  if (typeof rating === "number" && Number.isFinite(rating) && rating >= 0 && rating <= 5) {
    productMetrics.push({
      metric: "rating",
      value: rating,
      unit: "unknown",
      metricNature: parsed.metricNature,
      status: "parsed",
      raw: `${rating} / 5`,
    });
  }

  const reviewCount = data.reviewCount;
  if (typeof reviewCount === "number" && Number.isSafeInteger(reviewCount) && reviewCount >= 0) {
    productMetrics.push({
      metric: "reviewCount",
      value: reviewCount,
      unit: "count",
      metricNature: parsed.metricNature,
      status: "parsed",
      raw: String(reviewCount),
    });
  }

  if (productMetrics.length === 0) return null;
  return {
    attachmentId: attachment.attachmentId,
    evidenceRef: `attachment:${attachment.attachmentId}`,
    capturedAt: attachment.capturedAt,
    contentHash: attachment.contentHash,
    metricNature: parsed.metricNature,
    provider: parsed.provider,
    sourceUrl: attachment.sourceUrl ?? parsed.sourceUrl ?? null,
    module: "sellersprite_product_market",
    subjectKey: parsed.subjectKey,
    marketplace: parsed.marketplace,
    asin,
    parentAsin,
    sourceType: attachment.sourceType,
    sourceSurface: parsed.sourceSurface,
    observedAt: parsed.providerUpdatedAt ?? null,
    limitations: parsed.limitations,
    productMetrics,
  };
}

// ============================================================================
// 3. Historical Trend Adapter
// ============================================================================

const DATE_SERIES_PATTERN = /^\d{4}-\d{2}(?:-\d{2})?$/;

/**
 * 采集时刻的时钟容差（毫秒）。
 *
 * 采集链路允许极小的时钟漂移（浏览器 / Gateway / 落盘三处时间戳不完全同步），
 * 因此「晚于当前时刻」需要一个窄容差；超出即视为**采集时刻不可信**。
 * 该容差远小于人工写死时间的误差量级（本项目已观测到 ~22 分钟）。
 */
const CAPTURE_TIME_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export type HistoricalTrendSourceEligibility =
  | "VERIFIED_NUMERIC_SOURCE"
  | "INVALID_CAPTURE_TIME"
  | "SCREENSHOT_ONLY"
  | "UNVERIFIED_SOURCE_IDENTITY";

/**
 * 历史趋势数值来源资格判定（纯函数、可复用、fail-closed、**时间无关**）。
 *
 * ## 为什么不能比较「消费时刻」
 *
 * 若把 `attachment.capturedAt` 与**消费时刻** `now` 比较，则一份不可信附件
 * （例如客户端写死了一个未来时间）会随着现实时间推进，在某一刻重新通过检查：
 *
 * ```text
 *   20:20 消费 → capturedAt 20:30 → INVALID
 *   21:00 消费 → capturedAt 20:30 → 通过（错误地"转正"）
 * ```
 *
 * 这会让已被判定为不可信的证据随时间漂移而反复进出研究结论，属于严重缺陷。
 * 因此本函数的判定**完全不使用消费时刻**：同一份不可变 Evidence 在任何时刻
 * 消费都得到同一资格结论。
 *
 * ## 判定依据（只使用不可变证据自身，不使用 payload 自我声明）
 *
 * 1. `INVALID_CAPTURE_TIME`
 *    - 附件采集时刻无法解析；或
 *    - 浏览器直采（`DOM_DIRECT`）来源缺少 `payload.data.browserObservedAt`，
 *      采集时刻无从追溯；或
 *    - 附件采集时刻**早于**其载荷记录的浏览器观察时刻（超出时钟容差）——
 *      观察必然先于采集，顺序颠倒说明时刻被事后写入。
 *    以上检查只使用证据**内部**时间戳的相对关系，**与消费时刻无关**。
 * 2. `SCREENSHOT_ONLY`
 *    - 截图能证明页面可见，不能证明其payload 里的数值 → 零数值观察。
 * 3. `UNVERIFIED_SOURCE_IDENTITY`
 *    - 主体键不一致（跨 ASIN / 跨 marketplace 混用）。
 * 4. 其余 → `VERIFIED_NUMERIC_SOURCE`。
 *
 * ## 关于「持久可信回执」的如实说明
 *
 * 现有 Capture Gateway 的附件 `capturedAt` 取自调用方传入的 `now`
 * （见 `lib/sourceLayer/server/captureGateway.ts`），raw artifact 元数据的 `capturedAt`
 * 同源于该值，**不存在独立于客户端的服务端接收回执**。
 * 因此无法在读取侧凭空证明「某历史附件的采集时刻一定真实」。
 * 本函数因此只做**内部一致性**判定：无法证明的证据不会因为时间推进而被自动放行，
 * 符合 fail-closed 原则。若将来 Gateway 落地不可变的服务端接收时刻，
 * 只需在此处增加一条基于该回执的判定分支，无需改变消费侧契约。
 */
export function evaluateHistoricalTrendSourceEligibility(input: {
  attachment: SourceEvidenceAttachment;
  parsed: V3ModuleEvidence;
  expectedSubjectKey?: string;
  /** 保留参数仅为调用方兼容；**判定刻意不使用消费时刻**（见上方说明）。 */
  now: Date;
}): HistoricalTrendSourceEligibility {
  void input.now;
  const capturedMs = Date.parse(input.attachment.capturedAt);
  if (Number.isNaN(capturedMs)) return "INVALID_CAPTURE_TIME";

  // 浏览器直采来源必须**自证观察时刻**，否则采集时刻无法追溯。
  //
  // 对 DOM_DIRECT（浏览器可见采集）趋势附件：
  //   - 缺失 `payload.data.browserObservedAt` → 采集时刻无从追溯 → fail-closed；
  //   - `capturedAt` 早于 `browserObservedAt`（超出时钟容差）→ 时序自相矛盾 → fail-closed。
  // 两者都只用**证据内部**的时间戳关系，**与消费时刻无关**，
  // 因此不可信附件不会因为现实时间推进而重新获得资格。
  //
  // 对 FILE_EXPORT（Keepa 等文件导入）来源不做此检查：其 capturedAt 是导入时刻，
  // 语义与浏览器直采不同，且窗口聚合本身不是逐月时间点。
  const isBrowserDirect = input.parsed.acquisitionMode === "DOM_DIRECT";
  if (isBrowserDirect) {
    const data = input.parsed.data;
    const observedRaw = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).browserObservedAt
      : undefined;
    if (typeof observedRaw !== "string") return "INVALID_CAPTURE_TIME";
    const observedMs = Date.parse(observedRaw);
    if (Number.isNaN(observedMs)) return "INVALID_CAPTURE_TIME";
    // 采集必然不早于观察；允许小幅时钟漂移，但不得「先观察后采集」。
    if (observedMs - capturedMs > CAPTURE_TIME_SKEW_TOLERANCE_MS) return "INVALID_CAPTURE_TIME";
  }

  if (input.parsed.acquisitionMode === "SCREENSHOT_EVIDENCE") return "SCREENSHOT_ONLY";
  if (input.expectedSubjectKey && input.parsed.subjectKey !== input.expectedSubjectKey) {
    return "UNVERIFIED_SOURCE_IDENTITY";
  }
  return "VERIFIED_NUMERIC_SOURCE";
}

/**
 * 纯读取、纯内存转换的 V3 历史趋势适配器。
 *
 * 铁律：
 * - 只接受 v3_historical_trend_v1 附件；
 * - 仅在内存中转换成 TrendObservation 供 Research 消费；
 * - 绝不向 Canonical Store 写入 t-*.json；
 * - 保留 provider_estimate，保留日期与实际指标；
 * - 数值消费必须先通过 {@link evaluateHistoricalTrendSourceEligibility}，
 *   不可信来源（尤其采集时刻不可信）一律零数值观察。
 */
export function adaptV3HistoricalTrendAttachment(
  attachment: SourceEvidenceAttachment,
  expectedSubjectKey?: string,
  options?: {
    /** 仅用于调用方兼容与确定性测试；**资格判定不使用消费时刻**。 */
    readonly now?: Date;
  },
): readonly TrendObservation[] {
  if (attachment.kind !== "v3_historical_trend_v1") return [];

  const parsed = parseV3ModuleEvidence(attachment.payload);
  if (!parsed || parsed.module !== "historical_trend") return [];

  if (parsed.status !== "VALIDATED_AVAILABLE" && parsed.status !== "AVAILABLE_WITH_LIMITATION") {
    return [];
  }

  // 来源资格（含截图、采集时刻、主体一致性）。不合格 → 零数值观察。
  const eligibility = evaluateHistoricalTrendSourceEligibility({
    attachment,
    parsed,
    expectedSubjectKey,
    now: options?.now ?? new Date(),
  });
  if (eligibility !== "VERIFIED_NUMERIC_SOURCE") return [];

  const data = parsed.data;
  if (!isRecord(data)) return [];

  const observations: TrendObservation[] = [];
  const refId = `attachment:${attachment.attachmentId}`;

  // Keepa 导表：窗口聚合指标（data.timeSeries），不是按日 series。
  // 不伪造日期点；capturedAt 使用附件采集时间，field 明确 keepa 窗口语义。
  const isKeepa = parsed.provider === "keepa_product_viewer" || attachment.sourceType === "keepa_export";
  if (isKeepa && isRecord(data.timeSeries)) {
    const windowMetrics = data.timeSeries;
    for (const [key, val] of Object.entries(windowMetrics)) {
      if (typeof val !== "number" && val !== null) continue;
      try {
        observations.push(buildTrendObservation({
          observationId: `v3:${attachment.attachmentId}:keepa:${key}`,
          subjectKey: parsed.subjectKey,
          field: `keepa.window.${key}`,
          value: val,
          valueKind: val === null ? "missing" : "observed",
          sourceType: "keepa_export",
          capturedAt: attachment.capturedAt,
          evidenceRefs: [refId],
        }));
      } catch {
        // fail-closed 跳过无效点
      }
    }
    return observations;
  }

  if (!Array.isArray(data.series) || data.series.length === 0) {
    return [];
  }

  for (const point of data.series) {
    if (!isRecord(point)) continue;
    const rawDate = typeof point.date === "string" ? point.date.trim() : "";
    if (!DATE_SERIES_PATTERN.test(rawDate)) continue;

    // 格式化为有效 ISO 字符串，如 "2025-04" -> "2025-04-01T00:00:00.000Z"
    const capturedAtIso = rawDate.length === 7
      ? `${rawDate}-01T00:00:00.000Z`
      : `${rawDate}T00:00:00.000Z`;

    if (Number.isNaN(Date.parse(capturedAtIso))) continue;

    for (const [key, val] of Object.entries(point)) {
      if (key === "date") continue;
      if (typeof val !== "number" && typeof val !== "string" && typeof val !== "boolean" && val !== null) {
        continue;
      }

      try {
        const observation = buildTrendObservation({
          observationId: `v3:${attachment.attachmentId}:${rawDate}:${key}`,
          subjectKey: parsed.subjectKey,
          field: `sellersprite.traffic.${key}`,
          value: val,
          valueKind: "estimated",
          sourceType: "sellersprite_plugin",
          capturedAt: capturedAtIso,
          evidenceRefs: [refId],
        });
        observations.push(observation);
      } catch {
        // fail-closed 跳过无效点，不猜测
      }
    }
  }

  return observations;
}

// ============================================================================
// 4. Trend Summary Extractor (for Scheme C: PROMPT_FROM_BUNDLE)
// ============================================================================

export type TrendMetricSummary = {
  readonly metric: string;
  readonly startValue: number | string | boolean | null;
  readonly endValue: number | string | boolean | null;
  readonly minValue?: number | null;
  readonly maxValue?: number | null;
  readonly direction: "rising" | "falling" | "stable" | "fluctuating" | "unknown";
};

export type TrendSummary = {
  readonly timeWindow: string;
  readonly pointsCount: number;
  readonly metrics: Record<string, TrendMetricSummary>;
  readonly evidenceRefs: readonly string[];
};

/**
 * 纯函数：将离散的 TrendObservation 序列总结为紧凑的时间跨度与指标走势摘要。
 * 供 Prompt 组装层显式呈现，保证模型能够消费时序数据，同时严格控制 Prompt Token 体积 (<250 tokens)。
 */
export function summarizeTrendObservations(
  observations: readonly TrendObservation[],
): TrendSummary | null {
  if (observations.length === 0) return null;

  // 按 capturedAt 稳定升序
  const sorted = [...observations].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const firstDate = sorted[0].capturedAt.slice(0, 10);
  const lastDate = sorted.at(-1)!.capturedAt.slice(0, 10);
  const timeWindow = firstDate === lastDate ? firstDate : `${firstDate} ~ ${lastDate}`;

  // 按 field 分组
  const byField = new Map<string, TrendObservation[]>();
  for (const obs of sorted) {
    const list = byField.get(obs.field) ?? [];
    list.push(obs);
    byField.set(obs.field, list);
  }

  const metrics: Record<string, TrendMetricSummary> = {};
  for (const [field, list] of byField.entries()) {
    const cleanKey = field.replace(/^sellersprite\.traffic\./u, "");
    const values = list.map((item) => item.value);
    const startValue = values[0] ?? null;
    const endValue = values.at(-1) ?? null;

    const numericValues = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    let minValue: number | null = null;
    let maxValue: number | null = null;
    let direction: TrendMetricSummary["direction"] = "unknown";

    // 同一时间点出现多个不同读数即为**来源冲突**。
    // 冲突无法用现有契约确定性地裁决（不得按数组顺序 / 最大值 / 最后一条盲选），
    // 因此该时间点的取值不参与方向判定，方向保持 unknown。
    //
    // 时间点标识用 `capturedAt` 全精度而非 `capturedDate`：
    // 同一日期内的不同瞬间是不同时间点（逐日/逐月序列都可能出现），
    // 只有**完全相同的时间戳**才是「同一时间点的冲突读数」。
    const distinctByInstant = new Map<string, Set<number | string | boolean | null>>();
    for (const item of list) {
      const bucket = distinctByInstant.get(item.capturedAt) ?? new Set<number | string | boolean | null>();
      bucket.add(item.value);
      distinctByInstant.set(item.capturedAt, bucket);
    }
    const conflictedInstants = [...distinctByInstant.values()].filter((set) => set.size > 1).length;

    if (numericValues.length > 0) {
      minValue = Math.min(...numericValues);
      maxValue = Math.max(...numericValues);
      // 单点不能证明历史稳定/涨跌，保持 unknown
      if (conflictedInstants > 0) {
        // 存在同一时间点的冲突读数：不得给出确定性方向
        direction = "unknown";
      } else if (numericValues.length === 1) {
        direction = "unknown";
      } else {
        const firstNum = numericValues[0];
        const lastNum = numericValues.at(-1)!;
        if (firstNum === lastNum && minValue === maxValue) {
          direction = "stable";
        } else if (lastNum > firstNum) {
          direction = "rising";
        } else if (lastNum < firstNum) {
          direction = "falling";
        } else {
          direction = "fluctuating";
        }
      }
    }

    metrics[cleanKey] = {
      metric: cleanKey,
      startValue,
      endValue,
      minValue,
      maxValue,
      direction,
    };
  }

  const allRefs = Array.from(
    new Set(sorted.flatMap((item) => item.evidenceRefs)),
  ).filter((ref) => typeof ref === "string" && ref.length > 0);

  return {
    timeWindow,
    pointsCount: sorted.length,
    metrics,
    evidenceRefs: allRefs,
  };
}

// ============================================================================
// 5. Deduplication Utilities (V3_PRIMARY_LEGACY_COMPAT: 保留 V3，丢弃 Legacy)
// ============================================================================

export function deduplicateReviewEvidence(
  legacyAttachments: readonly SourceEvidenceAttachment[],
  v3Attachments: readonly SourceEvidenceAttachment[],
): readonly SourceEvidenceAttachment[] {
  if (v3Attachments.length === 0) return legacyAttachments;
  if (legacyAttachments.length === 0) return v3Attachments;

  // V3_PRIMARY_LEGACY_COMPAT: preserve V3 and discard legacy copies by hash or
  // by a complete, row-level match when the two formats serialize differently.
  const v3Hashes = new Set(v3Attachments.map((item) => item.contentHash));
  const v3ReviewSignatures = new Set(
    v3Attachments.flatMap((item) => {
      if (item.kind !== "v3_review_voc_v1" || !adaptV3ReviewAttachment(item, item.subjectKey)) return [];
      return reviewRowSignatures(item, true) ?? [];
    }),
  );
  const distinctLegacy = legacyAttachments.filter((item) => {
    if (v3Hashes.has(item.contentHash)) return false;

    const legacySignatures = reviewRowSignatures(item, false);
    // Fail closed: only omit a whole legacy attachment if every row has a
    // stable identity and every row is already present in valid V3 evidence.
    return !legacySignatures
      || legacySignatures.length === 0
      || !legacySignatures.every((signature) => v3ReviewSignatures.has(signature));
  });

  return [...v3Attachments, ...distinctLegacy];
}

function reviewRowSignatures(
  attachment: SourceEvidenceAttachment,
  v3: boolean,
): string[] | null {
  if (typeof attachment.subjectKey !== "string" || !extractAsinFromSubjectKey(attachment.subjectKey)) return null;

  const payload = attachment.payload;
  if (!isRecord(payload)) return null;
  const data = v3 ? payload.data : payload;
  if (!isRecord(data) || !Array.isArray(data.reviews) || data.reviews.length === 0) return null;

  const signatures: string[] = [];
  for (const row of data.reviews) {
    if (!isRecord(row)) return null;

    const text = firstNonEmptyString(row.reviewText, row.body, row.text);
    const date = firstNonEmptyString(row.reviewDate, row.publishedAt, row.date);
    const asin = firstNonEmptyString(row.asin)?.toUpperCase() ?? extractAsinFromSubjectKey(attachment.subjectKey);
    const rating = typeof row.rating === "number" && Number.isFinite(row.rating) ? row.rating : null;
    if (!text || !date || !asin || rating === null || asin !== extractAsinFromSubjectKey(attachment.subjectKey)) return null;

    const title = firstNonEmptyString(row.title, row.reviewTitle) ?? "";
    const verifiedPurchase = typeof row.verifiedPurchase === "boolean" ? row.verifiedPurchase : null;
    const identity = JSON.stringify([
      attachment.subjectKey,
      asin,
      date.trim().toLocaleLowerCase("en-US"),
      rating,
      title.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"),
      text.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"),
      verifiedPurchase,
    ]);
    signatures.push(createHash("sha256").update(identity, "utf8").digest("hex"));
  }

  return signatures;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function deduplicateKeywordEvidence(
  legacyAttachments: readonly SourceEvidenceAttachment[],
  v3Attachments: readonly SourceEvidenceAttachment[],
): readonly SourceEvidenceAttachment[] {
  if (v3Attachments.length === 0) return legacyAttachments;
  if (legacyAttachments.length === 0) return v3Attachments;

  // V3_PRIMARY_LEGACY_COMPAT: 保留 V3，丢弃内容重复的 Legacy 项
  const v3Hashes = new Set(v3Attachments.map((item) => item.contentHash));
  const distinctLegacy = legacyAttachments.filter((item) => !v3Hashes.has(item.contentHash));

  return [...v3Attachments, ...distinctLegacy];
}

export function deduplicateTrendObservations(
  existingTrends: readonly TrendObservation[],
  v3Trends: readonly TrendObservation[],
): readonly TrendObservation[] {
  if (v3Trends.length === 0) return existingTrends;
  if (existingTrends.length === 0) return v3Trends;

  // V3_PRIMARY_LEGACY_COMPAT: 重复趋势点优先保留 V3，丢弃旧版重复点
  const v3DedupeKeys = new Set(v3Trends.map((t) => t.dedupeKey));
  const distinctExisting = existingTrends.filter((t) => !v3DedupeKeys.has(t.dedupeKey));

  return [...v3Trends, ...distinctExisting];
}
