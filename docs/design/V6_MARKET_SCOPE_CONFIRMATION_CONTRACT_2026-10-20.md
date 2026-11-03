# 市场研究范围人工确认 · 最小业务合同方案（待批准）

> 状态：**设计 + 纯函数校验已就绪，持久化未实施**（需 Schema 迁移授权）。
> 关联：P2 `docs/reports/V6_MARKET_SCOPE_QUALITY_2026-10-19.md`
> 本轮代码：`lib/marketScan/scopeConfirmation.ts`（纯函数，无落库）

## 1. 为什么不能复用现有合同

| 候选 | 现有语义 | 能否承载「人工范围确认」 | 结论 |
|---|---|---|---|
| `V5MarketSampleLifecycle.archivedAt` | 样本是否参与市场统计（归档后从快照视图与代表商品候选中排除） | 不能。归档 = 让样本退出统计，范围确认 = 保留样本但标记「不符合本次研究目标」 | **不可复用** |
| `marketSampleAction`（archive/restore/delete） | 已有 `expectedVersion` CAS + 幂等回执 | 只能复用其**版本与幂等模式**，不能承载新状态 | 复用模式，不复用语义 |
| `V5OperationReceipt` | 幂等回执（requestBody 存档） | 不是业务状态表，写入会被下一次同 key 请求覆盖/复用 | **禁止滥用** |
| `OpportunityCandidate` / `Research Task` | 下游研究身份 | 早于代表商品选择，不能代表「整批样本范围」 | 不可复用 |
| 代表商品（representatives） | 只记录被选中的少数商品 + 角色/理由 | 只覆盖 1–50 件，且是「研究样本选择」，不是全量范围判定 | 语义不同，保持分离 |

**结论：缺少逐样本的人工范围确认字段，必须新增持久化合同。**

## 2. 最小 Schema 变更（建议，未执行）

在 `V5MarketSampleLifecycle` 上追加 5 个可空列（不新建表、不动已有列）：

```prisma
model V5MarketSampleLifecycle {
  id              String    @id @default(cuid())
  ownerScope      String
  scanId          String
  marketSampleKey String
  archivedAt      DateTime?
  // P3 新增（全部可空，历史行默认 NULL = 未人工核对）
  scopeStatus       String?   // "IN_SCOPE" | "OUT_OF_SCOPE" | null(=UNREVIEWED)
  scopeReason       String?   // 1..500
  scopeSampleHash   String?   // 确认时绑定的 MarketScan.sampleHash
  scopeConfirmedAt  DateTime?
  scopeConfirmedBy  String?   // "owner:v1"
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @default(now()) @updatedAt

  @@unique([ownerScope, marketSampleKey])
  @@index([ownerScope, scanId, archivedAt, updatedAt])
  @@index([ownerScope, scanId, scopeStatus])
}
```

对应迁移（新增目录 `prisma/migrations/<timestamp>_add_market_sample_scope_confirmation/`）：

```sql
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeStatus" TEXT;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeReason" TEXT;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeSampleHash" TEXT;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeConfirmedAt" DATETIME;
ALTER TABLE "V5MarketSampleLifecycle" ADD COLUMN "scopeConfirmedBy" TEXT;
CREATE INDEX "V5MarketSampleLifecycle_ownerScope_scanId_scopeStatus_idx"
  ON "V5MarketSampleLifecycle"("ownerScope", "scanId", "scopeStatus");
```

**兼容性**：全部可空；旧行读出即 `UNREVIEWED`；不触碰 `archivedAt` 语义；不改任何现有索引。

## 3. API 合同（建议）

```
POST /api/market-analysis/[scanId]/scope-confirmations
Headers: Idempotency-Key（必填）, Origin（同源）
Body: {
  expectedScanHash: string,
  items: [{
    marketSampleKey: string,   // `${scanId}:${ASIN}`
    asin: string,
    subjectKey: string,
    status: "IN_SCOPE" | "OUT_OF_SCOPE",
    reason: string,            // 1..500
    expectedVersion: string    // sampleResourceVersion(sampleHash, key, archivedAt)
  }]
}
→ 200 { items: [...], summary: {total,inScope,outOfScope,unreviewed,stale}, replayed }
→ 409 MARKET_SNAPSHOT_STALE | SAMPLE_VERSION_CONFLICT
→ 422 SAMPLE_NOT_IN_SCAN | SAMPLE_ASIN_MISMATCH | SAMPLE_SUBJECT_MISMATCH | SCOPE_REASON_REQUIRED | SCOPE_STATUS_INVALID
```

校验与幂等**全部复用** `lib/marketScan/scopeConfirmation.ts` 的 `validateScopeConfirmationBatch`（本轮已实现并测试），API 层只负责取数、事务与回执。

## 4. 版本与过期规则

1. **批次级**：`expectedScanHash !== scan.sampleHash` → 整体拒绝（409）。
2. **样本级**：`expectedVersion` 必须等于当前 `sampleResourceVersion`（与 archive 同一算法）→ 否则 409，不静默覆盖。
3. **快照变化**：已保存确认**保留历史**，读侧按 `scopeSampleHash !== 当前 sampleHash` 标记 `reviewStale=true`，要求重新核对；不自动删除、不自动改状态。
4. **重复提交**：同一 `status + reason + 版本` → `idempotent=true`，不新增事件。
5. **并发**：两个客户端同时保存不同结果时，后者因 `expectedVersion` 已变被拒绝（先到先得，需刷新）。

## 5. 与既有门禁的分离（硬约束）

| 对象 | 关系 |
|---|---|
| `validSampleCount` / `MIN_VALID_SAMPLE_COUNT` | **完全不变**；人工确认不参与门槛计算 |
| Market Gate（PROCEED / missingDataAcknowledged） | **不变**；范围内商品很少也不自动撤销已保存决定，只在 UI 提示 |
| 代表商品 | **不变**；人工确认只作为选择依据，不自动增删代表商品 |
| Research Handoff | **不变**；仍只使用人工已保存的代表商品与门禁结果 |
| P2 `sampleScope` | **并存**：系统投影（`basis/inScope=null/unknown`）与人工确认（`inScope=N`）分开展示，各自标注来源 |

## 6. 验收标准（批准后实施）

1. 收纳箱 30 件：保存 1 条 IN_SCOPE / 1 条 OUT_OF_SCOPE → 回读 30 行、统计 `1/1/28`、`stale=0`；Market Gate 与代表商品不变。
2. 硅胶垫：系统投影 33/1/0 与人工确认并存，互不覆盖。
3. 冲突：错 key / 跨 ASIN / 跨 subjectKey / 旧版本 / 缺理由 / 重复样本 → 全部 4xx，且**不产生部分写入**。
4. 快照更新后：旧确认保留且 `reviewStale=true`，重新保存需新 `expectedVersion`。
5. 幂等：重复提交相同内容 → `replayed=true`，无重复行。

## 7. 本轮已交付（无需批准即可用）

- `lib/marketScan/scopeConfirmation.ts`：投影 + 统计 + 批量校验（纯函数）。
- `lib/marketScan/scopeConfirmation.test.ts`：11 例，覆盖真实 30 件、硅胶/未知品类、跨 ASIN、CAS、幂等、过期。
- 未落库、未改 Schema、未改 UI、未改任何门禁。
