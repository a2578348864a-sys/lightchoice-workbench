import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  /** 英文辅助标题：中文优先，英文仅作辅助，不替代主标题。 */
  titleEn?: string;
  description?: string;
  breadcrumbs?: BreadcrumbItem[];
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

export function PageHeader({
  eyebrow,
  title,
  titleEn,
  description,
  breadcrumbs,
  actions,
  children,
}: PageHeaderProps) {
  return (
    <div className="lc-heading lc-standard-heading border-b border-slate-200 pb-5 mb-6">
      {/* Breadcrumbs */}
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="面包屑导航" className="mb-2 flex items-center gap-1.5 text-[13px] text-slate-500">
          {breadcrumbs.map((crumb, idx) => {
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <React.Fragment key={idx}>
                {idx > 0 && <ChevronRight className="size-3.5 text-slate-400" />}
                {crumb.href && !isLast ? (
                  <Link href={crumb.href} className="hover:text-slate-800 transition-colors">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className={isLast ? "font-medium text-slate-800" : ""}>{crumb.label}</span>
                )}
              </React.Fragment>
            );
          })}
        </nav>
      )}

      {/* Eyebrow */}
      {eyebrow && <p className="text-[12px] font-semibold uppercase tracking-wider text-emerald-700">{eyebrow}</p>}

      {/* Title & Actions Row */}
      <div className="mt-1 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-[28px] sm:leading-9">
            {title}
            {titleEn ? (
              <span className="ml-2.5 align-middle text-base font-medium tracking-normal text-slate-400 sm:text-lg">
                {titleEn}
              </span>
            ) : null}
          </h1>
          {description && <p className="mt-1.5 max-w-3xl text-[15px] leading-[1.65] text-slate-600">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2.5 sm:shrink-0">{actions}</div>}
      </div>

      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
