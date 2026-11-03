# `lib/sourceLayer/` — 商品来源层（Source Layer）

## 职责

商品来源层负责把多源商品数据（手动表单 / Amazon DOM 结构化载荷 / SellerSprite 插件 / SellerSprite XLSX / ProductBatch 批量）转换为标准化的 **CapturePackage**，并产出可被下游消费的 evidence-only 证据。

- 统一入口：`server/captureGateway.ts`（所有外部采集先进入 Gateway）
- 录入入口：手动表单、Amazon DOM 结构化载荷、SellerSprite 插件、SellerSprite XLSX、ProductBatch
- 数据归一化：`CapturePackage`（不可变 + SHA-256 sourceRef）
- 字段验证：`Validator`（基于 `CAPTURE_FIELD_KEYS` 全集）
- 证据持久化：`EvidenceStore`（按 subjectKey 隔离）
- 事实扩展：`fact/ProductFact`（由 Evidence 做结构映射，不替换旧 CapturePackage）
- 候选晋级：`handoffCapturesToResearch`（推进到 `/opportunity-candidates`）

## 不负责

- ❌ AI 大模型调用（来源数据必须原样进入系统）
- ❌ 直接生成研究任务（必须经 Evidence → Candidate 路径）
- ❌ 直接生成 Listing / Image（属 Creative / Studio 职责）
- ❌ 跨层反向调用（不读 Candidate / Research / Decision / Creative / Studio 内部状态）

## 核心文件

```
lib/sourceLayer/
├── capturePackage.ts         # CapturePackage 类型 + CAPTURE_FIELD_KEYS
├── stateMachine.ts           # 状态机（CAPTURE_LIFECYCLE_STATES）
├── validator.ts              # 字段级验证器
├── expiration.ts             # 过期判定
├── errorCodes.ts             # 错误码常量
├── auditLog.ts               # 审计日志
├── sourceAdapter.ts          # Adapter 抽象
├── adapters/                 # 多源适配器
│   ├── manualEntryAdapter.ts
│   ├── sellerSpriteAdapter.ts
│   ├── sellerSpritePluginAdapter.ts
│   ├── amazonDomAdapter.ts
│   └── sourceAdapters.test.ts
├── fact/                     # ProductFact 最小契约、适配器与 QualityGate 预留接口
│   ├── types.ts
│   ├── productFactAdapter.ts
│   └── qualityGate.ts
└── server/                   # 服务层编排
    ├── evidenceStore.ts      # 证据持久化
    ├── captureGateway.ts     # 外部采集统一入口
    ├── sourceLayerService.ts # 业务编排入口
    ├── productBatchBridge.ts # 与 ProductBatch 互操作
    └── creativeHandoffFacts.ts
```

## API 入口（`app/api/source-layer/`）

- `Capture Gateway` 是外部采集的统一服务入口；API 返回保留旧结构，并附加 ProductFact / QualityGate 结果
- `POST /api/source-layer/ingest` — Adapter 摄入
- `POST /api/source-layer/handoff` — Evidence → Candidate 晋级
- `POST /api/source-layer/from-product-batch` — ProductBatch → CapturePackage
- `GET /api/source-layer` — 列表
- `GET /api/source-layer/evidence/[subjectKey]` — 单个 subjectKey 的 evidence 详情

## 约束（来自 ARCHITECTURE_RULES.md §1.1）

✅ 允许：
- 新增来源适配器（`adapters/<source>.ts`）
- 新增 ProductFact 扩展字段与结构适配（必须来源于已落地 Evidence）
- 新增 Capture Gateway 来源映射（必须先写 Evidence，不得直写 Candidate）
- 新增字段（同步 `CAPTURE_FIELD_KEYS`）
- 新增验证规则
- 新增子状态（不修改既有）

❌ 禁止：
- AI 生成结论
- 直接创建研究任务
- 直接生成 Listing
- 绕过 Evidence
- 修改既有状态机函数

## V3 Phase 1 边界

- `CapturePackage` 是旧链路的兼容契约；`ProductFact` 是 Evidence 之后的扩展投影，不能替换或删除旧字段。
- `sellersprite_plugin` Confirm 只能调用 `captureGateway`，再由既有 handoff / Candidate Authority 完成候选写入；插件路由不直接写 `OpportunityCandidate`。
- `ProductFact` 只做结构映射。缺失字段保持 `value: null` + `status: "missing"`，不自动补价格、销量或商业结论。
- `QualityGate` 仅定义未来 TypeSafe / Jev 接口，Phase 1 默认关闭，不改变现有流程。

## 状态机铁律

`stateMachine.ts` 的 `CAPTURE_LIFECYCLE_STATES` / `CAPTURE_HAPPY_PATH` / `transition()` **不得修改**。新增状态须扩展而非替换。

---

*详细规则见 [`docs/architecture/ARCHITECTURE_RULES.md`](../../docs/architecture/ARCHITECTURE_RULES.md) §1.1*
