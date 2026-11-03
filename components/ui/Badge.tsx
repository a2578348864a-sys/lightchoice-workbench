import * as React from "react";

export type BadgeTone = "slate" | "blue" | "emerald" | "amber" | "rose" | "indigo" | "purple";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: "sm" | "md";
  dot?: boolean;
}

const toneStyles: Record<BadgeTone, string> = {
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
};

const dotColors: Record<BadgeTone, string> = {
  slate: "bg-slate-400",
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  indigo: "bg-indigo-500",
  purple: "bg-purple-500",
};

export function Badge({
  className = "",
  tone = "slate",
  size = "md",
  dot = false,
  children,
  ...props
}: BadgeProps) {
  const sizeStyle = size === "sm" ? "px-1.5 py-0.5 text-[13px]" : "px-2 py-0.5 text-xs";
  const toneStyle = toneStyles[tone] || toneStyles.slate;

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap font-medium rounded-md border ${toneStyle} ${sizeStyle} ${className}`.trim()}
      {...props}
    >
      {dot && <span className={`size-1.5 rounded-full ${dotColors[tone]}`} />}
      {children}
    </span>
  );
}
