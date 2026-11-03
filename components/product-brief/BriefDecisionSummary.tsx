import type { BriefDecisionSummary, BriefDecisionTone } from "@/lib/productBrief/briefDecisionSummary";

/**
 * 04 需求单首屏「决策摘要」。
 *
 * 只渲染 `buildBriefDecisionSummary()` 的结果——与 Markdown 导出同一计算来源，
 * 避免页面说一套、导出说一套。不提供编辑，不改变门禁、不写库。
 */

const TONE_CLASS: Readonly<Record<BriefDecisionTone, string>> = {
  ok: "lc-decision-ok",
  warn: "lc-decision-warn",
  blocked: "lc-decision-blocked",
  neutral: "lc-decision-neutral",
};

export function BriefDecisionSummaryCard({ summary }: { summary: BriefDecisionSummary }) {
  return (
    <section className="lc-block" data-testid="brief-decision-summary" aria-label="决策摘要">
      <h3 className="lc-block-title">
        决策摘要<em className="lc-chip lc-chip-read">自动汇总 · 不替代人工决定</em>
      </h3>

      <p className={`lc-decision-headline ${TONE_CLASS[summary.tone]}`} data-testid="brief-decision-headline">
        {summary.headline}
      </p>
      <p className="lc-causal-line" data-testid="brief-decision-headline-basis">{summary.headlineBasis}</p>

      <div className="lc-decision-levels" data-testid="brief-decision-levels">
        {summary.levels.map((level) => (
          <div key={level.key} className="lc-decision-level" data-testid={`brief-decision-level-${level.key}`}>
            <span className="lc-decision-level-label">{level.label}</span>
            <strong className={TONE_CLASS[level.tone]}>{level.value}</strong>
            <span className="lc-decision-level-note">{level.note}</span>
          </div>
        ))}
      </div>

      <div className="lc-decision-grid">
        <div data-testid="brief-decision-problems">
          <h4 className="lc-block-subtitle">主要产品问题（{summary.productProblems.length} 项）</h4>
          {summary.productProblems.length ? (
            <ul className="lc-causal-line">
              {summary.productProblems.map((problem, index) => (
                <li key={index} data-testid={`brief-decision-problem-${index}`}>
                  <span>{problem.text}</span>
                  <span className="lc-decision-meta">
                    来源：{problem.source}｜假设：{problem.isHypothesis ? "是（非确认事实）" : "否"}｜{problem.verified}｜{problem.counter}｜{problem.evidenceRefs}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="lc-empty">{summary.productProblemNote}</p>
          )}
          {summary.productProblems.length && summary.productProblemNote ? <p className="lc-causal-line">{summary.productProblemNote}</p> : null}
        </div>

        <div data-testid="brief-decision-unknowns">
          <h4 className="lc-block-subtitle">最大未知事项（{summary.keyUnknowns.length} 项）</h4>
          {summary.keyUnknowns.length ? (
            <ul className="lc-causal-line">
              {summary.keyUnknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}
            </ul>
          ) : (
            <p className="lc-empty">未列出未知事项，需人工补充；不要假设「没有未知」。</p>
          )}
          <p className="lc-causal-line">{summary.keyUnknownsSource}</p>
        </div>

        <div data-testid="brief-decision-next">
          <h4 className="lc-block-subtitle">
            ① 产品问题验证（{summary.verification.items.length} 项）
            <span className="lc-decision-tag" data-testid="brief-decision-verification-source">
              {summary.verification.sourceKind === "RESEARCH" ? "研报已提出" : summary.verification.sourceKind === "TEMPLATE" ? "规则模板 · 未经人工确认" : "缺失"}
            </span>
          </h4>
          {summary.verification.items.length ? (
            <ol className="lc-causal-line">
              {summary.verification.items.map((action, index) => <li key={index}>{action}</li>)}
            </ol>
          ) : (
            <p className="lc-empty">研报未给出可执行验证动作。</p>
          )}
          <p className="lc-causal-line">{summary.verification.note}</p>
        </div>

        <div data-testid="brief-decision-business">
          <h4 className="lc-block-subtitle">
            ② 商业可行性确认（{summary.business.items.length} 项）
            <span className="lc-decision-tag">值不值得开发</span>
          </h4>
          {summary.business.items.length ? (
            <ul className="lc-causal-line">
              {summary.business.items.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          ) : (
            <p className="lc-empty">商业条件已具备有效值。</p>
          )}
          <p className="lc-causal-line">{summary.business.note}</p>
        </div>

        <div data-testid="brief-decision-supplier">
          <h4 className="lc-block-subtitle">
            ③ 供应商确认（{summary.supplier.items.length} 项）
            <span className="lc-decision-tag">能否制造 / 代价多少</span>
          </h4>
          {summary.supplier.items.length ? (
            <ul className="lc-causal-line">
              {summary.supplier.items.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          ) : (
            <p className="lc-empty">需求单未列出供应商确认事项。</p>
          )}
          <p className="lc-causal-line">{summary.supplier.note}</p>
        </div>

        <div data-testid="brief-decision-stop">
          <h4 className="lc-block-subtitle">停止条件</h4>
          {summary.stopConditions.length ? (
            <ul className="lc-causal-line">
              {summary.stopConditions.map((condition, index) => <li key={index}>{condition}</li>)}
            </ul>
          ) : (
            <p className="lc-empty">{summary.stopConditionsNote}</p>
          )}
        </div>
      </div>

      <details className="lc-decision-caliber" data-testid="brief-decision-caliber">
        <summary>事实与状态口径（点击展开）</summary>
        <ul className="lc-causal-line">
          {summary.caliberNotes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
        <p className="lc-causal-line">
          进入低成本验证 ≠ 可以立项 ≠ 可以下发生产；需求单是人工决策的输入，不是自动立项或生产授权。
        </p>
      </details>
    </section>
  );
}
