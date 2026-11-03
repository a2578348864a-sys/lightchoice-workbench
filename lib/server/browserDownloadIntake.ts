import "server-only";

import { lstat, readFile } from "node:fs/promises";

import type { AccessContext } from "@/lib/server/accessPassword";
import {
  RAW_ARTIFACT_MAX_BYTES,
  type RawArtifactKind,
  type RawArtifactProvenance,
} from "@/lib/sourceLayer/rawArtifact";
import type { CaptureSourceType } from "@/lib/sourceLayer/capturePackage";
import {
  persistRawArtifact,
  type RawArtifactIntakeInput,
} from "@/lib/sourceLayer/server/rawArtifactIntake";

export type BrowserDownloadLike = {
  suggestedFilename(): string;
  path(): Promise<string | null>;
  createReadStream?(): Promise<AsyncIterable<Uint8Array> | null>;
};

async function bytesFromStream(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > RAW_ARTIFACT_MAX_BYTES) throw new Error("RAW_ARTIFACT_OVERSIZED");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * 读取 Playwright Download 的本地临时文件/流，不访问下载 URL，也不把凭据写入日志。
 * 文件名仍由 rawArtifact.inspectRawArtifact 做路径穿越、格式和大小 fail-closed。
 */
export async function readBrowserDownload(download: BrowserDownloadLike): Promise<{
  fileName: string;
  bytes: Uint8Array;
}> {
  const fileName = download.suggestedFilename();
  const stream = download.createReadStream ? await download.createReadStream() : null;
  if (stream) return { fileName, bytes: await bytesFromStream(stream) };
  const filePath = await download.path();
  if (!filePath) throw new Error("DOWNLOAD_FAILED");
  const stat = await lstat(filePath);
  if (!stat.isFile()) throw new Error("DOWNLOAD_FAILED");
  if (stat.size > RAW_ARTIFACT_MAX_BYTES) throw new Error("RAW_ARTIFACT_OVERSIZED");
  return { fileName, bytes: new Uint8Array(await readFile(filePath)) };
}

export async function persistBrowserDownload(input: Omit<RawArtifactIntakeInput, "fileName" | "bytes"> & {
  context: AccessContext;
  sourceType: CaptureSourceType;
  kind: RawArtifactKind;
  provenance: RawArtifactProvenance;
  download: BrowserDownloadLike;
}) {
  const downloaded = await readBrowserDownload(input.download);
  return persistRawArtifact({
    ...input,
    fileName: downloaded.fileName,
    bytes: downloaded.bytes,
  });
}
