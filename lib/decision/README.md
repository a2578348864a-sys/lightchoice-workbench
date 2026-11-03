# lib/decision — AI Decision Provider 层

> **定位**：可插拔 AI 决策分析层，为商品候选提供研究优先级建议。  
> **架构层级**：Candidate Layer 辅助分析（位于 Evidence Layer 之后、Research Layer 之前）。  
> **约束**：纯辅助建议，不自动改变候选状态，不替代人工决策，不修改证据。

---

## 核心原则

1. **AI 建议 ≠ AI 决策**：所有输出必须标注「AI 建议」，最终决策由运营人员人工判断。
2. **数据输入限于已有字段**：`ProductFacts` 只能从候选的 `sourceMetaJson` / `analysisJson` 中已有字段提取，不访问 EvidenceStore。
3. **三层严格分离**：
   - `Evidence`（证据层事实）
   - `DecisionSnapshot`（AI 分析层，本模块输出）
   - `Human Decision`（人工最终判断）
4. **全链路可拔插**：显式 Provider 不可用 → `failed / unavailable`，主流程零影响；生产环境不静默切换 Mock。
5. **业务层隔离**：业务层统一通过 `decisionEngine.ts` 调用，禁止直接 import 具体 provider。

---

## 目录结构

```
lib/decision/
├── types.ts                    # 核心类型：ProductFacts / ProductDecision / DecisionSnapshot / DecisionProvider
├── decisionEngine.ts           # 业务门面：analyzeProductDecision / analyzeResearchPriority / buildDecisionSnapshot
├── providers/
│   ├── mockProvider.ts         # Mock provider：仅开发/测试显式启用
│   ├── typesafeProvider.ts     # TypeSafe AI (Jev) adapter
│   └── index.ts                # Provider 注册表（根据 DECISION_PROVIDER 环境变量选择）
├── schemas/
│   └── productDecision.ts      # 运行时结构校验 + pending/failed 构建函数
└── README.md                   # 本文件
```

---

## 环境变量

| 变量名 | 描述 | 默认值 |
|---|---|---|
| `DECISION_PROVIDER` | 使用的 provider（非生产显式 `mock` / `typesafe`） | `unavailable` |
| `TYPESAFE_API_KEY` | TypeSafe AI API Key（server-only，不进客户端） | 无（缺失时 `unavailable`） |
| `TYPESAFE_BASE_URL` | TypeSafe API base URL | `https://api.typesafe.ai/v1` |
| `TYPESAFE_MODEL` | 使用的模型标识 | `jev-latest` |

---

## 调用方式

```typescript
// ✅ 正确：通过 decisionEngine 调用
import { analyzeResearchPriority, buildDecisionSnapshot } from "@/lib/decision/decisionEngine";

// ❌ 错误：直接 import provider
import { TypeSafeDecisionProvider } from "@/lib/decision/providers/typesafeProvider";
```

---

## 数据流

```
候选 analysisJson (SellerSprite 字段)
         ↓
    ProductFacts (提取输入)
         ↓
  decisionEngine.analyzeResearchPriority()
         ↓
     ProductDecision (AI 建议)
         ↓
  buildDecisionSnapshot() → 保存到 analysisJson[decisionSnapshot]
         ↓
  ResearchPriorityCard (前端只读展示)
```

---

## 架构约束

- ❌ 禁止 import `lib/sourceLayer/server/**`（不直接访问 EvidenceStore）
- ❌ 禁止修改候选 status / convertedTaskId（只能读和追加 analysisJson）
- ❌ 禁止自动推进研究流程
- ✅ 允许追加写入候选的 `analysisJson.decisionSnapshot`（不覆盖证据）

---

*Created 2026-09-19 · Architecture Layer: Candidate (analysis assist)*
