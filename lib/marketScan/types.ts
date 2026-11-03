/**
 * Product Development V1 — Phase 1 MarketScan 正式契约（versioned）。
 *
 * MarketScan 是**业务研究对象**，不是新的事实来源：
 *
 * ```
 * Source Adapter → Capture Gateway → Evidence → ProductFact
 *                                              ↓ 编组（只读，不改变事实层）
 *                                           MarketScan
 *                                              ↓
 *                                     MarketSample Snapshot（事实版本锁定）
 *                                              ↓
 *                                   Deterministic Market Metrics（纯函数）
 * ```
 *
 * 硬边界：
 * - 本模块不认识 SellerSprite、Amazon DOM、Plugin 或任何具体来源的字段名与表结构，
 *   唯一输入是标准化后的 `ProductFact`。新增来源不应改动本模块。
 * - 禁止新增 `sourceType = market_scan`。
 * - 缺失值一律表达为 `status: "missing"` / `NOT_AVAILABLE`，绝不用 `0` 或默认值顶替。
 */

import type { ProductFact } from "@/lib/sourceLayer/fact/types";

/* ── schemaVersion ───────────────────────────────────────────────── */

export const MARKET_SCAN_SCHEMA = "market-scan.v1" as const;
export const MARKET_SCAN_SAMPLE_SCHEMA = "market-scan-sample.v1" as const;
export const MARKET_METRICS_SCHEMA = "market-metrics.v1" as const;

/** 指标算法版本。算法变化必须升版，禁止静默重写历史 Scan 的 metricsJson。 */
export const MARKET_METRICS_VERSION = "market-metrics.v1" as const;

export type MarketScanSchema = typeof MARKET_SCAN_SCHEMA;
export type MarketScanSampleSchema = typeof MARKET_SCAN_SAMPLE_SCHEMA;
export type MarketMetricsSchema = typeof MARKET_METRICS_SCHEMA;

/**
 * Phase 1 只保存定义，不创建 NicheOpportunity。
 * 即使当前只用得上 `sellersprite_filter` / `custom_sample` / `category` / `keyword`，
 * 数据模型也不得写死 `Category = Niche`。
 */
export const NICHE_DEFINITION_KINDS = [
  "category",
  "keyword",
  "keyword_cluster",
  "best_sellers",
  "new_releases",
  "sellersprite_filter",
  "custom_sample",
] as const;

export type NicheDefinitionKind = (typeof NICHE_DEFINITION_KINDS)[number];

export type NicheDefinitionV1 = {
  readonly schemaVersion: typeof MARKET_SCAN_SAMPLE_SCHEMA;
  readonly kind: NicheDefinitionKind;
  readonly label: string;
  /** 自由文本描述；只作为研究对象的记录，不参与任何事实推断。 */
  readonly notes: string | null;
  /** 定义参数（类目路径、关键词、筛选条件等）。只做记录，不驱动事实生成。 */
  readonly parameters: Readonly<Record<string, string | number | boolean | null>>;
};

/* ── 样本定义（编组条件，不是事实） ───────────────────────────────── */

/**
 * 样本来源只允许是**已存在的 Evidence / ProductFact**。
 * 这里记录的是「从哪些已入库的来源类型里取的」，不是「去哪个来源采集」。
 */
export const MARKET_SCAN_SOURCE_TYPES = [
  "sellersprite_xlsx",
  "sellersprite_plugin",
  "amazon_dom",
  "keepa_export",
  "manual",
] as const;

export type MarketScanSourceType = (typeof MARKET_SCAN_SOURCE_TYPES)[number];

export type MarketScanSampleOriginV1 =
  /** 复用既有 ProductBatch 只读桥接得到的 Evidence / ProductFact。 */
  | "existing_product_batch_evidence"
  /** 复用来源证据库中已存在的 Evidence / ProductFact（任意来源）。 */
  | "existing_evidence";

/**
 * 样本主图的轻量引用。图片不是指标输入，不能把 Base64 内容复制进快照：
 * - 公网 HTTPS 图片直接保存 URL；
 * - 批次缓存的内嵌图片保存其 Evidence 定位符，由读取 API 按版本解析。
 */
export const MARKET_SCAN_IMAGE_REF_SCHEMA = "market-scan-image-ref.v1" as const;

export type MarketScanImageRefV1 =
  | {
      readonly schemaVersion: typeof MARKET_SCAN_IMAGE_REF_SCHEMA;
      readonly kind: "external_url";
      readonly url: string;
    }
  | {
      readonly schemaVersion: typeof MARKET_SCAN_IMAGE_REF_SCHEMA;
      readonly kind: "source_evidence";
      readonly subjectKey: string;
      readonly evidenceId: string;
      readonly evidenceVersion: number;
    };

