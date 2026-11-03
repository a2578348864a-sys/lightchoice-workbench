import {NextRequest,NextResponse} from "next/server";
import {randomUUID} from "node:crypto";
import {readAuth,writeAuth,writeOriginOk,authResponse,originError,jsonBody,v5ErrorResponse} from "@/lib/server/v5ApiRoute";
import {V5CoreError} from "@/lib/server/v5CoreCommon";
import {getMarketIntelligence} from "@/lib/server/marketIntelligenceService";
import {createSellerSpriteCaptureJobRepository} from "@/lib/server/sellerSpriteCaptureJobRepository";
import {sellerSpriteCaptureAccessScopeHash,type SellerSpriteCaptureLimitation} from "@/lib/server/sellerSpriteCaptureJob";
import {collectSellerSpriteSubjectWithCdp} from "@/lib/server/sellerSpriteVisibleBrowser";
import {probeBrowserIdentityViaHttp} from "@/lib/server/sellerSpriteBrowserIdentity";
import {resolveSellerSpriteCdpEndpoint,resolveSellerSpriteProfileDirectory} from "@/lib/server/sellerSpriteProfileConfig";
export const runtime="nodejs";export const dynamic="force-dynamic";
const validUrl=(raw:string)=>{try{const u=new URL(raw);return u.protocol==="https:"&&!u.username&&!u.password&&!u.hash&&/(^|\.)sellersprite\.com$/iu.test(u.hostname)&&![...u.searchParams.keys()].some(k=>/token|auth|password|secret|session/iu.test(k));}catch{return false;}};
/** 主体采集的结构性受阻原因：必须和「技术错误」「套餐限制」分开，避免误报。 */
const SUBJECT_LIMITATION_BY_CODE:Record<string,SellerSpriteCaptureLimitation>={
 SELLERSPRITE_HISTORY_DRAWER_NOT_OPEN:"source_page_not_ready",
 SELLERSPRITE_HISTORY_NO_VERIFIED_POINTS:"no_verified_values",
 SELLERSPRITE_HISTORY_SUBJECT_MISMATCH:"source_identity_mismatch",
 SELLERSPRITE_SOURCE_PAGE_REDIRECTED_HOME:"source_page_redirected",
 SELLERSPRITE_SESSION_OR_PERMISSION_REQUIRED:"human_login_required",
 SELLERSPRITE_MARKETPLACE_NOT_CONFIRMED:"source_identity_unconfirmed"};
