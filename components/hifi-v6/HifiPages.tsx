"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { HifiApp } from "@/components/hifi-v6/HifiApp";
import type { Screen } from "@/components/hifi-v6/data";

const VIEW_MAP: Record<string, Screen> = {
  overview: "overview",
  competition: "competition",
  keywords: "keywords",
  voc: "voc",
  compare: "compare",
  gate: "gate",
};

function HifiMarketInner({ scanId }: { scanId: string }) {
  const params = useSearchParams();
  const view = params.get("view") || "competition";
  const screen = VIEW_MAP[view] ?? "competition";
  return <HifiApp initialScreen={screen} scanId={scanId} />;
}

export function HifiMarketClient({ scanId }: { scanId: string }) {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>加载研究工作区…</div>}>
      <HifiMarketInner scanId={scanId} />
    </Suspense>
  );
}

export function HifiExplorerClient() {
  return <HifiApp initialScreen="explorer" />;
}
