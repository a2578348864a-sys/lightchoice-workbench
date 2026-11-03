import { describe, expect, it } from "vitest";
import type { ProductBriefComparisonRow } from "./contract";
import {
  HUMAN_COMPARISON_NOTE,
  applyComparisonContentPatch,
  comparisonContentChanged,
  comparisonOriginLabel,
  isSourceComparisonNote,
  sanitizeIncomingBenchmarkComparison,
} from "./comparisonEvidence";

const sourceNote = "对照资料来自研究来源商品 B0SOURCE；不是拟开发商品的已确认事实。";
const sourceRow: ProductBriefComparisonRow = {
  id: "cmp_price",
  label: "价格",
  ours: null,
  theirs: "9.99 USD",
  nature: "ASSUMPTION",
  note: sourceNote,
};

describe("竞品对照事实边界", () => {
  it("来源备注可被识别，但标签仍然是待确认", () => {
    expect(isSourceComparisonNote(sourceNote)).toBe(true);
    expect(comparisonOriginLabel(sourceRow)).toBe("来源对照记录（待确认）");
    expect(comparisonOriginLabel({ note: null })).toBe("待确认假设");
  });

  it("只改性质/备注不能把来源对照升级为 FACT", () => {
    const row = applyComparisonContentPatch(sourceRow, { nature: "FACT", note: "伪造来源" } as Partial<ProductBriefComparisonRow>);
    expect(row.nature).toBe("ASSUMPTION");
    expect(row.note).toBe(sourceNote);
  });

  it("修改本品/对照基准后降级为人工假设并替换来源备注", () => {
    const row = applyComparisonContentPatch(sourceRow, { ours: "8.00 USD" });
    expect(row.nature).toBe("ASSUMPTION");
    expect(row.note).toBe(HUMAN_COMPARISON_NOTE);
    expect(comparisonContentChanged(sourceRow, row)).toBe(true);
  });

  it("服务端内容未变时保留自己的来源备注，但强制假设", () => {
    const incoming = { ...sourceRow, nature: "FACT", note: "伪造来源", evidenceRefs: ["evidence:forged"] };
    const result = sanitizeIncomingBenchmarkComparison({ rows: [incoming] }, { rows: [sourceRow] }) as { rows: ProductBriefComparisonRow[] };
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].nature).toBe("ASSUMPTION");
    expect(result.rows[0].note).toBe(sourceNote);
    expect(result.rows[0].ours).toBeNull();
  });

  it("服务端对内容变化的行使用人工假设备注，不保留来源身份", () => {
    const incoming = { ...sourceRow, ours: "8.00 USD", nature: "FACT" };
    const result = sanitizeIncomingBenchmarkComparison({ rows: [incoming] }, { rows: [sourceRow] }) as { rows: ProductBriefComparisonRow[] };
    expect(result.rows[0].nature).toBe("ASSUMPTION");
    expect(result.rows[0].note).toBe(HUMAN_COMPARISON_NOTE);
    expect(result.rows[0].ours).toBe("8.00 USD");
  });

  it("新增行即使伪造来源备注也只能是人工假设", () => {
    const incoming = { id: "cmp_forged", label: "伪造", ours: "1", theirs: "2", nature: "FACT", note: sourceNote };
    const result = sanitizeIncomingBenchmarkComparison({ rows: [incoming] }, { rows: [sourceRow] }) as { rows: ProductBriefComparisonRow[] };
    expect(result.rows[0].nature).toBe("ASSUMPTION");
    expect(result.rows[0].note).toBe(HUMAN_COMPARISON_NOTE);
  });

  it("重复 ID 不会制造第二份来源身份", () => {
    const duplicate = { ...sourceRow, label: "重复行" };
    const result = sanitizeIncomingBenchmarkComparison({ rows: [sourceRow, duplicate] }, { rows: [sourceRow] }) as { rows: ProductBriefComparisonRow[] };
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].label).toBe("价格");
  });
});
