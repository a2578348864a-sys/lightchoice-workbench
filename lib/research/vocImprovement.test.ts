import { describe, expect, it } from "vitest";
import { deriveImprovementRequirements, deriveSupplierCheckpoints } from "./vocImprovement";

const theme = (overrides: Partial<Record<string, unknown>> = {}) => ({
  themeId: "t1",
  label: "密封圈漏水",
  summary: "多位买家反映杯盖密封圈容易漏水。",
  evidenceRefs: ["rev-1", "rev-2", "rev-3", "rev-4"],
  reviewCount: 4,
  coverage: 0.2,
  strength: "recurring",
  limitations: null,
  ...overrides,
});

describe("P1-VOC-01 deriveImprovementRequirements", () => {
  it("recurring 痛点/复现请求主题派生为改进需求，带来源、频次与证据引用", () => {
    const requirements = deriveImprovementRequirements([theme()], [theme({ themeId: "t2", label: "杯盖难开", summary: "复现请求：希望更容易拧开。", reviewCount: 5, evidenceRefs: ["rev-5", "rev-6", "rev-7", "rev-8", "rev-9"] })]);
    expect(requirements).toHaveLength(2);
    expect(requirements[0].requirement).toContain("密封圈漏水");
    expect(requirements[0].sourceThemeId).toBe("t1");
    expect(requirements[0].reviewCount).toBe(4);
    expect(requirements[0].evidenceRefs).toEqual(["rev-1", "rev-2", "rev-3", "rev-4"]);
    expect(requirements[1].sourceThemeId).toBe("t2");
  });

  it("weak / isolated 主题不派生改进需求（避免过度解读弱样本）", () => {
    const requirements = deriveImprovementRequirements(
      [theme({ themeId: "t3", strength: "weak", reviewCount: 2, evidenceRefs: ["rev-1", "rev-2"] }), theme({ themeId: "t4", strength: "isolated", reviewCount: 1, evidenceRefs: ["rev-3"] })],
      [],
    );
    expect(requirements).toHaveLength(0);
  });

  it("主题级 limitations 透传为 severityHint；无则 null（不推断严重度）", () => {
    const [withHint] = deriveImprovementRequirements([theme({ limitations: "多为前 3 个月评论，长期耐用性未知。" })], []);
    expect(withHint.severityHint).toBe("多为前 3 个月评论，长期耐用性未知。");
    const [noHint] = deriveImprovementRequirements([theme()], []);
    expect(noHint.severityHint).toBeNull();
  });

  it("无证据引用的主题被拒收（证据下限，对齐 JEV 证据门禁）", () => {
    const requirements = deriveImprovementRequirements([theme({ evidenceRefs: [] })], []);
    expect(requirements).toHaveLength(0);
  });

  it("非数组/缺字段输入返回空数组（fail-soft，缺段不报错）", () => {
    expect(deriveImprovementRequirements(null, undefined)).toEqual([]);
    expect(deriveImprovementRequirements([{ label: "缺 themeId" }], [])).toEqual([]);
  });
});

describe("P1-VOC-02 deriveSupplierCheckpoints", () => {
  it("痛点主题一一映射为待供应商确认问题，可溯源且只提出待确认问题", () => {
    const checkpoints = deriveSupplierCheckpoints([theme(), theme({ themeId: "t5", label: "异味", summary: "开箱有塑料异味。", reviewCount: 1, evidenceRefs: ["rev-10"], strength: "weak" })]);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0].checkpoint).toContain("密封圈漏水");
    expect(checkpoints[0].checkpoint).toContain("4 条");
    expect(checkpoints[0].sourceThemeLabel).toBe("密封圈漏水");
    expect(checkpoints[0].evidenceRefs).toEqual(["rev-1", "rev-2", "rev-3", "rev-4"]);
    // 弱样本痛点也映射为检查项，但 reviewCount 明示（人工判断样本量）
    expect(checkpoints[1].checkpoint).toContain("1 条");
  });

  it("检查项文本不含报价 / MOQ 数值 / 供应链事实（S-16 边界）", () => {
    const checkpoints = deriveSupplierCheckpoints([theme()]);
    const json = JSON.stringify(checkpoints);
    expect(json).not.toMatch(/moq|报价|价格/i);
  });

  it("无痛点主题返回空数组", () => {
    expect(deriveSupplierCheckpoints([])).toEqual([]);
  });
});
