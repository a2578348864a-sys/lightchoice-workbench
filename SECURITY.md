# Security Policy

## 报告安全问题

请不要在公开 Issue 中披露可利用细节。使用 GitHub 的 Private Vulnerability Reporting（仓库 **Security** 页），
或在 Issue 中只描述影响面、留出私下沟通方式。

## 部署定位（先读这一条）

本产品是**本地单用户工作台（Local Owner）**：

- 服务默认只绑定 `127.0.0.1`，面向本机浏览器；
- **不要直接暴露到公网**；当前没有多租户、访客隔离、配额或公网身份体系；
- 如需多人使用，必须自行增加反向代理、TLS、身份认证与网络隔离，并自行承担安全评估。

## 身份与写入门禁

- 所有写操作经服务端统一入口校验：Owner 身份 + 同源（Host/Origin）检查；跨站写请求返回 403。
- 前端隐藏按钮不构成鉴权；门禁在 route/service 层执行。
- 关键写路径带幂等键与版本/CAS 校验，重复提交不会重复落库。

## 数据与凭据

| 项 | 位置 | 建议 |
|---|---|---|
| 数据库 | `DATABASE_URL`（默认 `prisma/dev.db`） | 仅本机可读；定期备份 |
| 证据库 | `SOURCE_LAYER_STORE_DIR`（默认 `data/source-layer-store`） | append-only；只读挂载给分析脚本 |
| API Key | `.env.local` | 不提交、不截图、不写进 issue |
| 采集浏览器 Profile | 本机目录 | 含登录态，按凭据对待 |

`.gitignore` 已排除 `.env*`、`*.db`、`.local-backups/`、Playwright Profile 等运行数据。

## AI 与外部内容边界

- AI 输出视为**不可信输入**：必须通过 schema 与引用白名单校验，失败时整份作废并保留上一份有效报告。
- 页面/评论/XLSX 中的文本按数据处理，不当作指令（防 Prompt Injection）。
- AI 不能写人工决策字段；决策必须来自人工操作。

## 已知边界

- 当前没有 CSRF Token；同源校验依赖浏览器发送的 Origin/Referer，非浏览器客户端可绕过该层（但仍是本机 Owner 模式）。
- 采集适配器依赖第三方页面结构，来源改版可能造成采集中断或字段缺失；缺失一律保持 unknown。
