import { describe, expect, it } from "vitest";
import { sellerSpriteAdapter } from "@/lib/sourceLayer/adapters/sellerSpriteAdapter";
import { createSourceLayerTestWorkbook } from "@/lib/sourceLayer/adapters/__fixtures__/sellerSpriteWorkbook";
import {
  KEYWORD_SOURCE_REF_MONTHLY_SEARCHES,
  adaptEvidenceToProductFact,
  keywordEvidenceInputFromAttachment,
  selectTopKeywords,
  withKeywordEvidence,
} from "@/lib/sourceLayer/fact/productFactAdapter";
import type { ProductFactKeywordRow } from "@/lib/sourceLayer/fact/types";

const NOW = "2026-09-19T08:00:00.000Z";
const EVIDENCE_REF = "attachment:att-keyword-1";
const PRODUCT_NAME = "Insulated Water Bottle";

function sellerSpriteEvidence() {
  const captured = sellerSpriteAdapter.capture({
    payload: createSourceLayerTestWorkbook(),
    capturedAt: NOW,
    operator: "owner:v1",
  });
  const draft = captured.drafts[0];
  if (!draft) throw new Error("SellerSprite fixture draft missing");
  const pkg = sellerSpriteAdapter.normalize({ draft, captureId: "cap-g2b", version: 1 });
  const outcome = sellerSpriteAdapter.validate({ pkg, context: { now: NOW } });
  return sellerSpriteAdapter.createEvidence({ pkg: outcome.pkg, report: outcome.report });
}

/** 20 条输入：5 条与商品名相关（其中前 3 条相关度最高）+ 15 条无关但搜索量极大的诱饵。 */
function twentyRows(): ProductFactKeywordRow[] {
  const relevant: ProductFactKeywordRow[] = [
    { keyword: "insulated water bottle", monthlySearches: 30_000, rowNumber: 1 },
    { keyword: "insulated bottle large", monthlySearches: 20_000, rowNumber: 2 },
    { keyword: "water bottle pink", monthlySearches: 10_000, rowNumber: 3 },
    { keyword: "bottle brush", monthlySearches: 9_000, rowNumber: 4 },
    { keyword: "insulated cup", monthlySearches: 8_000, rowNumber: 5 },
  ];
  const decoys: ProductFactKeywordRow[] = Array.from({ length: 15 }, (_, i) => ({
    keyword: `kitchen gadget pro ${i + 1}`,
    monthlySearches: 999_999,
    rowNumber: 100 + i,
  }));
  return [...relevant, ...decoys];
}

function select(rows: readonly ProductFactKeywordRow[]) {
  return selectTopKeywords({ rows, productName: PRODUCT_NAME, knownBrands: [], evidenceRef: EVIDENCE_REF });
}

function keywordAttachmentPayload() {
  return {
    schema: "seller-sprite-keyword-attachment.v1",
    asin: "B0FH1ZXTN1",
    sourceRef: "keyword-report.xlsx",
    sourceMethod: "sellersprite_official_xlsx",
    evidence: {
      schema: "seller-sprite-keyword-evidence.v1",
      reportType: "reverse_asin",
      capturedAt: "2026-09-20T00:00:00.000Z",
      dataPeriod: null,
      updatedAt: "2026-09-20T00:00:00.000Z",
      rows: [
        {
          rowNumber: 1,
          keyword: "insulated water bottle",
          keywordTranslation: "保温水瓶",
          fields: {
            monthlySearches: { raw: "30,000", normalized: 30_000, metricNature: "estimate", applicability: "available" },
            acRecommended: { raw: "Y", normalized: true, metricNature: "snapshot", applicability: "available" },
          },
        },
        {
          rowNumber: 2,
          keyword: "insulated bottle large",
          keywordTranslation: "大号保温瓶",
          fields: {
            monthlySearches: { raw: "", normalized: null, metricNature: "unknown", applicability: "missing" },
          },
        },
        { rowNumber: 3, keyword: "", keywordTranslation: null, fields: {} },
      ],
    },
  };
}

