import { describe, expect, it } from "vitest";
import { buildCompetitorComparison, parseTitlePackCount } from "./competitorComparison";

const missing = { presence: "missing" } as const;

function present<T>(value: T) {
  return { presence: "present", value } as const;
}

type FactOverrides = Record<string, unknown>;

function factValues(asin: string, overrides: FactOverrides = {}) {
  return {
    asin,
    title: missing,
    brand: missing,
    category: missing,
    price: { presence: "missing", valueSource: "FACT" } as const,
    rating: missing,
    reviewCount: missing,
    bsr: missing,
    launchedDate: missing,
    monthlySalesEstimate: { presence: "missing", valueSource: "PROVIDER_ESTIMATE" } as const,
    monthlyRevenueEstimate: { presence: "missing", valueSource: "PROVIDER_ESTIMATE" } as const,
    ...overrides,
  };
}

function snapshotItem(asin: string, overrides: FactOverrides = {}) {
  return {
    asin,
    subjectKey: `amazon:US:${asin}`,
    evidenceId: `evidence-${asin}`,
    evidenceVersion: 1,
    capturedAt: "2026-10-01T00:00:00.000Z",
    sourceType: "CAPTURE",
    factValues: factValues(asin, overrides),
  };
}

function representative(asin: string, role: string | null, note: string | null = null) {
  return { asin, subjectKey: `amazon:US:${asin}`, role, note };
}

function priceFact(amount: number, currency = "USD") {
  return { presence: "present", value: { amount, currency }, valueSource: "FACT" } as const;
}

