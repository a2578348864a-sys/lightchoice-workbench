# scripts/ops

| 脚本 | 用途 |
|---|---|
| `capture-runtime-config.mjs` | 采集运行时配置（供应给 lib 的采集适配器） |
| `provider-preflight.mjs` | AI Provider 配置自检（`npm run check:provider-config`） |
| `db/protect-sqlite-db.mjs` | 数据库 + 证据库备份/校验/隔离恢复 |

这些脚本只做只读检查或显式的本地运维动作；不会自动发起采集或付费调用。
