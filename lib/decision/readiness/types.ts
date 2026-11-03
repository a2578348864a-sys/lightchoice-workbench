/**
 * Jev Research Readiness — 隔离 Spike 契约（jev-readiness-spike.v1）
 *
 * 定位：Spike 零费用验收冻结契约；2026-10-15 已按该契约完成生产接线（默认关闭 + 费用门禁），
 * 真实模型接入仍为 NOT_VERIFIED。
 *
 * 与旧 lib/decision 的关系：
 * - 复用其「Provider 注册 + 工厂 + 输出运行时校验 + 失败不静默降级」的设计思想；
 * - **不复用** ProductFacts / ProductDecision：旧 ProductFacts 只承载 sellerSprite 候选字段，
 *   旧 ProductDecision 的 priority(P1/P2/P3) 是「研究优先级」，语义上不等于「研究准备度」，
 *   且其 score/confidence 无 evidenceRefs（本地审计已记录量纲与校验缺陷）。
 *
 * 严格禁止（本契约在任何字段上都不提供表达方式）：
 * - Opportunity Score / Product Score / P1·P2·P3 复用
 * - 自动 PROCEED / VALIDATE_MORE / PAUSE / DROP
 * - 自动生成 Product Brief
 */

/** 输入侧：仅来自既有正式 Research 边界的可核验字段；缺失一律显式标记，不补齐。 */
export type JevReadinessInput = {
  readonly schema: "jev-readiness-input.v1";
  readonly taskId: string;
  readonly asin: string | null;
  readonly binding: ReadinessInputBinding;
  /** 已有确定性风险规则摘要（来自 buildDecisionDelivery.riskGate） */
  readonly riskGateSummary: {
    readonly status: "passed" | "blocked" | "warning";
    readonly hasBlockingRisk: boolean;
    readonly blockingReasons: readonly string[];
    readonly warningReasons: readonly string[];
    readonly ruleCounts: { readonly blocking: number; readonly warning: number; readonly notComputable: number; readonly passed: number };
  } | null;
  /** 已有缺失信息（来自 decisionSummary.missingInformation） */
  readonly missingInformation: readonly string[];
  /** 已有确定性建议摘要（仅作上下文，Jev 不得改写它） */
  readonly decisionSummary: {
    readonly researchPriority: "P1" | "P2" | "P3";
    readonly recommendedNextAction: "继续研究" | "补充数据" | "暂停";
    readonly keyReasons: readonly string[];
    readonly blockingRisks: readonly string[];
  } | null;
  /** 可核验研究叙述：必须通过 isVerifiedNarrative（非空文本 + ≥1 条 evidenceRef） */
  readonly verifiedNarratives: readonly { readonly text: string; readonly evidenceRefs: readonly string[] }[];
  /** 无引用的 AI 文本：只能作为未验证假设，不得显示为已确认结论 */
  readonly unverifiedNarratives: readonly string[];
  /** 正式 VOC 的强度与独立评论数（无正式分析时为 null） */
  readonly voc: {
    readonly available: boolean;
    readonly independentReviewCount: number | null;
    readonly themeMentionCount: number;
    readonly themes: readonly {
      readonly label: string;
      readonly reviewCount: number;
      readonly strength: "isolated" | "weak" | "recurring";
      readonly kind: "pain" | "positive" | "request";
      /** 上游正式 VOC 主题携带的证据引用（用于输出引用核验） */
      readonly evidenceRefs: readonly string[];
    }[];
  } | null;
  /** 证据白名单：模型输出只能引用这些 refId */
  readonly allowedEvidenceRefs: readonly string[];
  /**
   * VOC 引用的解析结果（P0-3 收严）。
   *
   * 只有「全部引用可确定性映射 + 全部凭证落在白名单 + 凭证来自本任务」的主题才进入 `voc.themes`；
   * 任一条不满足即**整主题降级**（不以部分合法引用冒充完整证据支持），并记录在此处供诊断。
   * `voc.themes` 中不含被降级主题 —— 模型因此无法依据它们作事实判断。
   */
  readonly vocRefResolution: {
    readonly strategy: "externalContentId_to_observation_evidenceRefs";
    readonly mappedThemeRefs: number;
    readonly unmappedRefs: readonly string[];
    readonly downgradedThemes: readonly {
      readonly label: string;
      readonly reviewCount: number;
      readonly reason: "UNMAPPED_REF" | "REF_NOT_IN_ALLOWLIST" | "FOREIGN_SOURCE" | "NO_CREDENTIAL_INDEX";
      readonly unmappedRefs: readonly string[];
    }[];
  };
  /** 关键字段存在性显式标记（present/missing），避免模型臆测缺失字段 */
  readonly fieldPresence: Readonly<Record<string, "present" | "missing">>;
};