describe("G2-B：SellerSprite 关键词投影", () => {
  it("20 条关键词 → 确定性 top3，且不因搜索量大而选中无关词", () => {
    const result = select(twentyRows());
    expect(result).toHaveLength(3);
    expect(result.map((item) => item.keyword)).toEqual([
      "insulated water bottle",
      "insulated bottle large",
      "water bottle pink",
    ]);
    // 诱饵（999,999 次/月但相关度为 0）绝不入选
    expect(result.map((item) => item.keyword)).not.toContain("kitchen gadget pro 1");
  });

  it("monthlySearches 保持 estimate，每条带 source / evidenceRef / confidence", () => {
    const [first] = select(twentyRows());
    expect(first).toMatchObject({
      keyword: "insulated water bottle",
      monthlySearches: 30_000,
      metricNature: "estimate",
      confidence: 0.9,
      sourceRef: KEYWORD_SOURCE_REF_MONTHLY_SEARCHES,
      evidenceRef: EVIDENCE_REF,
    });
    expect(first!.metricNature).not.toBe("confirmed");
  });

  it("乱序输入 → 输出完全一致（无随机、无 AI 排序）", () => {
    const rows = twentyRows();
    const baseline = select(rows).map((item) => item.keyword);
    const reversed = select([...rows].reverse()).map((item) => item.keyword);
    const rotated = select([...rows.slice(7), ...rows.slice(0, 7)]).map((item) => item.keyword);
    // monthlySearches 并列时的次序也必须稳定：仅改顺序不改结果
    const tied: ProductFactKeywordRow[] = [
      { keyword: "water bottle", monthlySearches: 5_000, rowNumber: 1 },
      { keyword: "bottle water", monthlySearches: 5_000, rowNumber: 2 },
      { keyword: "insulated water bottle", monthlySearches: 5_000, rowNumber: 3 },
    ];
    expect(reversed).toEqual(baseline);
    expect(rotated).toEqual(baseline);
    expect(select([...tied].reverse()).map((item) => item.keyword))
      .toEqual(select(tied).map((item) => item.keyword));
  });

  it("无合格关键词 → 空结果（不造词），withKeywordEvidence 原样返回", () => {
    const irrelevant: ProductFactKeywordRow[] = Array.from({ length: 20 }, (_, i) => ({
      keyword: `kitchen gadget pro ${i + 1}`,
      monthlySearches: 1_000 + i,
      rowNumber: i + 1,
    }));
    expect(select(irrelevant)).toEqual([]);
    const base = adaptEvidenceToProductFact({ evidence: sellerSpriteEvidence() });
    expect(withKeywordEvidence(base, { rows: irrelevant, evidenceRef: EVIDENCE_REF, capturedAt: NOW, sourceMethod: null }))
      .toEqual(base);
    expect(withKeywordEvidence(base, null)).toEqual(base);
    expect(base.keywordEvidence).toBeUndefined();
  });

  it("附件解析：只接受既有契约、只读 monthlySearches、契约不符返回 null", () => {
    const parsed = keywordEvidenceInputFromAttachment(keywordAttachmentPayload(), EVIDENCE_REF);
    expect(parsed).not.toBeNull();
    expect(parsed!.rows).toEqual([
      { keyword: "insulated water bottle", monthlySearches: 30_000, rowNumber: 1 },
      { keyword: "insulated bottle large", monthlySearches: null, rowNumber: 2 },
    ]);
    expect(parsed!.evidenceRef).toBe(EVIDENCE_REF);
    expect(parsed!.capturedAt).toBe("2026-09-20T00:00:00.000Z");
    expect(parsed!.sourceMethod).toBe("sellersprite_official_xlsx");
    // 契约不符 / 空行 → null（fail-closed）
    expect(keywordEvidenceInputFromAttachment({ schema: "something-else" }, EVIDENCE_REF)).toBeNull();
    expect(keywordEvidenceInputFromAttachment(
      { schema: "seller-sprite-keyword-attachment.v1", evidence: { rows: [] } },
      EVIDENCE_REF,
    )).toBeNull();
    expect(keywordEvidenceInputFromAttachment(null, EVIDENCE_REF)).toBeNull();
  });

  it("withKeywordEvidence：投影到 ProductFact 且沿用同一证据指纹（不改四元组）", () => {
    const base = adaptEvidenceToProductFact({ evidence: sellerSpriteEvidence() });
    const projected = withKeywordEvidence(base, {
      rows: twentyRows(),
      evidenceRef: EVIDENCE_REF,
      capturedAt: "2026-09-20T00:00:00.000Z",
      sourceMethod: "sellersprite_official_xlsx",
    });
    expect(projected.sourceProof).toEqual(base.sourceProof);
    expect(projected.keywordEvidence?.topKeywords).toMatchObject({
      status: "present",
      metricNature: "estimate",
      source: base.sourceProof.source,
      confidence: 0.9,
      rawProofHash: base.sourceProof.contentHash,
    });
    expect(projected.keywordEvidence?.topKeywords.value?.map((item) => item.keyword)).toEqual([
      "insulated water bottle",
      "insulated bottle large",
      "water bottle pink",
    ]);
  });
});
