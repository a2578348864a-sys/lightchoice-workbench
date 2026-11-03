"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { BRIEF_SECTIONS, describeDraftValue, draftChanges, type BriefDraft, type ConflictChoices } from "@/lib/productBrief/briefEditing";

/** 整组字段逐条展示可比对的关键列，不显示技术字段。 */
const LIST_LABELS: Partial<Record<keyof BriefDraft, readonly string[]>> = {
  specifications: ["label", "value", "unit", "nature", "verification"],
  confirmationItems: ["item", "status", "reason"],
  benchmarkComparison: ["label", "ours", "theirs", "nature", "note"],
  verificationPlan: ["item", "method", "timing", "status"],
};

function readable(key: keyof BriefDraft, value: BriefDraft[keyof BriefDraft]): string {
  if (typeof value === "string") return value.trim() ? value : "未填写 / 未知";
  const list = value as readonly Record<string, unknown>[];
  if (!list.length) return "无记录";
  const columns = LIST_LABELS[key] ?? [];
  return list
    .map((item, index) => {
      const parts = columns.map((column) => item[column]).filter((part) => part !== null && part !== undefined && String(part).trim() !== "");
      return `${index + 1}. ${parts.length ? parts.join(" · ") : describeDraftValue(key, value)}`;
    })
    .join("\n");
}

/**
 * CAS 冲突对照（对照 3414 设计预览第 47 张）：
 * 本地草稿基于 base 版本，服务器已有 latest 版本。
 * 只有「双方都改且不同」的字段需要人工选择；列表按整组处理，不做按行合并。
 */
export function BriefConflictPanel({
  base,
  latest,
  draft,
  baseRevision,
  latestRevision,
  busy,
  onResolve,
}: {
  base: BriefDraft;
  latest: BriefDraft;
  draft: BriefDraft;
  baseRevision: number;
  latestRevision: number;
  busy: boolean;
  onResolve: (choices: ConflictChoices) => void;
}) {
  const [choices, setChoices] = useState<ConflictChoices>({});
  const rows = draftChanges(base, draft, latest);
  const conflicts = rows.filter((row) => row.conflict);
  const missing = conflicts.filter((row) => !choices[row.key]).length;
  const sectionLabel = (id: string) => BRIEF_SECTIONS.find((section) => section.id === id)?.label ?? "";

  return (
    <section className="lc-conflict" aria-label="版本冲突对照" data-testid="brief-conflict-panel">
      <div className="lc-conflict-banner">
        <div>
          <strong>发现新版本，你的输入仍然保留</strong>
          <p>另一客户端已保存新版本。你的输入已保留，请先对照最新版本，逐项决定后再保存。</p>
        </div>
        <span className="lc-conflict-badge">最新 v{latestRevision}</span>
      </div>

      <div className="lc-conflict-card">
        <h2>对照变动章节，逐项决定保留哪一份</h2>
        <p className="lc-conflict-lead">
          本地基于第 {baseRevision} 版，最新为第 {latestRevision} 版。
          {conflicts.length > 0 ? `其中 ${conflicts.length} 项双方都修改过，必须逐项选择；` : "没有同字段冲突，其余修改会按来源自动保留；"}
          规格、对照表、确认事项与验证计划按整组处理，不会按行号拼接，也不会自动保存。
        </p>

        <div className="lc-conflict-list">
          {rows.map((row) => (
            <div key={row.key} className="lc-conflict-row" data-testid={`brief-conflict-${row.key}`}>
              <div className="lc-conflict-row-head">
                <strong>{sectionLabel(row.section)} / {row.label}</strong>
                <span className={row.conflict ? "lc-tag lc-tag-warn" : "lc-tag"}>
                  {row.conflict ? "双方都改，需选择" : row.localChanged ? "仅本地修改，将保留" : "仅最新版本修改，将读取"}
                </span>
              </div>
              <div className="lc-conflict-pair">
                <div><span>我的输入</span><pre>{readable(row.key, row.local)}</pre></div>
                <div><span>最新已保存</span><pre>{readable(row.key, row.remote)}</pre></div>
              </div>
              {row.conflict && (
                <fieldset className="lc-conflict-choices">
                  <legend>{row.label}的处理方式</legend>
                  {([["local", "保留我的输入"], ["remote", "采用最新值"]] as const).map(([value, label]) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name={`conflict-${row.key}`}
                        value={value}
                        checked={choices[row.key] === value}
                        onChange={() => setChoices((previous) => ({ ...previous, [row.key]: value }))}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          ))}
        </div>

        <div className="lc-conflict-foot">
          <p role="status">{missing > 0 ? `还有 ${missing} 项未选择，暂不能继续保存。` : "选择后不会立即保存；应用后请回到顶部保存修改。"}</p>
          <Button size="sm" variant="primary" disabled={missing > 0 || busy} onClick={() => onResolve(choices)} data-testid="brief-conflict-apply">应用选择，继续编辑</Button>
        </div>
      </div>
    </section>
  );
}
