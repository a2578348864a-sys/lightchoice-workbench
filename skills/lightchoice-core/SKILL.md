---
name: lightchoice-core
description: LightChoice Workbench V5 project architecture and operating rules. 用于在本仓库开展任何开发、审计、文档或协作前，固定产品定位、架构红线、执行规范、验收规则，以及如何读取最新项目状态。不复制动态进度；不替代业务 Skill。
---

# LightChoice Core（lightchoice-core.v1）

长期稳定规则层。只约束「项目是什么、边界在哪、怎么干活、怎么算完成」。  
**动态进度、阶段编号、运行身份、提交哈希、构建号、进程号、端口一律不写入本 Skill**，必须从仓库权威文件读取。

## 何时使用

- 新 Agent 进入本仓库，需要理解项目与禁区。
- 修改代码、文档、测试、运行配置前的规则校准。
- 多 Agent 协作时统一产品语义、事实边界与验收口径。
- 回答「项目是什么 / 什么不能改 / 怎么算完成」。

不用于：商品研究业务结论、市场预筛、单次任务日报、临时状态汇报。业务方法用 `skills/amazon-product-research`、`skills/sellersprite-market-preview` 等专用 Skill。

## 产品定位

LightChoice Workbench V5（轻选工作台）是**面向个人使用、单用户优先**的**跨境电商 AI 商品研究与产品开发决策辅助工作台**。

- **个人使用、单用户优先**：默认 Owner 本地单人决策场景；协作能力是可选辅助，不改写「个人工作台」产品主定位。
- **决策辅助，不是自动经营**：AI 提供研究与证据辅助，最终拍板始终是人。

核心业务语义：

```text
来源证据与候选输入 → Agent 分析 → 人工复核 → Task 与后续复盘
```

用户主链（产品开发流程）：

```text
01 市场采集 → 02 市场研究 → 03 商品深研 → 04 产品开发需求单
```

产品承诺边界：

- 提供证据、分析、风险与未知项，支持人工决策。
- **不是**无人值守自动选品、自动采购、自动上架或已验证商业成功工具。
- 缺少证据的真实销量、成本、物流、费用、利润、合规与经营结果保持未知，不由 AI 猜测补齐。

## 核心架构原则

冻结主链（不得改道、不得旁路）：

```text
External Source
  → Capture Gateway
  → EvidenceStore
  → ProductFact
  → Market Research
  → Product Research
  → Human Decision
  → Product Requirement
```

原则：

1. **EvidenceStore 是唯一事实来源**（唯一不可变原始证据权威）。
2. **ProductFact 是 Evidence 的投影**，不是第二事实库。
3. **Capture Gateway 是唯一正式来源写入边界**。
4. **Research 只消费已持久事实，不在 Research 路径重新采集**。
5. **Human Decision 是最终人工权威**；AI 不替代、不覆盖人工最终决策。
6. **缺失数据保持 unknown / missing / blocked**。采集**能力边界已冻结**（不无限扩模块/覆盖面），但**不是禁止一切采集**；研究确需的缺失数据按任务做**定向补证**。
7. Job / Scheduler / 任务状态是控制状态，不是事实存储。
8. 外部估算（如 SellerSprite 月销/月销额）保持 `estimated` / `provider-derived`，不得改标为 Amazon 直接观察或 confirmed 商业事实。

## 数据边界

| 允许 | 禁止 |
|---|---|
| 经 Capture Gateway 落 EvidenceStore | 绕过 Gateway 直写事实 |
| 从 ProductFact / Evidence 只读消费 | 建立第二事实库、第二证据库、第二 ResearchInputBundle |
| 人工门禁后保存 Confirmed Facts | AI 自动确认事实或自动写最终决策 |
| 缺证据记 null / missing / unknown | 编造供应链事实（报价、MOQ、交期、供应商） |
| 在授权下做定向补证 | 为覆盖率无限扩采集模块/依赖/付费源 |
| 隔离 fixture / disposable DB 做测试 | 手改真实 SQLite、`data/demo-*.json` 或正式 EvidenceStore |

权限与数据不变量以 `docs/development/AGENTS.md` 为准：服务端 Guard 校验、fail-closed、Owner/Visitor 边界、真实 AI/外部源/付费 Provider 需授权。

## 开发约束

