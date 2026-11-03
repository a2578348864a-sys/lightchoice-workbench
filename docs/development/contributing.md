# 贡献指南（开发向）

## 原则

1. **不降低门禁**：状态、版本、哈希、引用白名单的校验只能加强或等价替换。
2. **证据优先**：新增结论字段必须能追溯到证据；缺数据就保持 unknown。
3. **人工决策不可代填**：AI/脚本不得写 `myChoice` 或批准状态。
4. **迁移只增不改**：已应用的 Prisma 迁移不重写；用新迁移表达变更。

## 改动流程

```bash
git switch -c feat/<short-name>
npm ci
# 修改 + 测试
npm run lint && npm run typecheck && npm test && npm run build
```

PR 描述包含：动机、影响面（页面/API/数据）、验证方式、是否有兼容性变化。

## 不要提交

- `.env.local`、任何真实 Key、Cookie、浏览器 Profile；
- `prisma/*.db`、`data/source-layer-store/**`；
- 真实商品/评论/供应商数据；示例一律合成并标注。
