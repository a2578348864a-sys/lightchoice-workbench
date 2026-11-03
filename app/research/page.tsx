import type { Metadata } from "next";
import { ResearchListClient } from "@/components/research/ResearchListClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "03 商品深研 - 轻选工作台",
  description: "基于商品事实基线与 DeepSeek 研报提炼，由您本人在第一屏做出关键商业决断：继续推进、需补充验证、暂缓观察或放弃。",
};

export default function ResearchPage() {
  // Active research view: view="research"
  return <ResearchListClient />;
}
