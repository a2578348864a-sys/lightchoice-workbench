import {
  ACTIONABILITY_LABELS,
  suggestedVerificationText,
  type ImprovementPlan,
} from "@/lib/research/improvementPlan";

/**
 * 04 需求单 —— 「改良假设（可开发化）」只读区。
 *
 * 需求单原本只有「原因 + 验证动作」，交给供应商时缺少「改哪个部位、可能牺牲什么、
 * 成本与合规未知在哪」。这里展示确定性派生的结果，并按三分法分组：
 *   待验证假设 / 供应商确认事项 / 开发验证要求。
 *
 * 纪律：
 * - 三分法**只对 PRODUCT_ACTIONABLE** 成立。NON_PRODUCT 回 02；MIXED 需人工拆分，
 *   两者都不得显示任何产品改良对象，否则等于把市场问题写进开发要求。
 * - 归因分类只是文本归类，必须与 ROOT_CAUSE_UNVERIFIED 同屏。
 * - 模板检查项不得与本商品已确认事实混排；不显示任何 MOQ / 报价 / 交期数值。
 * - 线索条数只称「证据线索概况」，不是证据强度或买家数量。
 */
export function ImprovementPlanSection({ plan }: { plan: ImprovementPlan }) {
  return (
    <div className="lc-block" data-testid="brief-improvement-plan">
      <h3 className="lc-block-title">
        改良假设（可开发化 · 根因未确认）<em className="lc-chip lc-chip-read">来源只读</em>
      </h3>
      <p className="lc-block-lead">
        {plan.statusLabel}：{plan.statusReason}
      </p>
      {plan.sourceDisclosure ? (
        <p className="lc-inline-warn" data-testid="brief-improvement-source-disclosure">
          来源契约披露：{plan.sourceDisclosure.note}
        </p>
      ) : null}
      <p className="lc-causal-line" data-testid="brief-improvement-input-kind">
        派生输入：{plan.inputKinds.length ? plan.inputKinds.map((kind) => (kind === "CAUSE_HYPOTHESIS" ? "原因假设（研究给出）" : "问题陈述（VOC 观察，无原因结论）")).join(" + ") : "（无）"}
      </p>
      <p className="lc-causal-line" data-testid="brief-improvement-rules-version">
        派生规则版本：{plan.rulesVersion}（不等于研报版本，也不等于本需求单版本；派生摘要 {plan.derivationDigest} 仅用于比对同一规则版本下结果是否一致）
      </p>
      {plan.actionabilityCounts.length ? (
        <p className="lc-causal-line">
          可改良性分布：
          {plan.actionabilityCounts.map((entry) => `${entry.label}×${entry.count}`).join("、")}
        </p>
      ) : null}
      {plan.attributionCounts.length ? (
        <p className="lc-causal-line">
          归因分布（仅产品问题，文本归类非确认根因）：
          {plan.attributionCounts.map((entry) => `${entry.label}×${entry.count}`).join("、")}
        </p>
      ) : null}
      {plan.items.length === 0 ? (
        <p className="lc-empty">研报没有提出可执行的原因假设，因此没有派生改良方向。不要在此状态下编写开发要求。</p>
      ) : (
        <div className="lc-causal-list">
          {plan.items.map((item) => (
            <div key={item.index} className="lc-causal-card" data-testid={`brief-improvement-${item.index}`}>
              <div className="lc-causal-head">
                <strong>
                  {item.inputKind === "CAUSE_HYPOTHESIS" ? "改良假设" : "问题陈述"} {item.index + 1}：{item.hypothesis}
                </strong>
                <span className="lc-chip lc-chip-read" data-testid={`brief-improvement-${item.index}-actionability`}>
                  {ACTIONABILITY_LABELS[item.actionabilityStatus]}
                </span>
                <span className="lc-causal-confidence">
                  ROOT_CAUSE_UNVERIFIED · {item.evidence.summaryLabel}：{item.evidence.levelLabel}
                </span>
              </div>
              <p className="lc-causal-line">归类依据：{item.attribution.basis}</p>
              <p className="lc-causal-line">
                {item.evidence.basis}；{item.evidence.scopeNote}
              </p>

              {item.productActionable ? (<>
                <p className="lc-inline-warn" data-testid={`brief-improvement-${item.index}-product-caveat`}>
                  以下候选对象根因未确认、仅供验证，不是正式开发要求；供应商事实（材料牌号 / 工艺 / 产能 / 报价）尚未确认。
                </p>
                <h4 className="lc-block-subtitle">待验证假设（不是开发要求）</h4>
                <ul className="lc-causal-line">
                  {item.targetStatus === "ANCHORED"
                    ? item.candidateTargets.map((target, index) => (
                        <li key={index}>候选改良对象（模板候选，需人工/供应商确认）：{target}</li>
                      ))
                    : (
                      <li data-testid={`brief-improvement-${item.index}-targets-unresolved`}>
                        {item.targetNote}
                        {item.partAnchors.length ? `（涉及部位：${item.partAnchors.join("、")}，仅用于定位问题，不代表应当改动该部位）` : ""}
                      </li>
                    )}
                  {item.linkedDirections.length ? (
                    item.linkedDirections.map((direction, index) => <li key={`d-${index}`}>研报相关差异化方向：{direction}</li>)
                  ) : (
                    <li>{item.inputKind === "CAUSE_HYPOTHESIS" ? "研报相关差异化方向" : "与本问题相关的差异化方向"}：未提供（不得把泛化建议当作改良方案）</li>
                  )}
                </ul>

                <h4 className="lc-block-subtitle">供应商确认事项（通用检查模板，非本商品结论）</h4>
                <ul className="lc-causal-line">
                  {item.sideEffects.map((entry, index) => <li key={`s-${index}`}>可能牺牲的性能：{entry.text}</li>)}
                  {item.costUncertainties.map((entry, index) => <li key={`c-${index}`}>成本未核算：{entry.text}</li>)}
                  {item.complianceChecks.map((entry, index) => <li key={`l-${index}`}>合规待核查：{entry.text}</li>)}
                </ul>

                <h4 className="lc-block-subtitle">开发验证要求（研究已给出的动作）</h4>
                {item.verificationTasks.length ? (
                  <ul className="lc-causal-line">
                    {item.verificationTasks.map((task, index) => <li key={index}>[{task.label}] {task.task}</li>)}
                    {item.missingVerificationCategories.length ? (
                      <li>尚未覆盖的验证类别：{item.missingVerificationCategories.length} 类（见 03 商品深研，按需补齐后再报价）</li>
                    ) : null}
                  </ul>
                ) : (
                  <p className="lc-inline-warn">
                    研报未给出验证动作：{item.inputKind === "CAUSE_HYPOTHESIS" ? "该假设" : "该问题"}目前无法验证，不能进入开发。
                  </p>
                )}
              </>) : (
                <p className="lc-inline-warn" data-testid={`brief-improvement-${item.index}-not-product`}>
                  {item.actionabilityStatus === "NON_PRODUCT"
                    ? `该假设属于市场研究问题（${item.actionabilityReason ?? "应回到 02 市场研究处理"}），不属于产品开发需求，因此不显示产品改良对象、供应商检查模板或开发验证要求。`
                    : `该假设的产品 / 市场属性无法可靠区分（${item.actionabilityReason ?? "需人工拆分"}）。请人工拆分假设或补充区分性证据后，再判断是否值得写入开发要求；此处不显示任何未经确认的产品改良对象。`}
                </p>
              )}

              {item.competitiveExplanations.length ? (
                <>
                  <h4 className="lc-block-subtitle">竞争性解释（未验证 · 需先区分）</h4>
                  <ul className="lc-causal-line" data-testid={`brief-improvement-${item.index}-explanations`}>
                    {item.competitiveExplanations.map((explanation, index) => (
                      <li key={index}>{explanation.label}：{explanation.observable}（区分证据：{explanation.discriminatingEvidence}）</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {item.unknowns.length ? (
                <>
                  <h4 className="lc-block-subtitle">仍未解决</h4>
                  <p className="lc-causal-line">{item.unknowns.join("；")}</p>
                </>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <p className="lc-block-lead">{plan.disclaimer}</p>
      <p className="lc-block-lead">进入低成本验证 ≠ 可以立项 ≠ 可以下发生产；供应商事实未确认前不得写入采购或生产要求。</p>
    </div>
  );
}
