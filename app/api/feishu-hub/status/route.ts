import { NextRequest, NextResponse } from "next/server";
import { authResponse, readAuth, v5ErrorResponse } from "@/lib/server/v5ApiRoute";
import { getFeishuConnectionStatus } from "@/lib/server/v5FeishuService";
import { getLarkConfig } from "@/lib/integrations/lark/config";
import { listTableFields } from "@/lib/integrations/lark/baseClient";
import { getV5HubConfig } from "@/lib/integrations/lark/v5HubConfig";
import { V5_HUB_TABLES, validateV5HubRemoteSchema } from "@/lib/integrations/lark/v5HubSchema";
import { okResponse } from "@/lib/server/v5CoreCommon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readV5HubSchemaStatus(): Promise<"verified" | "unavailable"> {
  try {
    const hubConfig = getV5HubConfig();
    const larkConfig = getLarkConfig();
    if (!larkConfig.ok) return "unavailable";
    const results = await Promise.all(V5_HUB_TABLES.map(async (table) => {
      const fields = await listTableFields({ ...larkConfig.config, tableId: hubConfig.tables[table.id] });
      return validateV5HubRemoteSchema(table.id, fields).isValid;
    }));
    return results.every(Boolean) ? "verified" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** 只读 Hub 状态；不拉取决策、不创建业务写入，也不改变人工决策。 */
export async function GET(request: NextRequest) {
  const auth = readAuth(request);
  if (!auth.ok) return authResponse(auth);
  try {
    const connection = getFeishuConnectionStatus();
    const schemaState = connection.preflight === "passed" ? "verified" as const : await readV5HubSchemaStatus();
    const hubOnline = connection.status === "ready" && schemaState === "verified";
    const tables = V5_HUB_TABLES.map((table) => ({
      key: table.id,
      name: table.name,
      status: hubOnline ? "available" as const : "unavailable" as const,
      schemaState: "declared" as const,
    }));
    return NextResponse.json(okResponse({
      status: connection.status,
      configured: connection.configured,
      preflight: connection.preflight,
      marketTableReady: connection.marketTableReady,
      researchTableReady: connection.researchTableReady,
      displayName: connection.displayName,
      hubStatus: hubOnline ? "online" as const : "unavailable" as const,
      schemaState,
      lastCheckAt: connection.lastCheckedAt,
      lastCheckedAt: connection.lastCheckedAt,
      lastSuccessAt: connection.lastSuccessAt,
      lastError: connection.lastError,
      lastPullAt: null,
      baseOpenUrl: connection.baseOpenUrl,
      tables,
    }).body);
  } catch (error) {
    return v5ErrorResponse(error);
  }
}
