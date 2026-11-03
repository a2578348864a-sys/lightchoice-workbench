import { NextResponse, type NextRequest } from "next/server";

import { isSameOriginRequest } from "@/lib/server/accessPassword";
import { requireOwnerOnly } from "@/lib/server/demoGuard";

const MAX_BODY_BYTES = 12_000;

export function monitoringError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}
export function authorizeMonitoringRequest(request: NextRequest, mutation: boolean): NextResponse | null {
  const auth = requireOwnerOnly(request);
  if (!auth.ok) return monitoringError(auth.status, auth.code, auth.message);
  if (!mutation) return null;
  const origin = request.headers.get("origin");
  if (origin) {
    return isSameOriginRequest(origin, request) ? null : monitoringError(403, "origin_not_allowed", "请求来源不受信任。");
  }
  const referer = request.headers.get("referer");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    return referer !== null
      && isSameOriginRequest(new URL(referer).origin, request)
      && (fetchSite === null || fetchSite === "same-origin")
      ? null
      : monitoringError(403, "origin_not_allowed", "请求来源不受信任。");
  } catch {
    return monitoringError(403, "origin_not_allowed", "请求来源不受信任。");
  }
}

export async function readMonitoringJsonBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function onlyAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
