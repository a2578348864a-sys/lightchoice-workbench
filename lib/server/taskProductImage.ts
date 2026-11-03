import { prisma } from "@/lib/server/db";
import { resolveResearchTaskProductImage } from "@/lib/productResearchImage";

export type TaskImageBufferResult = {
  buffer: Buffer;
  mimeType: string;
};

function safeParseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractBase64Buffer(dataUrlOrBase64: string, fallbackMime = "image/jpeg"): TaskImageBufferResult | null {
  const trimmed = dataUrlOrBase64.trim();
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(trimmed);
  if (match) {
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], "base64"),
    };
  }
  // 纯 base64 字符串
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length > 64) {
    return {
      mimeType: fallbackMime,
      buffer: Buffer.from(trimmed, "base64"),
    };
  }
  return null;
}

/**
 * 从「已解析的 task result 对象」中提取商品主图字节。
 *
 * 抽出的原因（AUTH-002）：任务对象授权必须发生在调用方（路由 / 服务），
 * 而图片提取本身与「任务归属」无关；拆开后 Demo sandbox 任务可以复用同一提取器，
 * 避免为绕过授权而复制解析逻辑。
 */
export async function extractTaskProductImageFromResult(
  rawResult: Record<string, unknown>,
): Promise<TaskImageBufferResult | null> {
  // 1. 尝试从 candidate 快照中解析
  const candidateId =
    (typeof rawResult.candidateToTask === "object" && rawResult.candidateToTask !== null
      ? ((rawResult.candidateToTask as Record<string, unknown>).candidateId as string | undefined)
      : undefined) ||
    (typeof rawResult.sourceMeta === "object" && rawResult.sourceMeta !== null
      ? ((rawResult.sourceMeta as Record<string, unknown>).candidateId as string | undefined)
      : undefined) ||
    (typeof rawResult.candidateAnalysisContext === "object" && rawResult.candidateAnalysisContext !== null
      ? ((rawResult.candidateAnalysisContext as Record<string, unknown>).candidateId as string | undefined)
      : undefined);

  if (candidateId) {
    const candidate = await prisma.opportunityCandidate.findFirst({
      where: { id: candidateId },
      select: { id: true, name: true, sourceMetaJson: true },
    });
    if (candidate?.sourceMetaJson) {
      const fixed = resolveResearchTaskProductImage({
        taskResult: rawResult,
        candidates: [candidate],
      });
      if (fixed?.dataUrl) {
        const extracted = extractBase64Buffer(fixed.dataUrl, fixed.mimeType);
        if (extracted) return extracted;
      }

      const sm = safeParseJson(candidate.sourceMetaJson);
      if (sm && typeof sm.imageSnapshot === "object" && sm.imageSnapshot !== null) {
        const snap = sm.imageSnapshot as Record<string, unknown>;
        if (typeof snap.base64 === "string" && snap.base64) {
          const mime = typeof snap.mimeType === "string" ? snap.mimeType : "image/jpeg";
          const extracted = extractBase64Buffer(snap.base64, mime);
          if (extracted) return extracted;
        }
      }
    }
  }

  // 2. 检查 ProductBatchItem (Excel / SellerSprite 导入主图快照)
  const candidateAnalysisContext =
    typeof rawResult.candidateAnalysisContext === "object" && rawResult.candidateAnalysisContext !== null
      ? (rawResult.candidateAnalysisContext as Record<string, unknown>)
      : null;
  const facts =
    candidateAnalysisContext &&
    typeof candidateAnalysisContext.facts === "object" &&
    candidateAnalysisContext.facts !== null
      ? (candidateAnalysisContext.facts as Record<string, unknown>)
      : null;
  const pbiId = typeof facts?.productBatchItemId === "string" ? facts.productBatchItemId : undefined;

  if (pbiId) {
    const pbi = await prisma.productBatchItem.findUnique({
      where: { id: pbiId },
      select: { imageSnapshotJson: true },
    });
    if (pbi?.imageSnapshotJson) {
      const snap = safeParseJson(pbi.imageSnapshotJson);
      if (snap) {
        if (typeof snap.dataUrl === "string") {
          const extracted = extractBase64Buffer(snap.dataUrl, (snap.mimeType as string) || "image/jpeg");
          if (extracted) return extracted;
        }
        if (typeof snap.base64 === "string") {
          const extracted = extractBase64Buffer(snap.base64, (snap.mimeType as string) || "image/jpeg");
          if (extracted) return extracted;
        }
      }
    }
  }

  // 3. 检查 productIdentity.image
  if (typeof rawResult.productIdentity === "object" && rawResult.productIdentity !== null) {
    const ident = rawResult.productIdentity as Record<string, unknown>;
    if (typeof ident.image === "string") {
      const extracted = extractBase64Buffer(ident.image);
      if (extracted) return extracted;
    }
  }

  return null;
}

/**
 * 解析任意形态的 task resultJson（字符串或对象）后提取主图。
 * 用于 Demo sandbox 任务（其 resultJson 为字符串）。
 */
export async function extractTaskProductImageFromResultJson(
  resultJson: unknown,
): Promise<TaskImageBufferResult | null> {
  if (typeof resultJson === "object" && resultJson !== null && !Array.isArray(resultJson)) {
    return extractTaskProductImageFromResult(resultJson as Record<string, unknown>);
  }
  const parsed = safeParseJson(resultJson);
  if (!parsed) return null;
  return extractTaskProductImageFromResult(parsed);
}

/**
 * 按 taskId 读取正式任务（viralAnalysisRecord）商品主图。
 *
 * 注意（AUTH-002）：本函数是**无授权**的数据读取，只按 id 查正式库。
 * HTTP 边界必须先完成访问域校验（Owner 仅正式任务 / Demo 仅同 demoAccessId sandbox 任务），
 * 否则会形成对象级越权。参见 app/api/tasks/[id]/image/route.ts。
 */
export async function getTaskProductImageBuffer(taskId: string): Promise<TaskImageBufferResult | null> {
  const normalizedId = taskId.trim();
  if (!normalizedId) return null;

  const record = await prisma.viralAnalysisRecord.findFirst({
    where: { id: normalizedId },
    select: { resultJson: true },
  });
  if (!record?.resultJson) return null;

  const rawResult = safeParseJson(record.resultJson);
  if (!rawResult) return null;

  return extractTaskProductImageFromResult(rawResult);
}
