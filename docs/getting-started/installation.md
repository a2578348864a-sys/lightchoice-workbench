# 安装与首次启动

## 前置

- Node.js **≥ 20.9**（CI 使用 22）
- npm（随 Node 提供）
- 可选：Chrome / Chromium（真实采集时需要），Git

## 步骤

```bash
git clone https://github.com/a2578348864a-sys/lightchoice-workbench.git
cd lightchoice-workbench
npm ci
cp .env.example .env.local
```

编辑 `.env.local`：

- `DEEPSEEK_API_KEY` 填自己的 Key（不填时 AI 研究辅助会明确报"未授权/不可用"，主链其余部分仍可打开）；
- `DATABASE_URL` 默认 `file:./dev.db`，会落在 `prisma/dev.db`；
- 想试真实采集时再打开 `LOCAL_ACQUISITION_ENABLED=true` 并配置 Profile。

初始化数据库（正式迁移链）：

```bash
npx prisma migrate deploy
```

启动：

```bash
npm run dev:local        # 开发模式，127.0.0.1:3010
# 或
npm run build && npm run start:local
```

打开 <http://127.0.0.1:3010>。

## 健康检查

```bash
curl http://127.0.0.1:3010/api/health          # 就绪：DB + 证据目录
curl "http://127.0.0.1:3010/api/health?probe=liveness"
```

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `P1003` / 数据库不存在 | 未执行迁移 | `npx prisma migrate deploy` |
| 健康检查 503 `DATABASE_UNAVAILABLE` | 数据库文件损坏或路径错误 | 检查 `DATABASE_URL`，必要时从备份恢复 |
| 健康检查 503 `EVIDENCE_STORE_UNAVAILABLE` | 证据目录不存在 | 创建目录或修正 `SOURCE_LAYER_STORE_DIR` |
| AI 研究辅助不可用 | 未配置 `DEEPSEEK_API_KEY` | 在 `.env.local` 填写后重启 |
| 采集按钮不可用 | 采集默认关闭 | 设 `LOCAL_ACQUISITION_ENABLED=true` 并配置 Profile |

## 停止与清理

- 停止：`Ctrl+C`（或 `node scripts/dev/local-next-runtime.mjs stop --port 3010`）。
- 重置本地数据：停止后删除 `prisma/dev.db` 与 `data/source-layer-store/`，再重新迁移（**会丢数据**）。
