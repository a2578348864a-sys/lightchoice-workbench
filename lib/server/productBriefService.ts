import { makeUnavailableClaimAudit } from "@/lib/research/evidenceAudit";
import { claimConsumptionBlockReason, claimConsumptionNotice } from "@/lib/research/claimConsumption";
import { appendProductBriefVersion, ProductBriefHistoryPreservationError, readProductBriefHistory } from "@/lib/productBrief/history";
import { sanitizeIncomingSpecifications } from "@/lib/productBrief/specEvidence";
import { sanitizeIncomingBenchmarkComparison } from "@/lib/productBrief/comparisonEvidence";
import { deriveApprovalBlockedReason } from "@/lib/productBrief/approvalGate";
import { diffBriefVersions, summarizeBriefDiff } from "@/lib/productBrief/diff";
import type { AccessContext } from "@/lib/server/accessPassword";
import type { ProductFact, FactField } from "@/lib/sourceLayer/fact/types";
import { prisma } from "@/lib/server/db";
import { buildResearchInputBundle } from "@/lib/server/research/researchInputBundle";
import { getVocAnalysis } from "@/lib/server/vocAnalysis";
import { deriveImprovementRequirements, deriveSupplierCheckpoints } from "@/lib/research/vocImprovement";
import { getResearchDetail } from "@/lib/server/v5ResearchService";
import { readStoredResearchReport, type StoredResearchReport } from "@/lib/server/research/researchReportStore";
import { readCommercialInputs } from "@/lib/server/commercialInputs";
import { formatResearchNarrative, type ResearchNarrative } from "@/lib/research/researchContracts";
import { hashJson, parseJsonRecord } from "@/lib/server/v5CoreCommon";
import { mutateTaskResultJson, TaskResultJsonMutationError } from "@/lib/server/taskResultJsonMutation";
import { readMarketWorkflowMetadata } from "@/lib/marketWorkflow/metadata";
import {
  calculatePurchaseCostCeiling,
  parseProductBrief,
  PRODUCT_BRIEF_MAX_BENCHMARKS,
  PRODUCT_BRIEF_SCHEMA,
  type ProductBrief,
  type ProductBriefBenchmarkComparison,
  type ProductBriefConfirmationItem,
  type ProductBriefEconomicOrigin,
  type ProductBriefEconomicsProvenance,
  type ProductBriefEvidenceLine,
  type ProductBriefSpecRow,
  type ProductBriefStatus,
} from "@/lib/productBrief/contract";

export class ProductBriefError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ProductBriefError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fieldValue<T>(field: FactField<T> | undefined): T | null {
  return field?.status === "present" ? field.value : null;
}

function sameCurrencyMoneyAmount(value: unknown, currency: string): number | null {
  if (!isRecord(value) || typeof value.value !== "number" || !Number.isFinite(value.value)) return null;
  return value.currency === currency ? value.value : null;
}

function roundEconomicAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function refsForFact(fact: ProductFact | null, field?: FactField<unknown>): string[] {
  if (field?.evidenceRefs?.length) return Array.from(new Set(field.evidenceRefs.map((ref) => ref.refId)));
  return fact?.sourceProof.evidenceId ? [`evidence:${fact.sourceProof.evidenceId}`] : [];
}

type NarrativeBindingEntry = { field?: string; text?: string; evidenceRefs?: unknown };

type NarrativeResolveOptions = {
  field?: string;
  bindings?: NarrativeBindingEntry[];
  defaultNature?: ProductBriefEvidenceLine["nature"];
  allowAssumption?: boolean;
  /** 数组中同文项不能靠文本回退，否则无法证明绑定的是哪一项。 */
  allowTextFallback?: boolean;
  /** 有 ResearchInputBundle 时，旧对象合同的引用也必须属于当前主体的证据集合。 */
  allowedEvidenceRefs?: readonly string[];
};

function normalizedBindingEntries(
  bindings: NarrativeBindingEntry[],
  allowedEvidenceRefs: readonly string[] = [],
): Array<{ field: string; text: string; evidenceRefs: string[] }> {
  const allowed = new Set(allowedEvidenceRefs);
  const enforceAllowed = allowed.size > 0;
  return bindings.flatMap((binding) => {
    const field = text(binding.field);
    const bindingText = text(binding.text);
    const rawEvidenceRefs = Array.isArray(binding.evidenceRefs)
      ? Array.from(new Set(binding.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0))).slice(0, 20)
      : [];
    // 绑定项含有任意当前主体之外的引用时整条失效，不能只留下合法子集后复活原句。
    if (enforceAllowed && rawEvidenceRefs.some((ref) => !allowed.has(ref))) return [];
    const evidenceRefs = rawEvidenceRefs;
    return field && bindingText && evidenceRefs.length ? [{ field, text: bindingText, evidenceRefs }] : [];
  });
}

function resolveNarrativeLine(
  value: unknown,
  options?: NarrativeResolveOptions | ProductBriefEvidenceLine["nature"]
): ProductBriefEvidenceLine | null {
  const defaultNature = (typeof options === "string" ? options : options?.defaultNature) ?? "EVIDENCE_DERIVED";
  const fieldKey = typeof options === "object" ? options?.field : undefined;
  const bindings = typeof options === "object" && Array.isArray(options?.bindings) ? options.bindings : [];
  const allowedEvidenceRefs = typeof options === "object" && Array.isArray(options?.allowedEvidenceRefs)
    ? options.allowedEvidenceRefs
    : [];
  const allowTextFallback = typeof options === "object" && options?.allowTextFallback !== undefined
    ? options.allowTextFallback
    : true;
  const allowAssumption = typeof options === "object" && typeof options?.allowAssumption === "boolean"
    ? options.allowAssumption
    : defaultNature === "ASSUMPTION";

  let textContent: string | null = null;
  let explicitRefs: string[] = [];

  if (isRecord(value) && typeof value.text === "string" && value.text.trim()) {
    textContent = value.text.trim();
    if (Array.isArray(value.evidenceRefs)) {
      explicitRefs = value.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0);
    }
  } else if (typeof value === "string" && value.trim()) {
    textContent = value.trim();
  } else {
    return null;
  }

  const normalizedBindings = normalizedBindingEntries(bindings, allowedEvidenceRefs);
  if (explicitRefs.length > 0 && allowedEvidenceRefs.length > 0) {
    const allowed = new Set(allowedEvidenceRefs);
    if (explicitRefs.some((ref) => !allowed.has(ref))) return null;
  }
  if (normalizedBindings.length > 0) {
    const fieldMatches = fieldKey ? normalizedBindings.filter((binding) => binding.field === fieldKey) : [];
    const exactFieldMatch = fieldMatches.length === 1 && fieldMatches[0]!.text === textContent ? fieldMatches[0] : null;
    const exactTextMatches = allowTextFallback
      ? normalizedBindings.filter((binding) => binding.text === textContent)
      : [];
    const textMatch = exactTextMatches.length === 1 ? exactTextMatches[0] : null;
    const matched = exactFieldMatch ?? textMatch;

    if (explicitRefs.length > 0) {
      // 对象旧合同自带引用时仍允许消费，但只接受能在同一条绑定中证明的引用；
      // 不能把一个合法引用“借给”另一句，或把污染引用带入 Brief。
      if (!matched || explicitRefs.some((ref) => !matched.evidenceRefs.includes(ref))) return null;
    } else if (matched) {
      explicitRefs = matched.evidenceRefs;
    } else if (!allowAssumption) {
      return null;
    }
  }

  const evidenceRefs = explicitRefs.slice(0, 20);
  if (evidenceRefs.length === 0 && !allowAssumption) {
    return null;
  }

  const nature: ProductBriefEvidenceLine["nature"] = evidenceRefs.length > 0 ? defaultNature : "ASSUMPTION";

  return { text: textContent.slice(0, 2_000), nature, evidenceRefs };
}

function narrativeLine(
  value: unknown,
  nature: ProductBriefEvidenceLine["nature"] = "EVIDENCE_DERIVED"
): ProductBriefEvidenceLine | null {
  return resolveNarrativeLine(value, nature);
}

function resolveNarrativeLines(
  value: unknown,
  options?: {
    fieldPrefix?: string;
    bindings?: NarrativeBindingEntry[];
    defaultNature?: ProductBriefEvidenceLine["nature"];
    allowedEvidenceRefs?: readonly string[];
  } | ProductBriefEvidenceLine["nature"]
): ProductBriefEvidenceLine[] {
  if (!Array.isArray(value)) return [];
  const defaultNature = (typeof options === "string" ? options : options?.defaultNature) ?? "EVIDENCE_DERIVED";
  const fieldPrefix = typeof options === "object" ? options?.fieldPrefix : undefined;
  const bindings = typeof options === "object" && Array.isArray(options?.bindings) ? options.bindings : [];
  const allowedEvidenceRefs = typeof options === "object" && Array.isArray(options?.allowedEvidenceRefs)
    ? options.allowedEvidenceRefs
    : [];

  const textCounts = new Map<string, number>();
  for (const item of value) {
    const itemText = isRecord(item) && typeof item.text === "string"
      ? item.text.trim()
      : typeof item === "string" ? item.trim() : "";
    if (itemText) textCounts.set(itemText, (textCounts.get(itemText) ?? 0) + 1);
  }

  return value.flatMap((item, index) => {
    const field = fieldPrefix ? `${fieldPrefix}[${index}]` : undefined;
    const itemText = isRecord(item) && typeof item.text === "string"
      ? item.text.trim()
      : typeof item === "string" ? item.trim() : "";
    const parsed = resolveNarrativeLine(item, {
      field,
      bindings,
      defaultNature,
      allowedEvidenceRefs,
      // 数组内同文项必须依赖原始字段路径精确匹配；文本回退会把引用挂错项。
      allowTextFallback: (textCounts.get(itemText) ?? 0) <= 1,
    });
    return parsed ? [parsed] : [];
  }).slice(0, 50);
}

