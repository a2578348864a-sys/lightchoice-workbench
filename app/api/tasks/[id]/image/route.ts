import { NextRequest, NextResponse } from "next/server";
import { checkAccessPassword, getAccessContext } from "@/lib/server/accessPassword";
import { getSandboxTask, isSandboxTaskId } from "@/lib/server/demoSandbox";
import {
  extractTaskProductImageFromResultJson,
  getTaskProductImageBuffer,
  type TaskImageBufferResult,
} from "@/lib/server/taskProductImage";

export const runtime = "nodejs";

/**
 * 越权 / 缺图 / 损坏统一 404：不区分「任务不存在」与「不属于当前访问身份」，
 * 避免通过状态码探测正式任务是否存在。
 */
const IMAGE_UNAVAILABLE = {
  ok: false,
  error: { code: "image_unavailable", message: "商品主图不可用。" },
} as const;

function imageUnavailable() {
  return NextResponse.json(IMAGE_UNAVAILABLE, { status: 404 });
}

function imageResponse(image: TaskImageBufferResult) {
  return new NextResponse(image.buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": image.mimeType,
      "Content-Length": String(image.buffer.length),
      "Cache-Control": "private, max-age=300",
    },
  });
}

/**
 * GET /api/tasks/[id]/image — 任务商品主图（只读字节流）。
 *
 * 对象级授权（AUTH-002）：
 * - Demo sandbox 任务（sandbox 前缀 id）：必须为 demo 身份，且任务属于同一 demoAccessId；
 * - 正式任务：必须为 Owner 身份，Demo/访客一律拒绝；
 * - 跨范围、任务缺失、无可用主图统一 404。
 *
 * 授权必须在本边界完成：lib/server/taskProductImage 的读取函数按 id 直连正式库，
 * 自身不做归属校验。
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
) {
  const authError = checkAccessPassword(request);
  if (authError) return NextResponse.json(authError.body, { status: authError.status });

  const access = getAccessContext(request);
  if (!access) {
    return NextResponse.json({ ok: false, error: { code: "invalid_access", message: "请先登录后再操作。" } }, { status: 401 });
  }

  const { id: rawId } = await context.params;
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!id) {
    return NextResponse.json({ ok: false, error: { code: "invalid_id", message: "缺少任务 ID。" } }, { status: 400 });
  }

  try {
    if (isSandboxTaskId(id)) {
      if (access.mode !== "demo") return imageUnavailable();
      const task = getSandboxTask(access.demoAccessId, id);
      if (!task) return imageUnavailable();
      const image = await extractTaskProductImageFromResultJson(task.resultJson);
      if (!image) return imageUnavailable();
      return imageResponse(image);
    }

    if (access.mode !== "owner") return imageUnavailable();

    const image = await getTaskProductImageBuffer(id);
    if (!image) return imageUnavailable();
    return imageResponse(image);
  } catch {
    return imageUnavailable();
  }
}
