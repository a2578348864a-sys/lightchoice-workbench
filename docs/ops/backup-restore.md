# 数据库与证据备份 / 恢复

工具：`scripts/ops/db/protect-sqlite-db.mjs`（SQLite `VACUUM INTO` + 证据镜像 + 校验 + 隔离恢复）。

## 一致性边界

| 对象 | 机制 | 一致性 |
|---|---|---|
| SQLite | `VACUUM INTO`（源库只读、无需停服） | 单次事务快照；随后做 `integrity_check`、关键表计数、sha256 |
| EvidenceStore | 增量镜像 + 清单（相对路径 / size / sha256） | 清单即恢复点；之后新增的文件不属于该恢复点 |

数据库快照与证据清单在同一次 `backup --evidence` 中生成，`restore-point.json` 把两者绑定。

## 生成恢复点

```bash
export DATABASE_URL="file:$PWD/prisma/dev.db"
export SOURCE_LAYER_STORE_DIR="$PWD/data/source-layer-store"
node scripts/ops/db/protect-sqlite-db.mjs backup --reason manual --evidence
```

产物在 `.local-backups/db-guard/<时间戳>/`；证据镜像在 `.local-backups/db-guard/evidence-store/`。

## 校验

```bash
node scripts/ops/db/protect-sqlite-db.mjs verify --backup .local-backups/db-guard/<时间戳>
```

校验：DB sha256/大小、`integrity_check`、关键表计数、证据清单逐文件哈希。

## 恢复（只允许隔离目录）

```bash
node scripts/ops/db/protect-sqlite-db.mjs restore \
  --backup .local-backups/db-guard/<时间戳> \
  --target ./restore-drill \
  --allow-root .
```

护栏：

- `--target` 必须在 `--allow-root` 之内，且不能落在正式数据根或仓库目录；
- 目标必须为空或不存在；`--force` 只清理本工具生成过的目标；
- 恢复前先完整 `verify`，失败即中止，绝不覆盖正式库；
- 恢复后核对 DB sha256、`integrity_check`、计数与证据哈希，结果写入 `restore-report.json`。

## 手动兜底

停服后直接复制 `prisma/dev.db` 与证据目录也可行，但需自行确认真实性。
**推荐始终使用上面的快照方式**，避免写入过程中的撕裂副本。
