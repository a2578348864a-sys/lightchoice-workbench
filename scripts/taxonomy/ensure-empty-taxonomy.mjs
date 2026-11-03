#!/usr/bin/env node
/**
 * 生成"空类目字典"本地占位文件。
 *
 * 公开仓库不附带任何 Amazon / SellerSprite 类目数据；但运行时模块需要两份 JSON 才能构建。
 * 本脚本只在文件缺失时写入空 schema，绝不覆盖使用者已导入的数据。
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(process.cwd(), "data", "amazon-taxonomy");
const TAXONOMY = resolve(DIR, "amazon-us-taxonomy.v1.json");
const ZH = resolve(DIR, "zh-presentation.v1.json");

const emptyTaxonomy = {
  schemaVersion: "amazon-us-taxonomy.v1",
  marketplace: "US",
  generatedAt: null,
  generator: "scripts/taxonomy/generate-amazon-us-category-tree.mjs",
  taxonomyStatus: "NOT_IMPORTED",
  amazonUsTaxonomy: "NOT_IMPORTED",
  officialDiff: {
    status: "NOT_IMPORTED",
    officialNodeCount: null,
    missingCount: null,
    extraOrSuspiciousCount: null,
    idNameConflictCount: null,
    requiredToComplete: [],
    attempts: [],
  },
  source: { kind: "not_imported", harvestedAt: null },
  stats: {
    rootCount: 0,
    totalNodeCount: 0,
    maxDepth: 0,
    zhCoverageRate: 0,
    translatedZhCount: 0,
    pendingZhCount: 0,
    missingZhCount: 0,
    missingEnCount: 0,
    rootsChildStatus: [],
    rootsWithoutChildren: [],
  },
  roots: [],
};

const emptyZh = {
  schemaVersion: "amazon-zh-presentation.v1",
  generatedAt: null,
  nameIndex: {},
  terms: {},
  notes: "not_imported",
};

let created = 0;
if (!existsSync(TAXONOMY)) {
  writeFileSync(TAXONOMY, JSON.stringify(emptyTaxonomy, null, 2) + "\n", "utf8");
  created += 1;
}
if (!existsSync(ZH)) {
  writeFileSync(ZH, JSON.stringify(emptyZh, null, 2) + "\n", "utf8");
  created += 1;
}
if (created > 0) {
  console.log(`[taxonomy] 已生成 ${created} 个空类目占位文件（未导入任何第三方数据）。`);
}
