"use client";

import type { ProductBriefEvidenceLine } from "@/lib/productBrief/contract";

function EvidenceList({ items, empty }: { items: readonly ProductBriefEvidenceLine[]; empty: string }) {
  if (!items.length) return <p className="text-xs text-slate-400">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={`${item.text}:${index}`} className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[12px] font-bold text-blue-800">证据推导</span>
            {item.evidenceRefs.map((ref) => <code key={ref} className="rounded bg-slate-100 px-1.5 py-0.5 text-[12px] text-slate-500">{ref}</code>)}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-800">{item.text}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * P1-VOC/BR-03：改进方向段（只读）。
 *
 * vocRequirements 只由 recurring 痛点派生（deterministic，零 AI 自由度）：
 * - undefined = 旧版需求单尚未生成该段（提示重新生成，不冒充有空结论）；
 * - [] = 当前 VOC 证据没有 recurring 级痛点（弱信号不会升级为改进方向）；
 * - 非空 = 逐条展示，标注「待验证假设」性质与证据引用。
 */
export function VocRequirementsSection({ vocRequirements }: { vocRequirements: readonly ProductBriefEvidenceLine[] | undefined }) {
  return (
    <section id="brief-voc-requirements-section" data-testid="brief-voc-requirements" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs print:rounded-none print:border-b print:shadow-none">
      <h2 className="section-title text-sm font-bold text-slate-950">改进方向（由 VOC 复现痛点派生 · 待验证假设）</h2>
      <p className="mt-1 text-[13px] text-slate-500">
        仅当同一类买家痛点<strong>反复出现（recurring）</strong>时才派生改进方向，每条都带证据引用，可逐一溯源到评论原文。
        它们是<strong>待验证的开发假设</strong>，不是已确认的产品要求；只有关键词提及或个别反馈的主题不会出现在这里——它们只会进入下方「产品开发确认事项」的待确认清单。
      </p>
      <div className="mt-3">
        {vocRequirements === undefined ? (
          <p className="text-[13px] text-amber-700">旧版需求单尚无改进方向段：重新生成后将自动从 recurring VOC 痛点派生。</p>
        ) : (
          <EvidenceList
            items={vocRequirements}
            empty="当前 VOC 证据中没有「反复出现」级别的痛点，因此没有可派生的改进方向；少量反馈不会自动成为产品要求。"
          />
        )}
      </div>
    </section>
  );
}
