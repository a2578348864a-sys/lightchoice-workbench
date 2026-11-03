import type { Metadata } from "next";
import { MarketAnalysisDetailClient } from "@/components/market-analysis/MarketAnalysisDetailClient";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "市场分析详情 - 轻选工作台",
  description: "锁定样本快照与统计口径的确定性大盘分析。支持一键将 1～3 款代表商品送入深度研究。",
};

export default async function MarketAnalysisDetailPage({
  params,
}: {
  params: Promise<{ scanId: string }>;
}) {
  const { scanId } = await params;

  return (
    <WorkspaceFrame>
        <div className="min-w-0 flex-1">
          <MarketAnalysisDetailClient scanId={scanId} />
        </div>
    </WorkspaceFrame>
  );
}
