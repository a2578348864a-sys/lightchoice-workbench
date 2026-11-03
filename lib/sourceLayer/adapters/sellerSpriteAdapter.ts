/**
 * Product Source Layer V1.2 — SellerSprite Adapter（Phase 6，第一数据来源）
 *
 * 明确不做（V1.2 十、对抗式审查第 1 条）：
 * - 不自动绕过 Amazon 反爬；
 * - 不自动登录；
 * - 不做大规模爬取。
 * 本 Adapter 只解析「用户已经合法导出的 SellerSprite XLSX」，
 * 属于用户辅助采集，不发起任何外部网络请求。
 *
 * 复用（禁止重复造轮子）：
 * - 表头映射 / 字段归一 / 结构预检：lib/upstream/sellersprite/precheck.ts
 * - 商品图片资源：lib/upstream/sellersprite/xlsx.ts（内嵌图）与快照 extraRaw（外链）
 *
 * 纯模块：无网络 / 无 DB / 无随机。
 */
import {
  parseXlsxEmbeddedImages,
  type XlsxEmbeddedImageParseResult,
} from "@/lib/upstream/sellersprite/xlsx";
import { precheckSellerSpriteXlsx } from "@/lib/upstream/sellersprite/precheck";
import {
  precheckSellerSpritePreview,
  type SellerSpriteAcceptedPreviewRow,
  type SellerSpritePreviewResult,
} from "@/lib/upstream/sellersprite/preview";
import { buildSellerSpriteMarketSnapshot } from "@/lib/upstream/sellersprite/marketSnapshot";
import {
  createSourceAdapter,
  registerSourceAdapter,
  type SourceAdapterCaptureResult,
  type SourceAdapterInput,
} from "@/lib/sourceLayer/sourceAdapter";
import {
  defaultCaptureMethodFor,
  type CapturePackageDraft,
  type CaptureFieldDraft,
  type CapturePackageExtensions,
  type MetricNature,
} from "@/lib/sourceLayer/capturePackage";
import {
  sellerSpriteMetricNatureForRawHeader,
} from "@/lib/upstream/sellersprite/fields";
import {
  buildSourceEvidenceAttachment,
  type SourceEvidenceAttachment,
} from "@/lib/sourceLayer/evidenceAttachment";

export const SELLERSPRITE_ADAPTER_VERSION = "sellersprite-adapter.v1" as const;
export const SELLERSPRITE_MARKETPLACE = "US" as const;

/** 与既有 ProductBatch 图片解析一致的候选表头（顺序即优先级）。 */
const IMAGE_HEADERS = ["商品主图", "图片", "Main Image", "Product Image"] as const;

/**
 * 解析 XLSX 载荷。字节必须由调用方从已授权的上传中取得；
 * 这里不读取磁盘、不下载任何 URL。
 */
