import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketResearchReport } from "@/components/market-analysis/MarketResearchReport";
import { EvidenceList, buildEvidenceLookup } from "@/components/market-analysis/MarketReportEvidence";
import type { MarketCitation, MarketIntelligence, MarketIntelligenceReport } from "@/lib/marketScan/intelligence";

function makeCitation(id: string, subjectKey: string, nature: string, capturedAt = "2026-10-20T08:00:00.000Z"): MarketCitation {
  return {
    id,
    subjectKey,
    evidenceId: id,
    contentHash: `hash-${id}`,
    version: 1,
    capturedAt,
    sourceUrl: null,
    nature,
  };
}

function buildBaseIntelligence(overrides: Partial<MarketIntelligence> = {}): MarketIntelligence {
  return {
    schema: "market-intelligence.v1",
    scanId: "scan-test-1",
    scanName: "silicone baking mat",
    marketplace: "US",
    sampleHash: "sample-hash-1",
    inputHash: "input-hash-1",
    resourceVersion: "v1",
    observedAt: "2026-10-23T10:00:00.000Z",
    research: { keyword: "silicone baking mat", sourceBatchId: "batch-1", captureEnabled: true },
    queryBindings: ["sellersprite:keyword_mining:us:silicone_baking_mat"],
    bindingCandidates: [],
    limitations: [],
    provider: { ready: true, code: "READY", message: "DeepSeek 已就绪" },
    samples: [
      {
        subjectKey: "asin:US:B0CFTP6JR4",
        asin: "B0CFTP6JR4",
        title: "Silicone Baking Mat Set of 2",
        brand: "Velesco",
        price: 9.99,
        priceCurrency: "USD",
        rating: 4.6,
        reviewCount: 681,
        monthlySalesEstimate: null,
        bsr: 120,
        valid: true,
        evidence: makeCitation("ev-sample-1", "asin:US:B0CFTP6JR4", "source_observed", "2026-10-14T08:00:00.000Z"),
      },
      {
        subjectKey: "asin:US:B0CWPNBC4Z",
        asin: "B0CWPNBC4Z",
        title: "Unknown Brand Mat",
        brand: null,
        price: null,
        priceCurrency: "USD",
        rating: null,
        reviewCount: null,
        monthlySalesEstimate: null,
        bsr: null,
        valid: true,
        evidence: makeCitation("ev-sample-2", "asin:US:B0CWPNBC4Z", "source_observed", "2026-10-14T08:00:00.000Z"),
      },
    ],
    reviews: [
      {
        id: "rev-1",
        subjectKey: "asin:US:B0CFTP6JR4",
        subjectKeys: ["asin:US:B0CFTP6JR4"],
        rating: 2,
        title: "Too large for my pan",
        text: "The mat curls up on the edges of my half sheet pan.",
        evidence: makeCitation("ev-rev-1", "asin:US:B0CFTP6JR4", "review_observation", "2026-10-20T08:00:00.000Z"),
      },
    ],
    keywords: [
      {
        keyword: "silicone baking mat 硅胶烘焙垫",
        subjectKey: "sellersprite:keyword_mining:us:silicone_baking_mat",
        module: "keyword_mining_trend",
        searchVolume: 77947,
        observedAt: "2026-10-23T05:00:00.000Z",
        metrics: {
          searchVolumeGrowth: { value: 0.0886, unit: "percent", metricNature: "provider_estimate" },
        },
        evidence: makeCitation("ev-kw-1", "sellersprite:keyword_mining:us:silicone_baking_mat", "provider_estimate", "2026-10-23T05:00:00.000Z"),
      },
    ],
    productSignals: [],
    productMarkets: [],
    trends: [],
    variations: [],
    category: null,
    sources: [],
    evidenceChanges: [],
    translations: {
      "review:rev-1": {
        text: "垫子对我的烤盘来说太大了，边缘会卷起。",
        model: "deepseek-flash",
        generatedAt: "2026-10-23T06:00:00.000Z",
        originalHash: "h1",
      },
    },
    reports: [],
    statistics: {
      schema: "market-intelligence-stats.v1",
      hash: "stats-hash-1234567890",
      rawCount: 35,
      uniqueCount: 34,
      technicallyValidCount: 34,
      sampleCount: 34,
      excludedCount: 0,
      subjects: ["asin:US:B0CFTP6JR4", "asin:US:B0CWPNBC4Z"],
      evidenceRefs: ["ev-sample-1", "ev-sample-2"],
      timeRange: { from: "2026-10-14T08:00:00.000Z", to: "2026-10-23T05:00:00.000Z" },
      prices: [{ currency: "USD", denominator: 34, min: 5.99, max: 29.99, median: 14.44, bins: [{ label: "$10-$15", count: 14 }], subjects: [] }],
      rating: { denominator: 34, mean: 4.6, bins: [{ label: "4.5-4.7", count: 20 }] },
      reviewCount: { denominator: 34, median: 228.5, bins: [{ label: "100-500", count: 12 }], lockedCount: 34, verifiedCount: 34, conflictCount: 0, unverifiedCount: 0, unclassifiedCount: 0, conflicts: [], unverifiedSubjects: [], policy: "fixture" },
      brands: { basis: "known_brand_product_count", denominator: 20, missing: 14, coverage: 20 / 34, rows: [{ brand: "Velesco", count: 3, share: 3 / 20 }] },
      reviews: { total: 129, rated: 129, lowStars: 6, highStars: 123, bins: [{ label: "2星", count: 2 }], policy: "fixture" },
      voc: [{ id: "fit", label: "尺寸或适配问题", count: 2, denominator: 129, productCount: 2, reviewIds: ["rev-1"], nature: "calculation", method: "phrase_rule" }],
      keywords: {
        rows: 20, withSearchVolume: 15, policy: "single_snapshot",
        market: { rows: 12, withSearchVolume: 9, withMonthlyPurchase: 0, subjects: ["sellersprite:US:keyword-mining:fixture"] },
        competitorTraffic: { rows: 8, withTrafficShare: 8, withSearchVolume: 6, subjects: ["asin:US:B0CFTP6JR4"] },
        unclassified: 0, separationPolicy: "separate_datasets",
      },
      modules: [],
    },
    ...overrides,
  };
}

