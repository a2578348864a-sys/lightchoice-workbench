# 安全模型

## 定位

本地单用户工作台（Local Owner）。默认绑定 `127.0.0.1`，**不支持公网多租户部署**。

## 认证与授权

| 层 | 实现 | 说明 |
|---|---|---|
| 身份 | `resolveAccessContext` → `LOCAL_OWNER_PRINCIPAL` | 本机即 Owner，不再签发访问密码 |
| 同源 | Host 信任 + mutating 请求 Origin/Referer 校验 | 跨站写返回 403 |
| 业务门禁 | 各服务内前置校验 | 状态、版本、哈希、幂等键 |

不提供：访客身份、多租户、配额、CSRF Token、对外 API Key。

## 写路径

- 统一使用幂等键；重复提交返回同一结果，不重复落库。
- 版本冲突用 `expectedRevision` / `expectedVersion` / 内容哈希做 CAS。
- 归档/恢复等单条操作前端二次确认，服务端校验对象与版本。

## 数据保护

- 密钥只从环境变量读取；仓库内只有 `.env.example` 占位符。
- 数据库、证据目录、浏览器 Profile 都在 `.gitignore` 中。
- 备份恢复只允许写入显式隔离目录，拒绝正式数据根与仓库目录。

## 已知限制

- 无 CSRF Token；同源校验依赖浏览器请求头。
- 采集适配器依赖第三方页面结构，改版会导致字段缺失（保持 unknown，不猜测）。
