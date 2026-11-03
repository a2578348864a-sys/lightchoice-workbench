# 本地开发

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev:local` | 开发模式启动（3010） |
| `npm run build` | 生产构建（webpack） |
| `npm run start:local` | 生产模式启动 |
| `npm run check:local` | 运行身份/端口/绑定检查 |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript |
| `npm test` | Vitest（默认回归） |
| `npm run db:migrate:deploy` | 应用迁移（不要用 db push） |
| `npm run db:summary` / `db:backup` | 数据库摘要 / 一致性备份 |

## 数据库

- schema：`prisma/schema.prisma`；迁移：`prisma/migrations/`（只增不改）。
- 新迁移：`npx prisma migrate dev --name <name>`（本地开发用；CI/发布用 deploy）。
- 测试必须使用独立临时数据库，**不要连本地正式库**。

## 目录约定

- 业务裁决写在 `lib/server/**`，组件只做展示与交互；
- 采集适配器写在 `tools/collectors/**`，不要在研究层另开抓取；
- 证据写入统一走 `lib/sourceLayer/server/evidenceStore.ts`。

## 测试

- 单元/合同测试与源码同目录：`*.test.ts`；
- 需要外部材料或真实凭据的测试默认排除，不要把它们加进 `npm test`；
- 浏览器验收脚本不随公开仓库分发，提交前用 `npm run build` + 手动检查关键入口。
