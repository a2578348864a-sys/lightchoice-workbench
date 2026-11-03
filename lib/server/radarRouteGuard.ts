import "server-only";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireOwnerOnly } from "@/lib/server/demoGuard";

export function radarErrorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return NextResponse.json({
    ...extra,
    ok: false,
    error: { code, message },
  }, { status });
}

export function radarNotFoundResponse() {
  return radarErrorResponse(404, "not_found", "Not found.");
}

/** Radar 仅允许真实回环 Host；不接受 localhost.evil.example 等前缀伪造。 */
export function isLocalLoopbackRequest(request: NextRequest) {
  const rawHost = (request.headers.get("host") || "").trim();
  if (!rawHost) return false;

  try {
    const hostname = new URL(`http://${rawHost}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export function requireRadarOwner(request: NextRequest, body?: Record<string, unknown>) {
  const auth = requireOwnerOnly(request, body);
  if (auth.ok) return null;
  return radarErrorResponse(auth.status, auth.code, auth.message);
}
