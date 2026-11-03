import { describe, it, expect } from "vitest";
import { mapLarkRecordToBitableRow, validateTableFields } from "./tableContract";
import type { LarkFieldMeta } from "./types";
import type { ResearchExportRecord } from "@/lib/research/researchContracts";
import type { LarkBaseRecord } from "@/lib/research/larkMapping";

/** 人工构造的旧 V1 契约夹具，仅用于字段兼容单元测试，不代表 live schema。
 * 当前 Hub 远端漂移由 scripts/feishu/v5-hub-schema-readback-run.mts 定期只读检测。
 */
function fullContractFields(): LarkFieldMeta[] {
  const spec: Array<[string, number, string]> = [
    ["ASIN", 1, "Text"],
    ["商品标题", 1, "Text"],
    ["商品图片", 1, "Text"],
    ["类目", 1, "Text"],
    ["研究链接", 1, "Text"],
    ["当前售价", 2, "Number"],
    ["售价币种", 1, "Text"],
    ["预估月销量", 2, "Number"],
    ["BSR", 2, "Number"],
    ["研究优先级", 3, "SingleSelect"],
    ["核心机会", 1, "Text"],
    ["核心风险", 1, "Text"],
    ["AI研究摘要", 1, "Text"],
    ["人工状态", 3, "SingleSelect"],
    ["下一步动作", 3, "SingleSelect"],
    ["人工备注", 1, "Text"],
    ["Task ID", 1, "Text"],
    ["Candidate ID", 1, "Text"],
    ["Report Hash", 1, "Text"],
    ["报告生成时间", 1, "Text"],
    ["最近同步时间", 1, "Text"],
  ];
  return spec.map(([fieldName, type, uiType], index) => ({
    fieldId: `fld${index + 1}`,
    fieldName,
    type,
    uiType,
    isPrimary: index === 0,
  }));
}

