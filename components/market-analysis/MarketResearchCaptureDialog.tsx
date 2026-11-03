"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {buildAccessHeaders} from "@/lib/client/accessToken";
import type {MarketIntelligence} from "@/lib/marketScan/intelligence";
import {CaptureEnvironmentStatusCard, type EnvironmentData} from "@/components/source/CaptureEnvironmentStatusCard";
import {SellerSpriteKeywordCapturePanel} from "@/components/source-layer/SellerSpriteKeywordCapturePanel";
import styles from "./MarketIntelligencePanel.module.css";
export type ResearchCaptureMode="environment"|"sellersprite_product_market"|"reverse_asin"|"keyword_mining_trend"|"historical_trend";
const titles:Record<ResearchCaptureMode,string>={environment:"CDP 浏览器与采集环境",sellersprite_product_market:"商品与市场深度补证",reverse_asin:"ASIN 反查",keyword_mining_trend:"种子关键词挖掘",historical_trend:"历史趋势补证"};
type SubjectJob={jobId:string;status:string;lastErrorCode:string|null;evidenceRefs?:string[];query:Record<string,string>;limitationReason:string};
type SubjectDiagnostics={pageSelection?:string|null;candidatePages?:number;pageUrlBefore?:string|null;pageUrlAfter?:string|null;navigated?:boolean;drawer?:{open:boolean;asin:string|null;activeTab:string|null;rangeLabel:string|null}|null;history?:{points:number;monthlyPoints:number;eventPoints:number;monthlyRange:{from:string;to:string;count:number}|null;eventRange:{from:string;to:string;count:number}|null;metrics:string[];sameDateVariants:number}|null;historyIssues?:string[]};

/** 结构性受阻原因：告诉用户「现在能做的一步」，而不是暴露内部错误码。 */
const ERROR_HINTS:Record<string,string>={
 SELLERSPRITE_HISTORY_DRAWER_NOT_OPEN:"这一页没有打开历史抽屉。请在结果行点击「历史趋势」图标，再点「重新检测/读取来源页」后采集。",
 SELLERSPRITE_HISTORY_NO_VERIFIED_POINTS:"历史抽屉已打开，但没有可验证的日期与数值。请把范围切到「全部(721天)」或「最近一年」后重试；系统不会用图表高度猜数值。",
 SELLERSPRITE_HISTORY_SUBJECT_MISMATCH:"抽屉显示的商品不是目标 ASIN。请重新打开该 ASIN 的历史抽屉。",
 SELLERSPRITE_SOURCE_PAGE_REDIRECTED_HOME:"来源页被跳回首页。请在专用浏览器重新打开目标 ASIN 页面并保持打开，再采。",
 SELLERSPRITE_SESSION_OR_PERMISSION_REQUIRED:"来源要求登录或相应权益。登录后点「重新检测」，再采集。",
 SELLERSPRITE_MARKETPLACE_NOT_CONFIRMED:"页面无法确认美国站：请核对站点后再采集。",
 SELLERSPRITE_SUBJECT_NOT_CONFIRMED:"页面没有确认目标 ASIN：请打开对应商品页后重试。",
 SELLERSPRITE_NUMERIC_DATA_MISSING:"当前页没有可验证的命名指标。可换到包含指标表格/抽屉的页面。",
 SELLERSPRITE_SOURCE_LIMIT_WITHOUT_VISIBLE_ROWS:"来源限制且当前没有可见行：等来源恢复后再采集，已有结果会保留。",
 SELLERSPRITE_SUBJECT_CAPTURE_FAILED:"采集过程技术失败：可先点「刷新进度」核对，再决定是否重试。"};
const LIMITATION_LABELS:Record<string,string>={
 query_finished:"来源查询已完成",source_limit_declared:"来源限制（仅部分范围可见）",human_login_required:"等待人工登录",technical_error:"技术错误",budget_stop:"按预算停止",source_page_not_ready:"来源页未就绪（需要打开对应抽屉）",no_verified_values:"没有可验证数值",source_identity_mismatch:"来源身份与目标不一致",source_page_redirected:"来源页被重定向",source_identity_unconfirmed:"来源身份未确认",unknown:"未记录"};
const SELECTION_LABELS:Record<string,string>={
 reused_confirmed_drawer:"复用已打开且已确认该 ASIN 的抽屉页（未导航）",reused_confirmed_url:"复用已打开且含该 ASIN 的页面（未导航）",reused_seller_page:"复用已打开的 SellerSprite 页面",navigated_home_page:"在首页导航到来源页",created_page:"新建页面并打开来源页"};