function buildV3Report(overrides: Partial<MarketIntelligenceReport> = {}): MarketIntelligenceReport {
  return {
    id: "rep-v3-1",
    schema: "market-intelligence-report.v3",
    generatedAt: "2026-10-23T10:33:00.000Z",
    model: "deepseek-flash",
    configuredModel: "deepseek-v4-flash",
    inputHash: "input-hash-1",
    summary: { text: "样本标价集中但品牌覆盖不完整", nature: "calculation", citations: ["ev-sample-1"] },
    opportunities: [],
    risks: [],
    unknowns: [],
    actions: [],
    judgment: {
      text: "样本标价集中在 10–20 美元，但 14/34 款商品品牌未知且无销量权重，暂不能判断真实市场集中度。",
      canJudge: "34 款样本的价格区间、评分分布及 60 条抽样评论中的主要尺寸/清洁痛点。",
      cannotJudge: "全市场销量份额、CR5 及长期需求增长趋势。",
      nature: "calculation",
      citations: ["ev-sample-1"],
    },
    findings: [
      {
        title: "品牌证据覆盖率为 58.82%",
        section: "competition",
        what: "34 款样本中 20 款有已校验品牌，14 款未知。",
        why: "缺失品牌会影响头部集中度判断。",
        basis: "20/34 款商品详情具备有效品牌字段。",
        limits: ["商品数占比不等于销量份额"],
        nature: "calculation",
        citations: ["ev-sample-1"],
      },
    ],
    riskGaps: [
      {
        title: "缺少销量权重与历史时间序列",
        text: "单次快照无法区分季节性与长期增长。",
        gap: "无 Keepa 历史序列与月销权重。",
        impact: "影响市场规模与趋势判断。",
        nature: "unknown",
        citations: ["ev-kw-1"],
      },
    ],
    productOpportunities: [
      {
        title: "标准烤盘内径精确适配标注",
        buyerProblem: "买家抱怨垫子尺寸偏大导致边缘卷曲。",
        scenario: "家用半盘烤箱烘焙场景。",
        hypothesis: "明确标注适配烤盘内径尺寸并优化裁切公差。",
        unverified: ["不同品牌烤盘内径公差分布", "模具改造成本"],
        citations: ["ev-rev-1"],
      },
    ],
    nextActions: [
      {
        question: "那 14 款品牌未知商品的真实品牌与规格是什么？",
        neededEvidence: "补齐 14 款商品的 Amazon 详情页快照。",
        howToVerify: "运行商品详情补证并核验 brand 字段。",
        doneWhen: "34 款正式样本品牌已知率达到 90% 以上。",
        citations: ["ev-sample-2"],
      },
    ],
    workspaces: {
      overview: { status: "assessed", reason: "已评估", summary: { text: "总览就绪", nature: "calculation", citations: ["ev-sample-1"] }, limits: ["样本无销量权重"] },
      competition: { status: "assessed", reason: "已评估", summary: { text: "价格集中在中低价位，品牌分散", nature: "calculation", citations: ["ev-sample-1"] }, limits: ["CR5 不可计算"] },
      demand: { status: "insufficient", reason: "仅单次快照，无历史时间序列", summary: { text: "种子词有第三方搜索量估算，但缺长期序列", nature: "estimate", citations: ["ev-kw-1"] }, limits: ["第三方估算不可相加"] },
      voice: { status: "assessed", reason: "已评估", summary: { text: "60 条输入评论中 15 条命中具体痛点或认可主题", nature: "inference", citations: ["ev-rev-1"] }, limits: ["低星优先非随机子集"] },
      comparison: { status: "assessed", reason: "已评估", summary: { text: "对比商品在套装标价与规格完整度上存在差异", nature: "fact", citations: ["ev-sample-1"] }, limits: ["套装未拆单件价"] },
    },
    voiceCoverage: {
      sampled: 60,
      available: 129,
      lowStarSampled: 6,
      themed: 15,
      noMatch: 45,
      unable: 0,
      sampledProducts: 11,
      samplePolicy: "low_star_first_non_random_subset",
    },
    voiceThemes: [
      {
        id: "theme_size",
        label: "尺寸偏大不适配烤盘",
        sentiment: "negative",
        reviewCount: 1,
        productCount: 1,
        statement: { text: "部分买家反馈烘焙垫尺寸大于标准烤盘内径。", nature: "fact", citations: ["ev-rev-1"] },
        scenario: "家用烤箱半盘烘焙",
        hypothesis: "产品外径按外沿而非烤盘底部内径设计",
        improvement: "提供精确内径尺寸对照图",
        verification: ["核实 Top 10 烤盘内径规格"],
        reviewIds: ["rev-1"],
      },
    ],
    reviewResults: [
      { reviewId: "rev-1", status: "themed", themeIds: ["theme_size"] },
    ],
    comparisonSubjects: ["asin:US:B0CFTP6JR4", "asin:US:B0CWPNBC4Z"],
    comparisonDifferences: [
      { dimension: "价格与规格完整度", text: "B0CFTP6JR4 标价 $9.99，B0CWPNBC4Z 缺失价格与品牌。", citations: ["ev-sample-1", "ev-sample-2"] },
    ],
    comparisonItems: [
      {
        subjectKey: "asin:US:B0CFTP6JR4",
        advantages: ["评分 4.6 且有 681 条评论基础"],
        limitations: ["存在尺寸偏大反馈"],
        unknowns: ["单件实测厚度未知"],
        citations: ["ev-sample-1"],
      },
    ],
    ...overrides,
  };
}