export function captureSellerSpriteXlsx(
  input: SourceAdapterInput,
): SourceAdapterCaptureResult {
  const errorCodes: SourceAdapterCaptureResult["errorCodes"] = [];
  if (!(input.payload instanceof Uint8Array)) {
    return {
      drafts: [],
      errorCodes: ["INVALID_FORMAT"],
      quarantinedCount: 0,
      pageDigest: "payload_not_xlsx_bytes",
    };
  }
  const precheck = precheckSellerSpriteXlsx(input.payload, {
    capturedAt: input.capturedAt,
  });
  // 官方 Preview/Confirm 入口支持的 SellerSprite Search Results 报表，
  // 与历史 ProductBatch 报表不是同一套列契约。先复用旧契约以保持已有
  // ProductBatch 回放稳定；若旧契约明确判定为 unknown，再用同一个官方
  // preview parser 重新解析。这里不放宽事实规则：Preview parser 仍会
  // 独立校验工作表、必填列、ASIN/URL 绑定和数值边界。
  if (precheck.reportType === "unknown" || precheck.errors.some((error) => error.code === "unsupported_report_type")) {
    return captureSellerSpritePreviewXlsx(input);
  }
  if (precheck.errors.some((error) => error.severity === "error" && error.rowNumber === undefined)) {
    return {
      drafts: [],
      errorCodes: ["INVALID_FORMAT"],
      quarantinedCount: precheck.totalRows,
      pageDigest: `sheet=${precheck.sheetName ?? "unknown"};structural_error`,
    };
  }

  let snapshot;
  try {
    snapshot = buildSellerSpriteMarketSnapshot(precheck);
  } catch {
    return {
      drafts: [],
      errorCodes: ["INVALID_FORMAT"],
      quarantinedCount: precheck.totalRows,
      pageDigest: `sheet=${precheck.sheetName ?? "unknown"};snapshot_build_failed`,
    };
  }

  let embedded: XlsxEmbeddedImageParseResult | null = null;
  try {
    embedded = parseXlsxEmbeddedImages(input.payload, snapshot.sheetName);
  } catch {
    // 内嵌图不可用不阻断采集：图片会退化为外链候选或缺失，由 Validator 复核。
    // 只在 replay warning 中记录可选图片解码失败；这不是浏览器 DOM 选择器错误。
  }

  const rowsByAsin = new Map<string, number[]>();
  for (const record of snapshot.records) {
    const asin = record.asin.normalized;
    if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin)) continue;
    const list = rowsByAsin.get(asin) ?? [];
    list.push(record.rowNumber);
    rowsByAsin.set(asin, list);
  }

  const drafts: CapturePackageDraft[] = [];
  for (const product of snapshot.products) {
    const rows = rowsByAsin.get(product.asin) ?? [];
    const metrics = product.providerMetrics as Record<
      string,
      { normalized?: unknown; applicability?: string; metricNature?: string } | undefined
    >;
    const resolved = (field: string): unknown => {
      const metric = metrics[field];
      return metric && metric.applicability === "available" ? metric.normalized : null;
    };

    const title = textValue(resolved("productTitle"));
    const price = numberValue(resolved("price"));
    const rating = numberValue(resolved("rating"));
    const reviews = numberValue(resolved("reviews"));
    const rootCategory = textValue(resolved("rootCategory"));
    const bsrRank = bsrValue(resolved("rootCategoryBsr"));
    const brand = textValue(resolved("brand"));
    const productUrl = textValue(resolved("productUrl"));
    const subCategoryBsrRank = bsrValue(resolved("subCategoryBsr"));
    const estimatedMonthlySales = numberValue(resolved("estimatedMonthlySales"));
    const estimatedMonthlyRevenue = numberValue(resolved("estimatedMonthlyRevenue"));
    const images = collectImages({ records: precheck.records, embedded, asin: product.asin });
    const rawRows = buildRawRows({
      snapshot,
      asin: product.asin,
    });
    const rawValue = (aliases: readonly string[]): string | null => exactRawValue(rawRows, aliases);
    const rawHeader = (aliases: readonly string[]): string | null => exactRawHeader(rawRows, aliases);
    const rawNature = (
      aliases: readonly string[],
      fallback: MetricNature,
    ): MetricNature => {
      const header = rawHeader(aliases);
      if (!header) return fallback;
      const declared = sellerSpriteMetricNatureForRawHeader(header);
      // SellerSprite 的「毛利率」列在旧 raw 字典中属于 derived；进入本轮
      // ProductFact 的 provider 估算投影时仍必须显式保持 estimate 语义。
      if (fallback === "estimate" && declared === "derived") return fallback;
      return declared === "unknown" ? fallback : declared;
    };
    const extensionMetadata = (field: string, aliases: readonly string[], fallback: MetricNature) => {
      const metricNature = rawNature(aliases, fallback);
      return {
        metricNature,
        valueOrigin: "provider_export" as const,
        confidence: metricNature === "snapshot" ? 1 : 0.9,
        sourceRef: `sellersprite.xlsx.${rawHeader(aliases) ?? field}`,
      };
    };
    const packageWeight = parseWeight(rawValue([
      "包装重量（单位换算）",
      "包装重量",
      "Package Weight",
    ]));
    const packageDimensions = parseDimensions(rawValue([
      "包装尺寸（单位换算）",
      "包装尺寸",
      "Package Dimensions",
    ]));
    const itemWeight = parseWeight(rawValue([
      "商品重量（单位换算）",
      "商品重量",
      "Product Weight",
    ]));
    const itemDimensions = parseDimensions(rawValue([
      "商品尺寸（单位换算）",
      "商品尺寸",
      "Product Dimensions",
    ]));
    const dateFirstAvailable = rawValue([
      "上架时间",
      "上架日期",
      "Date First Available",
      "Listing Date",
    ]);
    const buyboxSeller = rawValue([
      "Buybox卖家",
      "Buy Box Seller",
      "Buybox Seller",
      "Seller",
    ]);
    const fulfillmentType = rawValue([
      "配送方式",
      "Fulfillment",
      "Fulfillment Type",
    ]);
    const estimatedFbaFee = parseUsdAmount(rawValue([
      "预估FBA费",
      "Estimated FBA Fee",
      "FBA Fee",
      "FBA费用",
    ]));
    const estimatedGrossMargin = parseNumber(rawValue([
      "预估毛利率",
      "毛利率",
      "Gross Margin",
      "Estimated Gross Margin",
    ]));
    const listingQualityScore = parseNumber(rawValue([
      "LQS评分",
      "LQS Score",
      "Listing Quality Score",
    ]));
    const childSales = parseNumber(rawValue([
      "子体销量",
      "子体月销量",
      "Child Sales",
      "Child Monthly Sales",
    ]));
    const childRevenueParsed = parseUsdAmount(rawValue([
      "子体销售额",
      "子体销售额($)",
      "Child Revenue",
      "Child Monthly Revenue",
    ]));
    const childRevenue = childRevenueParsed
      ? childRevenueParsed.amount
      : parseNumber(rawValue([
          "子体销售额",
          "子体销售额($)",
          "Child Revenue",
          "Child Monthly Revenue",
        ]));
    const sellerLocation = rawValue([
      "卖家所属地",
      "卖家属地",
      "Seller Origin",
      "Seller Country",
      "Seller Location",
    ]);
    const dealBadge = rawValue([
      "秒杀",
      "7天促销",
      "Deal",
      "Lightning Deal",
      "Deal Badge",
    ]);

    let currentAsinSalesShare: number | null = null;
    if (childSales !== null && estimatedMonthlySales !== null && estimatedMonthlySales > 0) {
      currentAsinSalesShare = Math.min(1, Math.max(0, Math.round((childSales / estimatedMonthlySales) * 10000) / 10000));
    } else if (childSales !== null) {
      const sumChild = snapshot.records
        .map((r) => parseNumber(r.extraRaw["子体销量"] ?? r.extraRaw["子体月销量"]))
        .filter((n): n is number => n !== null && n > 0)
        .reduce((sum, n) => sum + n, 0);
      if (sumChild > 0) {
        currentAsinSalesShare = Math.min(1, Math.max(0, Math.round((childSales / sumChild) * 10000) / 10000));
      }
    }
    const isDominantVariation = currentAsinSalesShare !== null ? currentAsinSalesShare >= 0.5 : null;
    const isMinorVariation = currentAsinSalesShare !== null ? currentAsinSalesShare < 0.1 : null;

    let brandCr5Share: number | null = null;
    if (snapshot.brandConcentrationSummary?.status === "available" && snapshot.brandConcentrationSummary.rows.length > 0) {
      const validShares = snapshot.brandConcentrationSummary.rows
        .map((r) => r.marketShare.normalized)
        .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
      if (validShares.length > 0) {
        const top5Sum = validShares.slice(0, 5).reduce((acc, v) => acc + v, 0);
        brandCr5Share = Math.min(1, Math.max(0, Math.round(top5Sum * 10000) / 10000));
      }
    }

    let amazon1pShare: number | null = null;
    if (snapshot.sellerConcentrationSummary?.status === "available" && snapshot.sellerConcentrationSummary.rows.length > 0) {
      const amazonRow = snapshot.sellerConcentrationSummary.rows.find((r) => {
        const name = (r.entity.normalized ?? "").trim().toLowerCase();
        return name === "amazon" || name === "amazon.com" || name === "amazon.com services llc";
      });
      if (amazonRow && typeof amazonRow.marketShare.normalized === "number") {
        amazon1pShare = amazonRow.marketShare.normalized;
      }
    }

    let sellerMarketShare: number | null = null;
    if (snapshot.sellerConcentrationSummary?.status === "available" && (buyboxSeller || resolved("seller"))) {
      const targetSeller = (buyboxSeller || textValue(resolved("seller")))?.trim().toLowerCase();
      if (targetSeller) {
        const matched = snapshot.sellerConcentrationSummary.rows.find((r) => (r.entity.normalized ?? "").trim().toLowerCase() === targetSeller);
        if (matched && typeof matched.marketShare.normalized === "number") {
          sellerMarketShare = matched.marketShare.normalized;
        }
      }
    }

    let sellerOriginDomesticRatio: number | null = null;
    const sellerLocations = snapshot.records
      .map((r) => r.extraRaw["卖家所属地"] ?? r.extraRaw["卖家属地"])
      .filter((l): l is string => typeof l === "string" && l.trim().length > 0);
    if (sellerLocations.length > 0) {
      const domesticCount = sellerLocations.filter((l) => {
        const t = l.trim().toUpperCase();
        return t === "CN" || t === "HK" || t === "MO" || t.includes("中国") || t === "CHINA";
      }).length;
      sellerOriginDomesticRatio = Math.round((domesticCount / sellerLocations.length) * 10000) / 10000;
    }

    const extensionFieldMetadata = {
      packageWeight: extensionMetadata("packageWeight", ["包装重量（单位换算）", "包装重量", "Package Weight"], "snapshot"),
      packageDimensions: extensionMetadata("packageDimensions", ["包装尺寸（单位换算）", "包装尺寸", "Package Dimensions"], "snapshot"),
      itemWeight: extensionMetadata("itemWeight", ["商品重量（单位换算）", "商品重量", "Product Weight"], "snapshot"),
      itemDimensions: extensionMetadata("itemDimensions", ["商品尺寸（单位换算）", "商品尺寸", "Product Dimensions"], "snapshot"),
      dateFirstAvailable: extensionMetadata("dateFirstAvailable", ["上架时间", "上架日期", "Date First Available", "Listing Date"], "snapshot"),
      launchedDate: extensionMetadata("launchedDate", ["上架时间", "上架日期", "Date First Available", "Listing Date"], "snapshot"),
      buyboxSeller: extensionMetadata("buyboxSeller", ["Buybox卖家", "Buy Box Seller", "Buybox Seller", "Seller"], "snapshot"),
      fulfillmentType: extensionMetadata("fulfillmentType", ["配送方式", "Fulfillment", "Fulfillment Type"], "snapshot"),
      estimatedFbaFee: extensionMetadata("estimatedFbaFee", ["预估FBA费", "Estimated FBA Fee", "FBA Fee", "FBA费用"], "estimate"),
      estimatedGrossMargin: extensionMetadata("estimatedGrossMargin", ["预估毛利率", "毛利率", "Gross Margin", "Estimated Gross Margin"], "estimate"),
      listingQualityScore: extensionMetadata("listingQualityScore", ["LQS评分", "LQS Score", "Listing Quality Score"], "estimate"),
      childSales: extensionMetadata("childSales", ["子体销量", "子体月销量"], "estimate"),
      childRevenue: extensionMetadata("childRevenue", ["子体销售额", "子体销售额($)"], "estimate"),
      currentAsinSalesShare: {
        metricNature: "derived" as const,
        valueOrigin: "derived" as const,
        confidence: 0.9,
        sourceRef: "sellersprite.variation.currentAsinSalesShare",
      },
      isDominantVariation: {
        metricNature: "derived" as const,
        valueOrigin: "derived" as const,
        confidence: 0.9,
        sourceRef: "sellersprite.variation.isDominantVariation",
      },
      isMinorVariation: {
        metricNature: "derived" as const,
        valueOrigin: "derived" as const,
        confidence: 0.9,
        sourceRef: "sellersprite.variation.isMinorVariation",
      },
      brandCr5Share: {
        metricNature: "derived" as const,
        valueOrigin: "provider_export" as const,
        confidence: 1,
        sourceRef: "sellersprite.brands.cr5Share",
      },
      amazon1pShare: {
        metricNature: "derived" as const,
        valueOrigin: "provider_export" as const,
        confidence: 1,
        sourceRef: "sellersprite.sellers.amazon1pShare",
      },
      sellerMarketShare: {
        metricNature: "derived" as const,
        valueOrigin: "provider_export" as const,
        confidence: 1,
        sourceRef: "sellersprite.sellers.sellerMarketShare",
      },
      sellerOriginDomesticRatio: {
        metricNature: "derived" as const,
        valueOrigin: "provider_export" as const,
        confidence: 1,
        sourceRef: "sellersprite.sellers.sellerOriginDomesticRatio",
      },
    };

    const sourceRef = (field: string) => `sellersprite.xlsx.${field}`;
    const providerExport = "provider_export" as const;
    const metricNatureFor = (field: string, fallback: "snapshot" | "estimate" | "derived" | "unknown" = "snapshot") => {
      const value = metrics[field]?.metricNature;
      return value === "snapshot" || value === "estimate" || value === "derived" || value === "unknown"
        ? value
        : fallback;
    };
    const draftField = <T,>(value: T, field: string, metricNature = metricNatureFor(field)): CaptureFieldDraft<T> => ({
      value,
      valueOrigin: providerExport,
      metricNature,
      sourceRef: sourceRef(field),
      confidence: metricNature === "snapshot" ? 1 : 0.9,
    });

    drafts.push({
      subjectKey: `amazon:${SELLERSPRITE_MARKETPLACE}:${product.asin}`,
      marketplace: SELLERSPRITE_MARKETPLACE,
      fields: {
        asin: draftField(product.asin, "asin"),
        title: draftField(title, "productTitle"),
        brand: draftField(brand, "brand"),
        images: draftField(images, "images"),
        price: draftField(
          price === null ? null : { amount: price, currency: "USD" },
          "price",
        ),
        rating: draftField(rating, "rating"),
        reviewCount: draftField(reviews === null ? null : Math.round(reviews), "reviews"),
        bsr: draftField(
          bsrRank === null ? null : { rank: bsrRank, category: rootCategory },
          "rootCategoryBsr",
        ),
        subCategoryBsr: draftField(subCategoryBsrRank, "subCategoryBsr"),
        estimatedMonthlySales: draftField(
          estimatedMonthlySales === null ? null : Math.round(estimatedMonthlySales),
          "estimatedMonthlySales",
          "estimate",
        ),
        estimatedMonthlyRevenueUsd: draftField(
          estimatedMonthlyRevenue,
          "estimatedMonthlyRevenue",
          "estimate",
        ),
        // 关键词：SellerSprite 搜索报表的查询词是本次采集的语境，不做推断。
        keywords: draftField(deriveKeywords({ productUrl, brand, rootCategory }), "keywords"),
      },
      extensions: {
        launchedDate: dateFirstAvailable,
        dateFirstAvailable,
        buyboxSeller,
        fulfillmentType,
        packageWeight,
        packageDimensions,
        itemWeight,
        itemDimensions,
        estimatedFbaFee,
        estimatedGrossMargin,
        listingQualityScore,
        childSales,
        childRevenue,
        currentAsinSalesShare,
        isDominantVariation,
        isMinorVariation,
        sellerLocation,
        dealBadge,
        brandCr5Share,
        amazon1pShare,
        sellerMarketShare,
        sellerOriginDomesticRatio,
        fieldMetadata: extensionFieldMetadata,
        sellerSpriteRaw: {
          schemaVersion: "sellersprite-xlsx-raw.v1",
          sourceType: "sellersprite_xlsx",
          sourceFileSha256: snapshot.sourceFileSha256,
          rows: rawRows,
        },
      },
      sourceProof: {
        sourceType: "sellersprite_xlsx",
        sourceMethod: "sellersprite_official_xlsx",
        sourceUrl: productUrl ?? input.sourceUrl ?? null,
        capturedAt: input.capturedAt,
        captureMethod: defaultCaptureMethodFor("sellersprite_xlsx"),
        operator: input.operator,
        sourceFingerprint: input.sourceFingerprint ?? snapshot.sourceFileSha256,
        sourceRecordRef: rows.length > 0 ? `rows=${rows.join(",")}` : null,
      },
      replay: {
        url: productUrl ?? input.sourceUrl ?? null,
        capturedAt: input.capturedAt,
        pageDigest: digest({
          sheet: snapshot.sheetName,
          reportType: snapshot.reportType,
          acceptedRows: snapshot.acceptedRows,
          rejectedRows: snapshot.rejectedRows,
        }),
        warnings: [
          ...(snapshot.warningCounts
            ? Object.entries(snapshot.warningCounts).map(([code, count]) => `warning:${code}=${count}`)
            : []),
          ...(embedded ? [] : ["embedded_image_unavailable"]),
        ].slice(0, 20),
      },
    });
  }

  return {
    drafts,
    errorCodes,
    quarantinedCount: precheck.rejectedRows,
    pageDigest: digest({
      sheet: snapshot.sheetName,
      reportType: snapshot.reportType,
      totalRows: precheck.totalRows,
      acceptedRows: precheck.acceptedRows,
      rejectedRows: precheck.rejectedRows,
    }),
  };
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return normalized.length > 0 ? normalized : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function captureSellerSpritePreviewXlsx(
  input: SourceAdapterInput,
): SourceAdapterCaptureResult {
  let preview: SellerSpritePreviewResult;
  try {
    preview = precheckSellerSpritePreview(input.payload as Uint8Array);
  } catch {
    return {
      drafts: [],
      errorCodes: ["INVALID_FORMAT"],
      quarantinedCount: 0,
      pageDigest: "sellersprite_preview;precheck_failed",
    };
  }

  const drafts = preview.acceptedRows.map((row) => previewDraft({ row, preview, input }));
  return {
    drafts,
    // 被 Preview parser 明确隔离的行已经在同一份预览结果中向操作者暴露；
    // 它们不是当前 accepted row 的采集失败，不能把合法行整体降级为 blocked。
    errorCodes: [],
    quarantinedCount: preview.rejectedRowCount,
    pageDigest: digest({
      parserContractVersion: preview.parserContractVersion,
      acceptedRows: preview.acceptedRowCount,
      rejectedRows: preview.rejectedRowCount,
      sourceFileSha256: preview.source.sourceFileSha256,
    }),
  };
}

