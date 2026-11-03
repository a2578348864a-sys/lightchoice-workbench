# Contributing

感谢你愿意参与。这个项目是本地单用户工作台，改动请优先保持"证据可追溯、决策由人做"的边界。

## 开始之前

1. 读 [AGENTS.md](AGENTS.md)（仓库工程约定）与 [docs/architecture/v6-architecture.md](docs/architecture/v6-architecture.md)。
2. 读 [SECURITY.md](SECURITY.md)：本项目不支持公网多租户部署。
3. 用 `npm ci` 安装；数据库用 `npx prisma migrate deploy` 初始化（不要用 `db push`）。

## 提交前检查

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

- 不提交 `.env.local`、数据库、证据文件、浏览器 Profile、本人或客户的真实数据；
- 不引入需要付费凭据的自动化测试；
- 新增/修改门禁时，必须同时更新对应测试，不允许为了通过而放宽断言。

## Pull Request

- 一个 PR 只做一件事，说明动机、影响面、验证方式；
- 涉及采集适配器、证据格式、研究合同、需求单版本时，请在 PR 描述里写明兼容性；
- 截图请使用合成数据，不要出现真实账号、真实评论或本机路径。
