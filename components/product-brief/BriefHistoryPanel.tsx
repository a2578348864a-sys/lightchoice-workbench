"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Drawer } from "@/components/ui/Drawer";
import { BRIEF_SECTIONS, dirtySections, draftFromBrief } from "@/lib/productBrief/briefEditing";
import type { ProductBrief, ProductBriefStatus } from "@/lib/productBrief/contract";
import { buildBriefMarkdown } from "@/lib/productBrief/export";

const statusLabel: Record<ProductBriefStatus, string> = { DRAFT: "草稿", READY: "待评审", APPROVED: "已批准" };

/** 使用同一份导出合同展示历史内容，避免重新生成研究或改变当前草稿。 */
export function BriefHistorySnapshot({ version, current }: { version: ProductBrief; current: ProductBrief }) {
  const changed = dirtySections(draftFromBrief(version), current);
  const changedNames = BRIEF_SECTIONS.filter((section) => changed.has(section.id)).map((section) => section.label);
  const oldBinding = version.sourceBinding;
  const newBinding = current.sourceBinding;
  const sourceChanged = oldBinding.researchRevision !== newBinding.researchRevision
    || oldBinding.reportHash !== newBinding.reportHash
    || oldBinding.factHash !== newBinding.factHash
    || oldBinding.evidenceHash !== newBinding.evidenceHash
    || oldBinding.marketScanId !== newBinding.marketScanId
    || oldBinding.marketSampleHash !== newBinding.marketSampleHash;
  const markdown = buildBriefMarkdown(version);
  // 人工文本本身可能包含 Markdown 分隔线；来源页脚是最后一个分隔线之后的内容。
  const footerMarker = "\n---\n";
  const footerIndex = markdown.lastIndexOf(footerMarker);
  const body = footerIndex < 0 ? markdown : markdown.slice(0, footerIndex);
  const source = footerIndex < 0 ? "" : markdown.slice(footerIndex + footerMarker.length);

  return (
    <section data-testid="brief-history-snapshot" aria-label={`第 ${version.revision} 版历史内容`} className="space-y-5">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
        <strong>历史版本 · 只读</strong>
        <p>这是当时保存的内容，不能在此编辑；关闭后会回到当前章节，未保存草稿不受影响。</p>
      </div>
      <section className="rounded-xl border border-emerald-100 bg-emerald-50/50 px-4 py-3 text-sm leading-6 text-slate-700">
        <h3 className="font-semibold text-slate-900">与当前已保存的第 {current.revision} 版比较</h3>
        <p>{changedNames.length ? `人工可编辑内容有变化的章节：${changedNames.join("、")}。` : "人工可编辑内容没有变化。"}</p>
        <p>{sourceChanged ? "研究或市场来源绑定与当前版本不同，请核对下方历史来源。" : "研究与市场来源绑定和当前版本一致。"}</p>
      </section>
      <article className="space-y-2 text-sm leading-7 text-slate-700" aria-label="历史需求单正文">
        {body.split("\n").map((line, index) => {
          if (!line.trim()) return null;
          if (line.startsWith("# ")) return <h3 key={index} className="text-lg font-bold text-slate-900">{line.slice(2)}</h3>;
          if (line.startsWith("## ")) return <h4 key={index} className="mt-5 border-b border-slate-200 pb-1 font-bold text-slate-900">{line.slice(3)}</h4>;
          if (line.startsWith("- ")) return <p key={index} className="break-words pl-3">• {line.slice(2)}</p>;
          return <p key={index} className="break-words">{line}</p>;
        })}
      </article>
      {source.trim() && (
        <details className="rounded-xl border border-slate-200 px-4 py-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-semibold">历史来源与版本标识</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all leading-6">{source.trim()}</pre>
        </details>
      )}
    </section>
  );
}

export function BriefHistoryPanel({ history, current }: { history: readonly ProductBrief[]; current: ProductBrief }) {
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const selected = history.find((version) => version.revision === selectedRevision) ?? null;

  return (
    <>
      <details className="lc-review-history">
        <summary>历史版本（{history.length}）</summary>
        <ul>
          {history.map((version) => (
            <li key={version.revision}>
              <button
                type="button"
                aria-label={`查看第 ${version.revision} 版`}
                className="text-left underline decoration-emerald-300 underline-offset-2 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-emerald-700"
                onClick={() => setSelectedRevision(version.revision)}
              >
                第 {version.revision} 版 · {statusLabel[version.status]} · {new Date(version.generatedAt).toLocaleString("zh-CN")}
              </button>
            </li>
          ))}
        </ul>
      </details>
      {typeof document !== "undefined" && createPortal(
        <Drawer
          isOpen={selected !== null}
          onClose={() => setSelectedRevision(null)}
          title={selected ? `第 ${selected.revision} 版历史需求单` : "历史需求单"}
          description="查看过去保存的内容，不改变当前需求单。"
          width="3xl"
        >
          {selected && <BriefHistorySnapshot version={selected} current={current} />}
        </Drawer>,
        document.body,
      )}
    </>
  );
}
