import "server-only";
import {record} from "@/lib/marketScan/intelligence";
import {parseSellerSpriteQuerySubjectKey} from "@/lib/sourceLayer/queryEvidenceSubject";
import {parseV3ModuleEvidence,type V3ModuleEvidence} from "@/lib/sourceLayer/v3ModuleEvidence";
import type {SourceEvidenceAttachment} from "@/lib/sourceLayer/evidenceAttachment";
import {validateSellerSpriteQueryInput,sellerSpriteProductMarketQuerySubjectKey,sellerSpriteKeywordMiningQuerySubjectKey} from "@/lib/server/sellerSpriteVisibleQuery";
/** Subject fingerprint identifies the query; account-scoped source/job hashes identify observations. */
export function matchesSellerSpriteQueryEvidenceSubject(parsed:V3ModuleEvidence):boolean{
 const subject=parseSellerSpriteQuerySubjectKey(parsed.subjectKey);if(!subject)return true;
 if(subject.module!==parsed.module||subject.marketplace!==parsed.marketplace)return false;
 const contract=record(parsed.data.queryContract);
 if(contract.queryFingerprint===subject.queryFingerprint)return true; // prior immutable export contract
 try{
  const input=validateSellerSpriteQueryInput(parsed.data.queryInput??contract.queryInput,parsed.module);
  const expected=input.module==="keyword_mining_trend"?sellerSpriteKeywordMiningQuerySubjectKey(input):input.module==="sellersprite_product_market"?sellerSpriteProductMarketQuerySubjectKey(input):null;
  if(expected!==parsed.subjectKey||input.marketplace!==parsed.marketplace)return false;
  if(input.module==="keyword_mining_trend"&&parsed.identity.keyword?.normalize("NFC").trim().toLocaleLowerCase()!==input.seedKeyword.normalize("NFC").trim().toLocaleLowerCase())return false;
  if(input.module==="sellersprite_product_market"&&parsed.identity.category?.normalize("NFC").trim().toLocaleLowerCase()!==input.category.normalize("NFC").trim().toLocaleLowerCase())return false;
  const identity=record(parsed.data.queryIdentity),hash=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}$/u.test(v);
  if(Object.keys(identity).length)return identity.subjectKey===parsed.subjectKey&&identity.module===parsed.module&&identity.marketplace===parsed.marketplace&&hash(identity.queryFingerprint)&&hash(identity.captureJobFingerprint);
  return contract.module===parsed.module&&contract.marketplace===parsed.marketplace&&hash(contract.queryFingerprint);
 }catch{return false;}
}

/** Read all saved windows from one authoritative generation; never backfill a failed latest run. */
export function currentSellerSpriteResearchWindows(latest:SourceEvidenceAttachment,attachments:readonly SourceEvidenceAttachment[]):SourceEvidenceAttachment[]{
 const parsed=parseV3ModuleEvidence(latest.payload);if(!parsed||!["reverse_asin","keyword_mining_trend"].includes(parsed.module)||!["VALIDATED_AVAILABLE","AVAILABLE_WITH_LIMITATION"].includes(parsed.status))return [latest];
 const win=record(parsed.data.captureWindow),identity=record(parsed.data.queryIdentity);
 if(typeof win.snapshotFingerprint!=="string"||!Number.isSafeInteger(win.captureGeneration)||typeof identity.captureJobFingerprint!=="string")return [latest];
 const windows=new Map<string,SourceEvidenceAttachment>();
 for(const attachment of [...attachments].sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt)||a.attachmentId.localeCompare(b.attachmentId))){
  const p=parseV3ModuleEvidence(attachment.payload);if(!p||p.module!==parsed.module||p.subjectKey!==parsed.subjectKey||p.marketplace!==parsed.marketplace||p.provider!==parsed.provider||!["VALIDATED_AVAILABLE","AVAILABLE_WITH_LIMITATION"].includes(p.status)||p.data.rowScope==="traversal_checkpoint_only")continue;
  const w=record(p.data.captureWindow),i=record(p.data.queryIdentity);
  if(w.snapshotFingerprint===win.snapshotFingerprint&&w.captureGeneration===win.captureGeneration&&i.captureJobFingerprint===identity.captureJobFingerprint&&i.queryFingerprint===identity.queryFingerprint&&typeof w.captureWindowKey==="string")windows.set(w.captureWindowKey,attachment);
 }
 return windows.size?[...windows.values()]:[latest];
}
