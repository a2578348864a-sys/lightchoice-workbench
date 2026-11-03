# 配置说明

配置只从环境变量读取；本地放在 `.env.local`（已被 `.gitignore` 排除）。模板见 `.env.example`。

## 必需 / 常用

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | SQLite 路径，相对 `prisma/` |
| `SOURCE_LAYER_STORE_DIR` | `./data/source-layer-store` | 证据库根目录 |
| `QX_RUNTIME_MODE` | `local_owner` | 运行模式；当前只有本机 Owner |
| `AI_PROVIDER` | `deepseek` | 研究辅助的模型提供方 |
| `DEEPSEEK_API_KEY` | — | 必填，AI 研究辅助需要 |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 官方地址 / `deepseek-chat` | 可替换为兼容端点 |
| `AI_TIMEOUT_MS` | `60000` | 单次调用超时 |
| `AI_RESEARCH_MAX_TOKENS` | `2000` | 研报输出预算；截断会 fail-closed |
| `PROOF_SIGNING_SECRET` | 本地默认 | 正式使用请设置随机值 |

## 采集相关（默认关闭）

| 变量 | 说明 |
|---|---|
| `LOCAL_ACQUISITION_ENABLED` | `true` 才允许真实采集；默认 `false` |
| `AMAZON_CAPTURE_PROFILE_DIR` | Amazon 采集浏览器 Profile（含登录态） |
| `AMAZON_CAPTURE_PROXY_URL` | 可选代理 |
| `SELLERSPRITE_CDP_ENDPOINT` | SellerSprite 走本机 CDP，默认 `http://127.0.0.1:9222` |

## 飞书（可选）

`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_BASE_APP_TOKEN` / `FEISHU_RESEARCH_TABLE_ID` / `FEISHU_MARKET_TABLE_ID`。
未配置时飞书相关菜单会禁用并说明原因，不影响 01→04 主链。

## 不要提交

`.env.local`、`prisma/*.db`、`data/source-layer-store/**`、Playwright Profile、任何真实 Key。
