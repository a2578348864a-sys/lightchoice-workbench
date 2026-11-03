"use client";

import * as React from "react";
import { CheckSquare, X } from "lucide-react";
import { Button } from "./Button";

export interface BulkActionBarProps {
  selectedCount: number;
  onClearSelection: () => void;
  actions: React.ReactNode;
}

export function BulkActionBar({
  selectedCount,
  onClearSelection,
  actions,
}: BulkActionBarProps) {
  if (selectedCount <= 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-white shadow-2xl animate-in slide-in-from-bottom-4 duration-200">
      <div className="flex items-center gap-2 text-xs font-medium border-r border-slate-700 pr-3">
        <CheckSquare className="size-4 text-emerald-400" />
        <span>
          已选择 <strong className="text-emerald-400 font-bold">{selectedCount}</strong> 项
        </span>
      </div>

      <div className="flex items-center gap-2">{actions}</div>

      <button
        onClick={onClearSelection}
        className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
        title="取消全选"
        aria-label="取消全选"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
