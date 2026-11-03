import { describe, expect, it } from "vitest";
import type { ProductBriefSpecRow } from "./contract";
import { applySpecContentPatch, enforceSpecEvidenceRules, sanitizeIncomingSpecifications } from "./specEvidence";

const base: ProductBriefSpecRow = {
  id: "spec_material",
  label: "材质",
  value: "304 不锈钢",
  unit: null,
  nature: "FACT",
  verification: "verified",
  evidenceRefs: ["evidence:ev-1"],
};

describe("规格证据边界", () => {
  it("有引用且内容未变时保留来源性质，但不保留人工已验证", () => {
    const row = enforceSpecEvidenceRules(base);
    expect(row.evidenceRefs).toEqual(base.evidenceRefs);
    expect(row.nature).toBe("FACT");
    expect(row.verification).toBe("unverified");
  });

  it("无引用时不能保持 FACT / verified", () => {
    const row = enforceSpecEvidenceRules({ ...base, evidenceRefs: [] });
    expect(row.nature).toBe("ASSUMPTION");
    expect(row.verification).toBe("unverified");
  });

  it("无引用时「不适用」仍可保留，因为它不是已核验声明", () => {
    const row = enforceSpecEvidenceRules({ ...base, evidenceRefs: [], verification: "not_applicable" });
    expect(row.verification).toBe("not_applicable");
  });

  it("修改数值会移除旧引用并降级，旧证据不再为新数值背书", () => {
    const row = applySpecContentPatch(base, { value: "201 不锈钢" });
    expect(row.evidenceRefs).toEqual([]);
    expect(row.nature).toBe("ASSUMPTION");
    expect(row.verification).toBe("unverified");
  });

  it("只改性质/验证下拉、不改内容时，不凭空创造引用；无引用仍降级", () => {
    const noRefs = { ...base, evidenceRefs: [], nature: "ASSUMPTION" as const, verification: "unverified" as const };
    const row = applySpecContentPatch(noRefs, { nature: "FACT", verification: "verified" });
    expect(row.evidenceRefs).toEqual([]);
    expect(row.nature).toBe("ASSUMPTION");
    expect(row.verification).toBe("unverified");
  });

  it("服务端比较旧版本：内容未变保留引用，内容变化或新增行清除引用", () => {
    const same = sanitizeIncomingSpecifications([base], [base]) as ProductBriefSpecRow[];
    expect(same[0].evidenceRefs).toEqual(["evidence:ev-1"]);
    expect(same[0].nature).toBe("FACT");

    const changed = sanitizeIncomingSpecifications([{ ...base, value: "201 不锈钢" }], [base]) as ProductBriefSpecRow[];
    expect(changed[0].evidenceRefs).toEqual([]);
    expect(changed[0].nature).toBe("ASSUMPTION");
    expect(changed[0].verification).toBe("unverified");

    const added = sanitizeIncomingSpecifications([{ ...base, id: "spec_new" }], [base]) as ProductBriefSpecRow[];
    expect(added[0].evidenceRefs).toEqual([]);
    expect(added[0].nature).toBe("ASSUMPTION");
  });

  it("服务端对旧版本无引用的行也强制降级", () => {
    const noRefs = { ...base, evidenceRefs: [] };
    const result = sanitizeIncomingSpecifications([noRefs], [noRefs]) as ProductBriefSpecRow[];
    expect(result[0].nature).toBe("ASSUMPTION");
    expect(result[0].verification).toBe("unverified");
  });

  it("内容未变时，客户端伪造引用或提升状态不被接受", () => {
    const forged = {
      ...base,
      evidenceRefs: ["evidence:forged"],
      nature: "FACT" as const,
      verification: "verified" as const,
    };
    const result = sanitizeIncomingSpecifications([forged], [base]) as ProductBriefSpecRow[];
    expect(result[0].evidenceRefs).toEqual(["evidence:ev-1"]);
    expect(result[0].nature).toBe("FACT");
    expect(result[0].verification).toBe("unverified");
  });

  it("内容未变时，客户端不能把无引用假设行提升为事实", () => {
    const previous = { ...base, evidenceRefs: [], nature: "ASSUMPTION" as const, verification: "unverified" as const };
    const promoted = { ...previous, nature: "FACT" as const, verification: "verified" as const, evidenceRefs: ["evidence:forged"] };
    const result = sanitizeIncomingSpecifications([promoted], [previous]) as ProductBriefSpecRow[];
    expect(result[0].evidenceRefs).toEqual([]);
    expect(result[0].nature).toBe("ASSUMPTION");
    expect(result[0].verification).toBe("unverified");
  });

  it("伪造已有 ID 但改动内容时不能继承该行事实身份", () => {
    const forged = { ...base, value: "伪造内容", evidenceRefs: base.evidenceRefs, nature: "FACT" as const, verification: "verified" as const };
    const result = sanitizeIncomingSpecifications([forged], [base]) as ProductBriefSpecRow[];
    expect(result[0].evidenceRefs).toEqual([]);
    expect(result[0].nature).toBe("ASSUMPTION");
    expect(result[0].verification).toBe("unverified");
  });

  it("重复 ID 不会制造第二份事实身份", () => {
    const duplicate = { ...base, label: "另一行" };
    const result = sanitizeIncomingSpecifications([base, duplicate], [base]) as ProductBriefSpecRow[];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(base.id);
    expect(result[0].evidenceRefs).toEqual([base.evidenceRefs[0]]);
  });
});
