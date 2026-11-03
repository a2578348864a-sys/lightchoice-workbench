/**
 * Product Source Layer V1.2 — Adapter 注册入口
 *
 * 新来源接入方式（唯一扩展点）：
 * 1. 新建 lib/sourceLayer/adapters/<source>Adapter.ts；
 * 2. 用 createSourceAdapter() 只实现 capture()；
 * 3. 在此文件 import 一次完成注册。
 * 不需要、也不允许改动 Evidence / Validator / 状态机 / Research 核心。
 */
import "@/lib/sourceLayer/adapters/sellerSpriteAdapter";
import "@/lib/sourceLayer/adapters/manualEntryAdapter";
import "@/lib/sourceLayer/adapters/amazonDomAdapter";
import "@/lib/sourceLayer/adapters/sellerSpritePluginAdapter";

export { sellerSpriteAdapter, captureSellerSpriteXlsx } from "@/lib/sourceLayer/adapters/sellerSpriteAdapter";
export { manualEntryAdapter, captureManualEntry } from "@/lib/sourceLayer/adapters/manualEntryAdapter";
export { amazonDomAdapter, captureAmazonDom } from "@/lib/sourceLayer/adapters/amazonDomAdapter";
export { sellerSpritePluginAdapter, captureSellerSpritePlugin } from "@/lib/sourceLayer/adapters/sellerSpritePluginAdapter";
