import type { Metadata } from "next";
import "./globals.css";
import "./youth-green.css";
import "./brief-workbook.css";
import "./visual-hierarchy.css";
import "./site-experience.css";
import "./workspace-navigation.css";

export const metadata: Metadata = {
  title: "轻选工作台｜跨境商品研究与产品开发",
  description: "从市场采集、市场研究到商品深研与产品开发需求，基于来源证据辅助研究，由人做关键商业判断。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