1. **修改前**：读 `docs/development/AGENTS.md`；`git status --short` 确认 dirty 现场；不覆盖无关未提交文件。
2. **最小修改**：找根因、复用现有实现、可回滚；禁止顺手重构、全局格式化、擅自换架构/升依赖。
3. **稳定产品边界**：Route 名、页面名、易变 Phase 状态不写入长期规则文件；以当前任务契约、代码、测试为准。
4. **采集策略**：采集能力边界已冻结（不无限扩展覆盖面/新模块）；不是「全部采集冻结」。研究需要的缺失数据走定向补证，不新开无任务绑定的采集工程。
5. **受控操作需本次明确授权**（见 `docs/development/AGENTS.md`）：迁移/改 schema、依赖变更、真实 AI/付费/外抓、部署、Git 写操作等。
6. **本机运行**：使用带 SQLite 门禁的 `check:local` / `start:local` / `dev:local`，不用裸 `next dev` / `next start` 代替受控入口。
7. **多 Agent 协作**：Skill 只存长期规则；动态状态从**当前工作区**权威文件读；同一文件同一时间一个写入方；不互相覆盖 dirty 现场。
8. **多 worktree**：长期规则统一读 `skills/lightchoice-core/SKILL.md`；执行前先识别当前工作区/分支/HEAD/dirty；进度与冲突按「多工作区规则」处理，禁止用主仓库状态覆盖开发 worktree。

## 验收原则

完成声明前，按任务类型验证，并只报告**实际执行**的命令与结果：

| 变更类型 | 最低验证 |
|---|---|
| 纯文档 | Markdown / 相对路径 / 命令 / 事实一致性 |
| 局部逻辑 | 相关测试；涉及类型或共享契约时 typecheck |
| API / 权限 / 数据 | 目标 Route、Guard、失败路径与业务错误码 |
| UI / 流程 | 目标页面或 Route 测试；保存后刷新、错误态 |
| Schema / 存储 | 未经授权不迁移；用隔离 store 或明确测试库 |
| 跨模块 / 构建 | `npm run check` 或 lint + test + build |

硬性规则：

- 未执行不能说通过；失败不能绕过；不删测试骗通过。
- HTTP 200 / Build PASS / 单测 PASS **不能单独**代表用户流程完成。
- 涉及网页功能时，验证真实用户流程（打开、入口、操作闭环、保存恢复、错误态、必要时移动端）。
- 自动 PASS 不替代人工验收（若任务要求真人确认）。
- 局部切片 PASS 不得扩大为整模块 / 整阶段完成。

## 如何读取最新项目状态

**禁止把下列内容写死进 Skill 或长期规则**：阶段编号与完成度、提交哈希、构建号、进程号、端口、执行者、dirty 文件数、临时 HOLD/DEFERRED。

按需只读权威来源（后写覆盖先写；冲突时报告缺口，不静默改写历史）：

| 要了解什么 | 权威入口 |
|---|---|
| 仓库协作规则、权限、受控操作 | `docs/development/AGENTS.md` |
| 当前执行状态快照 | `docs/MASTER_EXECUTION_STATE.md`（多层历史并存，以最新节 + 代码/测试为准） |
| 当前架构边界 | `docs/architecture/current-v5-architecture.md` |
| 证据与事实权威 | `docs/architecture/evidence-chain.md`、`docs/architecture/ARCHITECTURE_RULES.md` |
| 采集与研究主计划 | `docs/plans/V5_CAPTURE_DEPTH_UPGRADE_MASTER_PLAN_V1_2026-10-08.md`（权威且锁定） |
| 最新主线/阶段对账 | `docs/reports/` 下最新日期报告、`docs/handoffs/` 当前接力文件 |
| 代码真实行为 | `prisma/schema.prisma`、相关 Route / Guard / 服务与测试 |

状态读取规则：

1. **历史冻结 ≠ 当前状态**。旧「FROZEN / COMPLETE」只证明其声明范围，不覆盖后续未关闭门禁。
2. **阶段编号（含 PH 编号）是锁定计划中的门禁标识，不是可忽略的「历史参考」**。当前完成/未完成/阻塞状态必须以权威文件最新记录为准；Agent 不得擅自改写编号语义、宣布关闭或升格完成。
3. 端口监听、附件存在、Stub 通过、单次截图，都不等于正式恢复、真实 Provider 成功或整阶段 PASS。
4. 当前结论与代码不一致时：报告缺口，不改业务语义去凑文档。
5. **动态进度 = 当前工作区代码 + 锁定计划 + 该工作区最新执行报告/验证证据**；四者不一致时如实分列，不挑对自己有利的单一来源。