function SubjectCapture({data,scanId,mode,environment,onRecheckEnvironment,onEvidenceReady}:{data:MarketIntelligence;scanId:string;mode:"sellersprite_product_market"|"historical_trend";environment:EnvironmentData|null;onRecheckEnvironment:()=>void;onEvidenceReady:(key:string)=>Promise<void>}){
 const samples=data.samples.filter(s=>data.statistics?.subjects.includes(s.subjectKey));
 const [asin,setAsin]=useState(samples[0]?.asin??""),[sourceUrl,setSourceUrl]=useState(""),[pages,setPages]=useState<Array<{title:string;url:string}>>([]),[pagesReason,setPagesReason]=useState(""),[job,setJob]=useState<SubjectJob|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[error,setError]=useState(""),[diagnostics,setDiagnostics]=useState<SubjectDiagnostics|null>(null);
 const endpoint="/api/source-layer/acquire/sellersprite-subject",storageKey=`market-subject:${scanId}:${mode}:${asin}`;
 const envReady=environment?Boolean(environment.cdpReachable):null;
 const post=useCallback(async(body:Record<string,unknown>)=>{const r=await fetch(endpoint,{method:"POST",headers:{...buildAccessHeaders(),"content-type":"application/json"},body:JSON.stringify({...body,scanId})});const p=await r.json();if(!r.ok||!p.ok)throw new Error(p.error?.message??"请求未确认，请先读取任务状态。");if(p.data.captureJob)setJob(p.data.captureJob);if(p.data.diagnostics)setDiagnostics(p.data.diagnostics as SubjectDiagnostics);return p.data;},[scanId]);
 const refreshPages=useCallback(async()=>{try{const r=await fetch(`${endpoint}?asin=${encodeURIComponent(asin)}`,{headers:buildAccessHeaders(),cache:"no-store"});const p=await r.json();if(!r.ok||!p.ok)throw new Error(p.error?.message??"无法读取来源页");const listed:Array<{title:string;url:string}>=p.data.pages;setPages(listed);setPagesReason(p.data.reason??"");const matched=listed.filter(page=>page.url.toUpperCase().includes(asin.toUpperCase()));const selectable=mode==="historical_trend"?listed:matched;setSourceUrl(current=>current&&selectable.some(page=>page.url===current)?current:(selectable.length===1?selectable[0].url:""));setNotice(listed.length?`已识别 ${listed.length} 个 SellerSprite 页面${mode==="historical_trend"?"；历史补证会在所选页面里打开该 ASIN 的历史抽屉并核对 ASIN":`，其中 ${matched.length} 个包含 ${asin}`}。`:(p.data.reason??"专用浏览器尚无 SellerSprite 来源页。"));}catch(e){setError(e instanceof Error?e.message:"读取失败");}}, [asin,mode]);
 useEffect(()=>{let live=true;setJob(null);const saved=sessionStorage.getItem(storageKey);if(saved)void post({action:"status",jobId:saved}).then(p=>{if(live){setSourceUrl(p.captureJob.query.sourceUrl);setNotice("已读取上次保存的任务状态（不会自动重复采集）。");}},e=>{if(live)setError(String(e.message));});return()=>{live=false;};},[storageKey,post]);
 async function action(action:string){setBusy(true);setError("");try{const p=await post({action,jobId:job?.jobId,module:mode,asin,sourceUrl});sessionStorage.setItem(storageKey,p.captureJob.jobId);setNotice(p.message??p.reason??(action==="prepare"?"任务已保存；点击采集才访问来源。":"已读取持久任务状态；不会自动重新采集。"));}catch(e){setError(e instanceof Error?e.message:"操作失败");}finally{setBusy(false);}}
 const matchedPages=pages.filter(page=>page.url.toUpperCase().includes(asin.toUpperCase()));
 const selectablePages=mode==="historical_trend"?pages:matchedPages;
 const target=`${samples.find(s=>s.asin===asin)?.brand??"品牌未知"} · ${asin}`;
 const existing=job?(job.evidenceRefs?.length??0):0;
 const stateLabel=!job?(envReady===false?"专用浏览器当前不可达":sourceUrl?"已选择来源页，可以准备采集":"尚未选择来源页"):({PENDING:"任务已保存，尚未访问来源",RUNNING:"正在采集（不要重复点击）",COMPLETE:"已保存可分析证据",PARTIAL:existing?`已保存来源观察（${existing} 项证据），可用数值不足`:"未取得可分析结果",FAILED:"采集失败，旧证据与计数已保留",CANCELLED:"任务已取消"} as Record<string,string>)[job.status]??job.status;
 const nextStep=!job?(envReady===false?"先恢复专用浏览器（登录/启动）后点「重新检测」":sourceUrl?"点「准备采集当前页」，再点「采集当前来源页」":"点「读取来源页」，选中含该 ASIN 的页面（历史补证需在该页点开「历史趋势」图标）")
  :job.status==="COMPLETE"?(existing?"点「关联已有证据」把已保存结果加入当前研究；这一步不会重新采集":"已保存可分析证据；若研究里还看不到，点「刷新进度」核对任务与来源范围")
  :job.status==="PENDING"?`点「采集当前来源页」${mode==="historical_trend"?"：将读取「销量趋势」月份表与「历史趋势」「留评率」悬停点":""}`
  :job.status==="RUNNING"?"等待本次采集结束；页面不会再发第二个任务"
  :job.status==="PARTIAL"&&existing?"已保存可用部分：先点「关联已有证据」纳入；需要更多数值再等来源恢复后重试"
  :"修正来源后点「来源恢复后准备重试」，再点采集；已有证据不会被清空";
 const failureHint=job?.lastErrorCode?ERROR_HINTS[job.lastErrorCode]??"已记录失败原因；技术详情见下方「任务详情与来源」。":"";
 return <section className={styles.subjectCapture}>
  <p className={styles.note}>{mode==="historical_trend"?"读取该商品的真实日期序列：SellerSprite 查竞品 → 行内「历史趋势」抽屉里的「销量趋势」月份表 +「历史趋势」悬停点。当前不提供关键词搜索历史。":"读取指定商品的 SellerSprite 指标；市场级查询结果另行验收。"}</p>
  <label className={styles.sourceField}>采集对象（美国站）<select aria-label="补证商品ASIN" disabled={busy||Boolean(job)} value={asin} onChange={e=>{setAsin(e.target.value);setSourceUrl("");setPages([]);setNotice("");setError("");}}>{samples.map(s=><option key={s.subjectKey} value={s.asin}>{s.brand??"品牌未知"} · {s.asin}</option>)}</select></label>
  {!job && <>
    <div className={styles.controls}><button disabled={busy} onClick={()=>void refreshPages()}>读取专用浏览器来源页</button><button disabled={busy} onClick={()=>{setError("");onRecheckEnvironment();setTimeout(()=>void refreshPages(),800);}}>重新检测环境</button></div>
    {pages.length>0 && <p className={styles.note}>{mode==="historical_trend"?"可选用页面（历史补证按抽屉确认 ASIN，选择当前打开的查竞品结果页即可）：":matchedPages.length?`可选用页面（含 ${asin}）：`:"已打开页面里没有该 ASIN，请先在专用浏览器打开其商品页。"}</p>}
    {selectablePages.length>0 && <label className={styles.sourceField}>选择对应来源页<select aria-label="选择来源页" value={sourceUrl} onChange={e=>setSourceUrl(e.target.value)}><option value="">请选择</option>{selectablePages.map(page=><option key={page.url} value={page.url}>{page.title||page.url}</option>)}</select></label>}
    {pagesReason && <p className={styles.note}>{pagesReason}</p>}
    <details className={styles.disclosure}><summary>手动指定已打开的来源页</summary><label className={styles.sourceField}>官方来源 URL<input aria-label="SellerSprite商品来源URL" value={sourceUrl} maxLength={4096} onChange={e=>setSourceUrl(e.target.value)} placeholder="https://www.sellersprite.com/…（含当前ASIN）"/></label><p className={styles.note}>须为对应 ASIN 的 SellerSprite 页面，不得携带凭据；提交后系统优先复用该已打开页面，不会无故重新导航。</p></details>
  </>}
  <div className={styles.review}>
    <p><b>采集对象</b>：{target}{mode==="historical_trend"?" · 商品历史（销量趋势 + 历史趋势）":" · 商品指标"}</p>
    <p><b>已有结果</b>：{job?`${existing} 项来源引用`:"本次尚未采集；旧任务可用下方「刷新进度」核对"}{diagnostics?.history?` · 月度点 ${diagnostics.history.monthlyPoints} · 悬停日期点 ${diagnostics.history.eventPoints}`:""}</p>
    <p><b>当前状态</b>：{stateLabel}{job&&job.status!=="COMPLETE"&&job.limitationReason?` · ${LIMITATION_LABELS[job.limitationReason]??job.limitationReason}`:""}</p>
    <p><b>下一步</b>：{nextStep}</p>
    {failureHint&&<p className={styles.error} role="alert">{failureHint}</p>}
  </div>
  {error&&<p className={styles.error} role="alert">{error}</p>}
  {notice&&<p role="status" className={styles.notice}>{notice}</p>}
  <div className={styles.controls}>{!job?<button disabled={busy||!sourceUrl||!asin||envReady===false} title={envReady===false?"专用浏览器不可达：请先启动/登录后重新检测":undefined} onClick={()=>void action("prepare")}>准备采集当前页</button>:<>
    {job.status==="PENDING"&&<button disabled={busy} title={mode==="historical_trend"?"会先读月份表，再在历史趋势图上做正常鼠标悬停读取可见浮层":"读取当前来源页"} onClick={()=>void action("capture")}>采集当前来源页</button>}
    <button disabled={busy} onClick={()=>void action("status")}>刷新进度</button>
    {["FAILED","PARTIAL"].includes(job.status)&&<button disabled={busy} onClick={()=>void action("retry")}>来源恢复后准备重试</button>}
    {Boolean(job.evidenceRefs?.length)&&<button disabled={busy} onClick={()=>{setBusy(true);void onEvidenceReady(job.query.subjectKey).then(()=>setNotice("当前研究已刷新；本次只关联已保存证据，不会重新采集。"),e=>setError(e.message)).finally(()=>setBusy(false));}}>关联已有证据</button>}
  </>}</div>
  {job&&<details className={styles.disclosure}><summary>任务详情与来源（技术信息）</summary><p>任务状态：{job.status} · 失败码：{job.lastErrorCode??"无"} · 受阻原因：{LIMITATION_LABELS[job.limitationReason]??job.limitationReason}</p><p>来源页：{job.query.sourceUrl}</p>{diagnostics&&<p>页面选择：{SELECTION_LABELS[diagnostics.pageSelection??""]??diagnostics.pageSelection??"未记录"} · 候选页 {diagnostics.candidatePages??0} 个 · 是否导航：{diagnostics.navigated?"是":"否"}</p>}{diagnostics?.drawer&&<p>历史抽屉：{diagnostics.drawer.asin??"ASIN 未确认"} · {diagnostics.drawer.activeTab??"标签未知"} · {diagnostics.drawer.rangeLabel??"范围未知"}</p>}{diagnostics?.history&&<p>历史点：月度 {diagnostics.history.monthlyPoints} · 悬停 {diagnostics.history.eventPoints} · 同日多读数 {diagnostics.history.sameDateVariants} · 月份范围 {diagnostics.history.monthlyRange?`${diagnostics.history.monthlyRange.from}~${diagnostics.history.monthlyRange.to}`:"无"} · 悬停范围 {diagnostics.history.eventRange?`${diagnostics.history.eventRange.from}~${diagnostics.history.eventRange.to}`:"无"}</p>}{Boolean(diagnostics?.historyIssues?.length)&&<p>解析提示：{diagnostics!.historyIssues!.slice(0,4).join("；")}</p>}<small>{job.jobId}</small><button disabled={busy||job.status==="RUNNING"} onClick={()=>{sessionStorage.removeItem(storageKey);setJob(null);setDiagnostics(null);setSourceUrl("");setNotice("");}}>选择另一来源</button></details>}
 </section>;
}
export function MarketResearchCaptureDialog({mode,data,scanId,onClose,onEvidenceReady}:{mode:ResearchCaptureMode;data:MarketIntelligence;scanId:string;onClose:()=>void;onEvidenceReady:(key:string)=>Promise<void>}){
 const ref=useRef<HTMLDialogElement>(null);
 const [environment,setEnvironment]=useState<EnvironmentData|null>(null);
 const [envKey,setEnvKey]=useState(0);
 useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>{dialog?.close();};},[]);
 return <dialog ref={ref} className={`${styles.captureDialog} ${styles.panel}`} onCancel={onClose} onClose={onClose} aria-labelledby="research-capture-title"><header className={styles.dialogHeader}><div><h2 id="research-capture-title">{titles[mode]}</h2><p>{data.research?.keyword} · {data.marketplace}</p></div><button autoFocus onClick={onClose}>关闭</button></header><CaptureEnvironmentStatusCard key={envKey} compact={mode!=="environment"} onReadinessChange={setEnvironment}/>{mode==="reverse_asin"||mode==="keyword_mining_trend"?<SellerSpriteKeywordCapturePanel key={mode} embedded environmentReadiness={environment} initialModule={mode} initialAsin={data.samples.find(s=>data.statistics?.subjects.includes(s.subjectKey))?.asin??""} initialKeyword={data.research?.keyword??""} researchScanId={scanId} onEvidenceReady={onEvidenceReady}/>:mode!=="environment"?<SubjectCapture data={data} scanId={scanId} mode={mode} environment={environment} onRecheckEnvironment={()=>setEnvKey(key=>key+1)} onEvidenceReady={onEvidenceReady}/>:<p className={styles.note}>连接可用后，请在专用浏览器登录 SellerSprite。具体功能权限以来源任务结果为准。</p>}</dialog>;
}
