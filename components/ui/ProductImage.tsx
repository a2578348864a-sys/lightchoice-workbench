"use client";

import * as React from "react";
import { Package } from "lucide-react";

export interface ProductImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src?: string | null;
  alt?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  aspectRatio?: "square" | "video";
}

const sizeClasses = {
  xs: "size-8 min-w-8",
  sm: "size-10 min-w-10",
  md: "size-14 min-w-14",
  lg: "size-20 min-w-20",
  xl: "size-28 min-w-28",
};

export function ProductImage({
  src,
  alt = "商品图片",
  size = "md",
  aspectRatio = "square",
  className = "",
  ...props
}: ProductImageProps) {
  const [hasError, setHasError] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    setHasError(false);
    setIsLoading(true);
  }, [src]);

  const containerSize = sizeClasses[size];

  if (!src || hasError) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-400 ${containerSize} ${className}`.trim()}
        title={alt}
      >
        <Package className="size-1/2 stroke-[1.5]" />
      </div>
    );
  }

  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-slate-200 bg-white ${containerSize} ${className}`.trim()}
    >
      {isLoading && <div className="absolute inset-0 animate-pulse bg-slate-100" />}
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        loading="lazy"
        onLoad={() => setIsLoading(false)}
        onError={() => {
          setIsLoading(false);
          setHasError(true);
        }}
        className={`size-full object-contain transition-opacity duration-150 ${
          isLoading ? "opacity-0" : "opacity-100"
        }`}
        {...props}
      />
    </div>
  );
}