export async function GET(request:NextRequest){
 const auth=readAuth(request);if(!auth.ok)return authResponse(auth);
 if(auth.context.mode!=="owner")return NextResponse.json({ok:false,error:{code:"OWNER_REQUIRED",message:"仅本机Owner可查看采集环境。"}},{status:403});
 const endpoint=resolveSellerSpriteCdpEndpoint();if(!endpoint)return NextResponse.json({ok:true,data:{pages:[],reason:"CDP地址未配置"}});
 try{if(await probeBrowserIdentityViaHttp(endpoint.origin,resolveSellerSpriteProfileDirectory())!=="managed")return NextResponse.json({ok:true,data:{pages:[],reason:"CDP实例身份未通过专用Profile校验，请检查采集环境"}});const response=await fetch(`${endpoint.origin}/json/list`,{signal:AbortSignal.timeout(2000),cache:"no-store"});const raw=await response.json();const pages=Array.isArray(raw)?raw.filter(p=>p.type==="page"&&validUrl(p.url)).map(p=>({title:String(p.title).slice(0,160),url:String(p.url)})):[];return NextResponse.json({ok:true,data:{pages,reason:pages.length?null:"专用浏览器尚无SellerSprite来源页"}});}catch{return NextResponse.json({ok:true,data:{pages:[],reason:"CDP暂不可达，请启动专用浏览器"}});}
}
export async function POST(request:NextRequest){
 const auth=writeAuth(request);if(!auth.ok)return authResponse(auth);if(!writeOriginOk(request))return originError();
 try{
  if(auth.context.mode!=="owner")throw new V5CoreError("OWNER_REQUIRED","仅Owner可执行真实来源任务。",403);
  const body=await jsonBody(request) as Record<string,unknown>;const action=String(body.action??"");const scanId=String(body.scanId??"");
  const current=await getMarketIntelligence({context:auth.context,scanId});const repo=createSellerSpriteCaptureJobRepository();
  if(action==="prepare"){
   const captureModule=String(body.module),asin=String(body.asin??"").trim().toUpperCase(),sourceUrl=String(body.sourceUrl??"");
   if(!["sellersprite_product_market","historical_trend"].includes(captureModule)||!/^[A-Z0-9]{10}$/u.test(asin)||!current.statistics?.subjects.includes(`amazon:US:${asin}`)||current.marketplace!=="US")throw new V5CoreError("SELLERSPRITE_SUBJECT_INVALID","请选择当前正式研究内的美国站ASIN。",422);
   if(!validUrl(sourceUrl)||sourceUrl.length>4096)throw new V5CoreError("SELLERSPRITE_SOURCE_PAGE_REQUIRED","请选择专用浏览器中的 SellerSprite 正式页面；URL 不得含凭据。",422);
   // 历史补证的身份由「抽屉里实际显示的商品」确认（采集时强校验 drawer.asin === 目标 ASIN），
   // 因此不强制 URL 里出现 ASIN：查竞品的列表页 URL 只带筛选条件，真正的对象在打开的历史抽屉里。
   if(captureModule!=="historical_trend"&&!sourceUrl.toUpperCase().includes(asin))throw new V5CoreError("SELLERSPRITE_SOURCE_PAGE_REQUIRED","请选择专用浏览器中包含该ASIN的SellerSprite正式商品来源页；URL不得含凭据。",422);
   const result=await repo.ensure({module:captureModule as "sellersprite_product_market"|"historical_trend",marketplace:"US",accessScope:"owner",query:{researchScanId:scanId,subjectKey:`amazon:US:${asin}`,asin,sourceUrl,kind:"single_subject_current_page"},windowBudget:1});return NextResponse.json({ok:true,data:{captureJob:result.job,created:result.created}});
  }
  const job=await repo.getById(String(body.jobId??""));
  if(!job||job.accessScopeHash!==sellerSpriteCaptureAccessScopeHash("owner")||job.query.researchScanId!==scanId||job.query.kind!=="single_subject_current_page"||!["sellersprite_product_market","historical_trend"].includes(job.module)||!current.statistics?.subjects.includes(job.query.subjectKey))throw new V5CoreError("CAPTURE_JOB_NOT_FOUND","当前研究没有这个可操作的主体任务。",404);
  if(action==="status")return NextResponse.json({ok:true,data:{captureJob:job}});
  if(action==="retry"){const retry=await repo.retry(job.jobId);if(!retry)throw new V5CoreError("CAPTURE_RETRY_REJECTED","请先确认上次任务已结束且来源条件已恢复。",409);return NextResponse.json({ok:true,data:{captureJob:retry}});}
  if(action!=="capture")throw new V5CoreError("INVALID_ACTION","采集动作无效。",400);
  const worker=`subject-${randomUUID()}`,claim=await repo.claim(job.jobId,worker);if(!claim)throw new V5CoreError("CAPTURE_JOB_BUSY","任务已结束或仍在执行，请先读取状态，不重复采集。",409);
  try{
   const result=await collectSellerSpriteSubjectWithCdp({context:auth.context,module:job.module as "sellersprite_product_market"|"historical_trend",asin:job.query.asin,sourceUrl:job.query.sourceUrl});
   const keys=result.usableRows&&result.attachment?[result.attachment.attachmentId]:[];
   const limitationReason=result.errorCode&&SUBJECT_LIMITATION_BY_CODE[result.errorCode]?SUBJECT_LIMITATION_BY_CODE[result.errorCode]:result.status==="human_required"?"human_login_required":result.status==="captured"?"query_finished":"technical_error";
   const saved=await repo.saveProgress(job.jobId,worker,claim.fence,{now:new Date(),rowKeys:keys,structuredValidRowKeys:keys,persistedRowKeys:keys,evidenceRefs:result.attachment?[result.attachment.attachmentId]:[],cursor:{page:1,scrollY:0},counters:{reportedTotalRows:null,accessibleRows:null,unavailableRows:null,capturedUniqueRows:keys.length,structuredValidRows:keys.length,persistedEvidenceRows:keys.length},status:result.status==="captured"?"COMPLETE":result.status==="partial"?"PARTIAL":"FAILED",limitationReason,lastErrorCode:result.errorCode});
   if(!saved)throw new V5CoreError("CAPTURE_CHECKPOINT_REJECTED","写入证据后任务状态未确认，请读取任务状态，不要重新采集。",409);
   return NextResponse.json({ok:true,data:{captureJob:saved,message:result.message,subjectKey:job.query.subjectKey,diagnostics:result.diagnostics,usableRows:result.usableRows}});
  }catch(error){
   await repo.saveProgress(job.jobId,worker,claim.fence,{now:new Date(),rowKeys:[],structuredValidRowKeys:[],persistedRowKeys:[],evidenceRefs:[],cursor:null,counters:{},status:"FAILED",limitationReason:"technical_error",lastErrorCode:"SELLERSPRITE_SUBJECT_CAPTURE_FAILED"});throw error;
  }
 }catch(error){return v5ErrorResponse(error);}
}
