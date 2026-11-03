import type { PrismaClient } from "@prisma/client";
import { createOwnerProductBatchStore } from "@/lib/server/ownerProductBatchStore";
import { createProductBatchRepository } from "@/lib/server/productBatchRepository";
import { importSellerSpriteProductBatch } from "@/lib/server/productBatchImportService";
import { SELLERSPRITE_SANITIZED_ROWS } from "@/lib/upstream/sellersprite/fixtures/search-export.sanitized.v1";
import { createSellerSpritePreviewTestWorkbook } from "@/tools/upstream/sellersprite-preview/test-fixtures";

/** Synthetic XLSX bytes go through the actual parser/import/store; no ready-row upserts. */
export async function seedAcceptanceImports(client: PrismaClient, options: { includeFixtureImage?: boolean } = {}) {
  const store = createOwnerProductBatchStore(createProductBatchRepository(client));
  const nonce = crypto.randomUUID();
  async function imported(count: number, query: string, cleanup = false) {
    const rows = Array.from({ length: count }, (_, index) => {
      const asin = index === 30 ? "B0DRAFT001" : "B0SRC" + String(index + 1).padStart(5, "0");
      return { ...SELLERSPRITE_SANITIZED_ROWS[0], ASIN: asin, "父ASIN": "",
        "商品标题": cleanup ? `离线生命周期夹具 ${nonce}` : `离线竹木厨房样本 ${index + 1}`,
        "#": String(index + 1), SKU: "OFFLINE-" + String(index + 1), "搜索排名": `自然位：第1页第${index + 1}位`, "大类目": "Home & Kitchen",
        "商品详情页链接": "https://www.amazon.com/dp/" + asin,
        ...(options.includeFixtureImage ? { "商品主图": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } : {}) };
    });
    return importSellerSpriteProductBatch({ store, bytes: new Uint8Array(createSellerSpritePreviewTestWorkbook({ rows })),
      sourceFileName: "offline-acceptance.xlsx", reportType: "search_results", query, category: "Home & Kitchen",
      priceMin: 10, priceMax: 80, now: new Date("2026-10-01T02:00:00.000Z"),
      // Offline image failure is an explicit limitation, never an external acquisition.
      fetchMainImage: async () => { throw new Error("OFFLINE_ACCEPTANCE_IMAGE_UNAVAILABLE"); } });
  }
  const importedMain = await imported(31, "offline kitchen " + nonce);
  const batchId = importedMain.batch.id;
  const items = await client.productBatchItem.findMany({ where: { batchId }, orderBy: { ordinal: "asc" } });
  if (importedMain.batch.batchStatus !== "ready" || items.length !== 31) throw new Error("ACCEPTANCE_IMPORT_NOT_READY");
  const cleanupBatches = [];
  for (const index of [1, 2, 3]) {
    const result = await imported(1, `待清理批次 ${index}`, true);
    cleanupBatches.push({ batchId: result.batch.id, query: result.batch.query });
  }
  await store.activateBatch(batchId);
  return { batchId, itemIds: items.map((item) => item.id), draftItemId: items[30].id, cleanupBatches,
    importSource: "REAL_SELLERSPRITE_IMPORT_SERVICE", synthetic: true, externalAcquisition: 0, fixtureImage: options.includeFixtureImage === true };
}
