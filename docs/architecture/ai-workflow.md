# AI 工作流

AI 在本项目里只做**研究辅助**，不做决策。

## 调用链

```
研究任务 → buildResearchInputBundle（证据 + 商品事实 + 缺口）
        → Provider（DeepSeek 兼容接口）
        → schema 校验（validateNarrativeDraft）
        → 引用绑定（bindNarrativesWithCitations）
        → 落库（报告 + 哈希 + 版本）
```

## 失败处理（fail-closed）

| 情况 | 行为 |
|---|---|
| HTTP/网络失败 | 标记 `status=failed` + errorCode，保留上一份有效报告 |
| `finish_reason=length` | 判为截断，不落半成品（可用 `AI_RESEARCH_MAX_TOKENS` 调整预算） |
| schema 不合法 | 整份作废，`PROVIDER_SCHEMA_VALIDATION_ERROR` |
| 引用不在白名单 | 整份作废，`PROVIDER_REF_NOT_ALLOWED` |

## 边界

- AI 输出不写人工决策字段，也不能把 `VALIDATE_MORE` 改成 `PROCEED`。
- AI 不得新增未采集的事实；缺口保持 unknown。
- 提示词与结构化输出合同在 `lib/server/v5ResearchService.ts` 与 `lib/server/aiClient.ts`。
