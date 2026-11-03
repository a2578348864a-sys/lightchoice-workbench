"use client";

import React from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { ProductImage } from "@/components/source-layer/ProductImage";

export type ProductIdentityProps = {
  image?: string | null;
  title?: string | null;
  chineseTitle?: string | null;
  asin?: string | null;
  marketplace?: string | null;
  brand?: string | null;
  category?: string | null;
  stale?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  href?: string;
  showAmazonLink?: boolean;
  className?: string;
  badge?: React.ReactNode;
  /**
   * 列表场景专用：优先用真实商品名做主标题。
   * 默认契约会用「品牌 · 品类」当主标题（HF-14/HF-16 中文概括优先），
   * 但同一店铺/同品类的多个商品会因此显示成一模一样的标题（例：三张卡片都叫「Kitchen & Dining 商品」），
   * 无法用于识别商品。仅在需要逐行区分商品时打开，不改默认行为、不写回任何事实字段。
   */
  preferProductTitle?: boolean;
};

export function resolveMarketplaceLabel(marketplace?: string | null): string {
  if (!marketplace) return "美国站";
  const code = marketplace.toUpperCase();
  if (code === "US") return "美国站 (US)";
  if (code === "JP") return "日本站 (JP)";
  if (code === "UK" || code === "GB") return "英国站 (UK)";
  if (code === "DE") return "德国站 (DE)";
  return `${code} 站`;
}

export function resolveProductIdentityTitle({ title, asin, brand, category }: Pick<ProductIdentityProps, "title" | "asin" | "brand" | "category">): string {
  const normalizedTitle = title?.trim();
  const normalizedAsin = asin?.trim();
  const titleIsOnlyAsin = Boolean(normalizedTitle && normalizedAsin && normalizedTitle.toLowerCase() === normalizedAsin.toLowerCase());

  if (normalizedTitle && !titleIsOnlyAsin) return normalizedTitle;
  if (brand && category) return `${brand} · ${category}`;
  if (brand) return `${brand} 商品`;
  if (category) return `Amazon ${category} 商品`;
  if (asin) return `Amazon 商品 · ${asin}`;
  return "— 未提供标题";
}

/**
 * 统一商品识别组件 (PRODUCT_IDENTITY_UI_CONTRACT)
 * 优先级：
 * 1. 商品主图 (Image)
 * 2. 中文概括主标题 + 英文原标题副标题 (HF-14 / HF-16)
 * 3. 品牌 / 核心品类 (Brand / Category)
 * 4. ASIN · 站点 · 状态 (Metadata)
 */
export function ProductIdentity({
  image,
  title,
  chineseTitle,
  asin,
  marketplace = "US",
  brand,
  category,
  stale = false,
  size = "md",
  href,
  showAmazonLink = false,
  className = "",
  badge,
  preferProductTitle = false,
}: ProductIdentityProps) {
  // 标题兜底降级策略：真实采集标题 -> 品牌+品类 -> Amazon 商品 · ASIN -> 未提供标题
  const resolvedTitle = resolveProductIdentityTitle({ title, asin, brand, category });
  const hasChinese = /[\u4e00-\u9fa5]/.test(resolvedTitle);
  // chineseTitle 为展示层中文主标题（presentation-only）：
  // 由服务端从已有权威字段推导，绝不作为 ProductFact 写回。
  // 未提供时退回既有降级链，并在有英文原标题时把它保留为灰色副标题。
  const normalizedChineseTitle = typeof chineseTitle === "string" && chineseTitle.trim() ? chineseTitle.trim() : null;
  const primaryTitle = preferProductTitle
    ? resolvedTitle
    : normalizedChineseTitle
      ?? (hasChinese ? resolvedTitle : (brand && category ? `${brand} · ${category}` : category ? `${category} 商品` : resolvedTitle));
  // 主标题已经是真实商品名时不再重复一行副标题。
  const subtitle = primaryTitle === resolvedTitle
    ? null
    : resolvedTitle;
  const marketLabel = resolveMarketplaceLabel(marketplace);

  const imgSizeClass =
    size === "xl"
      ? "size-28 sm:size-32 rounded-xl"
      : size === "lg"
      ? "size-20 sm:size-24 rounded-xl"
      : size === "sm"
      ? "size-10 rounded-lg"
      : "size-12 rounded-lg";

  const iconSizeClass = size === "xl" ? "size-10" : size === "lg" ? "size-8" : size === "sm" ? "size-4" : "size-5";

  return (
    <div data-testid="product-identity" className={`flex items-start gap-3 min-w-0 ${className}`}>
      <ProductImage
        src={image}
        alt={primaryTitle}
        className={`${imgSizeClass} border border-slate-200 object-contain shrink-0 bg-white`}
        iconClassName={iconSizeClass}
        testId="product-identity-image"
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {href ? (
            <Link
              href={href}
              data-testid="product-identity-primary-title"
              className={`font-semibold text-slate-900 hover:text-emerald-700 leading-snug line-clamp-2 transition ${size === "xl" ? "text-sm sm:text-base" : "text-xs"}`}
              title={primaryTitle}
            >
              {primaryTitle}
            </Link>
          ) : (
            <span
              data-testid="product-identity-primary-title"
              className={`font-semibold text-slate-900 leading-snug line-clamp-2 ${size === "xl" ? "text-sm sm:text-base" : "text-xs"}`}
              title={primaryTitle}
            >
              {primaryTitle}
            </span>
          )}
        </div>

        {/* 英文原标题副标题 (HF-14 / HF-16) */}
        {subtitle && (
          <p
            data-testid="product-identity-secondary-title"
            className="mt-0.5 text-[13px] text-slate-400 line-clamp-1"
            title={subtitle}
          >
            {subtitle}
          </p>
        )}

        {/* 品牌与品类 (Secondary Context) */}
        {(brand || category) && (
          <p className="mt-0.5 text-[13px] text-slate-500 truncate">
            {brand && <span className="font-medium text-slate-600">{brand}</span>}
            {brand && category && <span> · </span>}
            {category && <span>{category}</span>}
          </p>
        )}

        {/* 次要元数据: ASIN · 站点 · 状态 */}
        <div className="mt-1 flex items-center gap-2 text-[13px] text-slate-400 font-mono flex-wrap">
          {asin && (
            <span>
              {asin}
              {marketLabel ? ` · ${marketLabel}` : ""}
            </span>
          )}
          {stale && (
            <span className="rounded bg-amber-100 px-1.5 py-0.2 text-[12px] font-bold text-amber-800 font-sans">
              需重新确认
            </span>
          )}
          {showAmazonLink && asin && (
            <a
              href={`https://www.amazon.com/dp/${asin}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center text-slate-400 hover:text-emerald-600 font-sans"
              title="前往亚马逊页面"
            >
              <ExternalLink className="size-2.5 ml-0.5" />
            </a>
          )}
          {badge}
        </div>
      </div>
    </div>
  );
}
