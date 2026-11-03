/**
 * 探索台：迁移 prototype/hifi-v6 探索台布局。
 * 数据经 HifiProvider → /api/home/summary（真实只读）。
 */
import type { Metadata } from "next";
import { HifiExplorerClient } from "@/components/hifi-v6/HifiPages";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "探索台 - 轻选工作台",
  description: "当前研究焦点、进展与下一步行动。",
};

export default function HomePage() {
  return <HifiExplorerClient />;
}
