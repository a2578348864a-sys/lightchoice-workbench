# 类目字典（默认空数据）

## 公开版本不附带任何类目数据

本目录中的两份 JSON 只是**空 schema**，用于保证应用在没有类目数据时也能构建与启动：

| 文件 | 内容 |
|---|---|
| `amazon-us-taxonomy.v1.json` | `taxonomyStatus: "NOT_IMPORTED"`、`roots: []`、统计全零 |
| `zh-presentation.v1.json` | 空 `nameIndex` / `terms` |

仓库**不包含**任何 Amazon storefront 节点、SellerSprite 补充节点或按节点整理的中文词表。
未导入时，01 采集页的「类目市场采集」会显示空状态与导入指引，不会渲染空树或崩溃。

## 用你自己的数据生成

前提：你已通过合法方式取得 Amazon 类目树（Seller Central / SP-API 导出或你自己的采集结果）。

```bash
# 1) 把你的原始类目树放到（文件不随仓库分发）：
#    data/amazon-taxonomy/amazon-us-browse-tree.raw.v1.json
#    结构：{ "roots": [{ "amazonNodeId": "...", "en": "...", "children": [...] }] }

# 2) 生成运行时数据（可选提供 zh-phrase-overrides / zh-terms 词表）
node scripts/taxonomy/generate-amazon-us-category-tree.mjs

# 3) 重启开发服务（或重新构建）让页面读取新数据
npm run dev:local
```

生成脚本会覆盖本目录的两份 JSON，并额外产出本地统计与报告文件。

## 注意

- **不要把生成结果提交到本仓库或任何公开仓库**；这些数据属于你的来源方，公开再分发需要你自己确认授权。
- 未提供原始类目树时，脚本会直接退出并提示，不会写入半成品。
- 类目数据缺失不影响按商品 ASIN 进行采集与研究；只影响「按类目选市场」的入口。
