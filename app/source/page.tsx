import type { Metadata } from "next";
import "@/app/capture-console-fonts.css";
import { SourceManagementClient } from "@/components/source/SourceManagementClient";
import { MarketResearchCaptureContext } from "@/components/source/MarketResearchCaptureContext";
import { CaptureEnvironmentStatusCard } from "@/components/source/CaptureEnvironmentStatusCard";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "01 市场采集 - 轻选工作台",
  description: "采集一批同一市场范围内的商品，系统会自动整理为一个采集批次，用于后续市场研究。",
};

export default function SourcePage() {
  return (
    <WorkspaceFrame
      modeLabel="采集网关"
      footerNote="01 市场采集 · 计划与真实执行分离，证据写入证据库"
    >
      <div className="space-y-4">
        <MarketResearchCaptureContext />
        <SourceManagementClient />
        <details className="lc-environment-details"><summary>采集环境与会话状态<span>需要时检查连接、登录与采集开关</span></summary><div><CaptureEnvironmentStatusCard /></div></details>
      </div>
    </WorkspaceFrame>
  );
}
