"use client";

import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import styles from "./BatchWorkspace.module.css";

/**
 * 画廊主图容器（T01 专用，不改共享 ProductImage 的全局尺寸）。
 *
 * 真实性规则与既有 source-layer/ProductImage 一致：
 * - 无 src → 直接占位，不发请求；
 * - 加载失败 / 0 尺寸 → 同一个占位，不出现破图；
 * - 不使用任何伪造图片；`data-image-state` 便于验收区分真实图与占位。
 * 视觉：1:1 舞台 + object-contain，长条/扁平/套装图都能完整展示。
 */
export function GalleryImage({
  src,
  alt,
  onOpenDetail,
}: {
  src: string | null | undefined;
  alt: string;
  onOpenDetail?: () => void;
}) {
  const normalized = typeof src === "string" && src.trim() ? src.trim() : null;
  const [state, setState] = useState<"loading" | "loaded" | "failed">(normalized ? "loading" : "failed");

  useEffect(() => {
    setState(normalized ? "loading" : "failed");
  }, [normalized]);

  const imageState = !normalized ? "PLACEHOLDER" : state === "failed" ? "PLACEHOLDER" : state === "loaded" ? "REAL_IMAGE" : "LOADING";

  const content = normalized && state !== "failed" ? (
    <>
      {state === "loading" ? <span className={styles.imageShimmer} aria-hidden="true" /> : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={normalized}
        alt={alt}
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        data-testid="gallery-product-image"
        data-image-state={imageState}
        className={`${styles.image} ${state === "loaded" ? styles.imageLoaded : styles.imageLoading}`}
        onLoad={(event) => {
          const img = event.currentTarget;
          if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
            setState("failed");
            return;
          }
          setState("loaded");
        }}
        onError={() => setState("failed")}
      />
    </>
  ) : (
    <span
      role="img"
      aria-label={`${alt}（暂无图片）`}
      data-testid="gallery-product-image"
      data-image-state="PLACEHOLDER"
      data-image-reason={normalized ? "load_failed" : "source_missing"}
      className={styles.imagePlaceholder}
      title={normalized ? "已保存图片加载失败；可核对来源与网络" : "已保存证据没有可用图片"}
    >
      <ImageOff size={22} strokeWidth={1.5} aria-hidden="true" />
      <span>{normalized ? "图片加载失败" : "暂无图片"}</span>
    </span>
  );

  return (
    <div className={styles.imageStage} data-image-stage="true">
      <button
        type="button"
        className={styles.imageLink}
        onClick={onOpenDetail}
        aria-label={`查看 ${alt} 详情`}
        title="查看商品详情"
      >
        {content}
      </button>
    </div>
  );
}
