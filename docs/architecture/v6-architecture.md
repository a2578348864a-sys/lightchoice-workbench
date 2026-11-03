# 架构（V6）

## 一句话

浏览器 → Next.js（App Router）→ 领域服务（lib）→ SQLite + EvidenceStore。

## 分层

```
app/                 页面与 API 路由（route handler）
components/          展示与交互（不含业务裁决）
lib/sourceLayer/     采集入口、证据读写、主体身份
lib/server/          领域服务：市场、研究、需求单、权限、健康检查
lib/v4, lib/listing  历史能力（不属当前主链）
prisma/              schema 与迁移（18 个迁移，只增不改）
tools/collectors/    采集适配器（Amazon / SellerSprite / 1688）
scripts/             本地运行、运维、类目生成
```

## 数据流

1. **采集**：`tools/collectors/*` 抓取页面 → `lib/sourceLayer` 规范化 → EvidenceStore 落盘（带内容哈希）。
2. **02 市场研究**：读样本快照与证据 → 计算样本充分性/缺口 → 人工 Market Gate（`PROCEED` 才可进入 03）。
3. **03 商品深研**：把商品事实 + 证据投影成研究输入 → AI 产出研报草稿 → schema 与引用白名单校验 → 落库。
4. **人工决策**：`POST /api/research/{id}/choice`，带 expectedRevision/ReportHash/FactHash/EvidenceHash 与幂等键。
5. **04 需求单**：仅在研究为 `PROCEED` 且未 stale 时生成；保存用 revision CAS；批准需经济学可计算。

## 身份与写入门禁

- 本地单用户 Owner：`lib/server/accessPassword.ts` 校验 Host + 同源（mutating 请求）。
- 路由统一走 `writeAuth` / `requireOwnerOnly`；服务层再校验业务前置条件（状态、版本、哈希）。
- 错误码稳定（如 `MARKET_GATE_REQUIRED`、`PRODUCT_BRIEF_STALE`），前端按码展示。

## 证据与事实

- EvidenceStore 目录结构：`owner-v1/subjects/<subjectKey>/…`，追加写，文件名由哈希派生。
- ProductFact 由证据投影而来，缺失字段保持 unknown；第三方估算带 `metricNature=estimate`，不升级为确认事实。
- 研报引用必须落在 `allowedEvidenceRefsOf(bundle)` 内，越界即整份失败。

## 健康与运维

- `GET /api/health`：`SELECT count(*) FROM sqlite_master` + 证据根可读；失败 503 + 稳定错误码。
- `GET /api/health?probe=liveness`：仅进程存活。
- 备份：`scripts/ops/db/protect-sqlite-db.mjs`（VACUUM INTO + 证据镜像 + verify/restore）。
