import {
  suggestedVerificationText,
  type ImprovementActionabilityStatus,
  type ImprovementPlan,
  type ImprovementVerificationCategory,
} from "@/lib/research/improvementPlan";

/**
 * 03 商品深研 —— 「改良假设（可开发化）」只读卡。
 *
 * 存在理由：正式研报只给到「原因假设 + 验证动作」，产品开发还需要知道
 * 「改哪个部位、可能牺牲什么、成本与合规未知在哪、验证动作覆盖了哪些类别」。
 * 本卡把这层缺口补成确定性派生，不调用模型、不写库、不参与门禁。
 *
 * 展示纪律（五层，顺序固定，不得合并）：
 *   L1 原因假设 → L2 可改良性判断 → L3 候选改良对象 → L4 验证要求 → L5 风险与未知
 * - 归因分类只是对假设文本的归类，必须与「根因未确认」同时出现，不能单独读成结论。
 * - 只有 PRODUCT_ACTIONABLE 才显示模板候选对象；NON_PRODUCT / MIXED 一律不显示。
 * - 通用检查模板逐条标注「模板检查项」，不能与本商品已确认事实混排。
 * - 线索条数只称「证据线索概况」，不得被包装成独立证据或可信度评分。
 * - 缺失信息显示「未提供」，不补数值、不猜供应链事实。
 */

const ACTIONABILITY_TONE: Readonly<Record<ImprovementActionabilityStatus, string>> = {
  PRODUCT_ACTIONABLE: "bg-emerald-50 text-emerald-700",
  NON_PRODUCT: "bg-slate-100 text-slate-700",
  MIXED_OR_UNCERTAIN: "bg-amber-50 text-amber-800",
};

