# 工作流指南

## 01 市场采集（`/source`）

1. 选择来源（Amazon 详情/搜索、SellerSprite 市场、1688 供应线索）。
2. 采集结果进入 EvidenceStore；页面上的"缺失字段"是真实缺失，不是加载失败。
3. 采集需要本机浏览器 Profile；`LOCAL_ACQUISITION_ENABLED=false` 时不会发起真实采集。

## 02 市场研究（`/market-analysis`）

1. 查看样本数与充分性；样本不足会明确标注 `INSUFFICIENT_SAMPLE`。
2. 对缺口逐项知悉（缺什么、影响什么）。
3. 选择 1–3 个代表商品。
4. 做 Market Gate 判断：只有 `PROCEED` 才能把代表商品交给 03。

## 03 商品深研（`/research`）

1. 查看证据投影出的商品事实与缺口。
2. 触发 AI 研究辅助：摘要、机会、风险、改良假设；引用必须来自允许集合。
3. 人工裁决：`PROCEED` / `VALIDATE_MORE` / `PAUSE` / `DROP`，并填写理由。
4. 决策后研究进入锁定状态；证据或报告变化会使下游需求单变为 stale。

## 04 产品开发需求单（`/product-brief`）

1. 仅 `PROCEED` 且未 stale 的研究可生成需求单。
2. 编辑规格、对照、验证计划；每次保存带 revision CAS。
3. 批准需要目标售价、目标毛利率与可计算的采购成本上限；缺 FBA 等成本项时保持"待评审"。
4. 历史版本可只读回看，不会覆盖既有版本。

## 常见失败与含义

| 错误码 | 含义 | 下一步 |
|---|---|---|
| `MARKET_GATE_REQUIRED` | 02 未判 PROCEED | 回 02 完成市场判断 |
| `RESEARCH_EVIDENCE_STALE` | 证据/报告/决策绑定已变化 | 重新确认研究 |
| `PRODUCT_BRIEF_STALE` | 研究或市场绑定变化 | 重新生成需求单 |
| `PRODUCT_BRIEF_REVISION_STALE` | 页面版本落后 | 刷新后重试 |
| `PRODUCT_BRIEF_NOT_READY` | 经济学不可计算 | 补齐目标价/毛利/成本项 |