function previewDraft(input: {
  row: SellerSpriteAcceptedPreviewRow;
  preview: SellerSpritePreviewResult;
  input: SourceAdapterInput;
}): CapturePackageDraft {
  const { row, preview } = input;
  const facts = row.facts;
  const estimates = row.estimates;
  const providerExport = "provider_export" as const;
  const sourceRef = (field: string) => `sellersprite.preview.${field}`;
  const field = <T,>(value: T, name: string, metricNature: MetricNature = "snapshot"): CaptureFieldDraft<T> => ({
    value,
    valueOrigin: providerExport,
    metricNature,
    sourceRef: sourceRef(name),
    // Preview parser 的销量/销售额是第三方估算；保留来源值，但不能以
    // confirmed 等价的满置信度写入 Validator。
    confidence: metricNature === "estimate" ? 0.9 : 1,
  });
  const images = facts.imageUrl ? [facts.imageUrl] : [];
  const rawColumns: Record<string, string | null> = {
    ASIN: facts.asin,
    商品标题: facts.title,
    商品详情页链接: facts.amazonUrl,
    ...(facts.parentAsin ? { 父ASIN: facts.parentAsin } : {}),
    ...(facts.imageUrl ? { 商品主图: facts.imageUrl } : {}),
    ...(facts.priceUsd !== undefined ? { "价格($)": String(facts.priceUsd) } : {}),
    ...(facts.rating !== undefined ? { 评分: String(facts.rating) } : {}),
    ...(facts.reviewCount !== undefined ? { 评分数: String(facts.reviewCount) } : {}),
    ...(facts.brand ? { 品牌: facts.brand } : {}),
    ...(facts.category ? { 类目路径: facts.category } : {}),
    ...(estimates.searchRank !== undefined ? { 搜索排名: String(estimates.searchRank) } : {}),
    ...(estimates.estimatedMonthlySales !== undefined ? { 月销量: String(estimates.estimatedMonthlySales) } : {}),
    ...(estimates.estimatedMonthlyRevenueUsd !== undefined
      ? { "月销售额($)": String(estimates.estimatedMonthlyRevenueUsd) }
      : {}),
    ...(facts.sku ? { SKU: facts.sku } : {}),
    ...(facts.detailAttributes ? { 详细参数: facts.detailAttributes } : {}),
    ...(facts.sellingPoints ? { 产品卖点: facts.sellingPoints } : {}),
  };
  const warnings = row.warnings.map((warning) => `warning:${warning.code}:${warning.field}`);

  return {
    subjectKey: `amazon:US:${facts.asin}`,
    marketplace: "US",
    fields: {
      asin: field(facts.asin, "asin"),
      title: field(facts.title, "title"),
      brand: field(facts.brand ?? null, "brand"),
      images: field(images, "imageUrl"),
      price: field(
        facts.priceUsd === undefined ? null : { amount: facts.priceUsd, currency: "USD" },
        "priceUsd",
      ),
      rating: field(facts.rating ?? null, "rating"),
      reviewCount: field(facts.reviewCount === undefined ? null : Math.round(facts.reviewCount), "reviewCount"),
      // 搜索排名不是大类 BSR，不能把不同语义的来源列强行映射为 BSR。
      bsr: field(null, "bsr"),
      subCategoryBsr: field(null, "subCategoryBsr"),
      estimatedMonthlySales: field(
        estimates.estimatedMonthlySales === undefined ? null : Math.round(estimates.estimatedMonthlySales),
        "estimatedMonthlySales",
        "estimate",
      ),
      estimatedMonthlyRevenueUsd: field(
        estimates.estimatedMonthlyRevenueUsd ?? null,
        "estimatedMonthlyRevenueUsd",
        "estimate",
      ),
      keywords: field(deriveKeywords({
        productUrl: facts.amazonUrl,
        brand: facts.brand ?? null,
        rootCategory: facts.category ?? null,
      }), "keywords"),
    },
    extensions: {
      fieldMetadata: {
        estimatedFbaFee: {
          metricNature: "estimate",
          valueOrigin: providerExport,
          confidence: 0.9,
          sourceRef: sourceRef("estimatedFbaFee"),
        },
        estimatedGrossMargin: {
          metricNature: "estimate",
          valueOrigin: providerExport,
          confidence: 0.9,
          sourceRef: sourceRef("estimatedGrossMargin"),
        },
        listingQualityScore: {
          metricNature: "estimate",
          valueOrigin: providerExport,
          confidence: 0.9,
          sourceRef: sourceRef("listingQualityScore"),
        },
      },
      sellerSpriteRaw: {
        schemaVersion: "sellersprite-xlsx-raw.v1",
        sourceType: "sellersprite_xlsx",
        sourceFileSha256: preview.source.sourceFileSha256,
        rows: [{
          rowNumber: row.rowNumber,
          columns: rawColumns,
          extraRaw: {},
          extraRawMetricNature: {},
        }],
      },
    },
    sourceProof: {
      sourceType: "sellersprite_xlsx",
      sourceUrl: facts.amazonUrl,
      capturedAt: input.input.capturedAt,
      captureMethod: defaultCaptureMethodFor("sellersprite_xlsx"),
      operator: input.input.operator,
      sourceFingerprint: input.input.sourceFingerprint ?? preview.source.sourceFileSha256,
      sourceRecordRef: row.rowHash ?? `row=${row.rowNumber}`,
      entityBinding: {
        expectedAsin: facts.asin,
        observedAsin: facts.asin,
        expectedMarketplace: "US",
        observedMarketplace: "US",
        urlAsin: facts.asin,
        urlMarketplace: "US",
        bound: true,
      },
    },
    replay: {
      url: facts.amazonUrl,
      capturedAt: input.input.capturedAt,
      pageDigest: digest({
        parserContractVersion: preview.parserContractVersion,
        sourceFileSha256: preview.source.sourceFileSha256,
        rowNumber: row.rowNumber,
        rowHash: row.rowHash,
      }),
      warnings,
    },
  };
}

