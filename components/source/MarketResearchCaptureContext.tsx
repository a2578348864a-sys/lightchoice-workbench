"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { buildAccessHeaders } from "@/lib/client/accessToken";
import type { MarketIntelligence } from "@/lib/marketScan/intelligence";

/** Context only: loading this card never prepares, drives, retries or charges a task. */
export function MarketResearchCaptureContext() {
  const [context,setContext] = useState<{ id: string; module: string; data: MarketIntelligence | null; error: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search), id = params.get("marketScanId") ?? "", sourceModule = params.get("module") ?? "";
    if (!/^[A-Za-z0-9_-]{8,96}$/u.test(id)) return;
    const controller = new AbortController();
    void fetch(`/api/market-analysis/${encodeURIComponent(id)}/intelligence`, { headers: buildAccessHeaders(), cache:"no-store", signal:controller.signal }).then(async(response)=>{
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error?.message ?? "当前研究不可读，请返回核对。");
      setContext({ id,module:sourceModule,data:body.data,error:"" });
    }).catch((error)=>{if(!controller.signal.aborted)setContext({id,module:sourceModule,data:null,error:error instanceof Error?error.message:"研究读取失败"});});
    return ()=>controller.abort();
  }, []);
  if (!context) return null;
  return <aside className="rounded-xl border border-sky-200 bg-sky-50 p-5 text-sm leading-relaxed" aria-label="市场研究补证上下文"><strong>为当前关键词研究补充证据</strong>{context.error?<p role="alert">{context.error}</p>:<><p>{context.data?.scanName} · {context.data?.marketplace} · 正式商品 {context.data?.statistics?.sampleCount ?? "未知"} 款</p><p>关键词：{context.data?.research?.keyword ?? "以研究保存范围为准"}。查询证据需要返回02明确关联；新发现的商品不会自动扩大正式样本。</p>{context.module==="sellersprite_product_market"&&<p>已定位原商品批次的任务入口。现有Product Market查询要求明确的类目/筛选条件，不能擅自当成关键词市场规模；商品观察、查询行和类目指标分别保存。来源条件不足时保留受阻状态。</p>}{context.module==="historical_trend"&&<p>复用现有Keepa合法文件导入入口。文件与ASIN、日期和单位需通过原有校验；不调用Keepa API，不把单点画成长周期趋势。</p>}{!context.data?.research?.captureEnabled&&<p className="text-amber-800">当前真实浏览器采集开关关闭。页面浏览不会开启采集；请核对账号会话与执行授权后使用原有入口。</p>}</>}<Link className="mt-2 inline-block text-sky-800 underline" href={`/market-analysis/${encodeURIComponent(context.id)}`}>返回02查看覆盖与新证据</Link></aside>;
}
