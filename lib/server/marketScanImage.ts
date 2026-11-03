import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { MARKET_SCAN_OWNER_SCOPE } from "@/lib/marketScan/contract";
import type { MarketScanImageRefV1 } from "@/lib/marketScan/types";

const HTTPS_IMAGE_PATTERN = /^https:\/\/\S+$/iu;
const INLINE_IMAGE_PATTERN = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/iu;

function displayableImageReference(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 2 * 1024 * 1024 * 2
    && (HTTPS_IMAGE_PATTERN.test(value) || INLINE_IMAGE_PATTERN.test(value));
}

/**
 * 解析 MarketScan 的展示图片引用。
 *
 * `source_evidence` 只按 subject/evidence/version 精确读取，不回落到最新版本，
 * 因此不会让历史扫描随着来源层更新而静默换图。Evidence 被裁剪或损坏时返回
 * null，由 ProductImage 展示统一占位。
 */
export async function resolveMarketScanImageRef(
  imageRef: MarketScanImageRefV1 | undefined,
): Promise<string | null> {
  if (!imageRef) return null;
  if (imageRef.kind === "external_url") return imageRef.url;

  const store = createEvidenceStore(MARKET_SCAN_OWNER_SCOPE);
  const subject = await store.getSubject(imageRef.subjectKey);
  const evidence = subject?.versions.find((version) => (
    version.evidenceId === imageRef.evidenceId
      && version.version === imageRef.evidenceVersion
  ));
  if (!evidence) return null;
  const image = evidence.pkg.fields.images.find(displayableImageReference);
  return image ?? null;
}
