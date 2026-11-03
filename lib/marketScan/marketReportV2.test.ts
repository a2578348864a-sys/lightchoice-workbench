import {describe,it,expect} from "vitest";
import {validateMarketReport,MARKET_REPORT_SECTIONS,type MarketIntelligence} from "./intelligence";
const ref={id:"review-source",evidenceId:"raw",subjectKey:"amazon:US:B012345678",contentHash:"a".repeat(64),capturedAt:"2026-10-23T00:00:00Z",sourceUrl:null,version:null,nature:"source_observed"};
const reviews=[{id:"R1",subjectKey:ref.subjectKey,subjectKeys:[ref.subjectKey,"amazon:US:B087654321"],title:null,text:"real-like isolated fixture",rating:2,evidence:ref}] satisfies MarketIntelligence["reviews"];
const point={text:"隔离合同测试推断",nature:"inference",citations:[ref.id]};
function input(){return {schema:"market-intelligence-report.v2",sections:Object.fromEntries(MARKET_REPORT_SECTIONS.map(k=>[k,[point]])),voiceThemes:[{label:"耐用性待验证",sentiment:"negative",statement:point,reviewIds:["R1","R1"],scenario:"",hypothesis:"",improvement:"",verification:["补充寿命测试"]}]};}
describe("five-workspace report evidence contract",()=>{
 it("computes theme denominators from unique supplied review identities and actual subjects",()=>{const report=validateMarketReport(input(),new Set([ref.id]),{reviews,comparisonSubjects:[ref.subjectKey]});expect(report.voiceThemes?.[0]).toMatchObject({reviewCount:1,productCount:2,reviewIds:["R1"]});expect(report.comparisonSubjects).toEqual([ref.subjectKey]);expect(validateMarketReport(report,new Set([ref.id])).sections).toEqual(report.sections);});
 it("rejects a fabricated review even if a citation is otherwise valid",()=>{const raw=input();raw.voiceThemes[0].reviewIds=["FOREIGN"];expect(()=>validateMarketReport(raw,new Set([ref.id]),{reviews,comparisonSubjects:[]})).toThrow("MARKET_AI_VOICE_INVALID");});
 it("requires every workspace and exact review evidence",()=>{const raw=input();delete raw.sections.demand;expect(()=>validateMarketReport(raw,new Set([ref.id]),{reviews,comparisonSubjects:[]})).toThrow();const bad=input();bad.voiceThemes[0].statement={text:"无依据",nature:"unknown",citations:[]};expect(()=>validateMarketReport(bad,new Set([ref.id]),{reviews,comparisonSubjects:[]})).toThrow("MARKET_AI_VOICE_CITATION_INVALID");});
});
