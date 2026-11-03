# THIRD_PARTY_NOTICES

本仓库的**代码**以 MIT 发布（见 `LICENSE`）。以下第三方成果有各自的许可与使用边界。

## 字体

`public/fonts/` 内的字体文件按 SIL Open Font License 1.1 分发，许可证随目录保留：

| 目录 | 字体 | 许可 |
|---|---|---|
| `public/fonts/geist/` | Geist / Geist Mono（Vercel） | OFL-1.1（见 `OFL.txt`） |
| `public/fonts/noto-sans-sc/` | Noto Sans SC（Google） | OFL-1.1（见 `OFL.txt`） |

字体仅作为界面资源随应用加载，未修改字形。

## 运行时依赖

直接依赖的许可证（完整依赖树见 `package-lock.json`）：

| 包 | 许可 |
|---|---|
| next / react / react-dom | MIT |
| @prisma/client / prisma | Apache-2.0 |
| @tanstack/react-table | MIT |
| recharts | MIT |
| lucide-react | ISC |
| clsx | MIT |
| openai | Apache-2.0 |
| sharp | Apache-2.0 |

## 类目数据（`data/amazon-taxonomy/`）

- 本仓库**不附带任何 Amazon / SellerSprite 类目数据**，也未跟踪相关数据文件；
  `npm ci` / `npm run build` 会在本地生成空 schema（`roots: []`、空词表），仅用于保证应用可构建与启动。
- 如需类目市场功能，请使用你自己合法取得的类目树运行 `scripts/taxonomy/generate-amazon-us-category-tree.mjs`，
  生成结果只保存在本地，**不要提交到本仓库或任何公开仓库**。
- 项目不对任何第三方类目数据的获取、使用或再分发作出授权；相关合规责任由使用者自行承担。

## 未随仓库分发的内容

- 真实 Amazon 商品与评论原文、真实供应商报价、打样资料、采集原始文件、浏览器 Profile；
- 任何第三方示例图片、风格库素材或数据集；
- 任何真实 API Key、Cookie、会话凭据。

如你认为本仓库包含应移除的第三方内容，请通过 Issue 联系维护者。
