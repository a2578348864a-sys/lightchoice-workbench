"use client";

import * as React from "react";
import { X } from "lucide-react";
import { useModalA11y } from "@/components/source-layer/useModalA11y";

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
}

const widthMap = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  // 采集控制台：1440 视口 780px，≥1700 视口 820px（与 T01.5-A C.1 一致）。
  "3xl": "max-w-[min(94vw,780px)] min-[1700px]:max-w-[820px]",
};

export function Drawer({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  width = "lg",
}: DrawerProps) {
  const drawerRef = React.useRef<HTMLDivElement | null>(null);
  const titleId = React.useId();

  // D0-005：与 Dialog 共用同一焦点管理方案（进入、循环、Escape、归还）。
  useModalA11y({ open: isOpen, onClose, containerRef: drawerRef });

  React.useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity animate-in fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Container */}
      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          {...(title ? { "aria-labelledby": titleId } : { "aria-label": "侧边抽屉" })}
          className={`w-screen ${widthMap[width]} bg-white shadow-2xl border-l border-slate-200 flex flex-col animate-in slide-in-from-right duration-200`}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
            <div>
              {title && <h2 id={titleId} className="text-base font-semibold text-slate-900">{title}</h2>}
              {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              aria-label="关闭抽屉"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-6 text-sm text-slate-700">{children}</div>

          {/* Optional Footer */}
          {footer && (
            <div className="border-t border-slate-200 px-6 py-3.5 bg-slate-50 flex items-center justify-end gap-3">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
