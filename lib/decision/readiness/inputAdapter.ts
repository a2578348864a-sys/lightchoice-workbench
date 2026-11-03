/**
 * Jev Research Readiness — 输入适配器（只读、最小化、缺失显式）
 *
 * 通过**窄读端口**（ReadinessSourcePort）取数，不直接读数据库、不读 EvidenceStore 原文、
 * 不读取旧 Candidate 的非权威字段冒充正式 ProductFact。
 *
 * 生产实现应由既有正式读边界提供端口（decisionDelivery 装配结果 + VOC 快照 +
 * allowedEvidenceRefsOf(bundle) + 已解析研报叙述）；本 Spike 用只读快照实现。
 *
 * 复用既有规则：isVerifiedNarrative（JEV-002）——无引用的 AI 文本不是结论。
 * 本适配器通过窄读端口只拿到 refId 字符串（与全仓 allowedEvidenceRefs 的形态一致），
 * 无法构造完整 ResearchEvidenceRef 的 8 个字段（正式契约），因此 isNarrativeVerifiable
 * 复用生产校验器 `isVerifiedNarrative`（@/lib/research/researchContracts）作基础判定，
 * 再叠加 allowlist 白名单约束（2026-10-15 生产接线修正）。
 *
 * P0-3 输入证据可信度收严：
 * - VOC 主题必须「全部引用可确定性映射 + 全部凭证落在本任务白名单 + 凭证来自本任务」才视为已验证；
 *   任一条不满足即**整主题降级**，不以部分合法引用冒充完整证据支持；降级主题**不进入 voc.themes**，
 *   仅记录诊断（模型因此无法依据它们作事实判断）。
 * - Research Narrative 必须「文本非空 + 引用数组有效 + 所有引用合法 + 所有引用属于本任务 allowlist」
 *   才进入 verifiedNarratives，否则进入 unverifiedNarratives（明确未验证）。
 *
 * 注意：引用 ID 合法 ≠ 引用内容在语义上支持结论。`semanticSupport = NOT_VERIFIED` 始终保留。
 */
import type { JevReadinessInput, ReadinessInputBinding } from "./types";
import { isVerifiedNarrative, type ResearchNarrative } from "@/lib/research/researchContracts";

/** VOC 观测 → 正式凭证索引条目（生产侧来自 bundle.customerVoiceEvidence[].observations[]） */
export type VocObservationCredential = {
  /** 观测唯一身份（customer_voice_observation_v1.externalContentId） */
  readonly externalContentId: string;
  /**
   * 该观测的正式证据凭证（生产上恒为 ["attachment:<attachmentId>"]）。
   *
   * 生产核对（2026-10-15）：`researchInputBundle.ts` 组装 bundle 时强制
   * `refId = attachment:<group.attachmentId>`；`vocAnalysis.ts` 的
   * `adaptCustomerVoiceEvidenceToVocObservations` 在 VOC 分析入口以 409
   * `CUSTOMER_VOICE_EVIDENCE_INVALID` 强校验同一约束。本适配器不依赖上游假设，
   * 仍自行复核（defense in depth）。
   */
  readonly evidenceRefs: readonly string[];
  /** 凭证所属研究任务；跨任务凭证一律不得映射 */
  readonly taskId: string;
};

/** VOC 主题引用解析输入形态 */
export type VocThemeProjection = {
  readonly label: string;
  readonly reviewCount: number;
  readonly strength: "isolated" | "weak" | "recurring";
  readonly kind: "pain" | "positive" | "request";
  readonly evidenceRefs: readonly string[];
};

/** VOC 主题引用降级原因（诊断用） */
export type VocThemeDowngradeReason = "UNMAPPED_REF" | "REF_NOT_IN_ALLOWLIST" | "FOREIGN_SOURCE" | "NO_CREDENTIAL_INDEX";

