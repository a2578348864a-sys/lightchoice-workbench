import type { Config } from "tailwindcss";

/**
 * V6 D2-1B · 全站字号阶梯（用户标准）：
 * 正文 17 / 导航按钮 16 / 辅助 14 / 页面标题 26–30。
 * 通过重映射 Tailwind 字号语义统一覆盖 text-xs~text-3xl 的大量局部使用，
 * 不使用 !important 或 zoom；技术 ID 类 10–12px 保留为 12–13px 级。
 */
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    fontSize: {
      // 12–13px 档：原 text-[10px]/[11px] 仍存在，这一档主要承接原 xs
      xs: ["0.875rem", { lineHeight: "1.45" }], // 14px · 辅助/标签
      sm: ["1rem", { lineHeight: "1.5" }], // 16px · 导航/按钮/表单
      base: ["1.0625rem", { lineHeight: "1.6" }], // 17px · 正文
      lg: ["1.125rem", { lineHeight: "1.55" }], // 18px
      xl: ["1.25rem", { lineHeight: "1.45" }], // 20px · 章节标题
      "2xl": ["1.625rem", { lineHeight: "1.35" }], // 26px · 页面标题
      "3xl": ["1.875rem", { lineHeight: "1.25" }], // 30px
      "4xl": ["2.25rem", { lineHeight: "1.2" }],
      "5xl": ["3rem", { lineHeight: "1.1" }],
      "6xl": ["3.75rem", { lineHeight: "1.05" }],
      "7xl": ["4.5rem", { lineHeight: "1" }],
      "8xl": ["6rem", { lineHeight: "1" }],
      "9xl": ["8rem", { lineHeight: "1" }],
    },
    extend: {
      boxShadow: {
        soft: "0 18px 48px rgba(15, 23, 42, 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
