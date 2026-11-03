"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  explorer as demoExplorer,
  keywords as demoKeywords,
  keywordEvidence as demoKeywordEvidence,
  asinFlow as demoAsinFlow,
  voc as demoVoc,
  compareQuestions as demoCompareQuestions,
  opportunityDetail as demoOpportunityDetail,
  moreEntries as demoMoreEntries,
  samples as demoSamples,
  scan as demoScan,
  priceBands as demoPriceBands,
  asinTrends as demoAsinTrends,
  type GateStatus,
  type Sample,
  type Screen,
} from "./data";
import { effectiveGate, emptyResearchData, subjectReviews, type ResearchReadData, type ScanReadModel } from "./researchPresentation";
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";
import { buildAccessHeaders } from "@/lib/client/accessToken";

export type HifiLive = {
  loading: boolean;
  error: string | null;
  screen: Screen;
  setScreen: (s: Screen) => void;
  explorer: typeof demoExplorer;
  scan: typeof demoScan;
  samples: Sample[];
  priceBands: typeof demoPriceBands;
  keywords: typeof demoKeywords;
  keywordEvidence: typeof demoKeywordEvidence;
  asinFlow: typeof demoAsinFlow;
  voc: typeof demoVoc;
  compareQuestions: typeof demoCompareQuestions;
  opportunityDetail: typeof demoOpportunityDetail;
  moreEntries: typeof demoMoreEntries;
  asinTrends: typeof demoAsinTrends;
  gate: GateStatus | null;
  setGate: (g: GateStatus | null) => void;
  gateReason: string;
  setGateReason: (r: string) => void;
  gateAck: boolean;
  setGateAck: (a: boolean) => void;
  draft: string[];
  setDraft: (d: string[]) => void;
  homeSummary: unknown;
  researchData: ResearchReadData;
  onSavedGate?: (status: GateStatus, reason: string) => Promise<void>;
  onSavedRepresentatives?: () => Promise<void>;
};

const HifiCtx = createContext<HifiLive | null>(null);

export function useHifi(): HifiLive {
  const ctx = useContext(HifiCtx);
  if (!ctx) throw new Error("useHifi outside HifiProvider");
  return ctx;
}

function mapSamplesFromApi(raw: {
  items?: Array<{
    asin?: string;
    title?: string | null;
    brand?: string | null;
    priceUsd?: number | null;
    price?: number | null;
    rating?: number | null;
    reviewCount?: number | null;
    reviewCountSnapshot?: number | null;
    reviewCountDetail?: number | null;
    imageUrl?: string | null;
    image?: string | null;
    role?: string | null;
    packLabel?: string | null;
    packSize?: string | null;
    dimensions?: string | null;
    itemDimensions?: { length?: number; width?: number; height?: number | null; unit?: string } | null;
    material?: string | null;
    conflict?: boolean;
    reviewConflict?: boolean;
    subjectKey?: string;
    factValues?: Record<string, unknown> | null;
    imageRef?: unknown;
  }>;
}): Sample[] {
  return (raw.items ?? []).map((item) => {
    const price =
      item.priceUsd ??
      (typeof item.price === "number" ? item.price : null);
    const reviews = item.reviewCount ?? item.reviewCountSnapshot ?? null;
    const reviewsAlt = item.reviewCountDetail ?? null;
    const conflict =
      Boolean(item.conflict || item.reviewConflict) ||
      (reviews != null && reviewsAlt != null && reviews !== reviewsAlt);
    let role: Sample["role"] = "sample";
    const r = (item.role || "").toLowerCase();
    if (r.includes("benchmark") || r.includes("基准")) role = "benchmark";
    else if (r.includes("pain") || r.includes("痛点")) role = "pain_point";
    else if (r.includes("new") || r.includes("新")) role = "newcomer";
    const facts = item.factValues ?? {};
    const dims = item.itemDimensions ?? (facts.itemDimensions as typeof item.itemDimensions);
    const dimText =
      dims && typeof dims === "object" && "length" in dims && "width" in dims
        ? `${dims.length}×${dims.width}${dims.height != null ? `×${dims.height}` : ""} ${dims.unit || "in"}`
        : (item.dimensions as string) || null;
    return {
      asin: item.asin || "UNKNOWN",
      name: item.title || item.asin || "未命名商品",
      brand: item.brand ?? null,
      role,
      price,
      rating: item.rating ?? null,
      reviews,
      reviewsAlt,
      size: dimText,
      thickness: null,
      pack: item.packLabel || item.packSize || null,
      unitPriceNote: null,
      voc: 0,
      pos: null,
      neg: null,
      comparable: true,
      note: conflict ? "评论数来源冲突未解决" : null,
      conflict,
      imageUrl: item.imageUrl || item.image || null,
    } as unknown as Sample;
  });
}