function narrativeLines(
  value: unknown,
  nature: ProductBriefEvidenceLine["nature"] = "EVIDENCE_DERIVED"
): ProductBriefEvidenceLine[] {
  return resolveNarrativeLines(value, nature);
}

/**
 * P3-01-B：V1 ResearchReport 的引用不是旧合同里的 string[]，而是完整
 * ResearchEvidenceRef 对象。这里只投影 refId，并在有当前 bundle 白名单时
 * 对每一条引用做 fail-closed 校验；没有引用的文本只能保持 ASSUMPTION。
 */
function researchNarrativeLine(
  value: unknown,
  allowedEvidenceRefs: readonly string[],
): ProductBriefEvidenceLine | null {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim()) return null;
  const evidenceRefs = Array.isArray(value.evidenceRefs)
    ? Array.from(new Set(value.evidenceRefs.flatMap((ref) => {
        if (!isRecord(ref) || typeof ref.refId !== "string" || !ref.refId.trim()) return [];
        return [ref.refId.trim()];
      }))).slice(0, 20)
    : [];
  if (allowedEvidenceRefs.length > 0) {
    const allowed = new Set(allowedEvidenceRefs);
    if (evidenceRefs.some((ref) => !allowed.has(ref))) return null;
  }
  return {
    text: (formatResearchNarrative(value as ResearchNarrative) ?? value.text.trim()).slice(0, 2_000),
    nature: evidenceRefs.length && !value.semanticReview ? "EVIDENCE_DERIVED" : "ASSUMPTION",
    evidenceRefs,
  };
}

function researchNarrativeLines(
  value: unknown,
  allowedEvidenceRefs: readonly string[],
): ProductBriefEvidenceLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = researchNarrativeLine(item, allowedEvidenceRefs);
    return parsed ? [parsed] : [];
  }).slice(0, 80);
}

