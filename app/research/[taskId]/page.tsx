import type { Metadata } from "next";
import { ResearchDetailClient } from "@/components/research/ResearchDetailClient";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "商品深度研报与决断 - 轻选工作台",
  description: "第一屏展示商品事实基线、DeepSeek 研报提炼、确定性风险核验，由您做出关键商业决断：继续推进、需补充验证、暂缓观察或放弃。",
};

export default async function ResearchDetailPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const { taskId } = await params;

  return (
    <WorkspaceFrame
      modeLabel="VOC 规则版本 / 历史研报 / 人工决策门禁"
      footerNote="03 商品深研详情 · A2 规则版本与来源时效保留"
    >
      <ResearchDetailClient taskId={taskId} />
    </WorkspaceFrame>
  );
}
