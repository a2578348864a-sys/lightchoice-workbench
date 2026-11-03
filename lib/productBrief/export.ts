import { claimConsumptionBlockReason, claimConsumptionNotice } from "@/lib/research/claimConsumption";
import { buildImprovementPlan, suggestedVerificationText } from "@/lib/research/improvementPlan";
import { buildBriefDecisionSummary } from "./briefDecisionSummary";
import { annotateSnapshotItem, snapshotAnnotationNote } from "./briefEconomicsStates";
import { approvalGateFromBrief } from "./approvalGate";
import { comparisonOriginLabel } from "./comparisonEvidence";
import type { ProductBrief, ProductBriefEconomicProvenance, ProductBriefEvidenceLine } from "./contract";

/**
 * P0-BR-A6 结构化导出：把 Brief 对象构建为 Markdown 文本（纯函数，前端生成，无服务端 route）。
 * 章节顺序 = 企划页顺序；证据行随行标注性质与验证状态；空章节显示「（空）」而非删除。
 */
export function buildBriefMarkdown(brief: ProductBrief, options: { readonly stale?: boolean; readonly staleReason?: string | null } = {}): string {
  // API read projection carries the current audit. Keep draft/original in storage,
  // but do not turn a previously generated Brief into an export bypass.
  if (brief.claimAudit !== undefined && claimConsumptionBlockReason(brief.claimAudit)) {
    return ["# 产品开发需求单 · 暂停采信", "", `ASIN：${brief.identity.asin}｜修订：rev.${brief.revision}`,
      "", claimConsumptionNotice(brief.claimAudit), "", "原文与人工编辑仍保留在工作台；本导出不携带未通过审查的开发结论。", ""].join("\n");
  }
  const out: string[] = [];
  if (brief.claimAudit?.verdict === "NEEDS_DOWNGRADE") out.push(
    "> 证据审查：待复核线索，不代表已确认缺陷或总体需求。", "",
    ...brief.claimAudit.flags.map(flag => `> 待复核：${flag.reason} 建议：${flag.suggested}`), "");
  const lineOf = (item: ProductBriefEvidenceLine): string => {
    const nature = item.nature === "FACT" ? "确认事实" : item.nature === "ASSUMPTION" ? "待确认假设" : "证据推导";
    const refs = item.evidenceRefs.length ? `（证据：${item.evidenceRefs.join("、")}）` : "";
    return `- [${nature}] ${item.text}${refs}`;
  };
  const section = (title: string, body: string[]) => {
    out.push(`## ${title}`, "", ...(body.length ? body : ["（空）"]), "");
  };

  out.push(`# 产品开发需求单 · 拟开发方案`, "");
  out.push(`研究参考商品：${brief.identity.title ?? brief.identity.asin}`, "");
  out.push(`ASIN：${brief.identity.asin}｜市场：${brief.identity.marketplace}｜品牌：${brief.identity.brand ?? "—"}｜类目：${brief.identity.category ?? "—"}`, "");
  out.push(`拟开发定位：${brief.positioning?.text ?? "尚未填写"}${brief.positioning ? `（${brief.positioning.nature === "FACT" ? "来源事实" : brief.positioning.nature === "ASSUMPTION" ? "待确认假设" : "证据推导"}）` : ""}`, "");
  out.push(`状态：${brief.status}｜修订：rev.${brief.revision}｜生成时间：${brief.generatedAt}`, "");
  // V13：导出如实标注历史/失效状态——来源失效与报告权威未定都算「历史内容只读」。
  if (options.stale === true) {
    out.push(`> 来源状态：${options.staleReason === "RESEARCH_REPORT_AUTHORITY_AMBIGUOUS" ? "报告权威未定（V1 与 V5 并存）" : "引用的研究或来源已变化"}；本文件为历史内容快照，只读参考，保存与评审在工作台暂不可用。`, "");
  }

  /**
   * 决策摘要：与 04 页面共用 buildBriefDecisionSummary + 同一份改良假设派生结果，
   * 保证「页面说的」和「导出说的」不是两套判断。
   */
  const planForSummary = brief.causalInvestigations !== undefined && brief.causalInvestigations.length > 0
    ? buildImprovementPlan({
        causes: brief.causalInvestigations.map((item) => ({
          hypothesis: item.hypothesis.text,
          rationale: item.rationale?.text ?? null,
          supportingEvidence: item.supportingEvidence.map((line) => line.text),
          counterevidence: item.counterevidence.map((line) => line.text),
          unknowns: item.unknowns,
          confidence: item.confidence,
          verification: item.verification,
        })),
        differentiationDirections: brief.differentiation.map((line) => line.text),
      })
    : brief.corePainPoints.length
      ? buildImprovementPlan({
          observations: brief.corePainPoints.map((line) => ({ statement: line.text, evidenceRefs: line.evidenceRefs })),
          differentiationDirections: brief.differentiation.map((line) => line.text),
          sourceDisclosure: {
            sourceKind: "unknown",
            missingFacts: [
              "原因假设（competitionInsight.causalInvestigations）",
              "假设提出理由（rationale）",
              "逐条支持线索",
              "逐条反证线索",
              "逐条未知事项",
              "验证动作（verification）",
            ],
          },
        })
      : null;
  const decision = buildBriefDecisionSummary({
    brief,
    plan: planForSummary,
    stale: options.stale === true,
    staleReason: options.staleReason ?? null,
    // 导出用**已保存**的测算值判断批准门禁（页面用当前表单值，服务端仍以提交值为准）。
    approvalBlockedReason: approvalGateFromBrief(brief, {
      targetPrice: brief.economics.targetPrice === null ? "" : String(brief.economics.targetPrice),
      targetMarginPct: brief.economics.targetMarginPct === null ? "" : String(brief.economics.targetMarginPct),
      referralFee: brief.economics.referralFee === null ? "" : String(brief.economics.referralFee),
      logistics: brief.economics.logistics === null ? "" : String(brief.economics.logistics),
      estimatedTax: brief.economics.estimatedTax === null ? "" : String(brief.economics.estimatedTax),
      otherKnownCosts: brief.economics.otherKnownCosts === null ? "" : String(brief.economics.otherKnownCosts),
    }),
  });
  out.push("## 决策摘要（自动汇总，不替代人工决定）", "");
  out.push(`- 当前决策状态：${decision.headline}`);
  out.push(`- 状态依据：${decision.headlineBasis}`);
  for (const level of decision.levels) out.push(`- ${level.label}：${level.value}｜${level.note}`);
  out.push("");
  out.push("**主要产品问题**", "");
  if (decision.productProblems.length) {
    for (const problem of decision.productProblems) {
      out.push(`- ${problem.text}`);
      out.push(`  - 来源：${problem.source}｜是否为假设：${problem.isHypothesis ? "是（非确认事实）" : "否"}｜${problem.verified}｜${problem.counter}｜${problem.evidenceRefs}`);
    }
  } else {
    out.push(`- ${decision.productProblemNote ?? "当前没有可识别的产品问题。"}`);
  }
  out.push("");
  out.push("**最大未知事项**", "");
  if (decision.keyUnknowns.length) for (const unknown of decision.keyUnknowns) out.push(`- ${unknown}`);
  else out.push("- 未列出未知事项，需人工补充；不要假设「没有未知」。");
  out.push(`- 口径：${decision.keyUnknownsSource}`);
  out.push("");
  out.push("**① 产品问题验证**", "");
  out.push(`- 来源：${decision.verification.sourceKind === "RESEARCH" ? "研报已提出" : decision.verification.sourceKind === "TEMPLATE" ? "规则模板（未经人工确认）" : "缺失"}`);
  if (decision.verification.items.length) for (const action of decision.verification.items) out.push(`- ${action}`);
  else out.push("- 研报未给出可执行验证动作。");
  out.push(`- 说明：${decision.verification.note}`);
  out.push("");
  out.push("**② 商业可行性确认（值不值得开发）**", "");
  out.push(`- 概述：${decision.economics.summaryLine}`);
  for (const field of decision.economics.fields) {
    out.push(`- ${field.label}：${field.display}｜${field.stateLabel}｜来源：${field.source}`);
  }
  if (decision.economics.upperBound) {
    out.push(`- 采购成本上限粗略上界：${decision.economics.upperBound.value} ${decision.economics.upperBound.currency}`);
    out.push(`  - 口径：${decision.economics.upperBound.note}`);
  }
  out.push(`- 说明：${decision.business.note}`);
  out.push("");
  out.push("**③ 供应商确认（能否制造 / 代价多少）**", "");
  if (decision.supplier.items.length) for (const item of decision.supplier.items) out.push(`- ${item}`);
  else out.push("- 需求单未列出供应商确认事项。");
  out.push(`- 说明：${decision.supplier.note}`);
  out.push("");
  out.push("**停止条件**", "");
  if (decision.stopConditions.length) for (const condition of decision.stopConditions) out.push(`- ${condition}`);
  else out.push(`- ${decision.stopConditionsNote ?? "尚未形成明确停止条件，需人工补充。"}`);
  out.push("");
  out.push("**事实与状态口径**", "");
  for (const note of decision.caliberNotes) out.push(`- ${note}`);
  out.push("- 进入低成本验证 ≠ 可以立项 ≠ 可以下发生产；本需求单是人工决策输入，不是自动立项或生产授权。", "");

  section(
    "项目概览与定位",
    [
      brief.projectOverview ? lineOf(brief.projectOverview) : [],
      brief.positioning ? [`- 产品定位：[${brief.positioning.nature === "FACT" ? "确认事实" : brief.positioning.nature === "ASSUMPTION" ? "待确认假设" : "证据推导"}] ${brief.positioning.text}`] : [],
      brief.targetUser ? [`- 目标用户：[${brief.targetUser.nature === "FACT" ? "确认事实" : brief.targetUser.nature === "ASSUMPTION" ? "待确认假设" : "证据推导"}] ${brief.targetUser.text}`] : [],
      ...brief.userScenarios?.map((item) => lineOf(item)) ?? [],
    ].flat(),
  );
  // 研报提出的问题可能只有孤立证据：标题明确「待核实」，避免被读成已确认开发需求。
  section("研报提出的用户问题（证据待核实）", brief.corePainPoints.map(lineOf));
  section(
    "改进方向（VOC 复现痛点派生 · 待验证假设）",
    brief.vocRequirements === undefined
      ? []
      : brief.vocRequirements.map(lineOf),
  );
  section(
    "基准 / 代表商品",
    brief.benchmarks.map((benchmark) => `- ${benchmark.asin}（${benchmark.role === "benchmark" ? "基准" : benchmark.role === "newcomer" ? "新进入者" : benchmark.role === "pain_point" ? "痛点" : "FAST_TRACK"}）${benchmark.title ?? ""}`),
  );
  section("差异化方向（事实 vs 假设）", brief.differentiation.map(lineOf));
  section("竞争性因果假设（研究来源）", brief.competitiveHypotheses?.map(lineOf) ?? []);
  section("竞争方案与保留现状备选（研究来源）", brief.researchAlternatives?.map(lineOf) ?? []);
  section("支持当前解释的证据（研究来源）", brief.supportingEvidence?.map(lineOf) ?? []);
  section("反证 / 可能推翻点（研究来源）", brief.counterevidence?.map(lineOf) ?? []);
  section("研究未验证假设（不得当作事实）", brief.researchAssumptions?.map(lineOf) ?? []);
  if (brief.causalInvestigations !== undefined) section("逐项原因调查（AI 假设，证据需人工核实）", brief.causalInvestigations.flatMap((item, index) => [
    `### 原因 ${index + 1}：${item.hypothesis.text}（待验证）`,
    ...(item.rationale ? [`- 为什么提出：${item.rationale.text}${item.rationale.evidenceRefs.length ? `（证据：${item.rationale.evidenceRefs.join("、")}）` : ""}`] : []),
    `- AI 可信度估计：${item.confidence}（并非事实确认）`,
    ...(item.supportingEvidence.length ? item.supportingEvidence.map((line) => `  - 支持线索：${lineOf(line).slice(2)}`) : ["  - 支持线索：未知"]),
    ...(item.counterevidence.length ? item.counterevidence.map((line) => `  - 反证线索：${lineOf(line).slice(2)}`) : ["  - 反证线索：未知"]),
    ...(item.unknowns.length ? item.unknowns.map((value) => `  - 未知：${value}`) : ["  - 未知：未提供"]),
    ...(item.verification.length ? item.verification.map((value) => `  - 验证：${value}`) : ["  - 验证：未提供"]),
  ]));
  // 2026-10-30：把「原因假设」推进到「可开发化的改良假设」。
  // 需求单原本只有原因与验证动作，缺少「改哪个部位 / 可能牺牲什么 / 成本与合规未知在哪」，
  // 交给供应商时无法沟通。这里由 Brief 已存内容确定性派生，不新增事实、不调用模型。
  // 与决策摘要复用同一份派生结果：页面与导出不能出现两套判断。
  if (planForSummary) {
    const plan = planForSummary;
    out.push("## 改良假设（可开发化 · 根因未确认）", "");
    out.push(`- 计划状态：${plan.statusLabel}（${plan.status}）`);
    out.push(`- 状态依据：${plan.statusReason}`);
    // 规则版本必须写进导出：Markdown 一旦发给供应商，就必须能说明「这是哪套规则派生的」，
    // 而且规则版本不等于研报版本 / 需求单版本，不能混为一谈。
    out.push(`- 派生输入：${plan.inputKinds.length ? plan.inputKinds.map((kind) => (kind === "CAUSE_HYPOTHESIS" ? "原因假设（研究给出）" : "问题陈述（VOC 观察，无原因结论）")).join(" + ") : "（无）"}`);
    if (plan.sourceDisclosure) out.push(`- 来源契约披露：${plan.sourceDisclosure.note}`);
    out.push(`- 派生规则版本：${plan.rulesVersion}；派生摘要：${plan.derivationDigest}（仅用于比对同一规则版本下结果是否一致，不是证据或事实哈希）`);
    out.push(`- 规则版本说明：${plan.rulesVersionNote}`);
    out.push(`- 可改良性分布：${plan.actionabilityCounts.length ? plan.actionabilityCounts.map((entry) => `${entry.label}×${entry.count}`).join("、") : "（无）"}`);
    out.push(`- 归因分布（仅产品问题，文本归类非确认根因）：${plan.attributionCounts.length ? plan.attributionCounts.map((entry) => `${entry.label}×${entry.count}`).join("、") : "（无）"}`);
    out.push("");
    for (const item of plan.items) {
      out.push(`### ${item.inputKind === "CAUSE_HYPOTHESIS" ? "改良假设" : "问题陈述"} ${item.index + 1}：${item.hypothesis}`, "");
      out.push(`- 归因分类：${item.attribution.primaryLabel}（${item.attribution.basis}）`);
      out.push(`- 可改良性判断：${item.actionabilityLabel}（${item.actionabilityStatus}）｜判定依据：${item.actionabilityBasis}`);
      out.push(`- 根因状态：ROOT_CAUSE_UNVERIFIED（文本归类不等于已确认根因）`);
      out.push(`- ${item.evidence.summaryLabel}：${item.evidence.levelLabel}；${item.evidence.basis}`);
      out.push(`- 线索解读边界：${item.evidence.scopeNote}`);
      out.push("");
      if (!item.productActionable) {
        // 非产品 / 混合假设：绝不输出「待验证假设 / 供应商确认事项 / 开发验证要求」三段，
        // 否则等于把市场问题当成开发要求发给供应商。
        out.push(`**不派生产品改良对象**`, "");
        out.push(`- ${item.actionabilityReason ?? "需人工拆分或补充区分性证据后再判断。"}`);
        if (item.verificationTasks.length) {
          out.push(`- 研报已给出的验证动作（供人工判断，不是开发要求）：`);
          for (const task of item.verificationTasks) out.push(`  - [${task.label}] ${task.task}`);
        }
        out.push("");
        if (item.unknowns.length) {
          out.push(`**仍未解决**`, "");
          for (const unknown of item.unknowns) out.push(`- ${unknown}`);
          out.push("");
        }
        continue;
      }
      out.push("**待验证假设（不是开发要求）**", "");
      if (item.targetStatus === "ANCHORED") {
        for (const target of item.candidateTargets) out.push(`- 候选改良对象（模板候选，需人工/供应商确认）：${target}`);
        out.push(`- 部位关联依据：${item.partAnchors.join("、")}（仅列与该部位直接对应的模板）`);
      } else {
        out.push(`- ${item.targetNote ?? "已识别问题但无法确定具体改良部位，需人工确认。"}`);
      }
      if (item.linkedDirections.length) {
        for (const direction of item.linkedDirections) out.push(`- 研报相关差异化方向：${direction}`);
      } else {
        out.push("- 研报相关差异化方向：未提供（不得把泛化建议当作改良方案）");
      }
      if (item.competitiveExplanations.length) {
        out.push("**竞争性解释（未验证，需先区分；不是本商品已确认原因）**", "");
        for (const explanation of item.competitiveExplanations) {
          out.push(`- ${explanation.label}：${explanation.observable}（区分证据：${explanation.discriminatingEvidence}）`);
        }
        out.push("");
      }
      out.push("");
      out.push("**供应商确认事项（通用检查模板，非本商品结论）**", "");
      for (const entry of item.sideEffects) out.push(`- 可能牺牲的性能：${entry.text}`);
      for (const entry of item.costUncertainties) out.push(`- 成本未核算：${entry.text}`);
      for (const entry of item.complianceChecks) out.push(`- 合规待核查：${entry.text}`);
      out.push("");
      out.push("**开发验证要求（研究已给出的动作）**", "");
      if (item.verificationTasks.length) {
        for (const task of item.verificationTasks) out.push(`- [${task.label}] ${task.task}`);
      } else {
        out.push("- 研报未给出验证动作：该假设目前无法验证，不能进入开发");
      }
      for (const category of item.missingVerificationCategories) {
        const suggestion = suggestedVerificationText(category);
        if (suggestion) out.push(`- [建议补齐] ${suggestion}`);
      }
      out.push("");
      if (item.unknowns.length) {
        out.push("**仍未解决**", "");
        for (const unknown of item.unknowns) out.push(`- ${unknown}`);
        out.push("");
      }
    }
    out.push(`> ${plan.disclaimer}`, "");
    out.push("> 进入低成本验证 ≠ 可以立项 ≠ 可以下发生产；供应商事实（材料牌号 / 工艺 / 产能 / 报价）未确认前不得写入采购或生产要求。", "");
  }
  section(
    "拟开发规格",
    [
      "> 从研究参考商品预填的尺寸 / 材质只是参考记录，不是拟开发商品的已确认规格；未经验证的规格不构成开发确认。",
      ...(brief.specifications
        ? brief.specifications.map((row) => {
            const unit = row.unit ? ` ${row.unit}` : "";
            const nature = row.nature === "FACT" ? "参考记录" : row.nature === "ASSUMPTION" ? "待确认假设" : "证据推导";
            // 规格没有正式核验机制；人工 verified 不进入导出结论。
            const verification = row.verification === "not_applicable" ? "不适用" : "未验证";
            return `- ${row.label}：${row.value}${unit}｜[${nature}｜${verification}]${row.evidenceRefs.length ? `（证据：${row.evidenceRefs.join("、")}）` : ""}`;
          })
        : brief.specsDirection.map(lineOf)),
    ],
  );
  section(
    "竞品-本品对照",
    brief.benchmarkComparison
      ? brief.benchmarkComparison.rows.map((row) => `- ${row.label}｜本品：${row.ours ?? "未采集"}｜对照基准：${row.theirs ?? "未采集"}｜[${comparisonOriginLabel(row)}]${row.note ? `（${row.note}）` : ""}`)
      : [],
  );
  const economics = brief.economics;
  const ceiling = economics.purchaseCostCeiling;
  const economicOriginLabel: Record<ProductBriefEconomicProvenance["origin"], string> = {
    PRODUCT_FACT: "商品事实",
    USER_INPUT: "人工输入",
    RESEARCH_ESTIMATE: "03研究/估算",
    MISSING: "未提供",
  };
  const economicsLine = (key: keyof NonNullable<ProductBrief["economics"]["provenance"]>, label: string, value: string): string => {
    const provenance = economics.provenance?.[key];
    const provenanceText = provenance
      ? `｜性质：${economicOriginLabel[provenance.origin]}｜来源：${provenance.source ?? "未注明"}${provenance.note ? `｜说明：${provenance.note}` : ""}`
      : "｜性质：旧快照未记录";
    return `- ${label}：${value}${provenanceText}`;
  };
  section(
    "经济性与购买成本上限",
    [
      economicsLine("targetPrice", "目标售价", `${economics.targetPrice ?? "未确认"} ${economics.currency}`),
      economicsLine("targetMarginPct", "目标毛利率", `${economics.targetMarginPct ?? "未确认"}%`),
      economicsLine("referralFee", "平台佣金（Referral fee）", `${economics.referralFee ?? "未提供"}`),
      economicsLine("fbaFee", "FBA 费用", `${economics.fbaFee ?? "未提供"}`),
      economicsLine("logistics", "物流", `${economics.logistics ?? "未提供"}`),
      economicsLine("estimatedTax", "估算税费", `${economics.estimatedTax ?? "未提供"}`),
      economicsLine("otherKnownCosts", "其他已知成本", `${economics.otherKnownCosts ?? "未提供"}`),
      `- 购买成本上限：${ceiling.status === "COMPUTED" ? `${ceiling.value} ${ceiling.currency}` : `待补齐输入${ceiling.reason ? `（${ceiling.reason}）` : ""}`}`,
      `- 公式：${ceiling.formula}`,
    ],
  );
  section(
    "产品开发确认事项",
    brief.confirmationItems?.map((row) => `- ${row.item}｜状态：${row.status}${row.reason ? `｜说明：${row.reason}` : ""}`) ?? [],
  );
  section("VOC 质量红线", brief.vocQaRedlines.map(lineOf));
  section("风险与形成理由", [...brief.risks, ...brief.rationale].map(lineOf));
  // 验证计划 / 待验证项是**生成时快照**：必须标注当前状态，否则会和上方实时经济性值冲突。
  const annotatedPlan = (brief.verificationPlan ?? []).map((row) => {
    const annotation = annotateSnapshotItem(row.item, decision.economics);
    return `- ${row.item}｜方法：${row.method || "待补充"}｜时点：${row.timing || "待补充"}｜状态：${row.status === "pending" ? "待验证" : row.status === "done" ? "已完成" : "已放弃"}${snapshotAnnotationNote(annotation) ? `｜${snapshotAnnotationNote(annotation)}` : ""}`;
  });
  section("验证计划（生成时快照，当前状态见「② 商业可行性确认」）", annotatedPlan);
  section(
    "待验证项（生成时快照，来源只读）",
    brief.missingValidation.map((item) => {
      const note = snapshotAnnotationNote(annotateSnapshotItem(item, decision.economics));
      return `- ${item}${note ? `｜${note}` : ""}`;
    }),
  );

  out.push("---", "");
  out.push(`来源绑定：taskId=${brief.sourceBinding.taskId}｜researchRevision=${brief.sourceBinding.researchRevision}`, "");
  out.push(`reportHash=${brief.sourceBinding.reportHash}`, `factHash=${brief.sourceBinding.factHash}`, `evidenceHash=${brief.sourceBinding.evidenceHash}`, "");
  out.push(`Brief 修订：rev.${brief.revision}｜由 LightChoice V5 生成（确定性搬运，未调用外部 AI）。`, "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function briefFileName(brief: ProductBrief): string {
  return `ProductBrief_${brief.identity.asin}_rev${brief.revision}.md`;
}
