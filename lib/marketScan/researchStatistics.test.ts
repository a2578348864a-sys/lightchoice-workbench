import { describe, expect, it } from "vitest";
import { approvedResearchSubjects, buildResearchStatistics, uniqueResearchSamples, voicePhraseSegments } from "./researchStatistics";
import { buildMarketAiInput } from "@/lib/server/marketIntelligenceService";
import { vi } from "vitest";
import type { MarketIntelligence, MarketIntelligenceSample } from "./intelligence";
vi.mock("@/lib/server/db", () => ({ prisma: {} }));
const sample = (i: number): MarketIntelligenceSample => ({ asin:`B${String(i).padStart(9,"0")}`,subjectKey:`amazon:US:B${String(i).padStart(9,"0")}`,title:`Item ${i}`,brand:null,price:i,priceCurrency:"USD",rating:4,reviewCount:20,monthlySalesEstimate:null,bsr:null,valid:true,evidence:{id:`evidence-${i}`,evidenceId:`ev-${i}`,subjectKey:`amazon:US:B${String(i).padStart(9,"0")}`,contentHash:"a".repeat(64),version:1,capturedAt:"2026-10-13T00:00:00Z",sourceUrl:null,nature:"source_observed"} });
const dataset = () => ({ samples:Array.from({length:34},(_,i)=>sample(i+1)),reviews:[],keywords:[],sources:[],trends:[] } as Pick<MarketIntelligence,"samples"|"reviews"|"keywords"|"sources"|"trends">);
describe("one authority for keyword market statistics",()=>{
  it("counts a same-ASIN reading once despite multiple query references and keeps conflicting values out",()=>{
    const first=sample(1),repeat={...first,evidence:{...first.evidence,id:"other-query"}};
    expect(uniqueResearchSamples([first,repeat])).toHaveLength(1);
    expect(uniqueResearchSamples([first,{...repeat,price:99}])).toHaveLength(0);
  });
  it("explicitly excludes 3 of 34 without mutating raw samples, and charts/AI share the 31-subject aggregate",()=>{
    const data=dataset(),approved=new Set(data.samples.slice(3).map((s)=>s.subjectKey));
    const stats=buildResearchStatistics(data,approved);
    expect(stats.sampleCount).toBe(31);expect(stats.excludedCount).toBe(3);expect(stats.prices[0].bins.reduce((n,b)=>n+b.count,0)).toBe(31);expect(data.samples).toHaveLength(34);
    const input=buildMarketAiInput({...data,queryBindings:[],productMarkets:[],productSignals:[],variations:[],statistics:{...stats,hash:"s"}} as unknown as MarketIntelligence,[]);
    expect(input.samples).toHaveLength(31);expect(input.statistics?.subjects).toEqual(stats.subjects);expect(input.statistics?.prices).toEqual(stats.prices);
  });
  it("keeps source estimates, product counts and missing demand separate",()=>{
    const data=dataset();data.samples[0].price=null;
    const stats=buildResearchStatistics(data);
    expect(stats.prices[0].denominator).toBe(33);expect(stats.keywords.withSearchVolume).toBe(0);expect(stats.brands.denominator).toBe(0);expect(stats.brands.missing).toBe(34);
    expect(approvedResearchSubjects({marketIntelligence:{analysisSampleKeys:[sample(1).subjectKey]}})?.size).toBe(1);
  });
  it("counts VOC against acquired reviews, includes high-star counter-evidence and permits multiple themes",()=>{
    const data=dataset(),s=data.samples[0];
    data.reviews=[{id:"r1",subjectKey:s.subjectKey,title:null,text:"Too slippery and hard to clean",rating:4,evidence:s.evidence},{id:"r2",subjectKey:s.subjectKey,title:null,text:"Easy to clean",rating:5,evidence:s.evidence}];
    const stats=buildResearchStatistics(data);
    expect(stats.reviews.lowStars).toBe(0);expect(stats.reviews.highStars).toBe(2);
    expect(stats.voc.find((v)=>v.id==="cleaning")).toMatchObject({count:1,denominator:2,productCount:1});
    expect(stats.voc.find((v)=>v.id==="slipping")?.count).toBe(1);
  });
  it("只把可复核的评论量计入分布，冲突与单次来源并列保留但不参与统计",()=>{    const data=dataset();
    const withCaliber=(index:number,value:number|null,caliber:MarketIntelligenceSample["reviewCountCaliber"])=>{const s=sample(index);s.reviewCount=value;s.reviewCountCaliber=caliber;return s;};
    data.samples=[
      withCaliber(1,27477,{state:"verified",lockedValue:27477,lockedSurface:"detail",productPageValue:27477,productPageCapturedAt:"2026-10-13T20:29:06.704Z",productPageEvidenceId:"ev-detail-1",conflicts:[],reason:"product_page_surface"}),
      withCaliber(2,570,{state:"verified",lockedValue:570,lockedSurface:"search",productPageValue:570,productPageCapturedAt:"2026-10-13T20:37:34.410Z",productPageEvidenceId:"ev-detail-2",conflicts:[],reason:"product_page_agrees"}),
      withCaliber(3,27,{state:"conflict",lockedValue:27,lockedSurface:"search",productPageValue:27477,productPageCapturedAt:"2026-10-13T20:29:06.704Z",productPageEvidenceId:"ev-detail-3",conflicts:[{value:27477,capturedAt:"2026-10-13T20:29:06.704Z",evidenceId:"ev-detail-3",version:2,surface:"detail"}],reason:"product_page_reading_incompatible"}),
      withCaliber(4,5,{state:"unverified",lockedValue:5,lockedSurface:"search",productPageValue:null,productPageCapturedAt:null,productPageEvidenceId:null,conflicts:[],reason:"search_surface_only"}),
      sample(5),
    ];
    const stats=buildResearchStatistics(data);
    expect(stats.reviewCount.denominator).toBe(3);
    expect(stats.reviewCount.median).toBe(570);
    expect(stats.reviewCount.bins.reduce((n,b)=>n+b.count,0)).toBe(3);
    expect(stats.reviewCount.lockedCount).toBe(5);
    expect(stats.reviewCount.conflictCount).toBe(1);
    expect(stats.reviewCount.unverifiedCount).toBe(1);
    expect(stats.reviewCount.unclassifiedCount).toBe(1);
    expect(stats.reviewCount.conflicts[0]).toMatchObject({asin:sample(3).asin,lockedValue:27,productPageValue:27477,lockedSurface:"search"});
    expect(stats.reviewCount.unverifiedSubjects).toEqual([sample(4).subjectKey]);
    expect(stats.reviewCount.policy).toContain("不进入分布");
    const input=buildMarketAiInput({...data,queryBindings:[],productMarkets:[],productSignals:[],variations:[],statistics:{...stats,hash:"s"}} as unknown as MarketIntelligence,[]);
    expect(input.statistics?.reviewCount.conflicts).toHaveLength(1);
    expect(input.samples.find((s)=>s.asin===sample(3).asin)?.reviewCountCaliber?.state).toBe("conflict");
  });
  it("分开统计市场关键词需求与竞品流量关键词：不相加、不共用分母、不静默并入",()=>{
    const data=dataset(),s=data.samples[0];
    const marketKey="sellersprite:US:keyword-mining:fixture";
    const keyword=(module:string,subjectKey:string,word:string,searchVolume:number|null,metrics:Record<string,{value:number|null;unit:string;metricNature:string}>)=>({keyword:word,subjectKey,module,searchVolume,observedAt:null,metrics,evidence:s.evidence});
    data.keywords=[
      keyword("keyword_mining_trend",marketKey,"silicone mat",1200,{searchVolume:{value:1200,unit:"count",metricNature:"provider_estimate"}}),
      keyword("keyword_mining_trend",marketKey,"baking sheet",800,{searchVolume:{value:800,unit:"count",metricNature:"provider_estimate"}}),
      keyword("reverse_asin",s.subjectKey,"sourdough mat",600,{trafficShare:{value:0.25,unit:"percent",metricNature:"provider_estimate"},searchVolume:{value:600,unit:"count",metricNature:"provider_estimate"}}),
      keyword("unknown_module",s.subjectKey,"mystery word",5,{searchVolume:{value:5,unit:"count",metricNature:"provider_estimate"}}),
    ];
    const stats=buildResearchStatistics(data);
    expect(stats.keywords.market.rows).toBe(2);
    expect(stats.keywords.market.withSearchVolume).toBe(2);
    expect(stats.keywords.competitorTraffic.rows).toBe(1);
    expect(stats.keywords.competitorTraffic.withTrafficShare).toBe(1);
    expect(stats.keywords.unclassified).toBe(1);
    expect(stats.keywords.rows).toBe(4);
    const input=buildMarketAiInput({...data,queryBindings:[marketKey],productMarkets:[],productSignals:[],variations:[],statistics:{...stats,hash:"s"}} as unknown as MarketIntelligence,[]);
    expect(input.keywordDemand.rows.map((row)=>row.keyword)).toEqual(["silicone mat","baking sheet"]);
    expect(input.competitorTrafficKeywords.rows.map((row)=>row.keyword)).toEqual(["sourdough mat"]);
    expect(input.unclassifiedKeywords).toBe(1);
    expect(input.keywordDemand.available+input.competitorTrafficKeywords.available).toBe(3);
  });
});

describe("原文短语强调与统计同源", () => {
  it("只切出同一 VOC 规则命中的字面片段，且不丢字、不改写原文", () => {
    const text = "The mat is too slippery and hard to clean after baking.";
    const segments = voicePhraseSegments("slipping", text);
    expect(segments.filter((s) => s.hit).map((s) => s.text)).toEqual(["too slippery"]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });
  it("同一评论可命中多条规则，中文原文同样可标", () => {
    const text = "尺寸不符，而且很难清洗。";
    const hit = voicePhraseSegments("fit", text).filter((s) => s.hit).map((s) => s.text);
    expect(hit).toEqual(["尺寸不符"]);
    expect(voicePhraseSegments("cleaning", text).map((s) => s.text).join("")).toBe(text);
  });
  it("未知规则或空文本退化为整段普通文本，不抛错", () => {
    expect(voicePhraseSegments("not-a-rule", "abc")).toEqual([{ text: "abc", hit: false }]);
    expect(voicePhraseSegments("cleaning", "")).toEqual([{ text: "", hit: false }]);
  });
});
