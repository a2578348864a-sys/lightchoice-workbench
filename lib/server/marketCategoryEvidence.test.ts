import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assessCategoryScope,
  buildCategoryEvidenceView,
  CATEGORY_EVIDENCE_BINDING_PARAM,
  listCategoryEvidenceSummaries,
  readCategoryEvidenceBinding,
  readCategoryEvidenceDetail,
} from "@/lib/server/marketCategoryEvidence";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { categoryMarketSubjectKey, type CategoryMarketCaptureBatch } from "@/lib/sourceLayer/categoryMarketCapture";

let storeDir = "";
const originalStoreDir = process.env.SOURCE_LAYER_STORE_DIR;

function estimate(value: number | null) {
  return { value, nature: "provider_estimate" as const };
}

function row(segment: string, overrides: Partial<Record<string, ReturnType<typeof estimate>>> = {}) {
  const base = {
    sampleProductCount: estimate(100),
    sampleBrandCount: estimate(33),
    sampleSellerCount: estimate(35),
    monthlyTotalSales: estimate(978_477),
    topMonthlyAverageSales: estimate(12_345),
    topMonthlyAverageRevenueUsd: estimate(234_567),
    averageReviewCount: estimate(1_234),
    averageRating: estimate(4.3),
    averageTopBsr: estimate(2_500),
    averageSellerCount: estimate(12),
    averagePriceUsd: estimate(19.99),
    fbaSellerSharePercent: estimate(72.5),
    amazonSellerSharePercent: estimate(8.1),
    fbmSellerSharePercent: estimate(19.4),
    productConcentrationPercent: estimate(41.2),
    brandConcentrationPercent: estimate(38.7),
    sellerConcentrationPercent: estimate(44.9),
    newProductCount: estimate(17),
    newProductSharePercent: estimate(12.3),
    totalProductCount: estimate(415_126),
    returnRatePercent: estimate(2.4),
  };
  return {
    segment: { value: segment, authority: "provider_derived" as const },
    ...base,
    ...overrides,
    warnings: [] as string[],
  };
}

function batchOf(input: {
  batchId: string;
  nodeId: string;
  label: string;
  capturedAt: string;
  rows: ReturnType<typeof row>[];
}): CategoryMarketCaptureBatch {
  return {
    schemaVersion: "category-market-capture-batch.v1",
    batchId: input.batchId,
    sourceType: "category",
    provider: "SellerSprite",
    marketplace: "US",
    query: input.label,
    category: { nodeId: input.nodeId, label: input.label, productCount: estimate(415_126) },
    capturedAt: input.capturedAt,
    sourceUrl: "https://www.sellersprite.com/v2/market-research",
    rowCount: input.rows.length,
    amazonConfirmed: false,
    rows: input.rows,
  };
}

async function seed(input: { nodeId: string; label: string; capturedAt: string; batchId: string; rows: ReturnType<typeof row>[] }) {
  const store = createEvidenceStore("owner:v1");
  const subjectKey = categoryMarketSubjectKey(input.nodeId);
  await store.appendCategoryMarketCapture!({
    subjectKey,
    batch: batchOf(input),
    operator: "owner:v1",
    now: new Date("2026-10-17T00:00:00.000Z"),
  });
  return subjectKey;
}

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), "category-evidence-test-"));
  process.env.SOURCE_LAYER_STORE_DIR = storeDir;
  await seed({
    nodeId: "1055398:284507",
    label: "Home & Kitchen:Kitchen & Dining",
    capturedAt: "2026-10-07T19:53:53.394Z",
    batchId: "category-aaaaaaaaaaaaaaaaaaaaaaaa",
    rows: [row("Thermoses"), row("Water Bottles")],
  });
  await seed({
    nodeId: "1055398:284507:510136",
    label: "Home & Kitchen:Kitchen & Dining:Storage & Organization",
    capturedAt: "2026-10-12T03:20:12.027Z",
    batchId: "category-111111111111111111111111",
    rows: [row("Kitchen Storage Bins")],
  });
  await seed({
    nodeId: "1055398:1063306:3733781",
    label: "Home & Kitchen:Furniture:Dining Room Furniture",
    capturedAt: "2026-10-17T16:22:47.741Z",
    batchId: "category-222222222222222222222222",
    rows: [row("Dining Chairs")],
  });
  await seed({
    nodeId: "3375251",
    label: "Sports & Outdoors",
    capturedAt: "2026-10-12T08:00:00.000Z",
    batchId: "category-bbbbbbbbbbbbbbbbbbbbbbbb",
    rows: [row("Resistance Bands")],
  });
});

