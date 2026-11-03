import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticated, requireOwnerOnly, type GuardResult } from "@/lib/server/demoGuard";
import { errorResponse, V5CoreError } from "@/lib/server/v5CoreCommon";

export function authResponse(auth: Extract<GuardResult, { ok: false }>): NextResponse;
export function authResponse(auth: Extract<GuardResult, { ok: true }>): null;
export function authResponse(auth: GuardResult): NextResponse | null {
  if (auth.ok) return null;
  const code = auth.code === "origin_denied" ? "ORIGIN_NOT_ALLOWED" : auth.code.toUpperCase();
  return NextResponse.json({ ok: false, error: { code, message: auth.message, retryable: false, conflict: false } }, { status: auth.status });
}

export function readAuth(request: NextRequest) {
  return requireAuthenticated(request);
}

export function writeAuth(request: NextRequest) {
  return requireOwnerOnly(request);
}

export async function jsonBody(request: NextRequest) {
  try {
    return await request.json() as unknown;
  } catch {
    throw new V5CoreError("INVALID_JSON", "请求体不是有效 JSON。", 400);
  }
}

export class BoundedJsonBodyError extends Error {
  constructor(public readonly code: "REQUEST_BODY_TOO_LARGE" | "INVALID_JSON" | "INVALID_FORM_DATA", public readonly status: 400 | 413) {
    super(code === "REQUEST_BODY_TOO_LARGE" ? "请求体超过允许大小。" : code === "INVALID_FORM_DATA" ? "请求体不是有效 multipart 表单。" : "请求体不是有效 JSON。");
    this.name = "BoundedJsonBodyError";
  }
}

/** Reads a request body with a hard byte bound, including chunked bodies without Content-Length. */
export async function boundedRequestBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("INVALID_JSON_BODY_LIMIT");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      throw new BoundedJsonBodyError("REQUEST_BODY_TOO_LARGE", 413);
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedJsonBodyError("REQUEST_BODY_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Parses bounded JSON, including chunked bodies without Content-Length. */
export async function boundedJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const bytes = await boundedRequestBodyBytes(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new BoundedJsonBodyError("INVALID_JSON", 400);
  }
}

/** Parses bounded multipart form data without trusting the client-provided Content-Length. */
export async function boundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType || !/^multipart\/form-data\s*;/iu.test(contentType) || !/\bboundary=/iu.test(contentType)) {
    throw new BoundedJsonBodyError("INVALID_FORM_DATA", 400);
  }
  const bytes = await boundedRequestBodyBytes(request, maxBytes);
  try {
    return await new Response(bytes.buffer as ArrayBuffer, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new BoundedJsonBodyError("INVALID_FORM_DATA", 400);
  }
}

export function boundedJsonBodyErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof BoundedJsonBodyError)) return null;
  return NextResponse.json({
    ok: false,
    error: { code: error.code, message: error.message, retryable: false, conflict: false },
  }, { status: error.status });
}

import { isTrustedWriteRequest } from "@/lib/server/accessPassword";

export function writeOriginOk(request: NextRequest): boolean {
  return isTrustedWriteRequest(request);
}

export function respond<T>(result: { body: T; status: number }) {
  return NextResponse.json(result.body, { status: result.status });
}

export function v5ErrorResponse(error: unknown) {
  const result = errorResponse(error);
  return NextResponse.json(result.body, { status: result.status });
}

export function originError() {
  return NextResponse.json({ ok: false, error: { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不受信任。", retryable: false, conflict: false } }, { status: 403 });
}