describe("Lark Bitable Table Contract", () => {
  const dummyExportRecord: ResearchExportRecord = {
    taskId: "task-test-01",
    candidateId: "cand-test-01",
    product: {
      asin: "B0TESTASIN1",
      title: "Stainless Steel Tumbler 20oz",
      image: "https://example.com/img.jpg",
      category: "Home & Kitchen",
    },
    market: {
      price: { amount: 24.99, currency: "USD" },
      sales: 1200,
      bsr: 150,
    },
    research: {
      summary: "优质保温杯标的，需求稳定。",
      priority: "P1",
      opportunity: "切入高保温性能细分人群",
      risks: ["竞争激烈", "FBA 运费敏感"],
      unverifiedAssumptions: [],
    },
    humanDecision: {
      status: "continue",
      nextAction: "continue_research",
      notes: "已核准，安排供应商测样",
      reviewedReportHash: "hash-test-abcdef123456",
      reviewStale: false,
    },
    evidence: {
      reportHash: "hash-test-abcdef123456",
      generatedAt: "2026-09-19T10:00:00.000Z",
      citationCount: 12,
      factCitationCount: 12,
      narrativeCitationCount: 0,
      unverifiedAssumptionCount: 0,
    },
  };

  const dummyLarkRecord: LarkBaseRecord = {
    商品信息: {
      图片: dummyExportRecord.product.image,
      ASIN: dummyExportRecord.product.asin,
      商品标题: dummyExportRecord.product.title,
      类目: dummyExportRecord.product.category,
    },
    市场数据: {
      当前售价: 24.99,
      当前售价币种: "USD",
      月销量: 1200,
      BSR: 150,
    },
    研究结论: {
      研究优先级: "P1",
      核心摘要: dummyExportRecord.research.summary,
      核心机会: dummyExportRecord.research.opportunity,
    },
    人工决策: {
      决策状态: "continue",
      下一步动作: "continue_research",
      决策备注: "已核准，安排供应商测样",
    },
    风险: dummyExportRecord.research.risks,
    证据: {
      报告指纹: dummyExportRecord.evidence.reportHash,
      生成时间: dummyExportRecord.evidence.generatedAt,
      引用数量: dummyExportRecord.evidence.citationCount,
    },
  };

  it("正确将记录投影为平铺的飞书多维表格行对象", () => {
    const row = mapLarkRecordToBitableRow(dummyExportRecord, dummyLarkRecord, {
      syncedAt: "2026-09-19T12:00:00.000Z",
      baseUrl: "http://localhost:3005",
    });

    expect(row["ASIN"]).toBe("B0TESTASIN1");
    expect(row["商品标题"]).toBe("Stainless Steel Tumbler 20oz");
    expect(row["商品图片"]).toBe("https://example.com/img.jpg");
    expect(row["当前售价"]).toBe(24.99);
    expect(row["预估月销量"]).toBe(1200);
    expect(row["BSR"]).toBe(150);
    expect(row["研究优先级"]).toBe("P1");
    expect(row["核心机会"]).toBe("切入高保温性能细分人群");
    expect(row["核心风险"]).toBe("竞争激烈\nFBA 运费敏感");
    expect(row["人工状态"]).toBe("continue");
    expect(row["下一步动作"]).toBe("continue_research");
    expect(row["Task ID"]).toBe("task-test-01");
    expect(row["Report Hash"]).toBe("hash-test-abcdef123456");
    expect(row["研究链接"]).toBe("http://localhost:3005/tasks/task-test-01");
  });

  it("Case A：21 字段全部存在时判定为可写", () => {
    const validation = validateTableFields(fullContractFields());
    expect(validation.isValid).toBe(true);
    expect(validation.missingRequiredFields.length).toBe(0);
    expect(validation.missingOptionalFields.length).toBe(0);
    expect(validation.missingWriteFields.length).toBe(0);
    expect(validation.incompatibleFields.length).toBe(0);
  });

  it("Case B：6 个必须字段齐全但缺 1 个写入（可选）字段时判定为不可写，且缺口不被静默", () => {
    const remoteFields: LarkFieldMeta[] = [
      { fieldId: "fld1", fieldName: "ASIN", type: 1, uiType: "Text", isPrimary: true },
      { fieldId: "fld2", fieldName: "商品标题", type: 1, uiType: "Text" },
      { fieldId: "fld3", fieldName: "研究优先级", type: 1, uiType: "Text" },
      { fieldId: "fld4", fieldName: "人工状态", type: 1, uiType: "Text" },
      { fieldId: "fld5", fieldName: "Task ID", type: 1, uiType: "Text" },
      { fieldId: "fld6", fieldName: "Report Hash", type: 1, uiType: "Text" },
    ];

    const validation = validateTableFields(remoteFields);
    // 关键回归：必须字段齐全，但写入行仍会发送全部 21 个字段名 → 不可写
    expect(validation.missingRequiredFields.length).toBe(0);
    expect(validation.isValid).toBe(false);
    expect(validation.missingOptionalFields).toContain("商品图片");
    expect(validation.missingOptionalFields).toContain("预估月销量");
    expect(validation.missingWriteFields).toContain("商品图片");
    expect(validation.missingWriteFields).toContain("预估月销量");
    expect(validation.missingWriteFields.length).toBe(15);
  });

  it("Case C：字段类型不兼容时判定为不可写并返回精确类型对照", () => {
    const remoteFields = fullContractFields().map((field) =>
      field.fieldName === "BSR"
        ? { ...field, type: 1, uiType: "Text" }
        : field,
    );

    const validation = validateTableFields(remoteFields);
    expect(validation.isValid).toBe(false);
    expect(validation.missingWriteFields.length).toBe(0);
    expect(validation.incompatibleFields).toHaveLength(1);
    expect(validation.incompatibleFields[0].fieldName).toBe("BSR");
    expect(validation.incompatibleFields[0].expectedType).toBe("2");
    expect(validation.incompatibleFields[0].actualType).toBe("1 (Text)");
  });

  it("当缺少 ASIN 等必须字段时判定为不可写并返回缺失清单", () => {
    const remoteFields: LarkFieldMeta[] = [
      { fieldId: "fld2", fieldName: "商品标题", type: 1, uiType: "Text" },
      { fieldId: "fld3", fieldName: "研究优先级", type: 1, uiType: "Text" },
    ];

    const validation = validateTableFields(remoteFields);
    expect(validation.isValid).toBe(false);
    expect(validation.missingRequiredFields).toContain("ASIN");
    expect(validation.missingRequiredFields).toContain("Task ID");
    expect(validation.missingRequiredFields).toContain("Report Hash");
  });
});
