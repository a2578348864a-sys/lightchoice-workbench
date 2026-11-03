import * as React from "react";
import { Badge, type BadgeTone } from "./Badge";

export type StandardBusinessStatus =
  | "pending"
  | "processing"
  | "ready"
  | "continue"
  | "watch"
  | "drop"
  | "approved"
  | "rejected"
  | "archived"
  | "completed"
  | "failed"
  | "sync_success"
  | "not_synced"
  | "unavailable";

interface StatusConfig {
  label: string;
  tone: BadgeTone;
}

const statusMap: Record<string, StatusConfig> = {
  // 决策状态
  continue: { label: "继续推进", tone: "emerald" },
  pass: { label: "通过", tone: "emerald" },
  approved: { label: "已立项", tone: "emerald" },
  completed: { label: "已完成", tone: "emerald" },
  ready: { label: "就绪", tone: "emerald" },
  creative_ready: { label: "可立项", tone: "emerald" },
  sync_success: { label: "已同步", tone: "emerald" },
  synced: { label: "已同步", tone: "emerald" },
  success: { label: "成功", tone: "emerald" },
  active: { label: "活跃", tone: "emerald" },
  confirmed: { label: "已确认", tone: "emerald" },

  // 中性/进行中
  pending: { label: "待决断", tone: "blue" },
  processing: { label: "研判中", tone: "blue" },
  researching: { label: "研究中", tone: "blue" },
  running: { label: "采集中", tone: "blue" },
  collecting: { label: "资料采集中", tone: "blue" },
  draft: { label: "草稿", tone: "slate" },
  not_synced: { label: "未同步", tone: "slate" },
  not_started: { label: "未开始", tone: "slate" },
  inactive: { label: "未启用", tone: "slate" },
  none: { label: "暂无", tone: "slate" },

  // 警示/观察/待处理
  needs_action: { label: "待拍板", tone: "amber" },
  waiting: { label: "等待处理", tone: "amber" },
  watch: { label: "重点观察", tone: "amber" },
  info_needed: { label: "待补资料", tone: "amber" },
  warning: { label: "需关注", tone: "amber" },
  partial: { label: "部分就绪", tone: "amber" },
  stale: { label: "需重新确认", tone: "amber" },
  research_stale: { label: "需重新确认", tone: "amber" },
  awaiting_confirmation: { label: "待确认事实", tone: "amber" },
  awaiting_decision: { label: "待人工决定", tone: "blue" },

  // 放弃/失败/取消
  drop: { label: "放弃", tone: "rose" },
  rejected: { label: "已否决", tone: "rose" },
  failed: { label: "失败", tone: "rose" },
  cancelled: { label: "已取消", tone: "rose" },
  error: { label: "异常", tone: "rose" },
  unavailable: { label: "不可用", tone: "rose" },

  // 归档
  archived: { label: "已归档", tone: "slate" },
  invalidated: { label: "已失效", tone: "slate" },
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: string | null | undefined;
  customLabel?: string;
  size?: "sm" | "md";
}

export function StatusBadge({ status, customLabel, size = "md", className = "", ...props }: StatusBadgeProps) {
  const normalized = (status || "").toLowerCase().trim();
  const isChinese = !!status && /[\u4e00-\u9fa5]/.test(status);
  const config = statusMap[normalized] || {
    label: customLabel || (isChinese ? status : "待确认"),
    tone: "slate" as BadgeTone,
  };
  const label = customLabel || config.label;

  return (
    <Badge tone={config.tone} size={size} dot className={className} {...props}>
      {label}
    </Badge>
  );
}
