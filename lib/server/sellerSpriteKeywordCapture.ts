import type { AccessContext } from "@/lib/server/accessPassword";
import {
  captureEvidenceAttachmentThroughGateway,
  type CaptureGatewayAttachmentResult,
} from "@/lib/sourceLayer/server/captureGateway";
import {
  planSellerSpriteReport,
  type SellerSpriteReportPlan,
} from "@/tools/collectors/recipes/sellerSprite";
import type { KeywordEvidenceV1 } from "@/lib/server/keywordEvidence";

export type SellerSpriteKeywordCaptureInput = {
  context: AccessContext;
  asin: string;
  headers: ReadonlyArray<string | null> | null;
  rows: ReadonlyArray<ReadonlyArray<string | null>> | null;
  capturedAt?: string;
  sourceRef: string;
  sourceMethod?: "sellersprite_page_manual_tsv" | "sellersprite_official_xlsx";
  unavailableReason?: "plugin_not_loaded" | "permission_denied" | "quota_exhausted" | "no_source";
};

export type SellerSpriteKeywordCaptureResult =
  | {
    ok: true;
    evidence: KeywordEvidenceV1;
    gateway: CaptureGatewayAttachmentResult;
    reportType: "reverse_asin" | "keyword_mining";
  }
  | {
    ok: false;
    plan: Extract<SellerSpriteReportPlan, { ok: false }>;
  };

export async function captureSellerSpriteKeywordEvidence(
  input: SellerSpriteKeywordCaptureInput,
): Promise<SellerSpriteKeywordCaptureResult> {
  const asin = input.asin.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return {
      ok: false,
      plan: {
        ok: false,
        status: "blocked",
        errorCode: "INVALID_FORMAT",
        reason: "关键词报表必须绑定到合法的 10 位 ASIN。",
      },
    };
  }
  const capturedAt = input.capturedAt && !Number.isNaN(Date.parse(input.capturedAt))
    ? input.capturedAt
    : new Date().toISOString();
  const sourceRef = input.sourceRef.trim().slice(0, 300);
  if (!sourceRef) {
    return {
      ok: false,
      plan: {
        ok: false,
        status: "blocked",
        errorCode: "INVALID_FORMAT",
        reason: "缺少 SellerSprite 面板或官方导出的来源引用。",
      },
    };
  }
  const planned = planSellerSpriteReport({
    headers: input.headers,
    rows: input.rows,
    capturedAt,
    sourceRef,
    sourceMethod: input.sourceMethod ?? "sellersprite_official_xlsx",
    unavailableReason: input.unavailableReason,
  });
  if (!planned.ok) return { ok: false, plan: planned };

  const gateway = await captureEvidenceAttachmentThroughGateway({
    context: input.context,
    subjectKey: `amazon:US:${asin}`,
    source: "sellersprite_xlsx",
    kind: "keyword_evidence",
    sourceFingerprint: sourceRef,
    payload: {
      schema: "seller-sprite-keyword-attachment.v1",
      asin,
      sourceRef,
      sourceMethod: input.sourceMethod ?? "sellersprite_official_xlsx",
      evidence: planned.evidence,
    },
    capturedAt: new Date(capturedAt),
  });
  // 商品级关键词证据必须有真实的商品 Evidence 引用；缺失即为合同不成立，fail-closed。
  if (!gateway.sourceEvidenceRef) {
    return {
      ok: false,
      plan: {
        ok: false,
        status: "blocked",
        errorCode: "NO_SOURCE_IN_REPO",
        reason: "SellerSprite 关键词证据没有绑定到已存在的商品 Evidence。",
      },
    };
  }
  return {
    ok: true,
    reportType: planned.reportType,
    gateway,
    evidence: {
      ...planned.evidence,
      sourceEvidenceRefs: [gateway.sourceEvidenceRef],
    },
  };
}
