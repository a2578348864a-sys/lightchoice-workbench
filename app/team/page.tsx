import type { Metadata } from "next";
import { WorkspaceFrame } from "@/components/ui/WorkspaceFrame";
import { FeishuWorkspaceClient } from "@/components/feishu/FeishuWorkspaceClient";
import { V5_HUB_TABLES } from "@/lib/integrations/lark/v5HubSchema";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "飞书个人研究中心 - 轻选工作台", description: "管理研究投影、资料视图与连接状态。" };
export default function TeamPage() {
  return <WorkspaceFrame footerNote="研究事实留在轻选，管理投影沉淀到飞书。">
    <FeishuWorkspaceClient tables={V5_HUB_TABLES.map(table => ({ id: table.id, name: table.displayName }))} />
  </WorkspaceFrame>;
}
