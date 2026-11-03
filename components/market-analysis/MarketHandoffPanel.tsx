"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, RotateCcw } from "lucide-react";
import { ProductImage } from "@/components/source-layer/ProductImage";
import styles from "./MarketHandoffPanel.module.css";

export type HandoffRole = "benchmark" | "newcomer" | "pain_point";

export type HandoffDraftItem = {
  marketSampleKey: string;
  asin: string;
  subjectKey: string;
  title: string;
  brand?: string | null;
  imageSrc?: string | null;
  role: HandoffRole;
  note: string;
  invalid: boolean;
};

export type HandoffSavedItem = {
  marketSampleKey: string;
  asin: string;
  subjectKey: string;
  role: HandoffRole;
  note: string | null;
};

const ROLE_LABELS: Record<HandoffRole, string> = { benchmark: "基准商品", newcomer: "新进入者", pain_point: "痛点样本" };
const NOTE_LIMIT = 1000;
const NOTE_MIN_HEIGHT = 132;
const NOTE_MAX_HEIGHT = 340;

/** 理由编辑器：默认 132px，随内容自动增高，超过 340px 才内部滚动；仍可手动拉伸。 */
function NoteEditor({
  value,
  onChange,
  disabled,
  invalid,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  invalid: boolean;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(NOTE_MAX_HEIGHT, Math.max(NOTE_MIN_HEIGHT, el.scrollHeight))}px`;
  }, [value]);
  const nearLimit = value.length > NOTE_LIMIT - 80;
  return (
    <div className={styles.noteWrap} data-invalid={invalid || undefined}>
      <textarea
        ref={ref}
        className={styles.noteInput}
        value={value}
        aria-label={ariaLabel}
        maxLength={NOTE_LIMIT}
        disabled={disabled}
        placeholder="写清楚为什么选它：它代表哪类商品、支撑哪个判断、还需要在商品研究里验证什么。"
        onChange={(event) => onChange(event.target.value)}
      />
      <div className={styles.noteFoot}>
        <span className={styles.noteHint}>1–{NOTE_LIMIT} 字符，前后端同一限制</span>
        <span className={styles.noteCount} data-near={nearLimit || undefined}>{value.length}/{NOTE_LIMIT}</span>
      </div>
    </div>
  );
}

/**
 * 决策工作区 → 代表商品与商品研究交接（P1-03 / P1-HANDOFF-UX）。
 * 纯展示与回调：市场判断、代表保存、进入商品研究的写入全部由既有 handler 执行；
 * 本组件不持有业务状态，只把真实门禁原因、保存状态与恢复动作显示出来。
 */
export function MarketHandoffPanel({
  gateStatus,
  gateStale,
  archived,
  busy,
  formalSampleCount,
  draftCount,
  draftSaved,
  draft,
  saved,
  notice,
  onRoleChange,
  onNoteChange,
  onSave,
  onHandoff,
  onGoToGate,
  onGoToSamples,
  onReload,
  onRestoreDraft,
}: {
  gateStatus?: string | null;
  gateStale?: boolean;
  archived: boolean;
  busy: boolean;
  formalSampleCount: number;
  draftCount: number;
  draftSaved: boolean;
  draft: HandoffDraftItem[];
  saved: HandoffSavedItem[];
  notice?: { type: "success" | "error" | "info"; message: string } | null;
  onRoleChange: (marketSampleKey: string, role: HandoffRole) => void;
  onNoteChange: (marketSampleKey: string, note: string) => void;
  onSave: () => void;
  onHandoff: () => void;
  onGoToGate: () => void;
  onGoToSamples: () => void;
  /** 冲突/失败后重新读取服务端最新代表状态；会丢弃未保存草稿，调用前必须确认。 */
  onReload?: () => void;
  /** 把「重新读取前保留的草稿」写回父级编辑状态。 */
  onRestoreDraft?: (items: Array<{ marketSampleKey: string; role: HandoffRole; note: string }>) => void;
}) {
  const gatePassed = gateStatus === "PROCEED" && !gateStale;
  const canSave = !busy && !archived && gatePassed && draftCount > 0;
  const canHandoff = !busy && !archived && gatePassed && saved.length > 0;

  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [backup, setBackup] = useState<HandoffDraftItem[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);

  const saveReason = archived ? "研究已归档，不能再保存。"
    : !gatePassed ? (gateStale ? "市场判断已因样本/来源变化失效，需要重新确认。" : "请先完成并通过市场判断。")
      : draftCount < 1 ? "先勾选商品或把推荐加入选择草稿。"
        : "核对角色与必填理由后保存当前草稿。";
  const handoffReason = archived ? "研究已归档，不能交接。"
    : !gatePassed ? (gateStale ? "市场判断已失效，需要重新确认后再交接。" : "请先通过市场判断。")
      : saved.length < 1 ? "尚无已保存代表；请先保存角色与理由。"
        : "只交接已保存代表；当前未保存的草稿不会进入商品研究。";

  const savedByKey = new Map(saved.map((item) => [item.marketSampleKey, item]));
  const dirtyCount = draft.filter((item) => {
    const server = savedByKey.get(item.marketSampleKey);
    return !server || server.role !== item.role || (server.note ?? "") !== item.note;
  }).length;

  const copyDraft = async () => {
    const text = draft.map((item) => `${item.asin} · ${ROLE_LABELS[item.role]}\n${item.note || "（空）"}`).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className={styles.panel} id="benchmark-selection-section" aria-label="代表商品与商品研究交接">
      <header className={styles.head}>
        <div>
          <span className={styles.kicker}>代表与商品研究交接</span>
          <h3>谁来代表这个市场进入商品研究？</h3>
          <p>
            正式样本 {formalSampleCount} 款 · 当前选择草稿 {draftCount} 款 · 已保存代表 {saved.length} 款。
            临时对比只影响本页事实表；保存代表与进入商品研究是两次独立写入。
          </p>
        </div>
        <span className={styles.savedCount} data-testid="representatives-saved-count">已保存 {saved.length} 款</span>
      </header>


      {notice ? (
        <div className={styles.notice} data-tone={notice.type} data-testid="benchmark-action-notice" role={notice.type === "error" ? "alert" : "status"}>
          <span>{notice.message}</span>
          {notice.type === "error" && onReload ? (
            <button type="button" className={styles.reloadAction} onClick={() => setReloadConfirm(true)}>
              重新读取最新状态
            </button>
          ) : null}
        </div>
      ) : null}

      {reloadConfirm ? (
        <div className={styles.reloadConfirm} role="alertdialog" aria-label="重新读取确认">
          <p>
            重新读取会丢弃当前未保存的 {dirtyCount || draftCount} 款修改。可以先把理由复制出来，或保留草稿后再读取。
          </p>
          <div className={styles.reloadActions}>
            <button type="button" className={styles.reloadGhost} onClick={() => void copyDraft()}>
              <Copy size={13} aria-hidden="true" />{copied ? "已复制" : "复制未保存理由"}
            </button>
            <button
              type="button"
              className={styles.reloadPrimary}
              onClick={() => { setBackup(draft); setReloadConfirm(false); onReload?.(); }}
            >
              保留草稿并重新读取
            </button>
            <button type="button" className={styles.reloadGhost} onClick={() => setReloadConfirm(false)}>取消</button>
          </div>
        </div>
      ) : null}

      {backup && onRestoreDraft ? (
        <div className={styles.backupBar} role="status">
          <span>已保留重新读取前的草稿（{backup.length} 款）。</span>
          <button
            type="button"
            onClick={() => { onRestoreDraft(backup.map((item) => ({ marketSampleKey: item.marketSampleKey, role: item.role, note: item.note }))); setBackup(null); }}
          >
            <RotateCcw size={13} aria-hidden="true" />恢复草稿
          </button>
          <button type="button" className={styles.backupDismiss} onClick={() => setBackup(null)}>丢弃</button>
        </div>
      ) : null}

      {draftCount === 0 ? (
        <div className={styles.emptyGuide} data-testid="representatives-empty-guide">
          <p><b>{gatePassed ? "尚未勾选代表商品" : "请先通过市场判断"}</b></p>
          <p>
            {gatePassed
              ? "在上方「正式样本」里搜索并勾选 1–50 款，勾选后会立刻出现在这里标注角色与理由。"
              : "市场判断通过后，才能选择代表商品并交接至商品研究。"}
          </p>
          <button type="button" onClick={gatePassed ? onGoToSamples : onGoToGate}>
            {gatePassed ? "前往勾选商品 ↑" : "前往市场判断 ↑"}
          </button>
        </div>
      ) : (
        <div className={styles.draftGrid}>
          {draft.slice(0, 50).map((item) => {
            const server = savedByKey.get(item.marketSampleKey);
            const sameAsSaved = Boolean(server) && server!.role === item.role && (server!.note ?? "") === item.note;
            return (
              <article
                key={item.marketSampleKey}
                className={styles.draftCard}
                data-testid="representative-item-card"
                data-invalid={item.invalid ? "true" : "false"}
              >
                <div className={styles.draftIdentity}>
                  <ProductImage
                    src={item.imageSrc ?? null}
                    alt={`${item.asin} 商品图`}
                    className={styles.draftImage}
                    placeholderLabel="无图"
                    testId={`handoff-image-${item.asin}`}
                  />
                  <div className={styles.draftTitle}>
                    <b title={item.title}>{item.title}</b>
                    <small>{item.asin}{item.brand ? ` · ${item.brand}` : ""}</small>
                  </div>
                  <span className={styles.saveState} data-state={sameAsSaved ? "saved" : server ? "dirty" : "new"}>
                    {sameAsSaved ? "已保存" : server ? "有未保存修改" : "未保存"}
                  </span>
                </div>

                <label className={styles.field}>
                  <span>代表角色</span>
                  <select
                    value={item.role}
                    aria-label={`${item.asin} 代表商品角色`}
                    disabled={busy || archived}
                    onChange={(event) => onRoleChange(item.marketSampleKey, event.target.value as HandoffRole)}
                  >
                    <option value="benchmark">基准商品</option>
                    <option value="newcomer">新进入者</option>
                    <option value="pain_point">痛点样本</option>
                  </select>
                </label>

                <div className={styles.field}>
                  <span>研究理由 <em>必填</em></span>
                  <NoteEditor
                    value={item.note}
                    ariaLabel={`${item.asin} 选择理由`}
                    disabled={busy || archived}
                    invalid={item.invalid}
                    onChange={(next) => onNoteChange(item.marketSampleKey, next)}
                  />
                </div>

                {item.invalid ? (
                  <p className={styles.invalid} data-testid="rep-note-error">请填写该商品的选择理由（必填）</p>
                ) : (
                  <p className={styles.roleHint}>当前：{ROLE_LABELS[item.role]}</p>
                )}
              </article>
            );
          })}
        </div>
      )}

      <div className={styles.actions}>
        <div className={styles.actionButtons}>
          <button type="button" className={styles.secondary} onClick={onSave} disabled={!canSave} title={saveReason}>
            {busy ? "保存中…" : "保存代表商品"}
          </button>
          <button type="button" className={styles.primary} onClick={onHandoff} disabled={!canHandoff} title={handoffReason}>
            发起商品研究（已保存 {saved.length} 款）
          </button>
        </div>
        <div className={styles.actionNotes}>
          <small>{!canSave ? saveReason : dirtyCount > 0 ? `有 ${dirtyCount} 款未保存修改；保存后会用服务端返回值回读。` : "草稿与已保存一致；保存不会重复写入。"}</small>
          <small>{!canHandoff ? handoffReason : "只使用已保存代表的角色与理由创建商品研究任务；返回 201 不等于交接成功，需回读商品研究。"}</small>
        </div>
      </div>

      <section className={styles.savedList} aria-label="已保存代表">
        <button type="button" className={styles.savedHead} onClick={() => setSavedOpen((open) => !open)} aria-expanded={savedOpen}>
          <span>已保存代表（{saved.length}）</span>
          <em>{savedOpen ? "收起" : "展开查看理由"}<ChevronDown size={13} aria-hidden="true" data-open={savedOpen || undefined} /></em>
        </button>
        {saved.length === 0 ? (
          <p>还没有已保存代表。草稿不会进入商品研究；保存失败或未保存时，发起商品研究的按钮保持禁用并说明原因。</p>
        ) : savedOpen ? (
          <ul>
            {saved.map((item) => (
              <li key={item.marketSampleKey}>
                <b>{item.asin}</b>
                <span>{ROLE_LABELS[item.role] ?? item.role}</span>
                <em>{item.note || "未记录理由"}</em>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.savedCompact}>
            {saved.map((item) => `${item.asin}（${ROLE_LABELS[item.role] ?? item.role}）`).join("、")}
            {dirtyCount > 0 ? ` · ${dirtyCount} 款草稿有修改待保存` : " · 与当前草稿一致"}
          </p>
        )}
      </section>
    </section>
  );
}