/** 窄读端口：只暴露构建输入所必需的字段，避免把整个库/Store 交给模型。 */
export interface ReadinessSourcePort {
  readonly taskId: string;
  readonly asin: string | null;
  readonly binding: ReadinessInputBinding;
  /** 来自 buildDecisionDelivery(...).riskGate + riskCounts */
  readonly riskGate: {
    status: "passed" | "blocked" | "warning";
    hasBlockingRisk: boolean;
    blockingReasons: readonly string[];
    warningReasons: readonly string[];
    ruleCounts: { blocking: number; warning: number; notComputable: number; passed: number };
  } | null;
  /** 来自 decisionSummary */
  readonly decisionSummary: {
    researchPriority: "P1" | "P2" | "P3";
    recommendedNextAction: "继续研究" | "补充数据" | "暂停";
    keyReasons: readonly string[];
    blockingRisks: readonly string[];
    missingInformation: readonly string[];
  } | null;
  /** 已解析的研报叙述（含引用）；未通过全部校验者降级到 unverified */
  readonly narratives: readonly { text: string | null; evidenceRefs: readonly string[] }[];
  /** 正式 VOC 快照投影（无正式分析时为 null） */
  readonly voc: {
    independentReviewCount: number | null;
    themeMentionCount: number;
    themes: readonly VocThemeProjection[];
  } | null;
  /**
   * 正式 VOC 观测凭证索引：externalContentId → 该观测的正式 attachment 凭证 + 所属任务。
   * 生产侧由 `bundle.customerVoiceEvidence[].observations[]` 提供
   * （`refId` 必须 == `attachment:<attachmentId>`；该约束由 researchInputBundle 组装
   * 与 vocAnalysis 409 双重保证——见 VocObservationCredential 注释；本适配器仍自行复核）。
   */
  readonly vocObservationCredentials?: readonly VocObservationCredential[];
  /** 来自 allowedEvidenceRefsOf(bundle) */
  readonly allowedEvidenceRefs: readonly string[];
  /** 关键字段存在性（present/missing），缺失一律显式标记 */
  readonly fieldPresence: Readonly<Record<string, "present" | "missing">>;
}

const MAX_NARRATIVES = 12;
const MAX_TEXT_LENGTH = 600;

function clampText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TEXT_LENGTH ? `${trimmed.slice(0, MAX_TEXT_LENGTH)}…` : trimmed;
}

function normalizeRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.filter((ref) => typeof ref === "string" && ref.trim().length > 0).map((ref) => ref.trim()))];
}

/**
 * P0-3-2：Research Narrative 严格校验（等价于 isVerifiedNarrative，另加 allowlist 约束）。
 * 必须同时满足：文本非空 + 引用数组有效 + 所有元素为非空白字符串 + 全部属于本任务 allowlist。
 */
export function isNarrativeVerifiable(text: string | null, evidenceRefs: readonly string[], allowedRefs: readonly string[]): boolean {
  // 基础判定复用生产正式校验器（JEV-002：文本非空 + 至少 1 条引用）。
  // 窄端口只有 refId 字符串，运行时判定与完整 ResearchEvidenceRef 的字符串级检查等价；
  // 类型上做最小对齐（ResearchNarrative["evidenceRefs"]），不做任何字段伪造。
  if (!isVerifiedNarrative({
    text: typeof text === "string" ? text : null,
    evidenceRefs: evidenceRefs as unknown as ResearchNarrative["evidenceRefs"],
  })) {
    return false;
  }
  // 再叠加 allowlist 白名单约束（旧实现语义保持：任一条非法引用 → 整条不可验证）。
  const allowed = new Set(normalizeRefs(allowedRefs));
  for (const ref of evidenceRefs) {
    if (typeof ref !== "string" || ref.trim().length === 0) return false;
    if (!allowed.has(ref.trim())) return false;
  }
  return evidenceRefs.length > 0;
}

