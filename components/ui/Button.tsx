import * as React from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 shadow-sm border border-emerald-700/20",
  secondary: "bg-slate-100 text-slate-800 hover:bg-slate-200 active:bg-slate-300 border border-slate-200",
  outline: "bg-white text-slate-700 hover:bg-slate-50 active:bg-slate-100 border border-slate-300 shadow-sm",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 border border-transparent",
  destructive: "bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800 shadow-sm border border-rose-700/20",
  link: "text-emerald-700 hover:text-emerald-800 hover:underline p-0 h-auto border-none",
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: "px-2 py-1 text-[13px] rounded",
  sm: "px-2.5 py-1.5 text-sm font-medium rounded-md",
  md: "px-3.5 py-2 text-sm font-medium rounded-lg",
  lg: "px-5 py-2.5 text-base font-medium rounded-lg",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className = "",
      variant = "outline",
      size = "md",
      isLoading = false,
      leftIcon,
      rightIcon,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const isLink = variant === "link";
    const baseStyle =
      "inline-flex items-center justify-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 disabled:pointer-events-none cursor-pointer";
    const variantStyle = variantClasses[variant] || variantClasses.outline;
    const sizeStyle = isLink ? "" : sizeClasses[size] || sizeClasses.md;

    return (
      <button
        data-variant={variant}
        ref={ref}
        disabled={disabled || isLoading}
        className={`${baseStyle} ${variantStyle} ${sizeStyle} ${className}`.trim()}
        {...props}
      >
        {isLoading ? <Loader2 className="size-3.5 animate-spin" /> : leftIcon}
        {children}
        {!isLoading && rightIcon}
      </button>
    );
  }
);
Button.displayName = "Button";
