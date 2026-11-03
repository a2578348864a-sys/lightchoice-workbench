"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

export interface PageToolbarProps {
  searchValue?: string;
  onSearchChange?: (val: string) => void;
  searchPlaceholder?: string;
  filters?: React.ReactNode;
  actions?: React.ReactNode;
  rightActions?: React.ReactNode;
  className?: string;
}

export function PageToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = "搜索...",
  filters,
  actions,
  rightActions,
  className = "",
}: PageToolbarProps) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between shadow-2xs mb-4 ${className}`.trim()}
    >
      {/* Left / Main filters */}
      <div className="flex flex-1 flex-wrap items-center gap-2.5">
        {onSearchChange !== undefined && (
          <div className="relative min-w-[200px] max-w-sm flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-slate-400" />
            <input
              type="text"
              value={searchValue || ""}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded-md border border-slate-200 bg-slate-50/50 py-1.5 pl-8 pr-7 text-xs text-slate-800 placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            {searchValue && (
              <button
                onClick={() => onSearchChange("")}
                className="absolute right-2 top-2 rounded p-0.5 text-slate-400 hover:text-slate-600"
                aria-label="清空搜索"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )}

        {filters}
        {actions}
      </div>

      {/* Right side utility / buttons */}
      {rightActions && <div className="flex items-center gap-2 sm:shrink-0">{rightActions}</div>}
    </div>
  );
}