/**
 * P0-3-1 / P1-2：VOC 主题引用 → 正式证据凭证（整主题严格校验）。
 *
 * 一个主题被视为已验证，当且仅当：
 * 1. 提供了观测凭证索引（否则 NO_CREDENTIAL_INDEX）；
 * 2. 该主题的**每一条**引用都能观测身份命中（类型非法 / 空白串一律视为不命中，不静默丢弃）；
 * 3. 命中的凭证**来自本任务**（跨任务一律 FOREIGN_SOURCE）；
 * 4. 命中的凭证**全部落在输出白名单**内；
 * 5. 主题自身引用数组非空。
 *
 * 任一条不满足 → 整主题降级（不以部分合法引用冒充完整证据支持）。
 */
export function resolveVocThemeCredentials(input: {
  readonly taskId: string;
  readonly themes: readonly VocThemeProjection[];
  readonly credentials: readonly VocObservationCredential[];
  readonly allowedRefs: readonly string[];
}): {
  themes: VocThemeProjection[];
  mappedThemeRefs: number;
  unmappedRefs: string[];
  downgradedThemes: { label: string; reviewCount: number; reason: VocThemeDowngradeReason; unmappedRefs: string[] }[];
} {
  const { taskId, themes, credentials, allowedRefs } = input;

  if (credentials.length === 0) {
    return {
      themes: [],
      mappedThemeRefs: 0,
      unmappedRefs: [...new Set(themes.flatMap((t) => t.evidenceRefs.filter((r) => typeof r === "string" && r.trim().length > 0).map((r) => r.trim())))],
      downgradedThemes: themes.map((theme) => ({
        label: theme.label,
        reviewCount: theme.reviewCount,
        reason: "NO_CREDENTIAL_INDEX" as const,
        unmappedRefs: normalizeRefs(theme.evidenceRefs),
      })),
    };
  }

  const byExternalId = new Map<string, VocObservationCredential>();
  for (const credential of credentials) {
    if (credential.externalContentId && credential.evidenceRefs.length > 0) byExternalId.set(credential.externalContentId, credential);
  }
  const allowed = new Set(normalizeRefs(allowedRefs));
  const allUnmappedRefs = new Set<string>();
  const downgradedThemes: { label: string; reviewCount: number; reason: VocThemeDowngradeReason; unmappedRefs: string[] }[] = [];
  const verified: VocThemeProjection[] = [];

  for (const theme of themes) {
    // 逐元素严格校验（与 schema.verdictEvidenceRefs 同一纪律）：null / 数字 / 对象 / 空白串
    // 一律不得静默丢弃 —— 出现任一条非法引用即视为该主题引用无法完整映射，整主题降级。
    const rawRefs: string[] = [];
    let hasInvalidRef = false;
    for (const ref of theme.evidenceRefs as readonly unknown[]) {
      if (typeof ref !== "string" || ref.trim().length === 0) { hasInvalidRef = true; continue; }
      rawRefs.push(ref.trim());
    }

    if (rawRefs.length === 0 && !hasInvalidRef) {
      downgradedThemes.push({ label: theme.label, reviewCount: theme.reviewCount, reason: "NO_CREDENTIAL_INDEX", unmappedRefs: [] });
      continue;
    }

    const unmapped: string[] = [];
    const mapped: string[] = [];
    let foreign = false;
    let outsideAllowlist = false;

    for (const rawRef of rawRefs) {
      const credential = byExternalId.get(rawRef);
      if (!credential) { unmapped.push(rawRef); continue; }
      if (credential.taskId !== taskId) { foreign = true; unmapped.push(rawRef); continue; }
      const usable = normalizeRefs(credential.evidenceRefs).filter((ref) => allowed.has(ref));
      if (usable.length === 0) { outsideAllowlist = true; unmapped.push(rawRef); continue; }
      mapped.push(...usable);
    }

    // 任一条引用不满足（含非法类型/空白引用）→ 整主题降级
    if (hasInvalidRef || unmapped.length > 0) {
      const reason: VocThemeDowngradeReason = foreign ? "FOREIGN_SOURCE" : outsideAllowlist ? "REF_NOT_IN_ALLOWLIST" : "UNMAPPED_REF";
      unmapped.forEach((ref) => allUnmappedRefs.add(ref));
      downgradedThemes.push({ label: theme.label, reviewCount: theme.reviewCount, reason, unmappedRefs: [...new Set(unmapped)] });
      continue;
    }

    verified.push({ ...theme, evidenceRefs: [...new Set(mapped)] });
  }

  return { themes: verified, mappedThemeRefs: verified.length, unmappedRefs: [...allUnmappedRefs], downgradedThemes };
}

