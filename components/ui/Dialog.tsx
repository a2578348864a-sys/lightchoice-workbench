"use client";

import * as React from "react";
import { X } from "lucide-react";
import { useModalA11y } from "@/components/source-layer/useModalA11y";

export interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl" | "5xl";
  scrollable?: boolean;
}

const maxWidthMap = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "5xl": "max-w-5xl",
};

export function Dialog({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth = "md",
  scrollable = false,
}: DialogProps) {
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const titleId = React.useId();

  // D0-005：焦点进入弹层、Tab/Shift+Tab 在弹层内循环、Escape 关闭、关闭后焦点归还触发元素。
  useModalA11y({ open: isOpen, onClose, containerRef: dialogRef });

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity animate-in fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Dialog Box */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        {...(title ? { "aria-labelledby": titleId } : { "aria-label": "对话框" })}
        className={`relative z-10 w-full ${maxWidthMap[maxWidth]} ${scrollable ? "max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain" : ""} rounded-xl bg-white p-6 shadow-xl border border-slate-200 animate-in zoom-in-95 duration-150`}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          aria-label="关闭"
        >
          <X className="size-4" />
        </button>

        {title && (
          <div className="mb-4 pr-6">
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
        )}

        <div className="text-sm text-slate-700">{children}</div>

        {footer && <div className="mt-6 flex items-center justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}