function uniqueEvidenceLines(lines: readonly ProductBriefEvidenceLine[]): ProductBriefEvidenceLine[] {
  const seen = new Set<string>();
  return lines.filter((item) => {
    const key = `${item.text}\u0000${item.evidenceRefs.join("\u0001")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validStoredResearchReport(root: Record<string, unknown>, taskId: string): StoredResearchReport | null {
  const stored = readStoredResearchReport(root);
  return stored?.report.taskId === taskId ? stored : null;
}

function productFactLine(textValue: string, fact: ProductFact | null, nature: ProductBriefEvidenceLine["nature"] = "FACT", field?: FactField<unknown>): ProductBriefEvidenceLine {
  return { text: textValue, nature, evidenceRefs: refsForFact(fact, field) };
}

/** P0-BR-A1：从已确认 ProductFact 搬运规格行（缺失字段不造行）。 */
function buildSpecificationRows(fact: ProductFact | null): ProductBriefSpecRow[] {
  if (!fact) return [];
  const rows: ProductBriefSpecRow[] = [];
  const add = (id: string, label: string, value: string | null, unit: string | null, field?: FactField<unknown>) => {
    if (!value) return;
    const fieldRefs = refsForFact(fact, field);
    rows.push({ id, label, value: value.slice(0, 300), unit, nature: fieldRefs.length ? "FACT" : "ASSUMPTION", verification: "unverified", evidenceRefs: fieldRefs });
  };
  const itemDimensions = fieldValue(fact.profit.itemDimensions);
  if (itemDimensions) {
    const dimensions = [itemDimensions.length, itemDimensions.width, itemDimensions.height]
      .filter((dimension): dimension is number => typeof dimension === "number");
    add("spec_item_dimensions", "单品尺寸", dimensions.join("×"), itemDimensions.unit, fact.profit.itemDimensions);
  }
  const packageDimensions = fieldValue(fact.profit.packageDimensions);
  if (packageDimensions) add("spec_package_dimensions", "包装尺寸", `${packageDimensions.length}×${packageDimensions.width}×${packageDimensions.height}`, packageDimensions.unit, fact.profit.packageDimensions);
  const itemWeight = fact.profit.itemWeight ? fieldValue(fact.profit.itemWeight) : null;
  if (itemWeight) add("spec_item_weight", "单品净重", String(itemWeight.value), itemWeight.unit, fact.profit.itemWeight);
  const packageWeight = fieldValue(fact.profit.packageWeight);
  if (packageWeight) add("spec_package_weight", "包装重量", String(packageWeight.value), packageWeight.unit, fact.profit.packageWeight);
  const material = fact.extended ? fieldValue(fact.extended.material) : null;
  if (material) add("spec_material", "材质", material, null, fact.extended?.material);
  const components = fact.extended ? fieldValue(fact.extended.includedComponents) : null;
  if (components?.length) add("spec_components", "包装包含物", components.slice(0, 20).join("、"), null, fact.extended?.includedComponents);
  return rows;
}

function productTitleFromSample(sample: Record<string, unknown>): string | null {
  const title = isRecord(sample.title) && sample.title.presence === "present" && typeof sample.title.value === "string" ? sample.title.value : null;
  return title;
}

function imageFromSample(sample: Record<string, unknown>): string | null {
  const imageRef = isRecord(sample.imageRef) ? sample.imageRef : null;
  return imageRef?.kind === "external_url" && typeof imageRef.url === "string" ? imageRef.url : null;
}

function factValueFromSample(sample: Record<string, unknown>, key: string): string | null {
  const value = sample[key];
  return isRecord(value) && value.presence === "present" && typeof value.value === "string" ? value.value : null;
}

function currentProductGateIsProceed(detail: Awaited<ReturnType<typeof getResearchDetail>>): boolean {
  const choice = isRecord(detail.myChoice) ? detail.myChoice : null;
  return choice?.canonicalStatus === "PROCEED" || choice?.choice === "PROCEED";
}

function economicOriginFromLine(line: Record<string, unknown> | null, fallback: ProductBriefEconomicOrigin): ProductBriefEconomicOrigin {
  if (line?.nature === "USER_INPUT") return "USER_INPUT";
  if (line?.nature === "ESTIMATED") return "RESEARCH_ESTIMATE";
  if (line?.nature === "CONFIRMED_REFERENCE") return "PRODUCT_FACT";
  return fallback;
}

function economicProvenanceEntry(input: {
  origin: ProductBriefEconomicOrigin;
  source?: unknown;
  note?: unknown;
}): { origin: ProductBriefEconomicOrigin; source: string | null; note: string | null } {
  return {
    origin: input.origin,
    source: typeof input.source === "string" && input.source.trim() ? input.source.trim().slice(0, 160) : null,
    note: typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 300) : null,
  };
}

function buildEconomicsProvenance(input: {
  previous: ProductBrief | null;
  commercialTargetPrice: number | null;
  fbaFee: number | null;
  ue: Record<string, unknown> | null;
  ueTargetPrice: number | null;
  ueReferral: number | null;
  ueLogistics: number | null;
  referralLine: Record<string, unknown> | null;
  logisticsLine: Record<string, unknown> | null;
}): ProductBriefEconomicsProvenance {
  const previousProvenance = input.previous?.economics.provenance ?? {};
  const lineSource = (line: Record<string, unknown> | null) => typeof line?.source === "string" ? line.source : null;
  const lineNote = (line: Record<string, unknown> | null) => typeof line?.note === "string" ? line.note : null;
  // P3-03：只有「人工填写」的来源可以跨重新生成继承；
  // 研究估算 / 商业输入派生 / 商品事实派生的值与来源必须每次按当前来源重算，
  // 否则输入变化后会把旧金额继续标成新来源（旧结论与新输入拼接）。
  const manual = (key: keyof ProductBriefEconomicsProvenance) => previousProvenance[key]?.source === "product-brief-owner";
  const derivedPriceChanged = (key: keyof ProductBriefEconomicsProvenance) => previousProvenance[key]?.source === "product-brief-derived-price-changed";
  const provenance: ProductBriefEconomicsProvenance = {};

  if (manual("targetPrice")) {
    provenance.targetPrice = previousProvenance.targetPrice!;
  } else if (input.ueTargetPrice !== null) {
    const sellingPrice = isRecord(input.ue?.sellingPrice) ? input.ue.sellingPrice : null;
    provenance.targetPrice = economicProvenanceEntry({
      origin: economicOriginFromLine(sellingPrice, "RESEARCH_ESTIMATE"),
      source: sellingPrice?.source ?? "03.unitEconomics",
      note: sellingPrice?.note ?? "沿用 03 单位经济学输入，仍需人工确认是否作为开发目标价。",
    });
  } else if (input.commercialTargetPrice !== null) {
    provenance.targetPrice = economicProvenanceEntry({
      origin: "USER_INPUT",
      source: "candidateAnalysisContext.commercialInputs.targetSellingPrice",
      note: "来自人工填写的开发目标售价。",
    });
  } else provenance.targetPrice = economicProvenanceEntry({ origin: "MISSING", note: "尚未填写开发目标售价，竞品售价不能替代。" });

  provenance.targetMarginPct = manual("targetMarginPct")
    ? previousProvenance.targetMarginPct!
    : economicProvenanceEntry({ origin: "MISSING", note: "尚未由人工填写。" });

  if (manual("referralFee") || derivedPriceChanged("referralFee")) {
    provenance.referralFee = previousProvenance.referralFee!;
  } else {
    provenance.referralFee = economicProvenanceEntry({
      origin: input.ueReferral !== null ? economicOriginFromLine(input.referralLine, "RESEARCH_ESTIMATE") : "MISSING",
      source: lineSource(input.referralLine) ?? (input.ueReferral !== null ? "03.unitEconomics" : null),
      note: lineNote(input.referralLine) ?? (input.ueReferral !== null ? "来自 03 单位经济学情景，需人工核对平台费率。" : "尚未提供，不能猜测。"),
    });
  }

  provenance.fbaFee = manual("fbaFee")
    ? previousProvenance.fbaFee!
    : economicProvenanceEntry({ origin: input.fbaFee !== null ? "PRODUCT_FACT" : "MISSING", source: input.fbaFee !== null ? "ProductFact.profit.fbaFee" : null, note: input.fbaFee !== null ? "来自已确认商品事实；不等同于开发后报价。" : "尚未提供。" });

  if (manual("logistics")) {
    provenance.logistics = previousProvenance.logistics!;
  } else {
    provenance.logistics = economicProvenanceEntry({
      origin: input.ueLogistics !== null ? economicOriginFromLine(input.logisticsLine, "RESEARCH_ESTIMATE") : "MISSING",
      source: lineSource(input.logisticsLine) ?? (input.ueLogistics !== null ? "03.unitEconomics" : null),
      note: lineNote(input.logisticsLine) ?? (input.ueLogistics !== null ? "来自 03 单位经济学情景，需人工核对物流口径。" : "尚未提供，不能猜测。"),
    });
  }

  provenance.estimatedTax = manual("estimatedTax")
    ? previousProvenance.estimatedTax!
    : economicProvenanceEntry({ origin: "MISSING", note: "尚未提供，不能猜测。" });
  provenance.otherKnownCosts = manual("otherKnownCosts")
    ? previousProvenance.otherKnownCosts!
    : economicProvenanceEntry({ origin: "MISSING", note: "尚未提供，不能猜测。" });
  return provenance;
}

async function jsonSnapshot(taskId: string) {
  const task = await prisma.viralAnalysisRecord.findUnique({ where: { id: taskId }, select: { id: true, type: true, resultJson: true, updatedAt: true } });
  if (!task || task.type !== "workflow") throw new ProductBriefError("RESEARCH_TASK_NOT_FOUND", 404, "正式商品深研任务不存在。",);
  return task;
}

/** 兼容旧 detail 形状：只在缺少 reportResolution 字段时使用，不改变真实歧义判定。 */
function inferResolutionForLegacyDetail(
  detail: { report?: unknown; reportHash?: string | null; researchRevision?: number | null },
  storedV1Hash: string | null,
): {
  status: "current" | "missing";
  source: "v1" | "v5" | null;
  reportHash: string | null;
  generatedAt: string | null;
  researchRevision: number | null;
  otherPresent: boolean;
  reason: string;
  candidates: { source: string; reportHash: string; generatedAt: string | null }[];
} {
  if (detail.report && typeof detail.report === "object") {
    return {
      status: "current",
      source: "v5",
      reportHash: detail.reportHash ?? "",
      generatedAt: null,
      researchRevision: typeof detail.researchRevision === "number" ? detail.researchRevision : null,
      otherPresent: false,
      reason: "only_candidate",
      candidates: [],
    };
  }
  if (storedV1Hash) {
    return { status: "current", source: "v1", reportHash: storedV1Hash, generatedAt: null, researchRevision: null, otherPresent: false, reason: "only_candidate", candidates: [] };
  }
  return { status: "missing", source: null, reportHash: null, generatedAt: null, researchRevision: null, otherPresent: false, reason: "no_report", candidates: [] };
}

async function briefContext(context: AccessContext, taskId: string, allowUntrustedDraft = false) {
  if (context.mode !== "owner") throw new ProductBriefError("PRODUCT_BRIEF_OWNER_REQUIRED", 403, "Product Brief 仅对 Owner 开放。");
  const detail = await getResearchDetail({ context, taskId });
  // 权威不明时给出更精确的拒绝码，避免被笼统的「证据已变化」掩盖。
  // 用局部别名判断，避免 TS 把后续 resolution 联合类型收窄掉 ambiguous 分支。
  const declaredResolution = detail.reportResolution;
  if (declaredResolution?.status === "ambiguous") {
    throw new ProductBriefError("RESEARCH_REPORT_AUTHORITY_AMBIGUOUS", 409, "当前无法确认哪一份是正式报告（V1 与 V5 并存且缺少权威记录）。请重新生成一次研报后再生成需求单。");
  }
  if (detail.stale) throw new ProductBriefError("RESEARCH_EVIDENCE_STALE", 409, "研究证据或决策绑定已变化，请先重新确认研究。",);
  if (!currentProductGateIsProceed(detail)) throw new ProductBriefError("PRODUCT_GATE_PROCEED_REQUIRED", 409, "请先在 Product Gate 选择“继续推进”，再形成 Product Brief。",);
  // P1-VOC-02：读取既有 VOC 主题分析（fail-soft：未分析/读取失败 = null，Brief 生成不阻断）
  const vocAnalysis = await getVocAnalysis(context, taskId).catch(() => null);
  const [bundle, task] = await Promise.all([
    buildResearchInputBundle({ context, taskId, recordDiagnostic: false }),
    jsonSnapshot(taskId),
  ]);
  const root = parseJsonRecord(task.resultJson);
  const storedResearchReport = validStoredResearchReport(root, taskId);
  const factSubjectKey = isRecord(bundle.productFact) && typeof bundle.productFact.subjectKey === "string"
    ? bundle.productFact.subjectKey
    : null;
  const usableV1Report = storedResearchReport
    && (!factSubjectKey || storedResearchReport.report.subjectKey === factSubjectKey)
    ? storedResearchReport
    : null;
  // 需求单必须与研究详情、人工决定使用同一份正式报告（权威由 researchCurrentReport 指针判定）。
  // 说明：生产 `getResearchDetail` 恒返回 reportResolution；仅当调用方传入的是没有该字段的
  // 旧 detail 形状（历史替身/测试）时，才退回「按已存在报告推断」的兼容判定。
  // 真实歧义（字段存在且 status=ambiguous）永远不会走这条兼容路径。
  const resolution = detail.reportResolution ?? inferResolutionForLegacyDetail(detail, usableV1Report?.reportHash ?? null);
  if (resolution?.status === "ambiguous") {
    throw new ProductBriefError("RESEARCH_REPORT_AUTHORITY_AMBIGUOUS", 409, "当前无法确认哪一份是正式报告（V1 与 V5 并存且缺少权威记录）。请重新生成一次研报后再生成需求单。");
  }
  if (!resolution || resolution.status !== "current") {
    throw new ProductBriefError("RESEARCH_REPORT_REQUIRED", 409, "请先完成正式商品深研报告。");
  }
  const authoritativeSource = resolution.source;
  const researchReport = authoritativeSource === "v1" ? usableV1Report : null;
  if (authoritativeSource === "v1" && !researchReport) {
    // 权威是 v1 但报告不可用（缺失/主体不符/结构非法）→ 保守拒绝，不回退到 v5 内容。
    throw new ProductBriefError("RESEARCH_REPORT_REQUIRED", 409, "当前正式研报（V1）不可用或与商品主体不一致，请重新生成研究。");
  }
  if (authoritativeSource === "v5" && (!detail.report || typeof detail.report !== "object")) {
    throw new ProductBriefError("RESEARCH_REPORT_REQUIRED", 409, "请先完成正式商品深研报告。");
  }
  const claimBlock = claimConsumptionBlockReason(detail.claimAudit);
  if (!allowUntrustedDraft && claimBlock) throw new ProductBriefError(claimBlock, 409, claimConsumptionNotice(detail.claimAudit));
  const authoritativeReportHash = resolution.reportHash ?? "";
  const marketProvenance = isRecord(detail.marketProvenance) ? detail.marketProvenance : null;
  let market: {
    scanId: string;
    scanName: string;
    sampleHash: string;
    metricsVersion: string;
    role: "benchmark" | "newcomer" | "pain_point";
    sampleKey: string;
    benchmarks: ProductBrief["benchmarks"];
  } | null = null;
  if (marketProvenance && typeof marketProvenance.marketScanId === "string" && typeof marketProvenance.marketSampleKey === "string") {
    const scan = await prisma.marketScan.findUnique({ where: { id: marketProvenance.marketScanId } });
    if (scan) {
      const snapshot = parseJsonRecord(scan.sampleSnapshotJson);
      const samples = Array.isArray(snapshot.items) ? snapshot.items.filter(isRecord) : [];
      const workflow = readMarketWorkflowMetadata(parseJsonRecord(scan.sampleDefinitionJson), {
        scanId: scan.id,
        sampleHash: scan.sampleHash,
        metricsHash: hashJson(parseJsonRecord(scan.metricsJson)),
        metricsVersion: scan.metricsVersion,
      });
      const selected = workflow.metadata.representatives.items;
      const benchmarks = selected.flatMap((representative) => {
        const sample = samples.find((item) => `${scan.id}:${String(item.asin ?? "").toUpperCase()}` === representative.marketSampleKey);
        if (!sample) return [];
        return [{
          asin: String(sample.asin ?? representative.asin).toUpperCase(),
          title: productTitleFromSample(sample),
          imageUrl: imageFromSample(sample),
          marketplace: scan.marketplace,
          role: representative.role,
          marketSampleKey: representative.marketSampleKey,
          evidenceRefs: typeof sample.evidenceId === "string" ? [`evidence:${sample.evidenceId}`] : [],
        }];
      }).slice(0, PRODUCT_BRIEF_MAX_BENCHMARKS);
      market = {
        scanId: scan.id,
        scanName: scan.scanName,
        sampleHash: scan.sampleHash,
        metricsVersion: scan.metricsVersion,
        role: marketProvenance.role === "newcomer" || marketProvenance.role === "pain_point" ? marketProvenance.role : "benchmark",
        sampleKey: marketProvenance.marketSampleKey,
        benchmarks,
      };
    }
  }
  return { detail, bundle, task, root, market, vocAnalysis, researchReport, authoritativeReportHash, authoritativeSource };
}

function buildBrief(
  input: Awaited<ReturnType<typeof briefContext>>,
  previous: ProductBrief | null = null,
  options: { resetDerivedFields?: boolean } = {},
): ProductBrief {
  // P3-02：默认保留人工内容；显式 resetDerivedFields 时只重置“研究派生且可编辑”的列表，
  // 不动 targetUser 与 economics（用户输入，重算会丢判断）。
  const prevSpecs = options.resetDerivedFields ? undefined : previous?.specifications;
  const prevConfirmations = options.resetDerivedFields ? undefined : previous?.confirmationItems;
  const prevBenchmark = options.resetDerivedFields ? undefined : previous?.benchmarkComparison;
  const prevVerification = options.resetDerivedFields ? undefined : previous?.verificationPlan;
  const prevPositioning = options.resetDerivedFields ? undefined : previous?.positioning;
  const { detail, bundle, market, vocAnalysis, researchReport, root } = input;
  const fact = bundle.productFact;
  const report = isRecord(detail.report) ? detail.report : {};
  const v1Report = researchReport?.report ?? null;
  const price = fact ? fieldValue(fact.basic.price)?.amount ?? null : null;
  const fbaFee = fact ? fieldValue(fact.profit.fbaFee)?.amount ?? null : null;
  const brand = fact ? fieldValue(fact.basic.brand) : null;
  const category = fact ? fieldValue(fact.basic.category) : null;
  const title = fact ? fieldValue(fact.basic.title) : null;
  const imageUrl = fact ? fieldValue(fact.basic.image) : null;
  const currency = fact ? fieldValue(fact.basic.price)?.currency ?? "USD" : "USD";
  const voc = isRecord(report.vocAnalysis) ? report.vocAnalysis : {};
  const allowedEvidenceRefs = Array.isArray(bundle.sourceEvidenceRefs)
    ? bundle.sourceEvidenceRefs.map((ref) => ref.refId)
    : [];
  const bindings = Array.isArray(report.narrativeBindings)
    ? report.narrativeBindings.filter((b): b is Record<string, unknown> => isRecord(b))
    : [];
  const painPoints = resolveNarrativeLines(voc.painPoints, { fieldPrefix: "vocAnalysis.painPoints", bindings, allowedEvidenceRefs });
  const failureModes = resolveNarrativeLines(voc.failureModes, { fieldPrefix: "vocAnalysis.failureModes", bindings, allowedEvidenceRefs });
  const useCases = resolveNarrativeLines(voc.useCases, { fieldPrefix: "vocAnalysis.useCases", bindings, allowedEvidenceRefs });
  const opportunities = resolveNarrativeLines(report.opportunities, { fieldPrefix: "opportunities", bindings, allowedEvidenceRefs });
  const risks = resolveNarrativeLines(report.risks, { fieldPrefix: "risks", bindings, allowedEvidenceRefs });
  const summary = resolveNarrativeLine(report.summary, { field: "summary", bindings, allowedEvidenceRefs });
  const v1Summary = v1Report ? researchNarrativeLine(v1Report.executiveSummary.analysis, allowedEvidenceRefs) : null;
  const v1PainPoints = v1Report ? researchNarrativeLines(v1Report.vocAnalysis.painPoints, allowedEvidenceRefs) : [];
  const v1Differentiation = v1Report ? researchNarrativeLines(v1Report.competitionInsight.differentiationSuggestions, allowedEvidenceRefs) : [];
  const v1Risks = v1Report ? researchNarrativeLines(v1Report.riskAssessment.risks, allowedEvidenceRefs) : [];
  const v1CompetitiveHypotheses = v1Report ? researchNarrativeLines(v1Report.competitionInsight.causalHypotheses, allowedEvidenceRefs)
    .map((line) => ({ ...line, nature: "ASSUMPTION" as const, text: `【待验证原因假设】${line.text}` })) : [];
  const v1Alternatives = v1Report ? researchNarrativeLines(v1Report.competitionInsight.alternatives, allowedEvidenceRefs) : [];
  const v1SupportingEvidence = v1Report ? researchNarrativeLines(v1Report.competitionInsight.supportingEvidence, allowedEvidenceRefs) : [];
  const v1Counterevidence = v1Report ? researchNarrativeLines(v1Report.competitionInsight.counterevidence, allowedEvidenceRefs) : [];
  const causalInvestigations = v1Report?.competitionInsight.causalInvestigations?.flatMap((item) => {
    const hypothesis = researchNarrativeLine(item.hypothesis, allowedEvidenceRefs);
    if (!hypothesis || hypothesis.evidenceRefs.some((ref) => !allowedEvidenceRefs.includes(ref))) return [];
    const checkedLines = (items: unknown) => researchNarrativeLines(items, allowedEvidenceRefs).filter((line) => line.evidenceRefs.every((ref) => allowedEvidenceRefs.includes(ref)));
    // P2-02：rationale 也必须过同一份引用白名单；越界就丢弃，不保留无依据的「为什么」。
    const rationale = item.rationale ? researchNarrativeLine(item.rationale, allowedEvidenceRefs) : null;
    return [{ hypothesis: { ...hypothesis, nature: "ASSUMPTION" as const }, ...(rationale && rationale.evidenceRefs.every((ref) => allowedEvidenceRefs.includes(ref)) ? { rationale } : {}), supportingEvidence: checkedLines(item.supportingEvidence), counterevidence: checkedLines(item.counterevidence), unknowns: item.unknowns, confidence: item.confidence, verification: item.verification }];
  });
  const v1VerificationItems = v1Report
    ? uniqueEvidenceLines([
        ...researchNarrativeLines(v1Report.competitionInsight.verificationItems, allowedEvidenceRefs),
        ...researchNarrativeLines(v1Report.riskAssessment.verificationItems, allowedEvidenceRefs),
      ])
    : [];
  const v1Assumptions = v1Report ? researchNarrativeLines(v1Report.unverifiedAssumptions, allowedEvidenceRefs) : [];
  const v1Rationale = v1Report
    ? [
        v1Summary,
        researchNarrativeLine(v1Report.marketOpportunity.analysis, allowedEvidenceRefs),
        researchNarrativeLine(v1Report.competitionInsight.analysis, allowedEvidenceRefs),
        researchNarrativeLine(v1Report.unitEconomics.analysis, allowedEvidenceRefs),
        researchNarrativeLine(v1Report.supplyChain.analysis, allowedEvidenceRefs),
      ].flatMap((item) => item ? [item] : [])
    : [];
  const projectOverview = v1Summary ?? summary;
  const corePainPoints = v1PainPoints.length ? v1PainPoints : painPoints;
  const differentiation = v1Differentiation.length ? v1Differentiation : opportunities;
  const mergedRisks = uniqueEvidenceLines([...v1Risks, ...risks]);
  const specs: ProductBriefEvidenceLine[] = [];
  const bulletPoints = fact ? fieldValue(fact.basic.bulletPoints) : null;
  if (bulletPoints?.length) specs.push(productFactLine(`现有商品卖点事实：${bulletPoints.slice(0, 5).join("；")}`, fact, "FACT", fact?.basic.bulletPoints));
  const material = fact?.extended ? fieldValue(fact.extended.material) : null;
  if (material) specs.push(productFactLine(`材质方向：${material}`, fact, "FACT", fact?.extended?.material));
  const included = fact?.extended ? fieldValue(fact.extended.includedComponents) : null;
  if (included?.length) specs.push(productFactLine(`已观察到的包含组件：${included.join("、")}`, fact, "FACT", fact?.extended?.includedComponents));
  const rationale = [
    ...(summary ? [summary] : []),
    ...opportunities.slice(0, 3),
  ];

  // P3-03：商业测算与假设复用（03 已有 unitEconomics 输入可继承作为草案兜底）
  const ue = isRecord(detail.unitEconomics) ? detail.unitEconomics : null;
  const ueTargetPrice = ue?.sellingPrice?.nature === "USER_INPUT" && typeof ue.sellingPrice.amountUsd === "number" ? ue.sellingPrice.amountUsd : null;
  const costLines = Array.isArray(ue?.costLines) ? ue.costLines : [];
  // 03 单位经济性当前生产投影使用 `commission`；`referral_fee` 是旧快照/测试形状。
  // 两者都表示平台佣金，必须统一映射到 04 的 referralFee，不能因 key 演进静默丢失。
  const referralLine = costLines.find((l) => isRecord(l) && (l.key === "commission" || l.key === "referral_fee"));
  // 03 单位经济性生产投影使用 `shipping`；兼容旧快照中的 first_leg_freight/logistics。
  const logisticsLine = costLines.find((l) => isRecord(l) && (l.key === "shipping" || l.key === "first_leg_freight" || l.key === "logistics"));
  // 以竞品事实售价计算出的佣金不能当作拟开发目标价的佣金。
  const ueReferral = ueTargetPrice !== null && typeof referralLine?.amountUsd === "number" ? referralLine.amountUsd : null;
  const ueLogistics = typeof logisticsLine?.amountUsd === "number" ? logisticsLine.amountUsd : null;

  // P2-01 的商业输入与 03 单位经济性共用同一任务命名空间。成本不完整时，
  // 03 可能没有 costLines，但已保存的同币种人工佣金/物流仍应安全继承到 04；
  // 不做跨币种猜测，也不把人工输入伪装成 ProductFact。
  const commercialInputs = readCommercialInputs(root);
  const commercialTargetPrice = sameCurrencyMoneyAmount(commercialInputs.targetSellingPrice, currency);
  const commercialLogistics = sameCurrencyMoneyAmount(commercialInputs.logisticsCost, currency);
  const effectiveTargetPrice = ueTargetPrice ?? commercialTargetPrice;
  const commercialReferral = commercialInputs.commissionRate !== undefined && effectiveTargetPrice !== null
    ? roundEconomicAmount(effectiveTargetPrice * commercialInputs.commissionRate)
    : null;
  const commercialReferralLine = commercialReferral !== null && (ueReferral === null || Math.abs(ueReferral - commercialReferral) < 0.011)
    ? {
        nature: "USER_INPUT",
        source: "candidateAnalysisContext.commercialInputs.commissionRate",
        note: "来自人工商业输入；平台费率性质仍以商业输入标记，不替代来源事实。",
      }
    : null;
  const commercialLogisticsLine = ueLogistics === null && commercialLogistics !== null
    ? {
        nature: "USER_INPUT",
        source: "candidateAnalysisContext.commercialInputs.logisticsCost",
        note: "来自人工商业输入的单件物流费用。",
      }
    : null;
  const effectiveReferralLine = commercialReferralLine ?? (ueReferral !== null && isRecord(referralLine) ? referralLine : null);
  const effectiveLogisticsLine = isRecord(logisticsLine) ? logisticsLine : commercialLogisticsLine;
  const effectiveReferral = ueReferral ?? commercialReferral;
  const effectiveLogistics = ueLogistics ?? commercialLogistics;

  // P3-03：人工填写值跨重新生成保留；研究/商业输入派生值必须按当前来源重算，
  // 不能因为「上一版有这个数字」就继续沿用（否则输入变化后金额与来源标注不一致）。
  const previousProvenance = previous?.economics.provenance;
  const ownerManual = (key: keyof ProductBriefEconomicsProvenance) => previousProvenance?.[key]?.source === "product-brief-owner";
  const targetPrice = ownerManual("targetPrice") ? previous!.economics.targetPrice : effectiveTargetPrice;
  const targetMarginPct = previous?.economics.targetMarginPct ?? null;
  const referralFee = ownerManual("referralFee") || previousProvenance?.referralFee?.source === "product-brief-derived-price-changed"
    ? previous!.economics.referralFee : effectiveReferral;
  const logistics = ownerManual("logistics") ? previous!.economics.logistics : effectiveLogistics;
  const estimatedTax = previous?.economics.estimatedTax ?? null;
  const otherKnownCosts = previous?.economics.otherKnownCosts ?? null;
  const economicsProvenance = buildEconomicsProvenance({
    previous,
    commercialTargetPrice,
    fbaFee,
    ue,
    ueTargetPrice,
    ueReferral: effectiveReferral,
    ueLogistics: effectiveLogistics,
    referralLine: effectiveReferralLine,
    logisticsLine: effectiveLogisticsLine,
  });
  const purchaseCostCeiling = calculatePurchaseCostCeiling({ targetPrice, targetMarginPct, referralFee, fbaFee, logistics, estimatedTax, otherKnownCosts, currency });
  const missingValidation = [
    ...(targetPrice === null ? ["目标售价尚未由人工填写；竞品售价仅供参考。"] : []),
    ...(targetMarginPct === null ? ["目标毛利率尚未由人工填写。"] : []),
    ...(referralFee === null ? ["平台 referral fee 尚未提供，购买成本上限暂不能完整计算。"] : []),
    ...(logistics === null ? ["头程/物流成本尚未提供，不能猜测。"] : []),
    ...(estimatedTax === null ? ["税费尚未提供，不能猜测。"] : []),
    ...(corePainPoints.length === 0 ? ["当前研究没有带合法引用的 VOC 痛点。"] : []),
    ...(market ? [] : ["该任务走快速通道，未绑定市场扫描；市场规模与代表商品需另行补证。"]),
    "未提供供应商报价、制造可行性、法规/IP 验证；本 Brief 不替代执行系统。",
    ...v1Assumptions.map((item) => `研究未验证假设：${item.text}`),
    ...v1VerificationItems.map((item) => `研究验证事项：${item.text}`),
  ];
  const missingItems = [...new Set(missingValidation)];

  // P3-02：人工编辑保留（重新生成时保留用户先前填写的规格方向与确认项，同时增量合并新来源派生）
  const freshSpecs = buildSpecificationRows(fact);
  const specifications: ProductBriefSpecRow[] = prevSpecs !== undefined
    ? prevSpecs.length
      ? [
          ...prevSpecs,
          ...freshSpecs.filter((fs) => !prevSpecs.some((ps) => ps.id === fs.id)),
        ]
      : []
    : freshSpecs;

  // P1-VOC-01/02：VOC 主题 → 改进需求 + 待供应商确认问题（确定性派生，与 vocImprovement 同源；无分析时为空，固定基线仍保留）
  const vocRequirements: ProductBriefEvidenceLine[] = vocAnalysis
    ? deriveImprovementRequirements(vocAnalysis.themes.painPointThemes, vocAnalysis.themes.recurringRequests).map((requirement) => ({
        text: requirement.requirement,
        nature: "EVIDENCE_DERIVED" as const,
        evidenceRefs: requirement.evidenceRefs,
      }))
    : [];
  const vocCheckpoints: ProductBriefConfirmationItem[] = vocAnalysis
    ? deriveSupplierCheckpoints(vocAnalysis.themes.painPointThemes).map((checkpoint) => ({
        id: checkpoint.id,
        item: checkpoint.checkpoint,
        status: "待确认" as const,
        reason: `由买家反馈派生（来源痛点：「${checkpoint.sourceThemeLabel}」），待供应商确认`,
      }))
    : [];
  const confirmationItems: ProductBriefConfirmationItem[] = prevConfirmations !== undefined
    ? prevConfirmations.length
      ? [
          ...prevConfirmations,
          ...vocCheckpoints.filter((vc) => !prevConfirmations.some((pc) => pc.id === vc.id)),
        ]
      : []
    : [
        ...vocCheckpoints,
        { id: "cfq_moq", item: "起订量（MOQ）与阶梯报价是否满足首单需求", status: "待确认", reason: "需要供应商确认" },
        { id: "cfq_sample", item: "是否支持样品测试与结构、做工改进确认", status: "待确认", reason: "需要供应商确认" },
        { id: "cfq_package", item: "出厂包装是否满足跨境运输防损要求", status: "待确认", reason: "需要供应商确认" },
        { id: "cfq_compliance", item: "质检报告与出口资质是否齐全", status: "待确认", reason: "需要供应商确认" },
        { id: "cfq_leadtime", item: "打样周期与交期是否满足开发节奏", status: "待确认", reason: "需要供应商确认" },
      ];
  const rating = fact ? fieldValue(fact.basic.rating) : null;
  const reviewCount = fact ? fieldValue(fact.basic.reviewCount) : null;
  const comparisonNote = `对照资料来自研究来源商品 ${detail.asin}；不是拟开发商品的已确认事实。`;

  const benchmarkComparison: ProductBriefBenchmarkComparison = prevBenchmark !== undefined
    ? prevBenchmark
    : {
        rows: [
          { id: "cmp_price", label: "价格", ours: targetPrice !== null ? `${targetPrice.toFixed(2)} ${currency}` : null, theirs: price !== null ? `${price.toFixed(2)} ${currency}` : null, nature: "ASSUMPTION", note: comparisonNote },
          { id: "cmp_rating", label: "评分", ours: null, theirs: rating !== null ? String(rating) : null, nature: "ASSUMPTION", note: comparisonNote },
          { id: "cmp_reviews", label: "评论数", ours: null, theirs: reviewCount !== null ? String(reviewCount) : null, nature: "ASSUMPTION", note: comparisonNote },
          { id: "cmp_selling_point", label: "核心卖点差异", ours: null, theirs: bulletPoints?.length ? bulletPoints.slice(0, 3).join("；") : null, nature: "ASSUMPTION", note: comparisonNote },
        ],
      };
  const freshResearchVerificationPlan = v1VerificationItems.map((item, index) => ({
    id: `research_v_${index + 1}`,
    item: item.text,
    method: "",
    timing: "",
    status: "pending" as const,
  }));
  // P3-03：验证计划里由「缺失项」自动生成的条目必须跟随当前缺失状态。
  // 用户填了目标售价/毛利率后，旧条目「目标售价尚未由人工填写」不能再留在文档里，
  // 否则导出会同时出现「目标售价：29.99」和「目标售价尚未由人工填写」。
  // 只清理「未被人工动过」的自动条目（id 形如 v_N、方法/时点为空、状态 pending）；
  // 人工补过方法/时点/状态或自行新增的条目一律保留。
  // 「缺失项」自动生成的验证条目（id 形如 v_N）代表某个条件当时不满足；
  // 条件已满足时必须清掉，否则导出会同时出现「目标售价：29.99」和「目标售价尚未由人工填写」。
  // 只清理这一类自动条目，人工新增条目（其他 id）与研究派生条目一律保留。
  const isAutoMissingItem = (item: NonNullable<ProductBrief["verificationPlan"]>[number]): boolean => /^v_\d+$/u.test(item.id);
  // 重新生成时只清理、不新增：否则用户主动清空的验证计划会被自动补回。
  const verificationPlan = prevVerification !== undefined
    ? prevVerification.filter((item) => !isAutoMissingItem(item) || missingItems.includes(item.item))
    : [...freshResearchVerificationPlan, ...missingItems.map((item, index) => ({ id: `v_${index + 1}`, item, method: "", timing: "", status: "pending" as const }))];

  // P0-BR-BR02：定位取自研报 differentiation / opportunities / summary 首条（无则显式 null，由人工填写为 ASSUMPTION）；
  // 用户场景 = VOC useCases（已有数据，纯读取）。空值诚实，不编造。
  const positioning = prevPositioning !== undefined
    ? prevPositioning
    : resolveNarrativeLine(report.differentiation, { field: "differentiation", bindings, allowedEvidenceRefs }) ?? differentiation[0] ?? projectOverview ?? null;
  const userScenarios = useCases;
  const brief: ProductBrief = {
    schemaVersion: PRODUCT_BRIEF_SCHEMA,
    status: "DRAFT",
    revision: (previous?.revision ?? 0) + 1,
    generatedAt: new Date().toISOString(),
    sourceBinding: {
      taskId: detail.taskId,
      researchRevision: Number(detail.researchRevision),
      reportHash: input.authoritativeReportHash,
      factHash: detail.factHash ?? "",
      evidenceHash: detail.evidenceHash ?? "",
      marketScanId: market?.scanId ?? null,
      marketSampleHash: market?.sampleHash ?? null,
    },
    identity: { asin: detail.asin, title: title ?? detail.title ?? null, imageUrl, brand, category, marketplace: detail.marketplace },
    projectOverview,
    targetUser: previous?.targetUser ?? null,
    corePainPoints,
    benchmarks: market?.benchmarks.length ? market.benchmarks : [{ asin: detail.asin, title: title ?? detail.title ?? null, imageUrl, marketplace: detail.marketplace, role: "fast_track", marketSampleKey: null, evidenceRefs: refsForFact(fact) }],
    differentiation,
    economics: { targetPrice, targetMarginPct, referralFee, fbaFee, logistics, estimatedTax, otherKnownCosts, currency, provenance: economicsProvenance, purchaseCostCeiling },
    specsDirection: specs,
    vocQaRedlines: failureModes.map((item) => ({ ...item, text: `QA redline：${item.text}` })),
    risks: mergedRisks,
    rationale: uniqueEvidenceLines([...v1Rationale, ...(summary ? [summary] : []), ...opportunities.slice(0, 3)]),
    missingValidation: missingItems,
    specifications,
    confirmationItems,
    benchmarkComparison,
    verificationPlan,
    positioning,
    userScenarios,
    // P1-VOC/BR-03：recurring 痛点派生的改进方向（待验证假设，非已确认产品要求）。
    // 历史上该字段只被计算却未写入 brief，导致 04 页无法展示；此处补齐映射。
    vocRequirements,
    ...(researchReport ? {
      competitiveHypotheses: v1CompetitiveHypotheses,
      researchAlternatives: v1Alternatives,
      supportingEvidence: v1SupportingEvidence,
      counterevidence: v1Counterevidence,
      researchAssumptions: v1Assumptions,
      ...(causalInvestigations !== undefined ? { causalInvestigations } : {}),
    } : {}),
  };
  return brief;
}

function briefIsCurrent(brief: ProductBrief, context: Awaited<ReturnType<typeof briefContext>>): boolean {
  const authoritativeReportHash = context.authoritativeReportHash;
  return brief.sourceBinding.taskId === context.detail.taskId
    && brief.sourceBinding.researchRevision === Number(context.detail.researchRevision)
    && brief.sourceBinding.reportHash === authoritativeReportHash
    && brief.sourceBinding.factHash === (context.detail.factHash ?? "")
    && brief.sourceBinding.evidenceHash === (context.detail.evidenceHash ?? "")
    && brief.sourceBinding.marketScanId === (context.market?.scanId ?? null)
    && brief.sourceBinding.marketSampleHash === (context.market?.sampleHash ?? null);
}

export async function readProductBrief(input: { context: AccessContext; taskId: string }) {
  if (input.context.mode !== "owner") throw new ProductBriefError("PRODUCT_BRIEF_OWNER_REQUIRED", 403, "Product Brief 仅对 Owner 开放。");
  const task = await jsonSnapshot(input.taskId);
  const root = parseJsonRecord(task.resultJson);
  const stored = parseProductBrief(root.productBrief);
  const currentAudit = await getResearchDetail({ context: input.context, taskId: input.taskId })
    .then(detail => detail.claimAudit ?? makeUnavailableClaimAudit())
    .catch(() => makeUnavailableClaimAudit());
  const projectedStored = stored ? { ...stored, claimAudit: currentAudit } : null;
  const history = readProductBriefHistory(root.productBriefHistory);
  const historyView = { history: history.items, historyIntegrity: history.valid ? "VALID" as const : "INVALID" as const };
  if (!stored) {
    // 无既有需求单时同样暴露服务端口径的门禁状态（与 briefContext 相同的判定来源：
    // detail.reportResolution / detail.stale / currentProductGateIsProceed / detail.report），
    // 让前端按钮状态反映服务端必然的接受或拒绝，而不是另写一套前端判断。
    // 报告权威未定与 briefContext 同序先判，避免被笼统的「证据已变化」掩盖。
    try {
      const detail = await getResearchDetail({ context: input.context, taskId: input.taskId });
      const storedResearchReport = validStoredResearchReport(root, input.taskId);
      const blockedReason = detail.reportResolution?.status === "ambiguous"
        ? "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS"
        : detail.stale
          ? "RESEARCH_EVIDENCE_STALE"
          : !currentProductGateIsProceed(detail)
            ? "PRODUCT_GATE_PROCEED_REQUIRED"
            : ((!detail.report || typeof detail.report !== "object") && !storedResearchReport)
              ? "RESEARCH_REPORT_REQUIRED"
              : claimConsumptionBlockReason(detail.claimAudit);
      return { taskId: input.taskId, claimAudit: currentAudit, brief: null, ...historyView, stale: blockedReason !== null, staleReason: blockedReason, resourceVersion: task.updatedAt.toISOString() };
    } catch (error) {
      if (error instanceof ProductBriefError) return { taskId: input.taskId, claimAudit: currentAudit, brief: null, ...historyView, stale: true, staleReason: error.code, resourceVersion: task.updatedAt.toISOString() };
      throw error;
    }
  }
  try {
    const context = await briefContext(input.context, input.taskId, true);
    const audit = currentAudit;
    return { taskId: input.taskId, claimAudit: currentAudit, brief: { ...stored, claimAudit: audit }, ...historyView, stale: !briefIsCurrent(stored, context), staleReason: briefIsCurrent(stored, context) ? null : "RESEARCH_OR_MARKET_BINDING_CHANGED", resourceVersion: task.updatedAt.toISOString() };
  } catch (error) {
    // V13：报告权威未定（V1/V5 并存）时历史需求单仍可只读查看——
    // 与「来源变化」同款降级：brief 原样返回 + stale 标记；写入门禁不变（briefContext 已拒绝生成/保存）。
    if (error instanceof ProductBriefError && ["PRODUCT_GATE_PROCEED_REQUIRED", "RESEARCH_EVIDENCE_STALE", "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS"].includes(error.code)) return { taskId: input.taskId, claimAudit: currentAudit, brief: projectedStored, ...historyView, stale: true, staleReason: error.code, resourceVersion: task.updatedAt.toISOString() };
    throw error;
  }
}

type BriefGenerateInput = { context: AccessContext; taskId: string; resetDerivedFields?: boolean; previewRevision?: number; previewSourceBinding?: ProductBrief["sourceBinding"]; idempotencyKey?: string };

async function replayBriefGeneration(input: BriefGenerateInput, fingerprint: string) {
  if (!input.idempotencyKey) return null;
  if (input.context.mode !== "owner") throw new ProductBriefError("PRODUCT_BRIEF_OWNER_REQUIRED", 403, "Product Brief 仅对 Owner 开放。");
  const task = await jsonSnapshot(input.taskId);
  const root = parseJsonRecord(task.resultJson);
  if (root.productBriefGenerationReceipts !== undefined && !isRecord(root.productBriefGenerationReceipts)) throw new ProductBriefError("PRODUCT_BRIEF_RECEIPTS_INVALID", 409, "生成记录异常，请检查数据。");
  const receipts = isRecord(root.productBriefGenerationReceipts) ? root.productBriefGenerationReceipts : {};
  const receipt = Object.hasOwn(receipts, input.idempotencyKey) ? receipts[input.idempotencyKey] : undefined;
  if (receipt === undefined) return null;
  if (!isRecord(receipt) || typeof receipt.fingerprint !== "string" || !Number.isInteger(receipt.revision)) throw new ProductBriefError("PRODUCT_BRIEF_RECEIPTS_INVALID", 409, "生成记录异常，请检查数据。");
  if (receipt.fingerprint !== fingerprint) throw new ProductBriefError("IDEMPOTENCY_KEY_REUSE", 409, "同一请求标识不能用于不同内容。");
  const current = parseProductBrief(root.productBrief);
  const history = readProductBriefHistory(root.productBriefHistory);
  if (!history.valid) throw new ProductBriefError("PRODUCT_BRIEF_HISTORY_INVALID", 409, "已有企划版本无法读取。");
  const brief = [current, ...history.items].find((item) => item?.revision === receipt.revision);
  if (!brief) throw new ProductBriefError("PRODUCT_BRIEF_RECEIPTS_INVALID", 409, "生成记录对应的需求单版本不存在。");
  return { taskId: input.taskId, brief, stale: true, resourceVersion: task.updatedAt.toISOString(), replayed: true };
}

export async function generateProductBrief(input: BriefGenerateInput) {
  if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.idempotencyKey)) throw new ProductBriefError("INVALID_IDEMPOTENCY_KEY", 400, "请求标识无效。");
  const fingerprint = hashJson({ resetDerivedFields: input.resetDerivedFields === true, previewRevision: input.previewRevision ?? null, previewSourceBinding: input.previewSourceBinding ?? null });
  const replay = await replayBriefGeneration(input, fingerprint);
  if (replay) return replay;
  const context = await briefContext(input.context, input.taskId);
  if (input.idempotencyKey && isRecord(context.root.productBriefGenerationReceipts) && Object.hasOwn(context.root.productBriefGenerationReceipts, input.idempotencyKey)) {
    const committed = await replayBriefGeneration(input, fingerprint);
    if (committed) return committed;
  }
  const existing = parseProductBrief(context.root.productBrief);
  if (existing && (input.previewRevision === undefined || !input.previewSourceBinding)) throw new ProductBriefError("PRODUCT_BRIEF_PREVIEW_REQUIRED", 409, "已有需求单，请重新预览差异后确认生成。");
  const brief = buildBrief(context, existing, { resetDerivedFields: input.resetDerivedFields === true });
  if (input.previewRevision !== undefined && (existing?.revision !== input.previewRevision || hashJson(brief.sourceBinding) !== hashJson(input.previewSourceBinding))) {
    throw new ProductBriefError("PRODUCT_BRIEF_PREVIEW_STALE", 409, "需求单或研究来源已变化，请重新预览后再确认。 ");
  }
  if (context.root.productBriefGenerationReceipts !== undefined && !isRecord(context.root.productBriefGenerationReceipts)) throw new ProductBriefError("PRODUCT_BRIEF_RECEIPTS_INVALID", 409, "生成记录异常，请检查数据。");
  try {
  const saved = await mutateTaskResultJson({
    context: input.context,
    taskId: input.taskId,
    writer: "product-brief",
    expectedStorageVersion: { resultJson: context.task.resultJson, updatedAt: context.task.updatedAt },
    mutate: (current) => ({ result: { ...current, ...preserveBriefHistory(current, brief), ...(input.idempotencyKey ? { productBriefGenerationReceipts: { ...(isRecord(current.productBriefGenerationReceipts) ? current.productBriefGenerationReceipts : {}), [input.idempotencyKey]: { fingerprint, revision: brief.revision } } } : {}) }, value: brief }),
  });
  return { taskId: input.taskId, brief: saved.value, stale: false, resourceVersion: saved.updatedAt, replayed: false };
  } catch (error) {
    if (error instanceof TaskResultJsonMutationError && error.code === "task_result_conflict") {
      const committed = await replayBriefGeneration(input, fingerprint);
      if (committed) return committed;
    }
    throw error;
  }
}

/**
 * P3-02：只读预览“来源更新后重新生成”的结果。
 * 不写库、不改 revision、不动历史；只返回当前 Brief、将要生成的 Brief 与字段级差异。
 */
export async function previewProductBrief(input: { context: AccessContext; taskId: string; resetDerivedFields?: boolean }) {
  const context = await briefContext(input.context, input.taskId);
  const existing = parseProductBrief(context.root.productBrief);
  const next = buildBrief(context, existing, { resetDerivedFields: input.resetDerivedFields === true });
  const changes = existing ? diffBriefVersions(existing, next) : [];
  return {
    taskId: input.taskId,
    stale: existing ? !briefIsCurrent(existing, context) : false,
    current: existing,
    next,
    changes,
    summary: summarizeBriefDiff(changes),
  };
}

/**
 * P3-02（3.3）：保存的幂等回放。
 * 只读回执；命中且指纹一致时返回已保存的 revision，不产生新版本。
 * 指纹不一致说明同一标识被用于不同内容，必须拒绝而不是复用旧回执。
 */
async function replayBriefSave(input: { context: AccessContext; taskId: string; idempotencyKey?: string }, fingerprint: string) {
  if (!input.idempotencyKey) return null;
  if (input.context.mode !== "owner") throw new ProductBriefError("PRODUCT_BRIEF_OWNER_REQUIRED", 403, "Product Brief 仅对 Owner 开放。");
  const task = await jsonSnapshot(input.taskId);
  const root = parseJsonRecord(task.resultJson);
  if (root.productBriefSaveReceipts !== undefined && !isRecord(root.productBriefSaveReceipts)) throw new ProductBriefError("PRODUCT_BRIEF_RECEIPTS_INVALID", 409, "保存记录异常，请检查数据。");
  const receipts = isRecord(root.productBriefSaveReceipts) ? root.productBriefSaveReceipts : {};
  const receipt = Object.hasOwn(receipts, input.idempotencyKey) ? receipts[input.idempotencyKey] : undefined;
  if (receipt === undefined) return null;
  if (!isRecord(receipt) || typeof receipt.fingerprint !== "string" || !Number.isInteger(receipt.revision)) throw new ProductBriefError("PRODUCT_BRIEF_RECEIPTS_INVALID", 409, "保存记录异常，请检查数据。");
  if (receipt.fingerprint !== fingerprint) throw new ProductBriefError("IDEMPOTENCY_KEY_REUSE", 409, "同一请求标识不能用于不同内容。");
  const history = readProductBriefHistory(root.productBriefHistory);
  if (!history.valid) throw new ProductBriefError("PRODUCT_BRIEF_HISTORY_INVALID", 409, "已有企划版本无法读取。");
  const brief = [parseProductBrief(root.productBrief), ...history.items].find((item) => item?.revision === receipt.revision);
  if (!brief) throw new ProductBriefError("PRODUCT_BRIEF_RECEIPTS_INVALID", 409, "保存记录对应的需求单版本不存在。");
  // 回执只证明该次写入成功，不证明来源仍然有效；来源状态仍按当前上下文判定。
  let stale = false;
  try {
    const context = await briefContext(input.context, input.taskId);
    stale = !briefIsCurrent(brief, context);
  } catch (error) {
    if (error instanceof ProductBriefError) stale = true;
    else throw error;
  }
  return { taskId: input.taskId, brief, stale, resourceVersion: task.updatedAt.toISOString(), replayed: true };
}

export async function saveProductBrief(input: {
  context: AccessContext;
  taskId: string;
  expectedRevision: number;
  idempotencyKey?: string;
  patch: Partial<Pick<ProductBrief["economics"], "targetPrice" | "targetMarginPct" | "referralFee" | "logistics" | "estimatedTax" | "otherKnownCosts">> & {
    targetUser: ProductBriefEvidenceLine | null;
    status: ProductBriefStatus;
    // P0-BR（追加修正）：整段替换式可选补丁，最终由 parseProductBrief 校验/过滤
    specifications?: unknown;
    confirmationItems?: unknown;
    benchmarkComparison?: unknown;
    verificationPlan?: unknown;
    positioning?: unknown;
  };
}) {
  if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.idempotencyKey)) throw new ProductBriefError("INVALID_IDEMPOTENCY_KEY", 400, "请求标识无效。");
  const saveFingerprint = hashJson({ action: "save", expectedRevision: input.expectedRevision, patch: input.patch });
  // 先回放：上次已成功写入时，重试不应再抬 revision，也不应因 revision 已前进而误报冲突。
  const replay = await replayBriefSave(input, saveFingerprint);
  if (replay) return replay;
  const context = await briefContext(input.context, input.taskId, true);
  const claimBlock = claimConsumptionBlockReason(context.detail.claimAudit);
  if (input.patch.status === "APPROVED" && claimBlock) throw new ProductBriefError(claimBlock, 409, claimConsumptionNotice(context.detail.claimAudit));
  const existing = parseProductBrief(context.root.productBrief);
  if (!existing) throw new ProductBriefError("PRODUCT_BRIEF_REQUIRED", 409, "请先生成 Product Brief。",);
  if (!briefIsCurrent(existing, context)) throw new ProductBriefError("PRODUCT_BRIEF_STALE", 409, "研究或市场绑定已变化，请重新生成 Product Brief。",);
  if (existing.revision !== input.expectedRevision) throw new ProductBriefError("PRODUCT_BRIEF_REVISION_STALE", 409, "Product Brief 已更新，请刷新后重试。",);
  // 规格证据边界由服务端最终裁决：新增行、内容变化行、无引用行都会降级；
  // 不依赖前端是否清空旧 evidenceRefs。
  const patch = {
    ...input.patch,
    ...(input.patch.specifications !== undefined
      ? { specifications: sanitizeIncomingSpecifications(input.patch.specifications, existing.specifications ?? []) }
      : {}),
    ...(input.patch.benchmarkComparison !== undefined
      ? { benchmarkComparison: sanitizeIncomingBenchmarkComparison(input.patch.benchmarkComparison, existing.benchmarkComparison) }
      : {}),
  };
  const initialEconomics = {
    ...existing.economics,
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => ["targetPrice", "targetMarginPct", "referralFee", "logistics", "estimatedTax", "otherKnownCosts"].includes(key))),
  } as ProductBrief["economics"];
  // 费率推导金额绑定旧目标价；价格变更且用户没有明确编辑佣金时先失效，
  // 避免把旧金额当作新目标价的费用，也不覆盖用户手工填写或清空的佣金。
  const invalidateDerivedReferral = Object.prototype.hasOwnProperty.call(patch, "targetPrice")
    && initialEconomics.targetPrice !== existing.economics.targetPrice
    && !Object.prototype.hasOwnProperty.call(patch, "referralFee")
    && existing.economics.provenance?.referralFee?.source === "candidateAnalysisContext.commercialInputs.commissionRate";
  const nextEconomics = invalidateDerivedReferral ? { ...initialEconomics, referralFee: null } : initialEconomics;
  const nextProvenance: ProductBriefEconomicsProvenance = { ...(existing.economics.provenance ?? {}) };
  if (invalidateDerivedReferral) nextProvenance.referralFee = economicProvenanceEntry({ origin: "MISSING", source: "product-brief-derived-price-changed", note: "目标售价已变化，原按费率推导的佣金待重新确认。" });
  for (const key of ["targetPrice", "targetMarginPct", "referralFee", "logistics", "estimatedTax", "otherKnownCosts"] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      nextProvenance[key] = economicProvenanceEntry({
        origin: "USER_INPUT",
        source: "product-brief-owner",
        note: patch[key] === null ? "Owner 在需求单中清空该项。" : "Owner 在需求单中填写或调整该项。",
      });
    }
  }
  const nextPurchaseCostCeiling = calculatePurchaseCostCeiling({ ...nextEconomics, currency: existing.economics.currency });
  if (patch.status === "APPROVED" && (nextEconomics.targetPrice === null || nextEconomics.targetMarginPct === null || nextPurchaseCostCeiling.status !== "COMPUTED")) {
    throw new ProductBriefError("PRODUCT_BRIEF_NOT_READY", 422, "只有目标价格、目标毛利率和购买成本上限都可计算时，才能将 Brief 标记为 APPROVED。",);
  }
  const nextBrief = parseProductBrief({
    ...existing,
    revision: existing.revision + 1,
    generatedAt: new Date().toISOString(),
    status: patch.status,
    targetUser: patch.targetUser === undefined ? existing.targetUser : patch.targetUser,
    economics: {
      ...nextEconomics,
      provenance: nextProvenance,
      purchaseCostCeiling: nextPurchaseCostCeiling,
    },
    ...(patch.specifications !== undefined ? { specifications: patch.specifications } : {}),
    ...(patch.confirmationItems !== undefined ? { confirmationItems: patch.confirmationItems } : {}),
    ...(patch.benchmarkComparison !== undefined ? { benchmarkComparison: patch.benchmarkComparison } : {}),
    ...(patch.verificationPlan !== undefined ? { verificationPlan: patch.verificationPlan } : {}),
    ...(patch.positioning !== undefined ? { positioning: patch.positioning } : {}),
  });
  if (!nextBrief) throw new ProductBriefError("PRODUCT_BRIEF_INVALID", 422, "Product Brief 修改内容无效。",);
  if (input.idempotencyKey && context.root.productBriefSaveReceipts !== undefined && !isRecord(context.root.productBriefSaveReceipts)) throw new ProductBriefError("PRODUCT_BRIEF_RECEIPTS_INVALID", 409, "保存记录异常，请检查数据。");
  const saved = await (async () => {
    try {
      const result = await mutateTaskResultJson({
        context: input.context,
        taskId: input.taskId,
        writer: "product-brief",
        expectedStorageVersion: { resultJson: context.task.resultJson, updatedAt: context.task.updatedAt },
        mutate: (current) => ({
          result: {
            ...current,
            ...preserveBriefHistory(current, nextBrief),
            // 回执与需求单在同一次 CAS 内写入：要么都生效，要么都不生效。
            ...(input.idempotencyKey ? { productBriefSaveReceipts: { ...(isRecord(current.productBriefSaveReceipts) ? current.productBriefSaveReceipts : {}), [input.idempotencyKey]: { fingerprint: saveFingerprint, revision: nextBrief.revision } } } : {}),
          },
          value: nextBrief,
        }),
      });
      return { kind: "saved" as const, result };
    } catch (error) {
      // 并发争抢同一 revision 时，若赢家正是同一个幂等请求，则按回执返回成功而不是报冲突。
      if (error instanceof TaskResultJsonMutationError && error.code === "task_result_conflict") {
        const committed = await replayBriefSave(input, saveFingerprint);
        if (committed) return { kind: "replayed" as const, result: committed };
      }
      throw error;
    }
  })();
  if (saved.kind === "replayed") return saved.result;
  return { taskId: input.taskId, brief: saved.result.value, stale: false, resourceVersion: saved.result.updatedAt, replayed: false };
}

function preserveBriefHistory(root: Record<string, unknown>, brief: ProductBrief) {
  try {
    const next = appendProductBriefVersion(root.productBrief, root.productBriefHistory, brief);
    return { productBrief: next.brief, productBriefHistory: next.history };
  }
  catch (error) {
    if (error instanceof ProductBriefHistoryPreservationError) throw new ProductBriefError("PRODUCT_BRIEF_HISTORY_INVALID", 409, "已有企划版本无法读取，请保留记录并检查数据，暂不能覆盖。");
    throw error;
  }
}

export async function listProductBriefs(context: AccessContext) {
  if (context.mode !== "owner") throw new ProductBriefError("PRODUCT_BRIEF_OWNER_REQUIRED", 403, "产品开发需求单仅对 Owner 开放。");
  const tasks = await prisma.viralAnalysisRecord.findMany({
    where: { type: "workflow", archivedAt: null, resultJson: { contains: '"productBrief"' } },
    select: { id: true, resultJson: true }, orderBy: { updatedAt: "desc" },
  });
  let invalidCount = 0;
  // V13：列表项带来源有效性（detail.stale / 报告权威未定），前端区分「来源锁定」，
  // 不把历史批准显示为当前有效批准。Owner 列表规模小，逐项取研究状态与 readProductBrief 同源。
  const items: {
    taskId: string;
    title: string | null;
    asin: string;
    status: string;
    revision: number;
    generatedAt: string;
    stale: boolean;
    staleReason: string | null;
    imageUrl: string | null;
    brand: string | null;
    researchRevision: number;
    positioningText: string | null;
    approvalBlocked: string | null;
    missingCostCount: number;
    syntheticSample: boolean;
  }[] = [];
  for (const task of tasks) {
    const brief = parseProductBrief(parseJsonRecord(task.resultJson).productBrief);
    if (!brief) { invalidCount++; continue; }
    const research = await getResearchDetail({ context, taskId: task.id })
      .then((detail) => ({
        stale: detail.stale === true,
        ambiguous: detail.reportResolution?.status === "ambiguous",
        staleReason: detail.staleReason ?? null,
      }))
      .catch(() => ({ stale: true, ambiguous: false, staleReason: null }));
    const approvalBlocked = deriveApprovalBlockedReason({
      targetPrice: brief.economics.targetPrice,
      targetMarginPct: brief.economics.targetMarginPct,
      referralFee: brief.economics.referralFee,
      logistics: brief.economics.logistics,
      estimatedTax: brief.economics.estimatedTax,
      otherKnownCosts: brief.economics.otherKnownCosts,
      fbaFee: brief.economics.fbaFee,
      currency: brief.economics.currency,
    });
    const missingCostCount = [
      brief.economics.targetPrice,
      brief.economics.targetMarginPct,
      brief.economics.referralFee,
      brief.economics.fbaFee,
      brief.economics.logistics,
      brief.economics.estimatedTax,
    ].filter((value) => value === null).length;
    items.push({
      taskId: task.id,
      title: brief.identity.title,
      asin: brief.identity.asin,
      status: brief.status,
      revision: brief.revision,
      generatedAt: brief.generatedAt,
      stale: research.stale || research.ambiguous,
      staleReason: research.staleReason ?? (research.ambiguous ? "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS" : research.stale ? "RESEARCH_EVIDENCE_STALE" : null),
      imageUrl: brief.identity.imageUrl,
      brand: brief.identity.brand,
      researchRevision: brief.sourceBinding.researchRevision,
      positioningText: brief.positioning?.text ?? null,
      approvalBlocked,
      missingCostCount,
      syntheticSample: /隔离|联调/.test([brief.projectOverview?.text, brief.targetUser?.text, brief.positioning?.text].filter(Boolean).join(" ")),
    });
  }
  return { items, invalidCount };
}