export type SampleDefinitionV1 = {
  readonly schemaVersion: typeof MARKET_SCAN_SAMPLE_SCHEMA;
  readonly origin: MarketScanSampleOriginV1;
  readonly marketplace: string;
  /** 记录实际纳入的来源类型；空数组代表「未限定来源」。 */
  readonly sourceTypes: readonly MarketScanSourceType[];
  /** ProductBatch 归属（如果样本来自批次）；仅作记录。 */
  readonly productBatchId: string | null;
  /** 请求的样本上限；null 代表不限制（仍受服务端硬上限约束）。 */
  readonly requestedLimit: number | null;
  readonly marketSamplePolicyVersion?: string;
  readonly insufficientSampleBypass?: { readonly enabledByEnvironment: true; readonly reason: string; readonly recordedAt: string; readonly validSampleCount: number };
};

/* ── 样本快照（Phase 1 最关键：锁定当时使用的事实版本） ───────────── */

/**
 * 每个样本条目必须锁定「当时用的是哪一版 ProductFact / Evidence」。
 *
 * 版本锁定字段全部来自既有 Evidence / ProductFact，不新增事实来源：
 * - `evidenceVersion`          → `EvidenceSubjectRecord.versions[].version`
 * - `evidenceId`               → `CaptureEvidenceRecord.evidenceId`
 * - `sourceProofHash`          → `ProductFact.sourceProof.contentHash`
 * - `productFactFingerprint`   → 由 `productFactFingerprintOf()` 从 ProductFact 确定性重算
 * - `capturedAt`               → `CaptureEvidenceRecord.capturedAt`
 *
 * 同一 `ProductFact` 可以进入多个 MarketScan；但一个已完成的 MarketScan，
 * 其样本成员不得因 ProductFact 后续变化而静默变化。
 */
export type MarketScanSampleItemV1 = {
  readonly asin: string;
  readonly subjectKey: string;
  /** Phase 1 不强制关联 Candidate；没有就是 null，不伪造。 */
  readonly candidateId: string | null;
  /** 编组时该 ProductFact 的内容指纹（由 ProductFact 计算，用于绑定事实版本）。 */
  readonly productFactFingerprint: string;
  /**
   * 快照内事实值的自证指纹 = hash(subjectKey + factValues)。
   * 与 `productFactFingerprint` 不同：它可以在**任何时候只凭已落库的快照**重算，
   * 因此能证明快照事实没有被篡改或截断。
   */
  readonly factValuesFingerprint: string;
  readonly sourceProofHash: string;
  readonly evidenceId: string;
  readonly evidenceVersion: number;
  readonly capturedAt: string;
  readonly sourceType: MarketScanSourceType;
  /** 命中重复 ASIN 时的确定性去重记录；未发生去重时为 null。 */
  readonly dedupeOf: string | null;
  readonly sampleValidityPolicyVersion?: string;
  readonly evidenceStatus?: string;
  readonly parentAsin?: string | null;
  /** 可选展示引用；旧快照没有该字段时仍可正常读取。 */
  readonly imageRef?: MarketScanImageRefV1;
  /**
   * 事实值快照：指标真正消费的 ProductFact 字段副本（含 present/missing 标志）。
   *
   * 为什么必须自带：证据库对同一 subjectKey 只保留最近 20 个版本，更旧的版本
   * 会被物理删除。若只存「版本指针」，已完成扫描在旧版被 prune 后就无法自证，
   * 甚至可能被静默重算成不同结果。因此把「当时的事实值」与「当时的事实定位符」
   * 一起冻结在快照里；这是**复制证据**，不是修改事实层。
   */
  readonly factValues: MarketFactValuesV1;
};

/** 单项事实值：显式区分「存在」与「缺失」，缺失绝不用 0 或空串表示。 */
export type MarketFactValueV1<T> =
  | { readonly presence: "present"; readonly value: T }
  | { readonly presence: "missing" };

export type MarketFactValueSourceV1 = "FACT" | "PROVIDER_ESTIMATE" | "DERIVED";

export type MarketFactFieldV1<T> = MarketFactValueV1<T> & {
  /** 该值的性质：来源事实 / 第三方估算 / 派生值。派生值永远不是来源事实。 */
  readonly valueSource: MarketFactValueSourceV1;
};

/**
 * 指标消费的事实字段子集。只包含计算用得到的字段，
 * 不做通用 ProductFact 复制（避免快照膨胀与语义漂移）。
 */
export type MarketFactValuesV1 = {
  readonly asin: string;
  readonly title: MarketFactValueV1<string>;
  readonly brand: MarketFactValueV1<string>;
  readonly category: MarketFactValueV1<string>;
  readonly price: MarketFactFieldV1<{ readonly amount: number; readonly currency: string }>;
  readonly rating: MarketFactValueV1<number>;
  readonly reviewCount: MarketFactValueV1<number>;
  readonly bsr: MarketFactValueV1<number>;
  readonly monthlySalesEstimate: MarketFactFieldV1<number>;
  readonly monthlyRevenueEstimate: MarketFactFieldV1<{
    readonly amount: number;
    readonly currency: string;
  }>;
  readonly launchedDate: MarketFactValueV1<string>;
};