/**
 * 构建最小研究准备度输入。
 * - VOC 主题：仅已验证主题进入 `voc.themes`；降级主题只进诊断；
 * - Research 叙述：仅通过严格校验者进入 verifiedNarratives；
 * - 缺失字段不补齐：decisionSummary / riskGate / voc 为 null 即 null。
 */
export function buildJevReadinessInput(port: ReadinessSourcePort): JevReadinessInput {
  const verified: { text: string; evidenceRefs: string[] }[] = [];
  const unverified: string[] = [];

  for (const narrative of port.narratives.slice(0, MAX_NARRATIVES)) {
    if (isNarrativeVerifiable(narrative.text, narrative.evidenceRefs, port.allowedEvidenceRefs)) {
      verified.push({ text: clampText(narrative.text as string), evidenceRefs: normalizeRefs(narrative.evidenceRefs) });
    } else if (typeof narrative.text === "string" && narrative.text.trim().length > 0) {
      unverified.push(clampText(narrative.text));
    }
  }

  const voc = port.voc
    ? resolveVocThemeCredentials({
      taskId: port.taskId,
      themes: port.voc.themes,
      credentials: port.vocObservationCredentials ?? [],
      allowedRefs: port.allowedEvidenceRefs,
    })
    : null;

  return {
    schema: "jev-readiness-input.v1",
    taskId: port.taskId,
    asin: port.asin,
    binding: {
      reportHash: port.binding.reportHash,
      factHash: port.binding.factHash,
      evidenceHash: port.binding.evidenceHash,
      researchRevision: port.binding.researchRevision,
    },
    riskGateSummary: port.riskGate
      ? {
        status: port.riskGate.status,
        hasBlockingRisk: port.riskGate.hasBlockingRisk,
        blockingReasons: [...port.riskGate.blockingReasons],
        warningReasons: [...port.riskGate.warningReasons],
        ruleCounts: { ...port.riskGate.ruleCounts },
      }
      : null,
    missingInformation: port.decisionSummary ? [...port.decisionSummary.missingInformation] : [],
    decisionSummary: port.decisionSummary
      ? {
        researchPriority: port.decisionSummary.researchPriority,
        recommendedNextAction: port.decisionSummary.recommendedNextAction,
        keyReasons: [...port.decisionSummary.keyReasons],
        blockingRisks: [...port.decisionSummary.blockingRisks],
      }
      : null,
    verifiedNarratives: verified,
    unverifiedNarratives: unverified,
    voc: voc
      ? {
        available: true,
        independentReviewCount: port.voc?.independentReviewCount ?? null,
        themeMentionCount: port.voc?.themeMentionCount ?? 0,
        themes: voc.themes,
      }
      : null,
    vocRefResolution: {
      strategy: "externalContentId_to_observation_evidenceRefs",
      mappedThemeRefs: voc?.mappedThemeRefs ?? 0,
      unmappedRefs: voc?.unmappedRefs ?? [],
      downgradedThemes: voc?.downgradedThemes ?? [],
    },
    allowedEvidenceRefs: normalizeRefs(port.allowedEvidenceRefs),
    fieldPresence: { ...port.fieldPresence },
  };
}
