/**
 * MarketScan 测试夹具：构造**结构真实**的 `ProductFact`（`product-fact.v3`）。
 *
 * 仅用于 `lib/marketScan/*.test.ts`；生产链路不引用本文件。
 * 约定：选项值为 `undefined` 表示「用默认值」，显式 `null` 表示「该事实字段缺失」。
 */

import type {
  FactField,
  ProductFact,
  ProductFactSource,
  ProductPrice,
} from "@/lib/sourceLayer/fact/types";
import { MarketScanSampleError } from "@/lib/marketScan/metrics";
import type {
  MarketFactValuesV1,
  MarketScanSampleInputV1,
  NicheDefinitionV1,
  SampleDefinitionV1,
} from "@/lib/marketScan/types";

/** 64 位小写十六进制，满足 `sourceProof.contentHash` 契约。 */
export const FIXTURE_CONTENT_HASH = "0123456789abcdef".repeat(4);
export const FIXTURE_CAPTURED_AT = "2025-01-01T00:00:00.000Z";
export const FIXTURE_REFERENCE_DATE = "2025-01-01T00:00:00.000Z";

export const FIXTURE_NICHE_DEFINITION: NicheDefinitionV1 = {
  schemaVersion: "market-scan-sample.v1",
  kind: "sellersprite_filter",
  label: "Fixture niche",
  notes: null,
  parameters: { marketplace: "US", minPrice: 10, maxPrice: 200 },
};

export const FIXTURE_SAMPLE_DEFINITION: SampleDefinitionV1 = {
  schemaVersion: "market-scan-sample.v1",
  origin: "existing_evidence",
  marketplace: "US",
  sourceTypes: ["sellersprite_xlsx"],
  productBatchId: null,
  requestedLimit: 100,
};

type FieldContext = {
  readonly source: ProductFactSource;
  readonly capturedAt: string;
  readonly rawProofHash: string;
};

export function presentField<T>(value: T, context: FieldContext): FactField<T> {
  return {
    value,
    status: "present",
    source: context.source,
    confidence: 0.9,
    capturedAt: context.capturedAt,
    rawProofHash: context.rawProofHash,
  };
}

export function missingField<T>(context: FieldContext): FactField<T> {
  return {
    value: null,
    status: "missing",
    source: context.source,
    confidence: 0,
    capturedAt: context.capturedAt,
    rawProofHash: context.rawProofHash,
  };
}

/** `null` → missing 字段；其余（含 NaN / Infinity / 负数）→ present 字段，用于异常用例。 */
export function nullableField<T>(value: T | null, context: FieldContext): FactField<T> {
  return value === null ? missingField<T>(context) : presentField<T>(value, context);
}

export type ProductFactFixtureOptions = {
  /** `undefined` → 默认 ASIN；`null` → 缺失 ASIN（非法样本）。 */
  readonly asin?: string | null;
  readonly subjectKey?: string;
  readonly title?: string | null;
  readonly image?: string | null;
  readonly brand?: string | null;
  /** 显式 `null` → missing；负数 / NaN / Infinity 也会被写成 present 字段（异常用例）。 */
  readonly price?: number | null;
  readonly priceCurrency?: string | null;
  readonly rating?: number | null;
  readonly reviewCount?: number | null;
  readonly bsr?: number | null;
  readonly monthlySalesEstimate?: number | null;
  readonly monthlyRevenueEstimate?: number | null;
  readonly monthlyRevenueCurrency?: string | null;
  readonly launchedDate?: string | null;
  readonly source?: ProductFactSource;
  readonly evidenceId?: string;
  readonly contentHash?: string;
  readonly capturedAt?: string;
};

function priceField(
  amount: number | null,
  currency: string | null,
  context: FieldContext,
): FactField<ProductPrice> {
  if (amount === null) return missingField<ProductPrice>(context);
  return presentField<ProductPrice>({ amount, currency: currency ?? "USD" }, context);
}