export type MarketScanSampleItemDraftV1 = Omit<MarketScanSampleItemV1, "dedupeOf">;

export type MarketScanSampleSnapshotV1 = {
  readonly schemaVersion: typeof MARKET_SCAN_SAMPLE_SCHEMA;
  /** 固定为 `market-metrics.v1`：快照与指标版本绑定，保证可重算。 */
  readonly metricsVersion: string;
  readonly itemCount: number;
  readonly sampleHash: string;
  readonly items: readonly MarketScanSampleItemV1[];
};

/* ── 每个指标的统一结构 ───────────────────────────────────────────── */

export const MARKET_METRIC_STATUSES = [
  /** 有可计算数据。 */
  "PRESENT",
  /** 该来源链路根本不提供该字段（不是算不出来）。 */
  "NOT_AVAILABLE",
  /** 字段存在但有效样本不足，或需要多个字段交叉而缺失过多。 */
  "INSUFFICIENT_DATA",
] as const;

export type MarketMetricStatus = (typeof MARKET_METRIC_STATUSES)[number];

export type MarketMetric<T> = {
  readonly status: MarketMetricStatus;
  /** 只有 `PRESENT` 才允许非 null；其余状态必须为 null（禁止用 0 顶替缺失）。 */
  readonly value: T | null;
  readonly sampleSize: number;
  readonly missingCount: number;
  readonly calculationVersion: string;
};

export type MarketFieldCoverage = {
  readonly presentCount: number;
  readonly missingCount: number;
  readonly coverageRatio: number;
};

export type MarketFieldCoverageV1 = {
  readonly price: MarketFieldCoverage;
  readonly sales: MarketFieldCoverage;
  readonly revenue: MarketFieldCoverage;
  readonly brand: MarketFieldCoverage;
  readonly rating: MarketFieldCoverage;
  readonly reviewCount: MarketFieldCoverage;
  readonly bsr: MarketFieldCoverage;
  readonly launchedDate: MarketFieldCoverage;
};

/** 分位数：线性插值，定义固定为 position = (n - 1) * p（见 calculatorVersion 文档）。 */
export type MarketNumericDistributionV1 = {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  readonly p25: number;
  readonly p75: number;
  readonly sampleSize: number;
  readonly missingCount: number;
};

export type MarketConcentrationV1 = {
  /** 份额分母：所有已知（非缺失）销量之和。 */
  readonly denominator: number;
  readonly usedSampleCount: number;
  readonly missingCount: number;
  readonly topN: ReadonlyArray<{
    readonly rank: number;
    readonly key: string;
    readonly value: number;
    readonly share: number;
  }>;
  /** `sum(topN) / denominator`；`INSUFFICIENT_DATA` 时 value 为 null。 */
  readonly ratio: number | null;
};

/**
 * Phase 1 **不**硬编码 HIGH / MEDIUM 之类业务阈值：
 * 覆盖率只产出事实（presentCount / missingCount / coverageRatio），
 * Data Quality 等级留到 Phase 2 用真实样本校准。
 */
