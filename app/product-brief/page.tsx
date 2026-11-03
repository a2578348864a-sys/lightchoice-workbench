import type { Metadata } from "next";
import { ProductBriefClient } from "@/components/product-brief/ProductBriefClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "04 产品开发需求单 - 轻选工作台",
  description: "基于研究、商品事实、买家声音与市场来源依据形成事实边界内的产品开发需求单。",
};

export default async function ProductBriefPage({ searchParams }: { searchParams: Promise<{ taskId?: string | string[] }> }) {
  const params = await searchParams;
  const taskId = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
  return <ProductBriefClient taskId={taskId ?? ""} />;
}
