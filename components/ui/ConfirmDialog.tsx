"use client";

import * as React from "react";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";

export interface ConfirmDialogMetrics {
  totalCount: number;
  actionableCount?: number;
  archivableOnlyCount?: number;
  protectedCount?: number;
  protectedReason?: string;
}

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: string;
  metrics?: ConfirmDialogMetrics;
  /** 实际将被操作的对象清单（名称 + 稳定 ID）；危险确认必须展示，防止操作错对象。 */
  selectedItems?: Array<{ id: string; label: string }>;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  isLoading?: boolean;
}

const MAX_LISTED_ITEMS = 8;

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  metrics,
  selectedItems,
  confirmText = "确认操作",
  cancelText = "取消",
  isDestructive = false,
  isLoading = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="md"
      title={
        <div className="flex items-center gap-2">
          {isDestructive ? (
            <AlertTriangle className="size-5 text-rose-600" />
          ) : (
            <Info className="size-5 text-emerald-600" />
          )}
          <span>{title}</span>
        </div>
      }
      description={description}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={isLoading}>
            {cancelText}
          </Button>
          <Button
            variant={isDestructive ? "destructive" : "primary"}
            size="sm"
            onClick={onConfirm}
            isLoading={isLoading}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {metrics && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/75 p-3.5 my-2 space-y-2 text-xs">
          <div className="flex justify-between items-center text-slate-700">
            <span>选中记录总计：</span>
            <span className="font-semibold text-slate-900">{metrics.totalCount} 条</span>
          </div>

          {metrics.actionableCount !== undefined && (
            <div className="flex justify-between items-center text-slate-700">
              <span>可执行条数：</span>
              <span className="font-semibold text-emerald-700">{metrics.actionableCount} 条</span>
            </div>
          )}

          {metrics.archivableOnlyCount !== undefined && metrics.archivableOnlyCount > 0 && (
            <div className="flex justify-between items-center text-amber-800 bg-amber-50/80 -mx-1.5 px-1.5 py-1 rounded border border-amber-200/60">
              <span className="flex items-center gap-1">
                <Info className="size-3.5 text-amber-600" />
                仅允许归档（已有下游引用）：
              </span>
              <span className="font-semibold">{metrics.archivableOnlyCount} 条</span>
            </div>
          )}

          {metrics.protectedCount !== undefined && metrics.protectedCount > 0 && (
            <div className="flex justify-between items-center text-rose-800 bg-rose-50/80 -mx-1.5 px-1.5 py-1 rounded border border-rose-200/60">
              <span className="flex items-center gap-1">
                <ShieldAlert className="size-3.5 text-rose-600" />
                已受保护禁止删除：
              </span>
              <span className="font-semibold">{metrics.protectedCount} 条</span>
            </div>
          )}

          {metrics.protectedReason && (
            <p className="text-[13px] text-slate-500 italic mt-1">{metrics.protectedReason}</p>
          )}
        </div>
      )}

      {selectedItems && selectedItems.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 my-2" data-testid="confirm-selected-items">
          <p className="text-xs font-semibold text-slate-700 mb-1.5">
            即将操作的 {selectedItems.length} 个对象：
          </p>
          <ul className="space-y-1 text-xs text-slate-600">
            {selectedItems.slice(0, MAX_LISTED_ITEMS).map((item) => (
              <li key={item.id} className="flex items-baseline gap-2">
                <span className="truncate">{item.label}</span>
                <code className="shrink-0 text-[12px] text-slate-400">{item.id}</code>
              </li>
            ))}
            {selectedItems.length > MAX_LISTED_ITEMS && (
              <li className="text-slate-400">…等共 {selectedItems.length} 项</li>
            )}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