## 多工作区（worktree）规则

本仓库常为多 Agent + 多 worktree 并行。**长期规则与动态事实必须分开，且动态事实属于「当前工作区」。**

### 1. 长期规则（跨工作区统一）

- 统一读取 `skills/lightchoice-core/SKILL.md`（唯一权威）。
- 工程细则读 `docs/development/AGENTS.md`。
- 某 worktree 未含 Skill 文件时：显式读主检出绝对路径中的同一文件；**禁止**在 worktree 复制第二套长期规则。

### 2. 执行前识别当前工作区

每次任务开始必须确认并汇报（只读）：

- 当前工作区路径（主检出 / 哪个 worktree）
- 当前分支与 HEAD
- `git status --short` dirty / untracked 概况

### 3. 动态进度归属

- 进度、阶段完成度、阻塞点、验收证据，**以当前工作区**内的代码、锁定计划、最新报告与验证证据为准。
- 主仓库（主检出）的报告、冻结记录、dirty 清单，**不能直接当作**当前开发 worktree 的进度或完成证明。
- 同样：worktree 的局部 PASS **不能**回写成主仓库/全项目完成。

### 4. 状态冲突时

- **明确报告**冲突双方路径、分支/HEAD、证据时间与差异点。
- **禁止**擅自同步、合并、覆盖、reset/clean 任一工作区来「消灭冲突」。
- 未获授权时只报告，不动手统一。

## 禁止行为（汇总）

- 建立第二事实库 / 第二采集网关 / 第二决策器。
- Research 重新采集；绕过 Capture Gateway。
- AI 替代人工最终决策；无证据给「值得卖」式结论。
- 编造供应链、成本、销量、利润等商业事实。
- 为完整度无限扩展采集能力或引入新付费源/新框架。
- 把测试 Provider、fixture、隔离库结果写成真实商业结论。
- 未授权 Git 写、迁移、依赖变更、部署、真实付费调用。
- 覆盖用户 dirty 修改、删除未提交实验文件、用 reset/clean 清现场。
- 把阶段编号、进程号、端口、提交哈希、构建号写入本 Skill 或当作长期事实。
- 用主仓库状态覆盖开发 worktree 实际进度，或在冲突时擅自同步/合并/覆盖工作区。

## 与项目文档的关系

```text
skills/lightchoice-core/SKILL.md     ← 长期稳定规则（本文件）
docs/development/AGENTS.md           ← 仓库工程协作与安全边界（优先于本文件的工程细则）
docs/MASTER_EXECUTION_STATE.md 等    ← 动态状态与历史报告（只读消费，不复制进 Skill）
skills/<业务 Skill>/SKILL.md         ← 具体业务方法（研究汇报、市场预筛等）
```

## 多 Agent 共享入口

**唯一权威正文**：`skills/lightchoice-core/SKILL.md`  
**仓库级协作入口与执行规则**：根目录 `AGENTS.md`；**共享工程细则**：`docs/development/AGENTS.md`。两者职责不同，均须按根规则读取和遵守。

**动态状态**：只读权威报告/接力文件，不复制进本 Skill。

发现桥接（短引用，不复制规则）：

| 路径 | 用途 |
|---|---|
| `.agents/skills/lightchoice-core/SKILL.md` | Agent Skills 兼容发现（Codex / ZCode / WorkBuddy / MiniMax 等凡扫描 `.agents/skills` 的客户端） |
| `.claude/skills/lightchoice-core/SKILL.md` | Claude Code 项目级发现 |

无法自动发现 Skill 时，**手动读取**上表路径或 `skills/lightchoice-core/SKILL.md` 即可；禁止为每个 Agent 复制一份完整规则。

跨工作区/多 worktree：长期规则统一读 `skills/lightchoice-core/SKILL.md`；动态事实必须落在**当前工作区**（详见「多工作区（worktree）规则」）。若 worktree 未包含本文件，显式读取主检出同一路径，不得再写第二套规则。

若权威文件缺失：停止并报告，不得自行重建规则。