export type MarketMetricsV1 = {
  readonly schemaVersion: typeof MARKET_METRICS_SCHEMA;
  readonly metricsVersion: string;
  /** 指标所依据的样本快照 hash（可独立重算校验）。 */
  readonly sampleHash: string;
  readonly sampleCount: number;
  /** 通过样本合法性校验（有 ASIN、有 fingerprint）的条数。 */
  readonly validSampleCount: number;
  readonly fieldCoverage: MarketFieldCoverageV1;
  readonly price: MarketMetric<MarketNumericDistributionV1>;
  /** 仅使用 ProductFact 中真实存在的 `market.monthlySalesEstimate`，缺失不补零。 */
  readonly sales: MarketMetric<{
    readonly total: number;
    readonly mean: number;
    readonly median: number;
    readonly p25: number;
    readonly p75: number;
    readonly min: number;
    readonly max: number;
    readonly distribution: MarketNumericDistributionV1;
  }>;
  /** 仅使用 ProductFact 中真实存在的 `market.monthlyRevenueEstimate`。 */
  readonly revenue: MarketMetric<{
    readonly currency: string | null;
    readonly total: number;
    readonly mean: number;
    readonly median: number;
    readonly p25: number;
    readonly p75: number;
    readonly distribution: MarketNumericDistributionV1;
    /**
     * 只有显式派生才允许存在；派生值永远不是来源事实，
     * 且必须在 `derivedFromSourceFacts: true` 时才有值。
     */
    readonly derivedFromPriceTimesSales: number | null;
    readonly derivedFromSourceFacts: boolean;
  }>;
  /** 销量集中度：分母与 usedSampleCount 必须同时返回，不得假装是完整市场份额。 */
  readonly salesConcentration: {
    readonly cr3: MarketMetric<MarketConcentrationV1>;
    readonly cr5: MarketMetric<MarketConcentrationV1>;
    readonly cr10: MarketMetric<MarketConcentrationV1>;
  };
  /** 品牌集中度：品牌缺失商品**不得**自动归入 "Other Brand"，必须显式缺失。 */
  readonly brandConcentration: {
    readonly brandCr3: MarketMetric<MarketConcentrationV1>;
    readonly brandCr5: MarketMetric<MarketConcentrationV1>;
    readonly uniqueBrandCount: MarketMetric<number>;
    readonly missingBrandCount: number;
  };
  readonly rating: {
    readonly averageRating: MarketMetric<number>;
    readonly medianRating: MarketMetric<number>;
  };
  readonly reviews: {
    readonly averageReviewCount: MarketMetric<number>;
    readonly medianReviewCount: MarketMetric<number>;
    /** Top 定义：按 reviewCount 降序、并列时按 ASIN 升序取前 N。 */
    readonly topReviewThreshold: MarketMetric<{
      readonly topN: number;
      readonly definition: string;
      readonly thresholdReviewCount: number;
      readonly headSampleCount: number;
      readonly headSalesShare: number | null;
    }>;
  };
  /** 只有 ProductFact 中存在可信 launchedDate 时才计算，否则 NOT_AVAILABLE。 */
  readonly newEntrants: {
    readonly referenceDate: string;
    readonly newProductCount30d: MarketMetric<number>;
    readonly newProductCount90d: MarketMetric<number>;
    readonly newProductShare90d: MarketMetric<number>;
    readonly newProductSalesShare90d: MarketMetric<number>;
  };
  /**
   * 观测窗口。ProductBatch 桥接写入的 `capturedAt` 是**桥接时刻**，
   * 不等于真实观测时刻，因此必须显式记录来源，不得让 UI 假装数据是「刚刚实测」。
   * `null` 代表未知，禁止用扫描创建时间冒充。
   */
  readonly evidenceWindow: {
    readonly earliestCapturedAt: string | null;
    readonly latestCapturedAt: string | null;
    readonly recordedObservedAt: string | null;
    readonly observedAtSource: "caller_recorded" | "evidence_captured_at" | "unknown";
    readonly marketplace: string;
  };
  readonly notes: readonly string[];
};

/* ── 输入类型 ─────────────────────────────────────────────────────── */

/** 指标引擎唯一输入单元：标准化后的 ProductFact + 版本锁定元数据。 */
export type MarketScanSampleInputV1 = {
  readonly subjectKey: string;
  readonly productFact: ProductFact;
  readonly evidenceStatus?: string;
  /**
   * 可选：已冻结的事实值快照。提供时指标必须直接使用它（保证历史扫描可重算、
   * 不随证据库变化漂移）；缺失时才从 `productFact` 现场投影。
   * 两者必须描述同一份事实，由服务层保证。
   */
  readonly factValues?: MarketFactValuesV1;
  /** 可选：Evidence 版本台账信息，用于样本快照锁定；缺失时用 ProductFact 自身推导。 */
  readonly evidenceVersion?: number | null;
  readonly evidenceId?: string | null;
  readonly capturedAt?: string | null;
  readonly candidateId?: string | null;
};

export type MarketScanMetricsInputV1 = {
  readonly sample: readonly MarketScanSampleInputV1[];
  /** 参考时间（新品统计窗口的基准），由调用方注入以保证可复现。 */
  readonly referenceDate: string;
  readonly metricsVersion?: string;
  /**
   * 已冻结的样本快照 hash。指标的 sampleHash 必须与快照一致，
   * 因此由调用方显式传入；未提供时引擎**不得**臆造一个看起来合法的 hash。
   */
  readonly sampleHash?: string;
  /** 样本所属市场站点；缺失时按样本主体的市场站点推断，无法推断则为 UNKNOWN。 */
  readonly marketplace?: string;
  /** 调用方记录的真实观测时刻（例如批次 importedAt）；缺失时退化为 evidence capturedAt。 */
  readonly observedAt?: string | null;
  /** 调用方补充的说明（例如样本来源、批次名）；引擎只追加不覆盖自己的说明。 */
  readonly extraNotes?: readonly string[];
};

/** 便于投影：样本条目 + ProductFact 的组合。 */
export type MarketScanSnapshotWithFacts = {
  readonly snapshot: MarketScanSampleSnapshotV1;
  readonly productFacts: readonly ProductFact[];
};
