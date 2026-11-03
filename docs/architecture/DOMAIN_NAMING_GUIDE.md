# Domain Naming Guide

> **生成时间**：2026-09-19
> **目标**：建立业务层与数据库层的命名分离，降低历史命名污染。
> **依据**：[`ARCHITECTURE_RULES.md`](./ARCHITECTURE_RULES.md) §4.2 + `lib/domain/`（历史材料，见 Git 历史）

---

## 1. 命名分层原则

轻选工作台 V5.1 采用**业务命名与数据库命名分离**策略：

```
┌────────────────────────────────────────────┐
│ 业务层 / UI / 新代码                        │
│ 使用：ProductCandidate / ProductResearchTask  │
└────────────────────────────────────────────┘
                    ↕（通过 @/lib/domain 类型别名映射）
┌────────────────────────────────────────────┐
│ Prisma 持久化层                              │
│ 使用：OpportunityCandidate / ViralAnalysisRecord│
└────────────────────────────────────────────┘
```

**核心规则**：

- ✅ 新业务代码、UI 组件、API 入参/返回值、文档一律使用 **`ProductCandidate` / `ProductResearchTask`**
- ✅ Prisma 模型层（`@prisma/client`）保留物理表名 `OpportunityCandidate` / `ViralAnalysisRecord`
- ✅ 数据库表名**本阶段不迁移**（避免 migration 风险）
- ❌ 新业务代码**禁止**直接 import `OpportunityXXX` / `ViralXXX`

---

## 2. 命名映射表

| 数据库表（物理） | Prisma 模型 | 业务命名 | 业务类型 | 别名映射入口 |
|---|---|---|---|---|
| `OpportunityCandidate` | `OpportunityCandidate` | `ProductCandidate` | `@/lib/domain/productCandidate` | `ProductCandidate = OpportunityCandidate` |
| `ViralAnalysisRecord` | `ViralAnalysisRecord` | `ProductResearchTask` | `@/lib/domain/productResearchTask` | `ProductResearchTask = ViralAnalysisRecord` |

### 2.1 状态枚举映射

| Prisma 字段（数据库） | 业务状态名（业务层） |
|---|---|
| `OpportunityCandidate.status` | `ProductCandidateStatus = "pending" \| "converted" \| "rejected" \| string` |
| `ViralAnalysisRecord.decisionStatus`（type="workflow"） | `ProductResearchDecisionStatus = "pending" \| "approved" \| "rejected" \| "needs_information" \| "continue" \| string` |

> 状态字符串值在数据库与业务层**保持一致**（因为字符串值本身是数据库 contract，无法低成本迁移）。但**类型引用**统一通过 `@/lib/domain`。

---

## 3. 模块入口

### 3.1 `@/lib/domain` 统一出口

```typescript
// ✅ 业务代码唯一推荐的入口
import type {
  ProductCandidate,
  ProductCandidateStatus,
  ProductResearchTask,
  ProductResearchDecisionStatus,
} from "@/lib/domain";
```

### 3.2 物理表访问（仅 Prisma 持久化层）

```typescript
// ✅ 允许：Prisma CRUD（Service 内部）
import { prisma } from "@/lib/server/prisma";
await prisma.opportunityCandidate.findMany(...);

// ❌ 禁止：在 UI / 业务逻辑 / 跨模块入参中使用裸 Prisma 模型
import { OpportunityCandidate } from "@prisma/client"; // ← 错误
```

### 3.3 内部别名定义（已就位）

`lib/domain/productCandidate.ts`：

```typescript
import type { OpportunityCandidate } from "@prisma/client";

export type ProductCandidate = OpportunityCandidate;
export type ProductCandidateStatus =
  | "pending" | "converted" | "rejected" | string;
```

`lib/domain/productResearchTask.ts`：

```typescript
import type { ViralAnalysisRecord } from "@prisma/client";

export type ProductResearchTask = ViralAnalysisRecord;
export type ProductResearchDecisionStatus =
  | "pending" | "approved" | "rejected" | "needs_information" | "continue" | string;
```

---

## 4. 旧命名兼容

### 4.1 历史兼容场景

以下场景**保留** Prisma 模型直接引用：

| 场景 | 位置 | 原因 |
|---|---|---|
| `prisma.opportunityCandidate.*` 实际 CRUD | `lib/server/opportunityCandidatePool.ts` 等 | 持久化层必须用物理名 |
| `prisma.viralAnalysisRecord.*` | `lib/server/researchLifecycle.ts`、`lib/server/viralAnalysisRecords.ts` 等 | 同上 |
| 数据库 migration 脚本 | `prisma/migrations/**` | schema 物理层 |
| Prisma schema | `prisma/schema.prisma` | 数据模型定义 |

### 4.2 现状（已完成的兼容工作）

- ✅ `lib/domain/` 已建立，包含 `ProductCandidate` / `ProductResearchTask` 类型别名
- ✅ `lib/domain/index.ts` 统一导出
- ✅ 数据库 schema **未触碰**（保持 `OpportunityCandidate` / `ViralAnalysisRecord` 表名）

---

## 5. 未来迁移路径（不在本阶段）

如未来要**完全统一**业务命名到数据库，需要：

1. **数据迁移**：新增 Prisma migration 把 `OpportunityCandidate` 重命名为 `ProductCandidate`，`ViralAnalysisRecord` 重命名为 `ProductResearchTask`（type="workflow" 数据保留）
2. **Schema 更新**：`prisma/schema.prisma` 物理模型改名
3. **代码统一**：移除 `lib/domain/` 类型别名层，所有引用统一用业务名
4. **测试覆盖**：补迁移回归测试

**本阶段明确不执行**（按用户红线："❌ 创建 migration"、"❌ 修改 SQLite 数据"）。

---

## 6. 反向风险

| 风险 | 说明 |
|---|---|
| 新代码误用旧命名 | 通过 PR review + lint 规则（业务代码不得 `@prisma/client` import 业务类型）预防 |
| 类型别名层导致类型推导变慢 | 仅 `type` 别名，运行时零成本（TypeScript 在编译期擦除） |
| 数据库命名与业务命名长期不一致 | 接受；这是架构阶段决策，未来 migration 才统一 |

---

## 7. 未来 PR 检查清单

新 PR 涉及候选/任务相关业务逻辑时：

- [ ] 是否 import 路径来自 `@/lib/domain` 而非 `@prisma/client`
- [ ] 是否在 UI/Service 中暴露了 Prisma 模型名（`OpportunityCandidate` / `ViralAnalysisRecord`）
- [ ] 是否在跨模块入参/返回值中混用两种命名
- [ ] 是否扩展了 lib/domain 未覆盖的新业务实体（如果是，按相同模式补充 `lib/domain/`）

---

*文档结束于 2026-09-19 · 配合 [ARCHITECTURE_RULES.md §4.2](./ARCHITECTURE_RULES.md) 使用*