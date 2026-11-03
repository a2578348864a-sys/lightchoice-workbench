import "server-only";
import {gzipSync,gunzipSync} from "node:zlib";
import {createHash} from "node:crypto";
const SCHEMA="market-intelligence-json.gzip.v1",MAX_BYTES=4*1024*1024;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
/** Storage encoding only: same existing MarketScan JSON field and CAS authority. */
export function readMarketStateValue(value:unknown):unknown{
 if(!value||typeof value!=="object"||Array.isArray(value)||(value as Record<string,unknown>).schema!==SCHEMA)return value;
 const raw=value as Record<string,unknown>;
 if(typeof raw.data!=="string"||raw.data.length>65536||typeof raw.contentHash!=="string")throw new Error("MARKET_STATE_ENCODING_INVALID");
 try{const json=gunzipSync(Buffer.from(raw.data,"base64"),{maxOutputLength:MAX_BYTES}).toString("utf8");if(hash(json)!==raw.contentHash)throw new Error("hash mismatch");return JSON.parse(json);}catch{throw new Error("MARKET_STATE_ENCODING_INVALID");}
}
export function writeMarketStateValue(value:unknown):unknown{
 const decoded=readMarketStateValue(value);if(decoded===undefined)return undefined;
 const json=JSON.stringify(decoded);if(Buffer.byteLength(json)>MAX_BYTES)throw new Error("MARKET_STATE_ENCODING_TOO_LARGE");
 return {schema:SCHEMA,contentHash:hash(json),data:gzipSync(json).toString("base64")};
}
export function encodeMarketState(state:Record<string,unknown>){return {...state,...(state.reports!==undefined?{reports:writeMarketStateValue(state.reports)}:{}),...(state.translations!==undefined?{translations:writeMarketStateValue(state.translations)}:{})};}