type SellerSpriteRawRow = {
  rowNumber: number;
  columns: Record<string, string | null>;
  extraRaw: Record<string, string | null>;
  extraRawMetricNature: Record<string, MetricNature>;
};

const SELLERSPRITE_MAPPED_FIELDS = [
  "asin",
  "sku",
  "brand",
  "productTitle",
  "productUrl",
  "parentAsin",
  "searchRank",
  "price",
  "rating",
  "reviews",
  "estimatedMonthlySales",
  "estimatedMonthlyRevenue",
  "seller",
  "variationCount",
  "rootCategory",
  "rootCategoryBsr",
  "subCategory",
  "subCategoryBsr",
] as const;

function normalizeRawHeader(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function buildRawRows(input: {
  snapshot: ReturnType<typeof buildSellerSpriteMarketSnapshot>;
  asin: string;
}): SellerSpriteRawRow[] {
  return input.snapshot.records
    .filter((record) => record.asin.normalized === input.asin)
    .map((record) => {
      const columns: Record<string, string | null> = { ...record.extraRaw };
      for (const field of SELLERSPRITE_MAPPED_FIELDS) {
        const header = input.snapshot.fieldMapping[field];
        if (!header) continue;
        const value = record[field] as unknown as { raw?: unknown };
        columns[header] = typeof value?.raw === "string" ? value.raw : null;
      }
      return {
        rowNumber: record.rowNumber,
        columns,
        extraRaw: { ...record.extraRaw },
        extraRawMetricNature: { ...record.extraRawMetricNature },
      };
    });
}

/**
 * 从已落库的 ProductBatch 快照恢复同一份 SellerSprite 扩展。
 *
 * ProductBatch 的标准化商品 JSON 只承担候选排序所需的投影，但批次快照
 * 仍保留了官方导表的 raw columns。批次桥接到 Evidence 时必须从这份快照
 * 重建扩展，否则 Phase A 的高价值列会在 ProductBatch → ProductFact 之间
 * 被截断。解析失败返回 null，由上层保持缺失而不是猜测。
 */
export function sellerSpriteProductFactExtensionsFromSnapshot(input: {
  snapshot: ReturnType<typeof buildSellerSpriteMarketSnapshot>;
  asin: string;
}): CapturePackageExtensions | null {
  const rawRows = buildRawRows(input);
  if (rawRows.length === 0) return null;

  const rawValue = (aliases: readonly string[]): string | null => exactRawValue(rawRows, aliases);
  const rawHeader = (aliases: readonly string[]): string | null => exactRawHeader(rawRows, aliases);
  const rawNature = (
    aliases: readonly string[],
    fallback: MetricNature,
  ): MetricNature => {
    const header = rawHeader(aliases);
    if (!header) return fallback;
    const declared = sellerSpriteMetricNatureForRawHeader(header);
    if (fallback === "estimate" && declared === "derived") return fallback;
    return declared === "unknown" ? fallback : declared;
  };
  const extensionMetadata = (
    field: string,
    aliases: readonly string[],
    fallback: MetricNature,
  ) => {
    const metricNature = rawNature(aliases, fallback);
    return {
      metricNature,
      valueOrigin: "provider_export" as const,
      confidence: metricNature === "snapshot" ? 1 : 0.9,
      sourceRef: `sellersprite.xlsx.${rawHeader(aliases) ?? field}`,
    };
  };

  const packageWeight = parseWeight(rawValue([
    "包装重量（单位换算）",
    "包装重量",
    "Package Weight",
  ]));
  const packageDimensions = parseDimensions(rawValue([
    "包装尺寸（单位换算）",
    "包装尺寸",
    "Package Dimensions",
  ]));
  const itemWeight = parseWeight(rawValue([
    "商品重量（单位换算）",
    "商品重量",
    "Product Weight",
  ]));
  const itemDimensions = parseDimensions(rawValue([
    "商品尺寸（单位换算）",
    "商品尺寸",
    "Product Dimensions",
  ]));
  const dateFirstAvailable = rawValue([
    "上架时间",
    "上架日期",
    "Date First Available",
    "Listing Date",
  ]);
  const buyboxSeller = rawValue([
    "Buybox卖家",
    "Buy Box Seller",
    "Buybox Seller",
    "Seller",
  ]);
  const fulfillmentType = rawValue([
    "配送方式",
    "Fulfillment",
    "Fulfillment Type",
  ]);
  const estimatedFbaFee = parseUsdAmount(rawValue([
    "预估FBA费",
    "Estimated FBA Fee",
    "FBA Fee",
    "FBA费用",
  ]));
  const estimatedGrossMargin = parseNumber(rawValue([
    "预估毛利率",
    "毛利率",
    "Gross Margin",
    "Estimated Gross Margin",
  ]));
  const listingQualityScore = parseNumber(rawValue([
    "LQS评分",
    "LQS Score",
    "Listing Quality Score",
  ]));

  return {
    launchedDate: dateFirstAvailable,
    dateFirstAvailable,
    buyboxSeller,
    fulfillmentType,
    packageWeight,
    packageDimensions,
    itemWeight,
    itemDimensions,
    estimatedFbaFee,
    estimatedGrossMargin,
    listingQualityScore,
    fieldMetadata: {
      packageWeight: extensionMetadata("packageWeight", ["包装重量（单位换算）", "包装重量", "Package Weight"], "snapshot"),
      packageDimensions: extensionMetadata("packageDimensions", ["包装尺寸（单位换算）", "包装尺寸", "Package Dimensions"], "snapshot"),
      itemWeight: extensionMetadata("itemWeight", ["商品重量（单位换算）", "商品重量", "Product Weight"], "snapshot"),
      itemDimensions: extensionMetadata("itemDimensions", ["商品尺寸（单位换算）", "商品尺寸", "Product Dimensions"], "snapshot"),
      dateFirstAvailable: extensionMetadata("dateFirstAvailable", ["上架时间", "上架日期", "Date First Available", "Listing Date"], "snapshot"),
      launchedDate: extensionMetadata("launchedDate", ["上架时间", "上架日期", "Date First Available", "Listing Date"], "snapshot"),
      buyboxSeller: extensionMetadata("buyboxSeller", ["Buybox卖家", "Buy Box Seller", "Buybox Seller", "Seller"], "snapshot"),
      fulfillmentType: extensionMetadata("fulfillmentType", ["配送方式", "Fulfillment", "Fulfillment Type"], "snapshot"),
      estimatedFbaFee: extensionMetadata("estimatedFbaFee", ["预估FBA费", "Estimated FBA Fee", "FBA Fee", "FBA费用"], "estimate"),
      estimatedGrossMargin: extensionMetadata("estimatedGrossMargin", ["预估毛利率", "毛利率", "Gross Margin", "Estimated Gross Margin"], "estimate"),
      listingQualityScore: extensionMetadata("listingQualityScore", ["LQS评分", "LQS Score", "Listing Quality Score"], "estimate"),
    },
    sellerSpriteRaw: {
      schemaVersion: "sellersprite-xlsx-raw.v1",
      sourceType: "sellersprite_xlsx",
      sourceFileSha256: input.snapshot.sourceFileSha256,
      rows: rawRows,
    },
  };
}

function matchingRawEntries(
  rows: ReadonlyArray<SellerSpriteRawRow>,
  aliases: readonly string[],
): Array<{ header: string; value: string }> {
  const aliasKeys = new Set(aliases.map(normalizeRawHeader));
  return rows.flatMap((row) => Object.entries(row.columns)
    .flatMap(([header, value]) => (
      aliasKeys.has(normalizeRawHeader(header))
      && typeof value === "string"
      && value.trim().length > 0
        ? [{ header, value: value.trim() }]
        : []
    )));
}

function exactRawHeader(
  rows: ReadonlyArray<SellerSpriteRawRow>,
  aliases: readonly string[],
): string | null {
  return matchingRawEntries(rows, aliases)[0]?.header ?? null;
}

/** 多行商品记录只有在值一致时才进入标准事实；冲突留在 raw 快照中并保持 missing。 */
function exactRawValue(
  rows: ReadonlyArray<SellerSpriteRawRow>,
  aliases: readonly string[],
): string | null {
  const values = [...new Set(matchingRawEntries(rows, aliases).map((entry) => entry.value))];
  return values.length === 1 ? values[0] : null;
}

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.replaceAll(",", "");
  const match = /-?(?:\d+(?:\.\d*)?|\.\d+)/u.exec(normalized);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseUsdAmount(value: string | null): { amount: number; currency: "USD" } | null {
  const amount = parseNumber(value);
  return amount === null ? null : { amount, currency: "USD" };
}

function parseWeight(value: string | null): { value: number; unit: "kg" | "lb" | "oz" } | null {
  if (!value) return null;
  const match = /(?:^|\s)(\d+(?:\.\d*)?|\.\d+)\s*(kg|kilograms?|lb|lbs?|pounds?|oz|ounces?)(?:\s|$)/iu.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const rawUnit = match[2].toLowerCase();
  const unit = rawUnit.startsWith("kg") || rawUnit.startsWith("kilogram")
    ? "kg"
    : rawUnit.startsWith("oz") || rawUnit.startsWith("ounce")
      ? "oz"
      : "lb";
  return { value: Math.round(amount * 1000) / 1000, unit };
}

function parseDimensions(value: string | null): {
  length: number;
  width: number;
  height: number;
  unit: "cm" | "in";
} | null {
  if (!value) return null;
  const unitMatch = /\b(cm|centimeters?|in|inch(?:es)?)\b/iu.exec(value);
  if (!unitMatch) return null;
  const numbers = value.match(/\d+(?:\.\d*)?|\.\d+/gu)?.map(Number) ?? [];
  if (numbers.length < 3 || numbers.slice(0, 3).some((item) => !Number.isFinite(item) || item < 0)) {
    return null;
  }
  const rawUnit = unitMatch[1].toLowerCase();
  return {
    length: Math.round(numbers[0] * 1000) / 1000,
    width: Math.round(numbers[1] * 1000) / 1000,
    height: Math.round(numbers[2] * 1000) / 1000,
    unit: rawUnit.startsWith("cm") ? "cm" : "in",
  };
}

function bsrValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "number" && Number.isSafeInteger(item));
    return typeof first === "number" ? first : null;
  }
  return null;
}