describe("competitorComparison / 代表商品可比性投影", () => {
  it("1) 6 件装 $18 与 2 件装 $10 同品类：两行 comparable，每件单价 3 / 5", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-1",
      scanName: "Clear storage bins",
      representatives: [representative("B0AAA00001", "benchmark"), representative("B0BBB00002", "pain_point")],
      items: [
        snapshotItem("B0AAA00001", {
          title: present("Acme 6-Pack Clear Storage Bins with Lid"),
          category: present("Storage Bins"),
          price: priceFact(18),
          rating: present(4.2),
          reviewCount: present(13),
        }),
        snapshotItem("B0BBB00002", {
          title: present("Beta 2 pack Clear Storage Bins"),
          category: present("Storage Bins"),
          price: priceFact(10),
          rating: present(4.6),
          reviewCount: present(120),
        }),
      ],
    });

    expect(comparison.rows).toHaveLength(2);
    for (const row of comparison.rows) {
      expect(row.comparability.level).toBe("comparable");
      expect(row.comparability.reason).toContain("同品类且包装数量已知");
    }
    expect(comparison.rows[0].packCount).toEqual({ value: 6, source: "title", raw: "6-Pack" });
    expect(comparison.rows[0].unitPrice).toEqual({ amount: 3, currency: "USD", unitLabel: "每件" });
    expect(comparison.rows[1].unitPrice).toEqual({ amount: 5, currency: "USD", unitLabel: "每件" });
    expect(comparison.rows[0].missing).not.toContain("price");
    expect(comparison.rows[0].missing).not.toContain("packCount");
  });

  it("2) 标题无包装数量：全部 unknown，每件单价全为 null，missing 含 packCount", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-2",
      scanName: "Bins without pack count",
      representatives: [representative("B0AAA00001", "benchmark"), representative("B0BBB00002", "newcomer")],
      items: [
        snapshotItem("B0AAA00001", {
          title: present("Clear Storage Bins with Lid"),
          category: present("Storage Bins"),
          price: priceFact(18),
        }),
        snapshotItem("B0BBB00002", {
          title: present("Clear Storage Bins, Large"),
          category: present("Storage Bins"),
          price: priceFact(10),
        }),
      ],
    });

    for (const row of comparison.rows) {
      expect(row.packCount).toBeNull();
      expect(row.unitPrice).toBeNull();
      expect(row.missing).toContain("packCount");
      expect(row.comparability.level).toBe("unknown");
      expect(row.comparability.reason).toContain("缺包装数量，无法计算每件单价");
    }
    expect(comparison.limitations.some((item) => item.includes("包装数量") && item.includes("1 件兜底"))).toBe(true);
  });

  it("3) 收纳袋 vs 塑料收纳箱（品类不同）：spec_differs，不给每件单价排序结论", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-3",
      scanName: "Mixed categories",
      representatives: [representative("B0AAA00001", "benchmark"), representative("B0BBB00002", "pain_point")],
      items: [
        snapshotItem("B0AAA00001", {
          title: present("Acme 6-Pack Storage Bags"),
          category: present("Storage Bags"),
          price: priceFact(18),
        }),
        snapshotItem("B0BBB00002", {
          title: present("Beta 2 pack Plastic Storage Bins"),
          category: present("Storage Bins"),
          price: priceFact(10),
        }),
      ],
    });

    for (const row of comparison.rows) {
      expect(row.comparability.level).toBe("spec_differs");
      expect(row.comparability.reason).toContain("品类或规格口径不同");
      expect(row.unitPrice).toBeNull();
    }
    expect(comparison.limitations.some((item) => item.includes("品类不一致") || item.includes("品类不同"))).toBe(true);
  });

  it("4) 价格 presence=missing：price 为 null、missing 含 price，绝不填 0", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-4",
      scanName: "Missing price",
      representatives: [representative("B0AAA00001", "benchmark"), representative("B0BBB00002", "benchmark")],
      items: [
        snapshotItem("B0AAA00001", {
          title: present("Acme 6-Pack Storage Bins"),
          category: present("Storage Bins"),
          price: { presence: "missing", valueSource: "FACT" },
        }),
        snapshotItem("B0BBB00002", {
          title: present("Beta 2 pack Storage Bins"),
          category: present("Storage Bins"),
          price: priceFact(10),
        }),
      ],
    });

    const noPrice = comparison.rows[0];
    expect(noPrice.price).toBeNull();
    expect(noPrice.missing).toContain("price");
    expect(noPrice.unitPrice).toBeNull();
    expect(noPrice.comparability.level).toBe("unknown");
    expect(noPrice.comparability.reason).toContain("缺价格");
    // 整组都无法计算每件单价
    for (const row of comparison.rows) expect(row.unitPrice).toBeNull();
  });

  it("5) 中文标题「4件装」可解析，标注来源 title", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-5",
      scanName: "中文包装数量",
      representatives: [representative("B0AAA00001", "benchmark")],
      items: [
        snapshotItem("B0AAA00001", {
          title: present("收纳袋 4件装 透明"),
          category: present("收纳袋"),
          price: priceFact(20, "CNY"),
        }),
      ],
    });

    expect(comparison.rows[0].packCount).toEqual({ value: 4, source: "title", raw: "4件装" });
    expect(comparison.rows[0].specs).toContainEqual({ label: "件数", value: "4件装", source: "title" });
    expect(comparison.rows[0].unitPrice).toEqual({ amount: 5, currency: "CNY", unitLabel: "每件" });
  });

  it("5b) 白名单包装数量模式：6-Pack / 2 pack / Set of 4 / (4 pack) / 4只装", () => {
    expect(parseTitlePackCount("Organizer 6-Pack")?.value).toBe(6);
    expect(parseTitlePackCount("Organizer 2 pack")?.value).toBe(2);
    expect(parseTitlePackCount("Organizer, Set of 4")?.value).toBe(4);
    expect(parseTitlePackCount("Organizer (4 pack)")?.value).toBe(4);
    expect(parseTitlePackCount("收纳盒 4只装")?.value).toBe(4);
    expect(parseTitlePackCount("Organizer 2 Packs")?.value).toBe(2);
    // 冲突信号 → 保守返回 null，不任选一个
    expect(parseTitlePackCount("Organizer Set of 2 (6 Pack)")).toBeNull();
    // 无数量词 → null，禁止默认 1 件
    expect(parseTitlePackCount("Organizer with Lid")).toBeNull();
    expect(parseTitlePackCount(null)).toBeNull();
  });

  it("6) 角色排序 benchmark → pain_point → newcomer", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-6",
      scanName: "Role order",
      representatives: [
        representative("B0NEW00003", "newcomer"),
        representative("B0BEN00001", "benchmark"),
        representative("B0PAIN0002", "pain_point"),
      ],
      items: [
        snapshotItem("B0NEW00003", { title: present("Newcomer 1 Pack Bin"), price: priceFact(9) }),
        snapshotItem("B0BEN00001", { title: present("Benchmark 1 Pack Bin"), price: priceFact(18) }),
        snapshotItem("B0PAIN0002", { title: present("Pain 1 Pack Bin"), price: priceFact(12) }),
      ],
    });

    expect(comparison.rows.map((row) => row.asin)).toEqual(["B0BEN00001", "B0PAIN0002", "B0NEW00003"]);
    expect(comparison.roleCoverage).toEqual(["benchmark", "pain_point", "newcomer"]);
    expect(comparison.rows.map((row) => row.roleLabel)).toEqual(["基准商品", "痛点样本", "新进入者"]);
    expect(comparison.representativesSelected).toBe(true);
  });

  it("7) 无代表商品：rows 为空、representativesSelected=false、limitations 有说明", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-7",
      scanName: "No representatives",
      representatives: [],
      items: [snapshotItem("B0AAA00001", { title: present("Unused 6-Pack Bin"), price: priceFact(18) })],
    });

    expect(comparison.rows).toEqual([]);
    expect(comparison.representativesSelected).toBe(false);
    expect(comparison.roleCoverage).toEqual([]);
    expect(comparison.differences).toEqual([]);
    expect(comparison.limitations.some((item) => item.includes("未选择代表商品"))).toBe(true);
    expect(comparison.limitations.some((item) => item.includes("rows 为空"))).toBe(true);
  });

  it("8) differences 只包含有事实的维度，不出现竞争力评分类文本", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-8",
      scanName: "Fact-only differences",
      representatives: [representative("B0AAA00001", "benchmark"), representative("B0BBB00002", "pain_point")],
      items: [
        snapshotItem("B0AAA00001", {
          title: present("Acme 6-Pack Clear Storage Bins"),
          category: present("Storage Bins"),
          price: priceFact(18),
          rating: present(4.2),
          reviewCount: present(13),
        }),
        snapshotItem("B0BBB00002", {
          title: present("Beta 2 pack Clear Storage Bins"),
          category: present("Storage Bins"),
          price: priceFact(10),
          rating: present(4.6),
          reviewCount: present(120),
        }),
      ],
    });

    expect(comparison.differences.map((item) => item.dimension).sort()).toEqual(["价格", "包装数量", "评分"].sort());
    const allText = comparison.differences.map((item) => item.summary).join(" ");
    expect(allText).not.toMatch(/竞争力评分|综合评分|推荐指数|打分|综合得分/);
    const priceDiff = comparison.differences.find((item) => item.dimension === "价格");
    expect(priceDiff?.summary).toBe("价格区间 $10–$18（2 件）");
    expect(comparison.differences.some((item) => item.dimension === "容量")).toBe(false);
  });

  it("9) 无 role 的代表商品被丢弃，不猜测角色", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-9",
      scanName: "Role missing",
      representatives: [representative("B0AAA00001", null), representative("B0BBB00002", "benchmark")],
      items: [
        snapshotItem("B0AAA00001", { title: present("No Role 6-Pack Bin"), price: priceFact(18) }),
        snapshotItem("B0BBB00002", { title: present("Benchmark 1 Pack Bin"), price: priceFact(12) }),
      ],
    });

    expect(comparison.rows).toHaveLength(1);
    expect(comparison.rows[0].asin).toBe("B0BBB00002");
    expect(comparison.representativesSelected).toBe(true);
  });

  it("10) 标题包装数量信号冲突：packCount 为 null 且计入 missing", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-10",
      scanName: "Ambiguous pack count",
      representatives: [representative("B0AAA00001", "benchmark")],
      items: [
        snapshotItem("B0AAA00001", {
          title: present("Acme Set of 2 (6 Pack) Storage Bins"),
          category: present("Storage Bins"),
          price: priceFact(18),
        }),
      ],
    });

    expect(comparison.rows[0].packCount).toBeNull();
    expect(comparison.rows[0].missing).toContain("packCount");
    expect(comparison.rows[0].unitPrice).toBeNull();
    expect(comparison.rows[0].comparability.level).toBe("unknown");
  });

  it("11) 代表商品无对应样本快照：字段全部按缺失处理，不推测", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-11",
      scanName: "Snapshot missing",
      representatives: [representative("B0AAA00001", "benchmark")],
      items: [],
    });

    const row = comparison.rows[0];
    expect(row.price).toBeNull();
    expect(row.title).toBeNull();
    expect(row.category).toBeNull();
    expect(row.rating).toBeNull();
    expect(row.reviewCount).toBeNull();
    expect(row.capturedAt).toBeNull();
    expect(row.missing).toEqual(
      expect.arrayContaining(["title", "brand", "category", "price", "rating", "reviewCount", "bsr", "packCount"]),
    );
    expect(comparison.limitations.some((item) => item.includes("没有对应的样本快照事实"))).toBe(true);
  });

  it("12) 容量不同但品类/包装一致：仍按每件比较，同时列出容量差异与限制", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-12",
      scanName: "Capacity difference",
      representatives: [representative("B0AAA00001", "benchmark"), representative("B0BBB00002", "newcomer")],
      items: [
        snapshotItem("B0AAA00001", {
          title: present("Acme 18 qt Storage Bin (1 Pack)"),
          category: present("Storage Bins"),
          price: priceFact(20),
        }),
        snapshotItem("B0BBB00002", {
          title: present("Beta 6 qt Storage Bin (1 Pack)"),
          category: present("Storage Bins"),
          price: priceFact(15),
        }),
      ],
    });

    for (const row of comparison.rows) {
      expect(row.comparability.level).toBe("comparable");
      expect(row.unitPrice?.amount).toBe(row.price?.amount);
    }
    const capacityDiff = comparison.differences.find((item) => item.dimension === "容量");
    expect(capacityDiff?.summary).toBe("容量 18 qt vs 6 qt");
    expect(comparison.limitations.some((item) => item.includes("未覆盖容量差异"))).toBe(true);
  });

  it("13) 币种不同：spec_differs，不给出跨币种每件单价", () => {
    const comparison = buildCompetitorComparison({
      scanId: "scan-13",
      scanName: "Currency mismatch",
      representatives: [representative("B0AAA00001", "benchmark"), representative("B0BBB00002", "pain_point")],
      items: [
        snapshotItem("B0AAA00001", {
          title: present("Acme 6-Pack Storage Bins"),
          category: present("Storage Bins"),
          price: priceFact(18, "USD"),
        }),
        snapshotItem("B0BBB00002", {
          title: present("Beta 2 pack Storage Bins"),
          category: present("Storage Bins"),
          price: priceFact(70, "CNY"),
        }),
      ],
    });

    for (const row of comparison.rows) {
      expect(row.comparability.level).toBe("spec_differs");
      expect(row.unitPrice).toBeNull();
    }
  });
});
