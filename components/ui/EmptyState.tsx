import * as React from "react";
import { FolderSearch } from "lucide-react";
import { Button } from "./Button";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  actionText?: string;
  onAction?: () => void;
  secondaryActionText?: string;
  onSecondaryAction?: () => void;
  className?: string;
}

export function EmptyState({
  icon = <FolderSearch className="size-6 text-slate-400" />,
  title,
  description,
  actionText,
  onAction,
  secondaryActionText,
  onSecondaryAction,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 py-7 text-center rounded-xl border border-dashed border-slate-300 bg-white/60 my-3 ${className}`.trim()}
    >
      <div className="flex items-center justify-center size-11 rounded-full bg-slate-50 border border-slate-200 mb-2.5 text-slate-500 shadow-2xs">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">{description}</p>}
      {(actionText || secondaryActionText) && (
        <div className="mt-3.5 flex items-center gap-2.5">
          {actionText && onAction && (
            <Button size="sm" variant="primary" onClick={onAction}>
              {actionText}
            </Button>
          )}
          {secondaryActionText && onSecondaryAction && (
            <Button size="sm" variant="outline" onClick={onSecondaryAction}>
              {secondaryActionText}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