afterAll(() => {
  if (originalStoreDir === undefined) delete process.env.SOURCE_LAYER_STORE_DIR;
  else process.env.SOURCE_LAYER_STORE_DIR = originalStoreDir;
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

describe("类目市场证据只读消费", () => {
  it("枚举类目主体并按采集时间倒序返回摘要", async () => {
    const summaries = await listCategoryEvidenceSummaries();
    const nodeIds = summaries.map((item) => item.nodeId);
    expect(nodeIds).toContain("3375251");
    expect(nodeIds).toContain("1055398:284507");
    expect(summaries.length).toBe(new Set(nodeIds).size);
    for (let index = 1; index < summaries.length; index += 1) {
      expect(summaries[index - 1]!.capturedAt >= summaries[index]!.capturedAt).toBe(true);
    }
    expect(summaries.every((item) => item.amazonConfirmed === false)).toBe(true);
  });

  it("读取详情时把每个指标标注为第三方估算，并保留缺失为 null", async () => {
    const detail = await readCategoryEvidenceDetail("market:US:category:1055398:284507");
    expect(detail).not.toBeNull();
    expect(detail!.label).toBe("Home & Kitchen:Kitchen & Dining");
    expect(detail!.rows).toHaveLength(2);
    const thermos = detail!.rows[0]!;
    expect(thermos.segment).toBe("Thermoses");
    expect(thermos.metrics.every((metric) => metric.nature === "provider_estimate")).toBe(true);
    const monthly = thermos.metrics.find((metric) => metric.key === "monthlyTotalSales");
    expect(monthly?.value).toBe(978_477);
    expect(monthly?.unit).toBe("count");
  });

  it("缺失指标不进入展示列表（保持未知，不补 0）", async () => {
    await seed({
      nodeId: "999001",
      label: "Partial Category",
      capturedAt: "2026-10-13T00:00:00.000Z",
      batchId: "category-cccccccccccccccccccccccc",
      rows: [row("Only Segment", { averageRating: estimate(null) })],
    });
    const detail = await readCategoryEvidenceDetail("market:US:category:999001");
    expect(detail).not.toBeNull();
    expect(detail!.rows[0]!.metrics.some((metric) => metric.key === "averageRating")).toBe(false);
    expect(detail!.rows[0]!.metrics.some((metric) => metric.key === "sampleProductCount")).toBe(true);
  });

  it("非法主体或站点不匹配时 fail-closed 返回 null", async () => {
    expect(await readCategoryEvidenceDetail("amazon:US:B000000001")).toBeNull();
    expect(await readCategoryEvidenceDetail("market:US:category:1055398", { marketplace: "UK" })).toBeNull();
    expect(await readCategoryEvidenceDetail("market:US:category:000000")).toBeNull();
  });

  it("未绑定时返回可绑定列表，不自动关联任何类目", async () => {
    const view = await buildCategoryEvidenceView({
      nicheDefinition: { kind: "keyword", label: "silicone baking mat", parameters: {} },
      marketplace: "US",
    });
    expect(view.status).toBe("not_linked");
    expect(view.linked).toBeNull();
    expect(view.available.length).toBeGreaterThanOrEqual(2);
  });

  it("显式绑定后返回该类目详情，且只返回被绑定的那一个", async () => {
    const view = await buildCategoryEvidenceView({
      nicheDefinition: {
        kind: "keyword",
        label: "silicone baking mat",
        parameters: { [CATEGORY_EVIDENCE_BINDING_PARAM]: "market:US:category:3375251" },
      },
      marketplace: "US",
      now: new Date("2026-10-17T00:00:00.000Z"),
    });
    expect(view.status).toBe("linked");
    expect(view.linked?.nodeId).toBe("3375251");
    expect(view.linked?.ageDays).toBe(4);
  });

  it("绑定的主体不存在时返回 linked_evidence_missing，且不自动改绑", async () => {
    const view = await buildCategoryEvidenceView({
      nicheDefinition: { parameters: { [CATEGORY_EVIDENCE_BINDING_PARAM]: "market:US:category:123456789" } },
      marketplace: "US",
    });
    expect(view.status).toBe("linked_evidence_missing");
    expect(view.linked).toBeNull();
  });

  it("只接受合法类目主体键，字符串相似不算绑定", async () => {
    expect(readCategoryEvidenceBinding({ parameters: { [CATEGORY_EVIDENCE_BINDING_PARAM]: "Home & Kitchen" } })).toBeNull();
    expect(readCategoryEvidenceBinding({ parameters: { [CATEGORY_EVIDENCE_BINDING_PARAM]: "market:US:category:abc" } })).toBeNull();
    expect(readCategoryEvidenceBinding({ parameters: {} })).toBeNull();
    expect(readCategoryEvidenceBinding(null)).toBeNull();
    expect(readCategoryEvidenceBinding({ parameters: { [CATEGORY_EVIDENCE_BINDING_PARAM]: "market:US:category:3375251" } }))
      .toBe("market:US:category:3375251");
  });

  it("同一主体多次采集只消费最新批次，不重复计入", async () => {
    const subjectKey = await seed({
      nodeId: "555001",
      label: "Repeat Category",
      capturedAt: "2026-10-01T00:00:00.000Z",
      batchId: "category-dddddddddddddddddddddddd",
      rows: [row("Old Segment")],
    });
    await seed({
      nodeId: "555001",
      label: "Repeat Category",
      capturedAt: "2026-10-15T00:00:00.000Z",
      batchId: "category-eeeeeeeeeeeeeeeeeeeeeeee",
      rows: [row("New Segment A"), row("New Segment B")],
    });
    const detail = await readCategoryEvidenceDetail(subjectKey);
    expect(detail?.batchId).toBe("category-eeeeeeeeeeeeeeeeeeeeeeee");
    expect(detail?.rows.map((item) => item.segment)).toEqual(["New Segment A", "New Segment B"]);
    const summaries = await listCategoryEvidenceSummaries();
    expect(summaries.filter((item) => item.nodeId === "555001")).toHaveLength(1);
  });
});

describe("类目证据与研究范围匹配校验（四级语义）", () => {
  // 「收纳盒」来源批次的近似事实：一级类目以 Home & Kitchen 为主，标题覆盖多种细分收纳用品。
  const BOX_SAMPLE = {
    categories: [
      "Home & Kitchen", "Home & Kitchen", "Home & Kitchen", "Kitchen & Dining", "Kitchen & Dining",
      "Home & Kitchen", "Baby", "Home & Kitchen", "Beauty & Personal Care", "Home & Kitchen",
    ],
    titles: [
      "Clothes Storage Bins with Lids",
      "Collapsible Fabric Storage Cubes Organizer",
      "Clear Plastic Storage Bin with Latching Gray Lid",
      "Pantry Organization and Storage Bins Kitchen Organizer",
      "Clear Plastic Storage Bins, Pantry Organizers Kitchen",
      "IRIS USA 4-Pack 55 Quart Clip Box with Latching Lid",
      "NaturalCozy Storage Baskets for Shelves Cotton Rope Woven",
      "Comforter Storage Bag 2-Pack Self Compression",
      "Makeup Organizer Bathroom Storage",
      "WYT Clear Storage Latch Bins, 6-Pack Storage Organizer Box",
    ],
  };

  it("同一一级目录但细分未被证实时，不得判定为匹配", () => {
    const result = assessCategoryScope({
      categoryLabel: "Home & Kitchen:Kitchen & Dining:Storage & Organization",
      sampleCategories: BOX_SAMPLE.categories,
      sampleTitles: BOX_SAMPLE.titles,
    });
    expect(result.evidenceTopCategory).toBe("Home & Kitchen");
    expect(result.sampleCategoryMatchCount).toBeGreaterThan(0);
    // 细分层级存在，但「Kitchen & Dining」命中率不足 → 只能到大类相关
    expect(result.level).toBe("category_related");
    expect(result.segments.map((segment) => segment.segment)).toEqual(["Kitchen & Dining", "Storage & Organization"]);
    const kitchen = result.segments.find((segment) => segment.segment === "Kitchen & Dining")!;
    expect(kitchen.supported).toBe(false);
    expect(result.reason).toMatch(/只有一级目录相交|不能认定/u);
  });

  it("同属 Home & Kitchen 的餐厅家具不得显示为已匹配", () => {
    const result = assessCategoryScope({
      categoryLabel: "Home & Kitchen:Furniture:Dining Room Furniture",
      sampleCategories: BOX_SAMPLE.categories,
      sampleTitles: BOX_SAMPLE.titles,
    });
    expect(result.level).not.toBe("range_matched");
    expect(result.level).toBe("category_related");
    expect(result.segments.every((segment) => !segment.supported)).toBe(true);
    expect(result.reason).toMatch(/只有一级目录相交/u);
  });

  it("类目只有一级目录时不构造精确匹配结果", () => {
    const result = assessCategoryScope({
      categoryLabel: "Home & Kitchen",
      sampleCategories: BOX_SAMPLE.categories,
      sampleTitles: BOX_SAMPLE.titles,
    });
    expect(result.level).toBe("category_related");
    expect(result.segments).toHaveLength(0);
    expect(result.reason).toMatch(/没有更细的层级|同属一级目录/u);
  });

  it("仅有标题命中、没有结构化类目路径时不得判定 range_matched", () => {
    const result = assessCategoryScope({
      categoryLabel: "Home & Kitchen:Kitchen & Dining:Storage & Organization",
      sampleCategories: ["Home & Kitchen", "Home & Kitchen", "Home & Kitchen", "Home & Kitchen"],
      sampleTitles: [
        "Kitchen Storage Bins Pantry Organization",
        "Kitchen Pantry Storage Organization Bins",
        "Kitchen Dining Storage Organizer Pantry",
        "Kitchen Pantry Organization Storage Bin",
      ],
    });
    // 标题词全部命中，但没有结构化类目路径 → 只能是大类相关
    expect(result.segments.every((segment) => segment.supported)).toBe(true);
    expect(result.level).toBe("category_related");
    expect(result.reason).toMatch(/仅作相关性提示|标题词相同不代表/u);
  });

  it("只有一级类目、标题大量命中也不得判定 range_matched", () => {
    const result = assessCategoryScope({
      categoryLabel: "Home & Kitchen:Kitchen & Dining:Storage & Organization",
      sampleCategories: ["Home & Kitchen", "Home & Kitchen", "Home & Kitchen", "Home & Kitchen"],
      sampleTitles: [
        "Kitchen Storage Bins", "Kitchen Storage Bins", "Kitchen Storage Bins", "Kitchen Storage Bins",
      ],
      sampleCategoryPaths: ["Home & Kitchen", "Home & Kitchen", "Home & Kitchen", "Home & Kitchen"],
    });
    expect(result.level).toBe("category_related");
  });

  it("结构化类目路径覆盖所选细分层级时才判定 range_matched", () => {
    const result = assessCategoryScope({
      categoryLabel: "Home & Kitchen:Kitchen & Dining:Storage & Organization",
      sampleCategories: ["Home & Kitchen", "Home & Kitchen"],
      sampleTitles: ["Clothes Storage Bins with Lids", "Pantry Organization and Storage Bins"],
      sampleCategoryPaths: [
        "Home & Kitchen:Kitchen & Dining",
        "Home & Kitchen:Kitchen & Dining:Storage & Organization",
      ],
    });
    expect(result.level).toBe("range_matched");
    expect(result.reason).toMatch(/结构化类目路径/u);
  });

  it("结构化类目路径只覆盖部分细分层级时仍不判定 range_matched", () => {
    const result = assessCategoryScope({
      categoryLabel: "Home & Kitchen:Kitchen & Dining:Storage & Organization",
      sampleCategories: ["Home & Kitchen", "Home & Kitchen"],
      sampleTitles: ["Kitchen Storage Bins", "Pantry Organization Bins"],
      sampleCategoryPaths: ["Home & Kitchen:Kitchen & Dining", "Home & Kitchen:Storage & Organization"],
    });
    // 两条路径各覆盖一部分，没有一条覆盖全部非首段 → 仍不判匹配
    expect(result.level).toBe("category_related");
  });

  it("一级类目不相交仍判定 possible_mismatch", () => {
    const result = assessCategoryScope({
      categoryLabel: "Automotive:Interior Accessories",
      sampleCategories: BOX_SAMPLE.categories,
      sampleTitles: BOX_SAMPLE.titles,
    });
    expect(result.level).toBe("possible_mismatch");
    expect(result.sampleCategoryTop).toBe("Home & Kitchen");
    expect(result.reason).toMatch(/没有交集/u);
  });

  it("类目信息缺失时保持 unknown，不凭空补充", () => {
    const noSample = assessCategoryScope({
      categoryLabel: "Home & Kitchen:Kitchen & Dining",
      sampleCategories: [null, "", null],
      sampleTitles: BOX_SAMPLE.titles,
    });
    expect(noSample.level).toBe("unknown");
    expect(noSample.segments).toHaveLength(0);

    const noLabel = assessCategoryScope({ categoryLabel: "", sampleCategories: ["Home & Kitchen"], sampleTitles: [] });
    expect(noLabel.level).toBe("unknown");
  });

  it("不提供标题时无法证实细分范围，退回 category_related", () => {
    const result = assessCategoryScope({
      categoryLabel: "Home & Kitchen:Kitchen & Dining:Storage & Organization",
      sampleCategories: BOX_SAMPLE.categories,
    });
    expect(result.level).toBe("category_related");
    expect(result.segments.every((segment) => !segment.supported)).toBe(true);
  });

  it("视图返回每个可选类目的范围评估，未绑定时 scopeAssessment 为 null；两个同大类的细分类目不会同时为匹配", async () => {
    const view = await buildCategoryEvidenceView({
      nicheDefinition: { kind: "keyword", label: "收纳盒", parameters: {} },
      marketplace: "US",
      sampleCategories: BOX_SAMPLE.categories,
      sampleTitles: BOX_SAMPLE.titles,
    });
    expect(view.status).toBe("not_linked");
    expect(view.scopeAssessment).toBeNull();
    const assessments = Object.values(view.availableScopeAssessments);
    expect(assessments.length).toBe(view.available.length);
    const storageEvidence = view.available.find((item) => item.label === "Home & Kitchen:Kitchen & Dining:Storage & Organization");
    const furnitureEvidence = view.available.find((item) => item.label === "Home & Kitchen:Furniture:Dining Room Furniture");
    expect(storageEvidence).toBeTruthy();
    expect(furnitureEvidence).toBeTruthy();
    const storageLevel = view.availableScopeAssessments[storageEvidence!.subjectKey]!.level;
    const furnitureLevel = view.availableScopeAssessments[furnitureEvidence!.subjectKey]!.level;
    expect(storageLevel).toBe("category_related");
    expect(furnitureLevel).toBe("category_related");
    expect(assessments.filter((item) => item.level === "range_matched").length)
      .toBeLessThan(assessments.filter((item) => item.level === "category_related").length);
  });
});

describe("异常指标不进入有效指标计算", () => {
  it("百分比超出 0–100 时保留原值但标记不可用", async () => {
    await seed({
      nodeId: "777001",
      label: "Anomaly Category",
      capturedAt: "2026-10-16T00:00:00.000Z",
      batchId: "category-ffffffffffffffffffffffff",
      rows: [row("Anomaly Segment", { productConcentrationPercent: estimate(350) })],
    });
    const detail = await readCategoryEvidenceDetail("market:US:category:777001");
    expect(detail).not.toBeNull();
    const metric = detail!.rows[0]!.metrics.find((item) => item.key === "productConcentrationPercent")!;
    expect(metric.value).toBe(350);
    expect(metric.usableForMetrics).toBe(false);
    expect(metric.anomaly).toBe("out_of_range_percent");
    expect(detail!.hasAnomalousMetrics).toBe(true);
  });

  it("正常百分比与计数不受影响", async () => {
    const detail = await readCategoryEvidenceDetail("market:US:category:1055398:284507");
    expect(detail!.hasAnomalousMetrics).toBe(false);
    const metrics = detail!.rows[0]!.metrics;
    expect(metrics.every((metric) => metric.usableForMetrics)).toBe(true);
    expect(metrics.every((metric) => metric.anomaly === null)).toBe(true);
    expect(metrics.every((metric) => metric.nature === "provider_estimate")).toBe(true);
  });
});
