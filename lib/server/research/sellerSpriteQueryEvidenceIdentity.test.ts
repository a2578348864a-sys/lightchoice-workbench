import {describe,it,expect} from "vitest";
import {matchesSellerSpriteQueryEvidenceSubject as matches,currentSellerSpriteResearchWindows as windows} from "./sellerSpriteQueryEvidenceIdentity";
import {sellerSpriteKeywordMiningQuerySubjectKey} from "@/lib/server/sellerSpriteVisibleQuery";
import {buildSourceEvidenceAttachment} from "@/lib/sourceLayer/evidenceAttachment";
import {parseV3ModuleEvidence} from "@/lib/sourceLayer/v3ModuleEvidence";
const query={module:"keyword_mining_trend" as const,seedKeyword:"fixture seed",marketplace:"US" as const},subjectKey=sellerSpriteKeywordMiningQuerySubjectKey(query);
function attachment(id:string,generation=1,status="AVAILABLE_WITH_LIMITATION",rowScope="visible_dom_window_not_total"){
 const capturedAt=`2026-10-23T00:00:0${id}.000Z`;
 return buildSourceEvidenceAttachment({attachmentId:`fixture-${id}`,subjectKey,kind:"v3_keyword_mining_trend_v1",sourceType:"sellersprite_plugin",capturedAt,sourceUrl:"https://www.sellersprite.com/v3/keyword-miner/",payload:{schemaVersion:"capture-system-v3-module-evidence.v1",module:query.module,subjectKey,marketplace:"US",provider:"SellerSprite",sourceSurface:"synthetic contract fixture",sourceUrl:"https://www.sellersprite.com/v3/keyword-miner/",capturedAt,providerUpdatedAt:null,freshness:{cadenceKey:null},acquisitionMode:"DOM_DIRECT",metricNature:"provider_estimate",status,limitations:["fixture"],identity:{keyword:query.seedKeyword},data:{queryInput:query,queryIdentity:{subjectKey,module:query.module,marketplace:"US",queryFingerprint:"a".repeat(64),captureJobFingerprint:"b".repeat(64)},captureWindow:{captureGeneration:generation,snapshotFingerprint:"c".repeat(64),captureWindowKey:id.repeat(64)},rowScope},evidenceOnly:true}});
}
describe("saved SellerSprite query identity and generations",()=>{
 it("accepts the current visible-window contract while preserving the public query subject identity",()=>{const parsed=parseV3ModuleEvidence(attachment("1").payload)!;expect(matches(parsed)).toBe(true);expect(matches({...parsed,data:{...parsed.data,queryInput:{...query,seedKeyword:"foreign seed"}}})).toBe(false);expect(matches({...parsed,data:{...parsed.data,queryIdentity:{subjectKey:"foreign"}}})).toBe(false);});
 it("reads same-generation windows, excludes checkpoints and old runs, and never backfills a failed latest source",()=>{const one=attachment("1"),old=attachment("2",0),two=attachment("3"),checkpoint=attachment("4",1,"AVAILABLE_WITH_LIMITATION","traversal_checkpoint_only"),blocked=attachment("5",1,"BLOCKED_WITH_EVIDENCE");expect(windows(checkpoint,[one,old,two,checkpoint]).map(a=>a.attachmentId)).toEqual([one.attachmentId,two.attachmentId]);expect(windows(blocked,[one,two,blocked])).toEqual([blocked]);});
});