function bandsOf(samples: Sample[]) {
  const defs = [
    { label: "$4.99–6.99", count: 0 },
    { label: "$6.99–9.99", count: 0 },
    { label: "$9.99–12.99", count: 0 },
    { label: "$12.99+", count: 0 },
  ];
  for (const s of samples) {
    if (s.price == null) continue;
    if (s.price < 7) defs[0].count++;
    else if (s.price < 10) defs[1].count++;
    else if (s.price < 13) defs[2].count++;
    else defs[3].count++;
  }
  return defs;
}

export function HifiProvider({
  children,
  initialScreen = "explorer",
  scanId,
  onSavedRepresentatives,
}: {
  children: ReactNode;
  initialScreen?: Screen;
  scanId?: string;
  onSavedGate?: (status: GateStatus, reason: string) => Promise<void>;
  onSavedRepresentatives?: () => Promise<void>;
}) {
  const [screen, setScreenState] = useState<Screen>(initialScreen);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveSamples, setLiveSamples] = useState<Sample[] | null>(null);
  const [liveScan, setLiveScan] = useState<typeof demoScan | null>(null);
  const [homeSummary, setHomeSummary] = useState<unknown>(null);
  const [gate, setGate] = useState<GateStatus | null>(null);
  const [gateReason, setGateReason] = useState("");
  const [gateAck, setGateAck] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null);

  const [researchData, setResearchData] = useState<ResearchReadData>(emptyResearchData);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function read<T,>(url: string): Promise<T> {
      const res = await fetch(url, { headers: buildAccessHeaders(), cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error?.message || `读取失败 (${res.status})`);
      return json.data as T;
    }
    async function load() {
      setLoading(true);
      setLiveSamples([]);
      try {
        type Home = { recentScans?: Array<{ scanId: string; scanName: string }> };
        const home = await read<Home>("/api/home/summary").catch(() => null);
        if (!cancelled) setHomeSummary(home);
        const target = scanId || home?.recentScans?.[0]?.scanId;
        if (!target) throw new Error("尚无可打开的市场研究，请先完成市场采集。");
        const scan = await read<ScanReadModel>(`/api/market-analysis/${encodeURIComponent(target)}`);
        let intelligence: MarketIntelligence | null = null, intelligenceError: string | null = null;
        try { intelligence = await read<MarketIntelligence>(`/api/market-analysis/${encodeURIComponent(target)}/intelligence`); }
        catch (e) { intelligenceError = e instanceof Error ? e.message : "研究证据读取失败"; }
        const recent = await Promise.all((home?.recentScans ?? []).slice(0, 3).map(async item => {
          try {
            const detail = item.scanId === scan.id ? scan : await read<ScanReadModel>(`/api/market-analysis/${encodeURIComponent(item.scanId)}`);
            const representative = detail.sampleItems.find(s => s.imageUrl);
            return { id: detail.id, name: detail.scanName, site: detail.marketplace, count: detail.sampleCount,
              image: representative?.imageUrl ?? null, asin: representative?.asin ?? null,
              gate: effectiveGate(detail), stale: Boolean(detail.marketGate?.stale || detail.marketWorkflow?.stale) };
          } catch { return { id: item.scanId, name: item.scanName, site: "待读取", count: 0, image: null, asin: null, gate: "PENDING" as const, stale: false }; }
        }));
        if (cancelled) return;
        const mapped = mapSamplesFromApi({ items: scan.sampleItems }).map(sample => {
          const key = scan.sampleItems.find(s => s.asin === sample.asin)?.subjectKey ?? "";
          const facts = intelligence?.productDetails?.find(d => d.subjectKey === key)?.facts;
          const caliber = intelligence?.samples.find(s => s.subjectKey === key)?.reviewCountCaliber;
          const role = scan.representatives?.items.find(s => s.asin === sample.asin)?.role ?? sample.role;
          return { ...sample, role, brand: facts?.brand ?? sample.brand,
            size: facts?.itemDimensions ? `${facts.itemDimensions.length}×${facts.itemDimensions.width} ${facts.itemDimensions.unit}` : "未知",
            thickness: "未知", pack: "未知", pos: "尚未逐条确认", neg: "尚未逐条确认",
            reviewsAlt: caliber?.productPageValue ?? sample.reviewsAlt, conflict: caliber?.state === "conflict",
            voc: intelligence ? subjectReviews(intelligence, key).length : 0,
          };
        });
        setLiveSamples(mapped);
        setGate(effectiveGate(scan));
        setGateReason(scan.marketGate?.reason ?? "");
        setGateAck(false);
        setLiveScan({ ...demoScan, id: scan.id, site: scan.marketplace, category: scan.scanName,
          sampleCount: scan.sampleCount, snapshotAt: scan.createdAt, researchQuestion: scan.marketWorkflow?.metadata?.researchQuestion ?? "" });
        setResearchData({ scan, intelligence, recent, error: null, intelligenceError });
        setError(null);
      } catch (e) {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : "读取研究失败";
          setResearchData({ ...emptyResearchData, error: message }); setError(message);
        }
      } finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
  }, [scanId, revision]);

  const value = useMemo<HifiLive>(
    () => ({
      loading,
      error,
      screen,
      setScreen: setScreenState,
      explorer: demoExplorer,
      scan: liveScan ?? demoScan,
      samples: liveSamples ?? demoSamples,
      priceBands: liveSamples ? bandsOf(liveSamples) : demoPriceBands,
      keywords: demoKeywords,
      keywordEvidence: demoKeywordEvidence,
      asinFlow: demoAsinFlow,
      voc: demoVoc,
      compareQuestions: demoCompareQuestions,
      opportunityDetail: demoOpportunityDetail,
      moreEntries: demoMoreEntries,
      asinTrends: demoAsinTrends,
      gate,
      setGate,
      gateReason,
      setGateReason,
      gateAck,
      setGateAck,
      draft: draft ?? researchData.scan?.representatives?.items.map(s => s.asin) ?? [],
      setDraft,
      homeSummary,
      researchData,
      onSavedGate: async (status, reason) => {
        const scan = researchData.scan;
        if (!scan) throw new Error("研究对象尚未加载");
        const response = await fetch(`/api/market-analysis/${encodeURIComponent(scan.id)}/market-gate`, {
          method: "POST", headers: { ...buildAccessHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ status, reason: reason.trim(), missingDataAcknowledged: gateAck,
            expectedScanHash: scan.sampleHash, expectedVersion: scan.resourceVersion, idempotencyKey: crypto.randomUUID() }),
        });
        const json = await response.json().catch(() => null);
        if (!response.ok || !json?.ok) throw new Error(json?.error?.message || `保存失败 (${response.status})`);
        setRevision(v => v + 1);
      },
      onSavedRepresentatives,
    }),
    [
      loading,
      error,
      screen,
      liveScan,
      liveSamples,
      gate,
      gateReason,
      gateAck,
      draft,
      homeSummary,
      researchData,
      onSavedRepresentatives,
    ]
  );

  return <HifiCtx.Provider value={value}>{children}</HifiCtx.Provider>;
}