/**
 * 关键词只从「已存在的确定性语境」派生：商品 URL、品牌、类目。
 * 绝不调用模型生成关键词，也绝不猜测搜索词。
 */
function deriveKeywords(input: {
  productUrl: string | null;
  brand: string | null;
  rootCategory: string | null;
}): string[] {
  const keywords: string[] = [];
  if (input.brand) keywords.push(input.brand);
  if (input.rootCategory) keywords.push(input.rootCategory);
  if (input.productUrl) {
    try {
      const url = new URL(input.productUrl);
      const query = url.searchParams.get("k");
      if (query && query.trim()) keywords.push(query.trim());
    } catch {
      // URL 不合法时不派生关键词。
    }
  }
  return [...new Set(keywords)].slice(0, 10);
}

function collectImages(input: {
  records: ReadonlyArray<{
    asin: { normalized: string | null };
    rowNumber: number;
    extraRaw: Readonly<Record<string, string | null>>;
  }>;
  embedded: XlsxEmbeddedImageParseResult | null;
  asin: string;
}): string[] {
  const images: string[] = [];
  const matched = input.records.filter((record) => record.asin.normalized === input.asin);
  const rows = new Set(matched.map((record) => record.rowNumber));

  if (input.embedded) {
    for (const image of input.embedded.images) {
      if (!rows.has(image.rowNumber)) continue;
      if (!IMAGE_HEADERS.includes((image.columnHeader ?? "") as (typeof IMAGE_HEADERS)[number])) {
        continue;
      }
      images.push(`data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`);
    }
  }
  // 复用既有 precheck 已解析出的原始列值（图片列不是 v1 映射字段，保留在 extraRaw 中）。
  for (const record of matched) {
    for (const header of IMAGE_HEADERS) {
      const raw = record.extraRaw[header];
      if (typeof raw !== "string") continue;
      const value = raw.trim();
      if (!/^https:\/\//i.test(value)) continue;
      images.push(value);
    }
  }
  return [...new Set(images)].slice(0, 10);
}

function digest(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join(";")
    .slice(0, 400);
}

export function buildSellerSpriteMarketShareAttachment(input: {
  subjectKey: string;
  asin?: string | null;
  brandCr5Share: number | null;
  amazon1pShare: number | null;
  sellerMarketShare: number | null;
  sellerOriginDomesticRatio: number | null;
  brandConcentrationRows?: Array<{ brand: string; share: number }> | null;
  sellerConcentrationRows?: Array<{ seller: string; share: number }> | null;
  capturedAt: string;
  sourceUrl?: string | null;
  sourceFingerprint?: string | null;
}): SourceEvidenceAttachment {
  const safeAsin = (input.asin ?? "summary").replace(/[^a-zA-Z0-9]/g, "");
  const safeTime = input.capturedAt.replace(/[^a-zA-Z0-9]/g, "");
  const attachmentId = `ss_mkt_${safeAsin}_${safeTime}`;
  return buildSourceEvidenceAttachment({
    attachmentId,
    subjectKey: input.subjectKey,
    kind: "sellersprite_market_share_v1",
    sourceType: "sellersprite_xlsx",
    capturedAt: input.capturedAt,
    sourceUrl: input.sourceUrl ?? null,
    sourceFingerprint: input.sourceFingerprint ?? null,
    payload: {
      schema: "sellersprite-market-share-attachment.v1",
      asin: input.asin ?? null,
      brandCr5Share: input.brandCr5Share,
      amazon1pShare: input.amazon1pShare,
      sellerMarketShare: input.sellerMarketShare,
      sellerOriginDomesticRatio: input.sellerOriginDomesticRatio,
      brandConcentrationRows: input.brandConcentrationRows ?? [],
      sellerConcentrationRows: input.sellerConcentrationRows ?? [],
    },
  });
}

export const sellerSpriteAdapter = createSourceAdapter({
  sourceType: "sellersprite_xlsx",
  label: "SellerSprite 导出报表",
  adapterVersion: SELLERSPRITE_ADAPTER_VERSION,
  capture: captureSellerSpriteXlsx,
});

registerSourceAdapter(sellerSpriteAdapter);
