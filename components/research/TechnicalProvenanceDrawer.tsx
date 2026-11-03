"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Hash } from "lucide-react";

export function TechnicalProvenanceDrawer(props: {
  reportHash: string | null;
  factHash: string | null;
  evidenceHash: string | null;
  decisionBindingHash: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = [
    ["研究版本绑定", props.reportHash],
    ["商品事实绑定", props.factHash],
    ["证据来源绑定", props.evidenceHash],
    ["决策版本绑定", props.decisionBindingHash],
  ] as const;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-xs">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center justify-between p-4 text-xs font-bold text-slate-800 hover:bg-slate-50 transition">
        <span className="flex items-center gap-2"><Hash className="size-4 text-slate-500" />技术核验证书</span>
        {expanded ? <ChevronUp className="size-4 text-slate-400" /> : <ChevronDown className="size-4 text-slate-400" />}
      </button>
      {expanded && (
        <div className="grid grid-cols-1 gap-3 border-t border-slate-100 bg-slate-50/50 p-5 text-xs sm:grid-cols-2">
          <p className="sm:col-span-2 text-[13px] text-slate-500">以下内容用于核对版本与来源绑定，不代表商品质量或系统自动决策。</p>
          {rows.map(([label, value]) => (
            <div key={label}>
              <span className="block text-[13px] text-slate-400">{label}</span>
              <span className="break-all font-mono text-slate-600">{value || "— 尚未生成"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
