type RuleRow = {
  readonly ruleId: string;
  readonly severity: string;
  readonly status: string;
  readonly reason: string | null;
};

const RULE_LABELS: Record<string, string> = {
  NEGATIVE_NET_PROFIT: "单件净利润为负",
  LOW_GROSS_MARGIN: "毛利率低于红线",
  HIGH_FBA_RATIO: "FBA 费用占比过高",
  LOW_RATING_RISK: "买家评分过低",
  AMAZON_BUYBOX_RISK: "亚马逊自营竞争",
  OVERSIZE_LOGISTICS_RISK: "物流超规风险",
  MINOR_VARIATION_RISK: "弱势变体风险",
  AMAZON_MONOPOLY_RISK: "亚马逊垄断风险",
  PRICE_WAR_COLLAPSE_RISK: "价格战破位风险",
  HIGH_DEAL_DEPENDENCY_RISK: "促销依赖过高",
  BRAND_OLIGOPOLY_RISK: "品牌寡头壁垒",
};

type RuleStatusDisplay = {
  readonly label: string;
  readonly className: string;
  readonly testId: string;
};

function statusDisplay(rule: RuleRow): RuleStatusDisplay {
  if (rule.status === "not_computable") {
    return {
      label: "数据缺失（不可评估）",
      className: "bg-slate-100 text-slate-500 border-slate-200",
      testId: "risk-status-not-computable",
    };
  }
  if (rule.status === "passed") {
    return { label: "通过", className: "bg-emerald-50 text-emerald-700 border-emerald-200", testId: "risk-status-passed" };
  }
  if (rule.status === "triggered" && rule.severity === "BLOCK") {
    return { label: "阻断", className: "bg-rose-50 text-rose-700 border-rose-200", testId: "risk-status-blocked" };
  }
  return { label: "预警", className: "bg-amber-50 text-amber-700 border-amber-200", testId: "risk-status-warning" };
}

/**
 * P0-DC-03：11 条确定性风险规则三态展示 + 未知项清单。
 * 红线：not_computable 一律显示「数据缺失（不可评估）」，禁止渲染为通过。
 */
export function RiskUnknowns({
  rules,
  missingInformation,
}: {
  rules: readonly RuleRow[];
  missingInformation?: readonly string[];
}) {
  if (!rules.length) {
    return (
      <div data-testid="risk-unknowns" className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-[13px] text-slate-500">
        风险规则结果暂不可用（证据边界未就绪）。
      </div>
    );
  }
  const counts = rules.reduce(
    (acc, rule) => {
      const display = statusDisplay(rule);
      if (display.testId === "risk-status-blocked") acc.blocked += 1;
      else if (display.testId === "risk-status-warning") acc.warning += 1;
      else if (display.testId === "risk-status-not-computable") acc.notComputable += 1;
      else acc.passed += 1;
      return acc;
    },
    { blocked: 0, warning: 0, notComputable: 0, passed: 0 },
  );
  const missing = missingInformation ?? [];
  return (
    <div data-testid="risk-unknowns" className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="rounded bg-rose-50 px-1.5 py-0.5 font-semibold text-rose-700" data-testid="risk-count-blocked">阻断 {counts.blocked}</span>
        <span className="rounded bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700" data-testid="risk-count-warning">预警 {counts.warning}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500" data-testid="risk-count-not-computable">缺失 {counts.notComputable}</span>
        <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-700" data-testid="risk-count-passed">通过 {counts.passed}</span>
      </div>
      <ul className="space-y-1.5">
        {rules.map((rule) => {
          const display = statusDisplay(rule);
          return (
            <li key={rule.ruleId} className="flex items-start justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50/50 p-2" data-testid={`risk-rule-${rule.ruleId}`}>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-slate-800">{RULE_LABELS[rule.ruleId] ?? rule.ruleId}</p>
                {rule.reason && <p className="text-[12px] leading-snug text-slate-500">{rule.reason}</p>}
              </div>
              <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[12px] font-semibold ${display.className}`} data-testid={display.testId}>
                {display.label}
              </span>
            </li>
          );
        })}
      </ul>
      {missing.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2" data-testid="risk-missing-list">
          <p className="text-[12px] font-semibold text-slate-600 mb-1">未知项（关键数据缺失）：</p>
          <ul className="space-y-0.5">
            {missing.map((item, index) => (
              <li key={index} className="text-[12px] leading-snug text-slate-500">· {item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
