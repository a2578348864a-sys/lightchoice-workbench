import type { Metadata } from "next";
import { MarketAnalysisListClient } from "@/components/market-analysis/MarketAnalysisListClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "02 市场研究 - 轻选工作台",
  description: "基于确定性大盘指标对细分品类进行宏观扫描。锁定样本快照与统计口径，挑选高潜代表商品送去深度研究。",
};

export default function MarketAnalysisPage() {
  return <MarketAnalysisListClient />;
}
