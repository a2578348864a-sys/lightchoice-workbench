"use client";
import { useState } from "react";

/** Product visual: real imageUrl when present; otherwise distinct ASIN illustration.
 *  Never substitutes another product's photo for a different ASIN. */
export function ProductImage({
  asin,
  imageUrl,
  variant,
  name,
  className = "",
  size = "md",
}: {
  asin: string;
  imageUrl?: string | null;
  variant?: string;
  name?: string;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = Boolean(imageUrl) && failedSource === imageUrl;
  const useReal = Boolean(imageUrl) && !failed;

  if (useReal) {
    return (
      <img
        className={`p-img p-img-${size} ${className}`}
        src={imageUrl!}
        alt={name || asin}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedSource(imageUrl!)}
        data-testid={`product-image-${asin}`}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
        }}
      />
    );
  }

  return (
    <div
      className={`p-img p-img-${size} ph ${className}`}
      role="img"
      aria-label={`${name || asin} 商品示意`}
      style={{ width: "100%", height: "100%" }}
      title={failed ? `${asin} 主图加载失败` : `${asin} · 演示示意（正式环境用 ASIN 主图）`}
    >
      <ProductGlyph variant={variant || asin.slice(-2)} />
      {size !== "sm" && (
        <span className="p-img-cap">{failed ? "主图加载失败" : "示意"}</span>
      )}
    </div>
  );
}

function ProductGlyph({ variant }: { variant: string }) {
  const seed = (variant.charCodeAt(0) + variant.charCodeAt(variant.length - 1)) % 4;
  // Distinct mat-like product glyphs — not photos, not cross-ASIN substitution
  return (
    <svg viewBox="0 0 80 80" width="70%" height="70%" aria-hidden="true">
      <rect x="8" y="18" width="64" height="44" rx="6" fill="#087f68" opacity={0.12 + seed * 0.04} />
      <rect x="12" y="22" width="56" height="36" rx="4" stroke="#087f68" strokeWidth="1.6" fill="none" opacity="0.55" />
      {seed % 2 === 0 ? (
        <>
          <rect x="20" y="32" width="22" height="14" rx="2" fill="#087f68" opacity="0.28" />
          <circle cx="54" cy="44" r="8" fill="#087f68" opacity="0.2" />
        </>
      ) : (
        <>
          <path d="M22 36h36M22 46h36" stroke="#087f68" strokeWidth="1.2" opacity="0.25" />
          <rect x="28" y="30" width="18" height="10" rx="2" fill="#087f68" opacity="0.22" />
        </>
      )}
      <text x="40" y="72" textAnchor="middle" fontSize="7" fill="#61736d" fontFamily="ui-monospace,monospace">
        {variant.slice(0, 6)}
      </text>
    </svg>
  );
}

/** Research drawer shell */
export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="btn btn-sm" type="button" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}