/** 研究版本绑定：四元组全部参与 stale 判定，不使用 TTL。 */
export type ReadinessInputBinding = {
  readonly reportHash: string | null;
  readonly factHash: string | null;
  readonly evidenceHash: string | null;
  readonly researchRevision: number | null;
};

/** 输出侧：仅「复核辅助」，不含任何分数、概率或自动决策。 */
export type JevReadinessAdvice = {
  readonly status: "available" | "unavailable" | "failed";
  readonly readiness: "READY_FOR_HUMAN_REVIEW" | "NEED_MORE_EVIDENCE" | "HIGH_RISK" | null;
  readonly reviewQuestions: readonly { readonly text: string; readonly evidenceRefs: readonly string[] }[];
  readonly contradictions: readonly { readonly text: string; readonly evidenceRefs: readonly string[] }[];
  readonly missingEvidence: readonly string[];
  readonly limitations: readonly string[];
  readonly inputBinding: ReadinessInputBinding;
};

/** Provider 接口：与旧 DecisionProvider 平行的独立最小接口（不扩展旧接口）。 */
export interface ReadinessAdviceProvider {
  readonly providerId: string;
  /** Configured model name/alias; offline providers may omit it. */
  readonly model?: string;
  /** 失败必须返回 status=failed/unavailable，不得抛异常，也不得静默降级为成功。 */
  advise(input: JevReadinessInput): Promise<unknown>;
}

/** 单条输出条目的证据校验结果（机械校验：是否在 allowlist 内）。 */
export type EvidenceRefVerdict = {
  readonly accepted: boolean;
  readonly reason:
    | "ok"
    | "empty_text"
    | "empty_refs"
    | "not_in_allowlist"
    | "EVIDENCE_REFS_NOT_ARRAY"
    | `EVIDENCE_REF_TYPE_INVALID:${number}`
    | `EVIDENCE_REF_EMPTY:${number}`;
  /** 校验通过时返回规范化后的引用（已 trim、已确认在白名单内）；失败为空数组 */
  readonly refs: readonly string[];
  readonly invalidRefs: readonly string[];
};

/** 语义支撑核验状态：离线无法判定，必须显式保持 NOT_VERIFIED。 */
export type SemanticSupportVerdict = "NOT_VERIFIED";

/**
 * 单次 Provider 调用的外部请求作用域（P0-1）。
 *
 * `observed()` 必须在 Provider 调用**结束之后**读取，覆盖成功/失败/抛异常全部退出路径。
 * 返回值 `null` 表示**无法可靠归属**（例如并发下使用全局累计计数器），此时绝不可写成 0。
 */
export type RequestScope = {
  readonly observed: () => number | null;
};

/**
 * 请求计数器工厂。
 * - `kind: "scoped"` — 作用域本地计数，并发下可可靠归属；
 * - `kind: "cumulative"` — 全局累计计数，只在单飞（无并发作用域）时可归属，否则同一时刻
 *   存在多个活跃作用域时 `observed()` 必须返回 null。
 */
export type RequestTracker = {
  readonly kind: "scoped" | "cumulative";
  begin(): RequestScope;
};

/** 副作用声明（P1-3 / P0-1）。 */
export type ReadinessSideEffects = {
  readonly deepseekInvoked: boolean;
  /** 本次调用期间实际观测到的外部请求次数；`null` = 未测量或无法归属（不得当作 0） */
  readonly externalRequestAttempted: number | null;
  readonly stateWritten: boolean;
  readonly reportRegenerated: boolean;
};

/** 副作用是"运行时测得"还是"未经验证的自述" */
export type SideEffectVerification = "runtime_measured" | "unverified";

export type ReadinessRunResult = {
  readonly status: "available" | "unavailable" | "failed";
  readonly advice: JevReadinessAdvice | null;
  readonly provider: string;
  readonly model: string | null;
  readonly generatedAt: string;
  readonly sideEffects: ReadinessSideEffects;
  /** sideEffects 是否由运行时计量得出（unverified 时不得据此声称零副作用） */
  readonly sideEffectsVerification: SideEffectVerification;
  /** 计数器类型；cumulative 并发下无法归属，externalRequestAttempted 必须为 null */
  readonly requestTrackerKind: "scoped" | "cumulative" | "none";
  /** 契约违规与拒收明细（fail-closed 证据） */
  readonly rejected: {
    readonly reason: string | null;
    readonly droppedQuestions: number;
    readonly droppedContradictions: number;
    readonly forbiddenFields: readonly string[];
    readonly bindingMismatch: boolean;
  };
  /** 语义支撑始终为 NOT_VERIFIED：离线无法证明引用支持该描述 */
  readonly semanticSupport: SemanticSupportVerdict;
  /** 机器可读的核验备注 */
  readonly notes: readonly string[];
};