describe("02 市场研究视觉层级与异常/边界状态渲染", () => {
  it("1. 尚无 AI 报告时，展示清晰空状态与生成入口", () => {
    const data = buildBaseIntelligence({ reports: [] });
    const html = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "研究总览",
        report: undefined,
        reportId: "",
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: ["asin:US:B0CFTP6JR4"],
      }),
    );
    expect(html).toContain("尚未生成真实市场报告");
    expect(html).toContain("生成整份研究报告");
  });

  it("2. 已有 v3 报告时，五个工作区按各自任务结构展示同一份报告", () => {
    const report = buildV3Report();
    const data = buildBaseIntelligence({ reports: [report] });

    const overviewHtml = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "研究总览",
        report,
        reportId: report.id,
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: report.comparisonSubjects!,
      }),
    );
    expect(overviewHtml).toContain("当前判断");
    expect(overviewHtml).toContain("可以判断：");
    expect(overviewHtml).toContain("暂不能判断：");
    expect(overviewHtml).toContain("最值得关注的发现");
    expect(overviewHtml).toContain("哪些判断现在不能当作事实");
    expect(overviewHtml).toContain("哪些改进方向值得进一步验证");
    expect(overviewHtml).toContain("按优先级，先核实什么");

    const demandHtml = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "关键词与需求",
        report,
        reportId: report.id,
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: report.comparisonSubjects!,
      }),
    );
    expect(demandHtml).toContain("证据受限");
    expect(demandHtml).toContain("仅单次快照，无历史时间序列");

    const voiceHtml = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "买家声音",
        report,
        reportId: report.id,
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: report.comparisonSubjects!,
      }),
    );
    expect(voiceHtml).toContain("主题导航（60 条输入子集）");
    expect(voiceHtml).toContain("尺寸偏大不适配烤盘");
    expect(voiceHtml).toContain("垫子对我的烤盘来说太大了，边缘会卷起。");
    expect(voiceHtml).toContain("逐条核对本次输入 1 条评论的处理结果");
  });

  it("3. 历史旧版报告存在时，显示旧版兼容说明，不伪装成 v3", () => {
    const legacyReport: MarketIntelligenceReport = {
      id: "rep-legacy-v2",
      schema: "market-intelligence-report.v2",
      generatedAt: "2026-10-22T10:00:00.000Z",
      model: "deepseek-flash",
      inputHash: "input-hash-1",
      summary: { text: "旧版总览段落", nature: "inference", citations: ["ev-sample-1"] },
      opportunities: [],
      risks: [],
      unknowns: [],
      actions: [],
    };
    const data = buildBaseIntelligence({ reports: [legacyReport] });
    const html = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "研究总览",
        report: legacyReport,
        reportId: legacyReport.id,
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: [],
      }),
    );
    expect(html).toContain("该报告为结构化改造前的旧版（v2 五区段落）");
    expect(html).toContain("旧版总览段落");
  });

  it("4 & 5. 证据更新导致报告过期、或临时对比集合与报告记录不一致时，显示明确提示", () => {
    const report = buildV3Report({ inputHash: "old-input-hash" });
    const data = buildBaseIntelligence({ reports: [report] });
    const staleHtml = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "研究总览",
        report,
        reportId: report.id,
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: report.comparisonSubjects!,
      }),
    );
    expect(staleHtml).toContain("研究证据已变化，当前显示的是历史报告，不能当作当前版本的新结论。");

    const freshReport = buildV3Report({ inputHash: "input-hash-1" });
    const mismatchHtml = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data: buildBaseIntelligence({ reports: [freshReport] }),
        active: "商品对比",
        report: freshReport,
        reportId: freshReport.id,
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: ["asin:US:B0CFTP6JR4"],
      }),
    );
    expect(mismatchHtml).toContain("当前临时对比的商品集合与报告记录不同");
    expect(mismatchHtml).toContain("当前临时对比集合（B0CFTP6JR4）已变化");
  });

  it("6 & 7. 付费 AI 已成功返回但保存失败时显示不重复计费保存入口；证据卡片分层展示可读内容与未知字段", () => {
    const data = buildBaseIntelligence({
      recoverableReport: {
        id: "rec-1",
        inputHash: "input-hash-1",
        generatedAt: "2026-10-23T11:00:00.000Z",
        model: "deepseek-flash",
        reason: "CAS_CONFLICT",
        stale: false,
        comparisonSubjects: ["asin:US:B0CFTP6JR4"],
      },
    });
    const recoveryHtml = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "研究总览",
        report: undefined,
        reportId: "",
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: ["asin:US:B0CFTP6JR4"],
      }),
    );
    expect(recoveryHtml).toContain("保存已生成的报告（不重复计费）");
    expect(recoveryHtml).toContain("不会再次计费");

    const lookup = buildEvidenceLookup(data);
    const evidenceHtml = renderToStaticMarkup(
      React.createElement(EvidenceList, {
        ids: ["ev-sample-2", "ev-rev-1", "ev-kw-1"],
        data,
        lookup,
        supports: "核对未知字段与中文译文",
        limits: ["低星优先非随机子集"],
      }),
    );
    expect(evidenceHtml).toContain("品牌未知");
    expect(evidenceHtml).toContain("垫子对我的烤盘来说太大了，边缘会卷起。");
    expect(evidenceHtml).toContain("搜索量 77,947");
  });

  it("8. 研究总览在有与无正式代表商品时分别正确展示实物缩略预览条与未保存提示", () => {
    const report = buildV3Report();
    const data = buildBaseIntelligence({
      reports: [report],
      productDetails: [
        {
          subjectKey: "asin:US:B0CFTP6JR4",
          facts: {
            title: "Velesco Baking Mat",
            brand: "Velesco",
            imageUrl: "https://m.media-amazon.com/images/I/71example.jpg",
            bulletPoints: [],
            conflicts: [],
          } as any,
          evidence: makeCitation("ev-detail-1", "asin:US:B0CFTP6JR4", "source_observed"),
          supplementalEvidence: [],
        },
      ],
    });

    // 1) 无正式代表商品时：显示未保存提示徽章，使用报告对比商品预览
    const unsavedHtml = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "研究总览",
        report,
        reportId: report.id,
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: report.comparisonSubjects!,
        savedRepresentatives: [],
      }),
    );
    expect(unsavedHtml).toContain("对比样本预览，尚未保存为正式代表");
    expect(unsavedHtml).toContain("data-preview-mode=\"comparison_preview\"");
    expect(unsavedHtml).toContain("B0CFTP6JR4");

    // 2) 有已保存正式代表商品时：展示正式代表商品，不展示未保存黄色提示徽章
    const savedHtml = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "研究总览",
        report,
        reportId: report.id,
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: report.comparisonSubjects!,
        savedRepresentatives: [
          {
            marketSampleKey: "scan-test-1:B0CFTP6JR4",
            asin: "B0CFTP6JR4",
            subjectKey: "asin:US:B0CFTP6JR4",
            role: "benchmark",
            note: "核心标杆",
          },
        ],
      }),
    );
    expect(savedHtml).toContain("已保存 1 款正式代表商品");
    expect(savedHtml).toContain("data-preview-mode=\"saved_representatives\"");
    expect(savedHtml).toContain("标杆竞品");
    expect(savedHtml).not.toContain("对比样本预览，尚未保存为正式代表");
  });

  it("9. 买家声音中主题动态显示输入条数、关联商品缩略图以及跨商品/变体口径差异提示", () => {
    // 构造一条主题：reviewIds 关联到 2 款商品，但 theme.productCount 记录为 1（存在跨商品或变体差异）
    const report = buildV3Report({
      voiceCoverage: {
        sampled: 48,
        available: 129,
        lowStarSampled: 6,
        themed: 15,
        noMatch: 33,
        unable: 0,
        sampledProducts: 11,
        samplePolicy: "low_star_first_non_random_subset",
      },
      voiceThemes: [
        {
          id: "theme_mismatch",
          label: "清洁发黏痛点",
          sentiment: "negative",
          reviewCount: 1,
          productCount: 1,
          statement: { text: "反复清洗后表面仍有油腻粘稠感。", nature: "fact", citations: ["ev-rev-1"] },
          scenario: "家用烘焙清洗",
          hypothesis: "耐高温涂层老化或吸附油脂",
          improvement: "改进硅胶原料配方",
          verification: ["测试洗碗机清洗循环"],
          reviewIds: ["rev-multi"],
        },
      ],
    });

    const data = buildBaseIntelligence({
      reports: [report],
      reviews: [
        {
          id: "rev-multi",
          subjectKey: "asin:US:B0CFTP6JR4",
          subjectKeys: ["asin:US:B0CFTP6JR4", "asin:US:B0CWPNBC4Z"],
          rating: 1,
          title: "Sticky residue",
          text: "Very sticky after two uses.",
          evidence: makeCitation("ev-rev-2", "asin:US:B0CFTP6JR4", "review_observation"),
        },
      ],
      productDetails: [
        {
          subjectKey: "asin:US:B0CFTP6JR4",
          facts: {
            title: "Velesco Baking Mat",
            brand: "Velesco",
            imageUrl: "https://m.media-amazon.com/images/I/71velesco.jpg",
            bulletPoints: [],
            conflicts: [],
          } as any,
          evidence: makeCitation("ev-detail-2", "asin:US:B0CFTP6JR4", "source_observed"),
          supplementalEvidence: [],
        },
      ],
    });

    const voiceHtml = renderToStaticMarkup(
      React.createElement(MarketResearchReport, {
        data,
        active: "买家声音",
        report,
        reportId: report.id,
        onReport: () => {},
        onGenerate: () => {},
        busy: false,
        comparisonSubjects: report.comparisonSubjects!,
      }),
    );

    // 动态条数校验
    expect(voiceHtml).toContain("本次 48 条输入中命中 1 条独立评论");
    expect(voiceHtml).toContain("主题导航（48 条输入子集）");
    // 商品缩略图与 ASIN chip
    expect(voiceHtml).toContain("B0CFTP6JR4");
    expect(voiceHtml).toContain("B0CWPNBC4Z");
    // 跨商品口径提示
    expect(voiceHtml).toContain("口径提示：评论关联到 2 款商品（共享变体或跨商品），已保留报告记录 1 款");
  });
});