export function makeProductFact(options: ProductFactFixtureOptions = {}): ProductFact {
  const asin = options.asin === undefined ? "B0FIXTURE1" : options.asin;
  const source = options.source ?? "sellersprite_xlsx";
  const capturedAt = options.capturedAt ?? FIXTURE_CAPTURED_AT;
  const contentHash = options.contentHash ?? FIXTURE_CONTENT_HASH;
  const subjectKey = options.subjectKey ?? `amazon:US:${asin ?? "unknown"}`;
  const evidenceId = options.evidenceId ?? `evidence-${asin ?? "unknown"}`;
  const context: FieldContext = { source, capturedAt, rawProofHash: contentHash };

  const price = options.price === undefined ? 19.99 : options.price;
  const revenue =
    options.monthlyRevenueEstimate === undefined ? 4997.5 : options.monthlyRevenueEstimate;

  return {
    schema: "product-fact.v3",
    subjectKey,
    sourceProof: {
      source,
      captureId: `capture-${asin ?? "unknown"}`,
      evidenceId,
      subjectKey,
      capturedAt,
      contentHash,
      sourceUrl: asin === null ? null : `https://www.amazon.com/dp/${asin}`,
      operator: "fixture",
    },
    basic: {
      asin: nullableField<string>(asin, context),
      title: nullableField<string>(
        options.title === undefined ? `Fixture product ${asin ?? "unknown"}` : options.title,
        context,
      ),
      image: nullableField<string>(
        options.image === undefined
          ? (asin === null ? null : `https://cdn.example.com/${asin}.jpg`)
          : options.image,
        context,
      ),
      brand: nullableField<string>(
        options.brand === undefined ? "FixtureBrand" : options.brand,
        context,
      ),
      category: presentField<string>("Home & Kitchen", context),
      price: priceField(price, options.priceCurrency ?? "USD", context),
      rating: nullableField<number>(options.rating === undefined ? 4.5 : options.rating, context),
      reviewCount: nullableField<number>(
        options.reviewCount === undefined ? 120 : options.reviewCount,
        context,
      ),
      bulletPoints: presentField<readonly string[]>(["point one", "point two"], context),
    },
    market: {
      bsr: nullableField<number>(options.bsr === undefined ? 1500 : options.bsr, context),
      monthlySalesEstimate: nullableField<number>(
        options.monthlySalesEstimate === undefined ? 300 : options.monthlySalesEstimate,
        context,
      ),
      monthlyRevenueEstimate: priceField(
        revenue,
        options.monthlyRevenueCurrency ?? "USD",
        context,
      ),
      launchedDate: nullableField<string>(
        options.launchedDate === undefined ? "2024-06-01" : options.launchedDate,
        context,
      ),
    },
    profit: {
      packageWeight: presentField({ value: 0.5, unit: "kg" as const }, context),
      packageDimensions: presentField(
        { length: 10, width: 8, height: 4, unit: "cm" as const },
        context,
      ),
      fbaFee: presentField<ProductPrice>({ amount: 4.25, currency: "USD" }, context),
    },
  };
}

export type SampleInputFixtureOptions = ProductFactFixtureOptions & {
  readonly evidenceVersion?: number | null;
  readonly candidateId?: string | null;
  /** 覆盖入参 capturedAt（`null` 时回落到 ProductFact.sourceProof.capturedAt）。 */
  readonly capturedAtOverride?: string | null;
  readonly evidenceIdOverride?: string | null;
  /** 模拟服务层已冻结好的事实值快照；缺省时不传，由引擎现场投影。 */
  readonly factValues?: MarketScanSampleInputV1["factValues"];
};

export function makeSampleInput(options: SampleInputFixtureOptions = {}): MarketScanSampleInputV1 {
  const productFact = makeProductFact(options);
  const base: MarketScanSampleInputV1 = {
    subjectKey: productFact.subjectKey,
    productFact,
    evidenceVersion: options.evidenceVersion ?? 1,
    evidenceId: options.evidenceIdOverride ?? productFact.sourceProof.evidenceId,
    capturedAt: options.capturedAtOverride ?? productFact.sourceProof.capturedAt,
    candidateId: options.candidateId ?? null,
  };
  return options.factValues === undefined ? base : { ...base, factValues: options.factValues };
}

/** 形如 `B0SCAN0007`（10 位大写，与真实 ASIN 长度一致）。 */
export function fixtureAsinAt(index: number): string {
  return `B0SCAN${String(index).padStart(4, "0")}`;
}

/**
 * 手写的 `MarketFactValuesV1` 夹具（不经过任何投影函数），
 * 用于独立校验快照自证指纹与条目 hash。
 */
export function fixtureFactValues(
  overrides: Partial<MarketFactValuesV1> = {},
): MarketFactValuesV1 {
  const base: MarketFactValuesV1 = {
    asin: "B0ITEM0001",
    title: { presence: "present", value: "Fixture title" },
    brand: { presence: "present", value: "FixtureBrand" },
    category: { presence: "present", value: "Home & Kitchen" },
    price: {
      presence: "present",
      value: { amount: 19.99, currency: "USD" },
      valueSource: "FACT",
    },
    rating: { presence: "present", value: 4.5 },
    reviewCount: { presence: "present", value: 120 },
    bsr: { presence: "present", value: 1500 },
    monthlySalesEstimate: { presence: "present", value: 300, valueSource: "PROVIDER_ESTIMATE" },
    monthlyRevenueEstimate: {
      presence: "present",
      value: { amount: 4997.5, currency: "USD" },
      valueSource: "PROVIDER_ESTIMATE",
    },
    launchedDate: { presence: "present", value: "2024-06-01" },
  };
  return { ...base, ...overrides };
}

/** 每条样本使用不同的 contentHash（用于去重并列时的字典序用例）。 */
export function fixtureContentHashAt(index: number): string {
  const prefix = index.toString(16).padStart(2, "0");
  return `${prefix}${"0123456789abcdef".repeat(4)}`.slice(0, 64);
}

export function makeSampleSeries(
  count: number,
  map: (index: number) => ProductFactFixtureOptions,
): MarketScanSampleInputV1[] {
  const series: MarketScanSampleInputV1[] = [];
  for (let index = 0; index < count; index += 1) {
    const overrides = map(index);
    series.push(
      makeSampleInput({
        ...overrides,
        asin: overrides.asin === undefined ? fixtureAsinAt(index) : overrides.asin,
      }),
    );
  }
  return series;
}

/** 捕获 `MarketScanSampleError`；未抛出或抛错类型不符时直接失败。 */
export function captureMarketScanSampleError(fn: () => unknown): MarketScanSampleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MarketScanSampleError) return error;
    throw error;
  }
  throw new Error("expected MarketScanSampleError, but no error was thrown");
}
