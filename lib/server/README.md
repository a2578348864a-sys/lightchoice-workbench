# `lib/server/` — 服务层

## 职责

服务端业务编排、持久化、跨层桥接。`lib/server/` 是**所有服务端业务逻辑的承载层**（Prisma 客户端、AI 配额门禁、各领域服务）。

- 跨层数据桥接：把 Source Layer 的 evidence 投影给 Candidate / Research / Creative / Studio
- 业务规则实现：候选分析、研究生命周期、决策状态、创作交接门禁
- 持久化封装：Prisma 客户端单例、SQLite 路径保护
- 服务端门禁：access / quota / human-fact gate

## 不负责

- ❌ UI 渲染（属 `components/`）
- ❌ 业务类型命名入口（属 `lib/domain/`）
- ❌ API 路由（属 `app/api/`）
- ❌ 状态机（属于 `lib/sourceLayer/stateMachine.ts`）
- ❌ CapturePackage 构造（属于 `lib/sourceLayer/capturePackage.ts`）
- ❌ 业务规则之外的"通用工具"（属 `lib/` 同级其他子目录）

## 分区概览

```
lib/server/
├── accessPassword.ts / accessSession.ts / signedToken.ts  # 身份与签名
├── demoAccess.ts / demoGuard.ts / demoSandbox.ts           # Visitor 沙箱
├── realAiListingGate.ts / realAiImageGate.ts               # AI 服务端门禁
├── prisma.ts                                                # Prisma 客户端
├── candidate*.ts / opportunityCandidatePool.ts            # Candidate 层服务
├── research*.ts / researchLifecycle*.ts                    # Research 层服务
├── creativeHandoff*.ts / studioApiResponseReliability.ts  # Creative / Studio 服务
├── productBatch*.ts / sourceImport*.ts                    # Source Layer 互操作
├── sellerSprite*.ts / sourceProof.ts / sourceEvidenceAssessment.ts  # 上游解析 / 证明
└── vocAnalysis.ts / vocIntegration*.ts                     # 评论分析
```

## 边界（关键约束）

| 约束 | 说明 |
|---|---|
| **类型入口** | 业务代码统一从 `@/lib/domain` 进入；本层内部 Prisma CRUD 用物理表名 |
| **Source 读取** | 仅通过 `lib/sourceLayer/server/sourceLayerService` 暴露的接口；不直读 evidenceStore 内部 |
| **跨层禁止** | 不反向 import `components/**` / `app/**`（业务规则不依赖 UI） |
| **状态机边界** | 不修改 `researchLifecycle.ts` 既有状态机；Research 内部"自然累积"，不程序化推进 |
| **AI 调用** | 真实 AI 全部走 `realAiListingGate` / `realAiImageGate` 服务端门禁；Visitor 配额走 `demoAccess` |

## 与 lib/domain 的关系

`lib/server/` 是把 `@/lib/domain` 的业务类型映射到 Prisma 物理表的地方。Service 文件可以同时 import：
- `@/lib/domain`（业务类型）
- `@prisma/client`（物理模型，仅用于 prisma.<model>.xxx() 调用）

但**禁止**在 Service 函数签名（入参/返回值）中暴露 Prisma 模型名。

## 与 lib/sourceLayer 的关系

- 服务层可**消费** Source Layer 暴露的接口（`sourceLayerService.ts`）
- SellerSprite 插件 API 只能通过 Source Layer 的 `captureGateway.ts` 进入 Evidence；Gateway 完成 ProductFact 投影后，再调用既有 handoff / Candidate Authority。
- `sellerSpriteCandidateImport.ts` 仍保留既有候选写入兼容实现，但不再是插件路由的采集入口。
- 服务层**不能修改** Source Layer 内部模块
- 服务层**不能直连** `evidenceStore`（除非是 Source Layer 自身）

---

*详细规则见 [`docs/architecture/ARCHITECTURE_RULES.md`](../../docs/architecture/ARCHITECTURE_RULES.md) §1 + [`DOMAIN_NAMING_GUIDE.md`](../../docs/architecture/DOMAIN_NAMING_GUIDE.md)*
