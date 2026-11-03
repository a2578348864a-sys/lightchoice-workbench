import { constants } from "node:fs";
import { accessSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/server/db";
import { evaluateReadiness, readinessErrorCode } from "@/lib/server/healthReadiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MODEL = "";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

function getProvider() {
  return process.env.AI_PROVIDER?.trim().toLowerCase() === "deepseek" ? "deepseek" : "openai";
}

/**
 * 只读探针：必须真实触盘。
 * `SELECT 1` 是常量表达式，SQLite 不会读取数据库文件——即便文件已损坏仍会返回成功
 *（实测：把库文件写成非 SQLite 内容后 `SELECT 1` 仍 ok），因此改为读 sqlite_master。
 */
async function probeDatabase() {
  const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint | number }>>("SELECT count(*) AS c FROM sqlite_master");
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("DB_PROBE_NO_ROWS");
}

/** 只读探针：证据根目录必须存在、是目录且可读（不遍历文件）。 */
function probeEvidenceStore() {
  const configured = process.env.SOURCE_LAYER_STORE_DIR?.trim();
  const root = resolve(configured && configured.length > 0 ? configured : resolve(process.cwd(), "data", "source-layer-store"));
  accessSync(root, constants.R_OK);
  if (!statSync(root).isDirectory()) throw new Error("EVIDENCE_STORE_NOT_DIRECTORY");
}

/**
 * 健康检查：
 * - `?probe=liveness`：纯进程存活，永远 200（给只需要「端口有响应」的脚本用）；
 * - 默认：就绪检查（数据库只读查询 + 证据目录可读），关键依赖不可用返回 503。
 *
 * 兼容性：正常时仍返回 `{ ok: true }`（既有启动/回滚脚本只读 `.ok`）；
 * 失败时返回 503 + 稳定错误码，不返回路径、异常文本或环境变量。
 */
export async function GET(request: NextRequest) {
  const probe = new URL(request.url).searchParams.get("probe");
  if (probe === "liveness") {
    return NextResponse.json({ ok: true, probe: "liveness" }, { headers: { "Cache-Control": "no-store" } });
  }

  const readiness = await evaluateReadiness({
    database: probeDatabase,
    evidenceStore: probeEvidenceStore,
  });

  if (!readiness.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: readinessErrorCode(readiness),
          message: "关键依赖不可用，工作台尚未就绪：请检查数据库与证据目录。",
        },
        checks: readiness.checks,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }

  const provider = getProvider();
  return NextResponse.json({
    ok: true,
    app: "hot-material-agent",
    name: "爆款素材识别 Agent",
    provider,
    hasOpenAIKey: provider === "openai" && Boolean(process.env.OPENAI_API_KEY),
    hasDeepSeekKey: provider === "deepseek" && Boolean(process.env.DEEPSEEK_API_KEY),
    model:
      provider === "deepseek"
        ? process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL
        : process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
    checks: readiness.checks,
  }, { headers: { "Cache-Control": "no-store" } });
}
