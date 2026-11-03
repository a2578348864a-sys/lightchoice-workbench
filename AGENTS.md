# 工程约定（AGENTS.md）

本文件面向所有协作者（含 AI 编码代理），只写长期有效的规则；流程细节见 `CONTRIBUTING.md`。

## 产品边界

- 主线：01 市场采集 → 02 市场研究 → 03 商品深研 → 04 产品开发需求单。
- Source Layer / Capture Gateway 是唯一正式采集入口；EvidenceStore 是唯一事实权威。
- Research 只消费已采集证据，不得另开采集通道或建立第二事实库。
- AI 只给建议；人工决策与需求单批准是服务端门禁，任何自动化不得代填。
- SellerSprite 等第三方估算不得升级为 Amazon 确认事实；缺失保持 unknown。

## 代码约定

- 业务裁决放 `lib/server/**`；`components/**` 只做展示与交互。
- 采集适配器放 `tools/collectors/**`；证据读写统一走 `lib/sourceLayer/server/evidenceStore.ts`。
- 写操作必须有幂等键与版本/哈希 CAS；错误码稳定、可前端识别。
- 不降低既有校验（状态、版本、哈希、引用白名单）；改动门禁必须同步测试。
- Prisma 迁移只增不改；正式初始化用 `prisma migrate deploy`，不要 `db push`。

## 数据与凭据

- 不提交 `.env.local`、数据库、证据文件、浏览器 Profile、真实商品/评论/供应商数据。
- 密钥只从环境变量读取；示例配置只放占位符。
- 测试使用独立临时数据库与合成数据，不得连接本地正式库。

## 提交前

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

真实采集、付费模型调用、生产切换都需单独授权，不属默认开发动作。