export function ImprovementPlanCard({ plan, stale }: { plan: ImprovementPlan; stale: boolean }) {
  const tone = plan.status === "READY_FOR_LOW_COST_VALIDATION"
    ? "bg-emerald-50 text-emerald-700"
    : plan.status === "NO_ACTIONABLE_CAUSE" || plan.status === "NO_PRODUCT_ACTIONABLE_CAUSE"
      ? "bg-slate-100 text-slate-600"
      : "bg-amber-50 text-amber-700";

  const natureLabel: Record<string, string> = {
    PROPERTY_OBSERVATION: "属性观察（未确认缺陷）",
    DEFECT_CLAIM: "缺陷主张（仍需证据确认）",
    UNCLEAR: "性质不明确",
  };
  const verificationLabel: Record<ImprovementVerificationCategory, string> = {
    competitor_comparison: "对比竞品",
    review_recheck: "复核买家反馈",
    dimension_measurement: "测量尺寸",
    material_structure_check: "材料结构核查",
    sample_test: "样品测试",
    supplier_process: "供应商工艺",
    cost_accounting: "成本核算",
    compliance_check: "合规核查",
    user_trial: "用户试用",
    other: "其他验证",
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="research-improvement-plan-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-bold text-slate-800">改良假设（可开发化）</h3>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`} data-testid="research-improvement-plan-status">
            {plan.statusLabel}
          </span>
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">根因未确认</span>
          <span
            className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
            data-testid="research-improvement-rules-version"
            title={plan.rulesVersionNote}
          >
            派生规则 {plan.rulesVersion}
          </span>
        </div>
        <p className="text-[11px] text-slate-500">
          由研报确定性派生 · 不调用模型
          {plan.inputKinds.length ? ` · 派生输入：${plan.inputKinds.map((kind) => (kind === "CAUSE_HYPOTHESIS" ? "原因假设" : "问题陈述")).join(" + ")}` : ""}
        </p>
      </header>

      <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-600" data-testid="research-improvement-plan-reason">
        {plan.statusReason}
      </p>
      {plan.sourceDisclosure ? (
        <div
          className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-700"
          data-testid="research-improvement-source-disclosure"
        >
          <p className="font-semibold text-slate-800">
            来源契约披露：{plan.sourceDisclosure.sourceKind === "v5" ? "v5 综合研报" : plan.sourceDisclosure.sourceKind === "v1" ? "v1 深度研报" : "未知来源"}
            {plan.sourceDisclosure.missingFacts.length ? ` · 缺 ${plan.sourceDisclosure.missingFacts.length} 类字段` : " · 字段齐全"}
          </p>
          <p className="mt-1">{plan.sourceDisclosure.note}</p>
        </div>
      ) : null}
      {stale ? (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[12px] leading-relaxed text-rose-700">
          研报引用的来源已变化：以下改良假设基于历史报告，需重新确认后再用于开发沟通。
        </p>
      ) : null}

      {plan.items.length === 0 ? (
        <p className="mt-3 text-[13px] text-slate-500" data-testid="research-improvement-plan-empty">
          研报没有提出可执行的原因假设，因此没有派生改良方向。请先补研究，不要在此状态下编写开发要求。
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="research-improvement-actionability-summary">
            <span className="text-[12px] text-slate-500">可改良性分布：</span>
            {plan.actionabilityCounts.map((entry) => (
              <span key={entry.status} className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${ACTIONABILITY_TONE[entry.status]}`}>
                {entry.label} × {entry.count}
              </span>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="research-improvement-attribution-summary">
            <span className="text-[12px] text-slate-500">归因分布（仅统计产品问题，文本归类非确认根因）：</span>
            {plan.attributionCounts.length ? plan.attributionCounts.map((entry) => (
              <span key={entry.category} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">
                {entry.label} × {entry.count}
              </span>
            )) : <span className="text-[11px] text-slate-500">（无产品可改良假设）</span>}
          </div>

          <div className="mt-3 space-y-3">
            {plan.items.map((item) => (
              <article key={item.index} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3" data-testid={`research-improvement-item-${item.index}`}>
                {/* L1 原因假设 */}
                <div data-testid={`research-improvement-item-${item.index}-layer-cause`}>
                  <p className="text-[11px] font-semibold text-slate-400">
                    {item.inputKind === "CAUSE_HYPOTHESIS" ? "① 原因假设（研究提出，不是确认根因）" : "① 问题陈述（VOC 观察，没有原因结论）"}
                  </p>
                  <p className="mt-0.5 text-[13px] font-semibold text-slate-700">
                    {item.inputKind === "CAUSE_HYPOTHESIS" ? "假设" : "问题"} {item.index + 1}：{item.hypothesis}
                  </p>
                  {item.rationale ? (
                    <p className="mt-1 text-[12px] leading-relaxed text-slate-600">为什么提出：{item.rationale}</p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-slate-500">归类依据：{item.attribution.basis}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
                    <span className="font-semibold text-slate-700">{item.evidence.summaryLabel}：</span>
                    <span className="rounded bg-white px-1.5 py-0.5">{item.evidence.levelLabel}</span>
                    <span>{item.evidence.basis}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{item.evidence.scopeNote}</p>
                </div>

                {/* L2 可改良性判断 */}
                <div className="mt-2" data-testid={`research-improvement-item-${item.index}-layer-actionability`}>
                  <p className="text-[11px] font-semibold text-slate-400">② 可改良性判断</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className={`rounded px-1.5 py-0.5 font-semibold ${ACTIONABILITY_TONE[item.actionabilityStatus]}`}>
                      {item.actionabilityLabel}
                    </span>
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700">ROOT_CAUSE_UNVERIFIED</span>
                    <span className="rounded bg-white px-1.5 py-0.5 text-slate-600">归因：{item.attribution.primaryLabel}</span>
                  </p>
                  {item.actionabilityReason ? (
                    <p
                      className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800"
                      data-testid={`research-improvement-item-${item.index}-not-product`}
                    >
                      {item.actionabilityReason}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-slate-500">判定依据：{item.actionabilityBasis}</p>
                  <p className="mt-1 text-[11px] text-slate-600">
                    问题性质：<span className="font-semibold text-slate-800">{natureLabel[item.problemNature] ?? item.problemNature}</span>
                    {item.problemNature === "PROPERTY_OBSERVATION" ? "（「薄/软/尺寸」等属性不等于缺陷，不能直接推导加厚加硬）" : ""}
                  </p>
                  {item.competitiveExplanations.length ? (
                    <div className="mt-1" data-testid={`research-improvement-item-${item.index}-explanations`}>
                      <p className="text-[11px] font-semibold text-slate-600">竞争性解释（未验证，需先区分；不是本商品已确认原因）</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[11px] leading-relaxed text-slate-600">
                        {item.competitiveExplanations.map((explanation, index) => (
                          <li key={index}>
                            <span className="font-semibold text-slate-700">{explanation.label}</span>：{explanation.observable}
                            <span className="text-slate-500">（区分证据：{explanation.discriminatingEvidence}）</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>

                {/* L3 候选改良对象（仅产品问题） */}
                {item.productActionable ? (
                  <div className="mt-2" data-testid={`research-improvement-item-${item.index}-layer-targets`}>
                    <p className="text-[11px] font-semibold text-slate-400">
                      {item.inputKind === "CAUSE_HYPOTHESIS" ? "③ 候选改良对象（模板候选，需人工与供应商确认）" : "③ 候选改良方向（由问题陈述派生，根因未确认，需人工确认）"}
                    </p>
                    {item.targetStatus === "ANCHORED" ? (
                      <>
                        <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[12px] leading-relaxed text-slate-600">
                          {item.candidateTargets.map((target, index) => <li key={index}>{target}</li>)}
                        </ul>
                        <p className="mt-1 text-[11px] text-slate-500">
                          仅输出与问题文本部位词（{item.partAnchors.join("、") || "—"}）直接对应的模板；未匹配的类别模板不列出。
                        </p>
                      </>
                    ) : (
                      <p className="mt-0.5 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800" data-testid={`research-improvement-item-${item.index}-targets-unresolved`}>
                        {item.targetNote}
                        {item.partAnchors.length ? (
                          <span className="mt-1 block text-[11px] text-amber-700">
                            涉及部位：{item.partAnchors.join("、")}（仅用于定位问题，不代表应当改动该部位）
                          </span>
                        ) : null}
                      </p>
                    )}
                    <p className="mt-1 text-[12px] leading-relaxed text-slate-600">
                      {item.inputKind === "CAUSE_HYPOTHESIS" ? "研报中与本原因相关的差异化方向：" : "研报中与本问题相关的差异化方向："}
                      {item.linkedDirections.length
                        ? item.linkedDirections.join("；")
                        : <span className="text-slate-500">未提供（不能把泛化建议当成改良方案）</span>}
                    </p>
                  </div>
                ) : null}

                {/* L4 验证要求（三态都保留：这是研报原文信息） */}
                <div className="mt-2" data-testid={`research-improvement-item-${item.index}-layer-verification`}>
                  <p className="text-[11px] font-semibold text-slate-400">④ 验证要求（需要什么证据才能支持或否定该假设）</p>
                  {item.verificationTasks.length ? (
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[12px] leading-relaxed text-slate-600">
                      {item.verificationTasks.map((task, index) => (
                        <li key={index}>
                          <span className="rounded bg-white px-1 py-0.5 text-[11px] text-slate-600">{task.label}</span>{" "}
                          {task.task}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-0.5 text-[12px] text-slate-500">
                      研报未给出验证动作：{item.inputKind === "CAUSE_HYPOTHESIS" ? "该假设" : "该问题"}目前无法验证，不能进入开发。
                    </p>
                  )}
                  {item.missingVerificationCategories.length ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] leading-relaxed text-slate-500">
                      {item.missingVerificationCategories.map((category) => (
                        <li key={category}>
                          建议补齐【{verificationLabel[category]}】{suggestedVerificationText(category)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                {/* L5 风险与未知 */}
                <div className="mt-2" data-testid={`research-improvement-item-${item.index}-layer-risk`}>
                  <p className="text-[11px] font-semibold text-slate-400">⑤ 风险与未知</p>
                  {item.productActionable ? (
                    <dl className="mt-0.5 space-y-1 text-[12px] leading-relaxed text-slate-600">
                      <div>
                        <dt className="font-semibold text-slate-700">可能牺牲的其他性能（模板检查项）</dt>
                        <dd>
                          <ul className="list-disc space-y-0.5 pl-5">
                            {item.sideEffects.map((entry, index) => <li key={index}>{entry.text}</li>)}
                          </ul>
                        </dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-slate-700">成本影响（未核算）</dt>
                        <dd>
                          <ul className="list-disc space-y-0.5 pl-5">
                            {item.costUncertainties.map((entry, index) => <li key={index}>{entry.text}</li>)}
                          </ul>
                        </dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-slate-700">合规核查（模板检查项，未取得证据）</dt>
                        <dd>
                          <ul className="list-disc space-y-0.5 pl-5">
                            {item.complianceChecks.map((entry, index) => <li key={index}>{entry.text}</li>)}
                          </ul>
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">
                      未派生风险 / 成本 / 合规模板：这些模板只对产品可改良假设有意义，市场问题不应套用产品检查表。
                    </p>
                  )}
                  <p className="mt-1.5 text-[12px] font-semibold text-slate-700">仍未解决</p>
                  {item.unknowns.length ? (
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[12px] leading-relaxed text-slate-600">
                      {item.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}
                    </ul>
                  ) : (
                    <p className="mt-0.5 text-[12px] text-slate-500">
                      {item.inputKind === "CAUSE_HYPOTHESIS" ? "未提供" : "该研报没有逐条未知事项字段；缺失不等于没有问题，需人工补充。"}
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500" data-testid="research-improvement-plan-disclaimer">
        {plan.disclaimer}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500" data-testid="research-improvement-plan-rules-note">
        {plan.rulesVersionNote} 派生摘要：{plan.derivationDigest}（仅用于比对同一规则版本下结果是否一致，不是证据或事实哈希。）
      </p>
    </section>
  );
}
