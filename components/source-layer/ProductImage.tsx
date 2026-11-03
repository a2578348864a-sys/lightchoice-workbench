"use client";

import { useEffect, useState } from "react";
import { Package } from "lucide-react";

/**
 * 商品图片展示与占位。
 *
 * 规则（Phase 1 真实性要求）：
 * - `src` 为空 → 直接显示占位，不发请求；
 * - 加载失败（含非法 https、破损 base64、不支持格式）→ 显示同一个占位，
 *   绝不让浏览器破图图标出现在列表 / 抽屉 / 移动端；
 * - 绝不使用任何伪造的商品图片。
 */
export function ProductImage({
  src,
  alt,
  className = "h-12 w-12 rounded-lg",
  iconClassName = "h-5 w-5",
  placeholderLabel,
  testId = "product-image",
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  iconClassName?: string;
  /** 可选的占位文字；移动端空间小时可省略。 */
  placeholderLabel?: string;
  /** 供验收区分 REAL_IMAGE / PLACEHOLDER，不影响业务渲染。 */
  testId?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [decodedSource, setDecodedSource] = useState<string | null>(null);

  // src 变化时重置失败状态，避免同一组件复用时把新图也判为失败。
  useEffect(() => {
    setFailed(false);
    setDecodedSource(null);
  }, [src]);

  const hasSource = typeof src === "string" && src.trim().length > 0;

  if (!hasSource || failed) {
    return (
      <div
        role="img"
        aria-label={`${alt}（暂无图片）`}
        data-testid={testId}
        data-image-state="PLACEHOLDER"
        data-image-reason={hasSource ? "load_failed" : "source_missing"}
        title={hasSource ? "已保存图片加载失败；可核对来源与网络" : "已保存证据没有可用图片"}
        className={`${className} flex flex-col items-center justify-center gap-0.5 border border-slate-200 bg-slate-100 text-slate-400 shrink-0`}
      >
        <Package className={iconClassName} aria-hidden="true" />
        {placeholderLabel ? (
          <span className="text-[12px] leading-none">{placeholderLabel}</span>
        ) : null}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      onLoad={(event) => {
        const img = event.currentTarget;
        if (img.naturalWidth <= 0 || img.naturalHeight <= 0) { setFailed(true); return; }
        void img.decode().then(() => setDecodedSource(src!.trim())).catch(() => setFailed(true));
      }}
      data-testid={testId}
      data-image-state="REAL_IMAGE"
      data-image-loaded={decodedSource === src?.trim() ? "true" : "false"}
      className={`${className} border border-slate-200 bg-white object-contain shrink-0`}
    />
  );
}
