# Amazon 商品详情字段规则表（最终目标合同）

> `DESIGN_STATUS=FINAL` · `TARGET_MODULE=AMAZON_PRODUCT_DETAIL_DEPTH` · `SOURCE=Amazon US detail page` · `IMPLEMENTATION_STARTED=YES` · `DATABASE_SCHEMA_CHANGE=0`
>
> 本表是三份文档中字段目标、优先级、性质和边界的唯一规范。审计时事实见审计报告（历史材料，见 Git 历史），实施次序见实施计划（历史材料，见 Git 历史）。本表定义目标合同，不表示当前代码已实现所有字段；当前 D1–D3 已通过、D4 live validation 部分完成，详见实施阶段报告（历史材料，见 Git 历史）。

## 1. 共用实体链与硬边界

```text
Amazon Product Detail -> ProductFact
Amazon Reviews -> ReviewEvidence
Keywords -> KeywordEvidence
Trends -> TrendObservation
ProductFact + ReviewEvidence + KeywordEvidence + TrendObservation
    -> ResearchInputBundle -> Research
```

ReviewEvidence 是独立采集/导入实体，经 Source Evidence Attachment 关联商品；不得放进 ProductFact，也不得以 `ProductFactVoc` 替代。Review/VOC 模块为 `SEPARATE_CAPTURE_MODULE` 且 `OUT_OF_CURRENT_PRODUCT_DETAIL_IMPLEMENTATION_SCOPE`。本轮仅定义以后与 ResearchInputBundle、合法引用的连接边界；任何 Research 引用扩展均不得放松 JEV-002。

不得跨 ASIN 污染；目标页实体绑定失败即 fail-closed。非美国出口门禁保持 fail-closed。缺字段不猜测，不以 AI 填值。直接页事实必须留存来源及可追溯证据。未在主商品页面明确呈现的包装属性保持缺失。

## 2. 字段性质

| 性质 | 含义与处理 |
|---|---|
| `DIRECT_FACT` | 页面在已绑定目标 ASIN 的主商品区域明确呈现的事实。缺失即缺失，不推断。 |
| `DERIVED_FACT` | 仅由一个或多个已确认事实按确定性、有版本的规则推导；必须保存源字段、规则标识/版本。 |
| `ESTIMATED_METRIC` | 平台以近似、区间或约数呈现的估计。保留原文与区间语义，标注 `metricNature=estimate`，禁止伪装精确值。 |
| `CONDITIONAL_FACT` | 仅在促销、变体等特定状态出现的直接事实。未显示表示缺失/不适用，不判作抽取失败。 |
| `BLOCKED` | Amazon 详情页不能提供或本轮禁止采集的指标；不从页面编造。 |

`DIRECT_FACT` / `DERIVED_FACT` 是事实性质；优先级表示实施顺序，两者不可混淆。

## 3. 优先级定义

- **P0**：身份、市场基线与页面核心商品信息，D1/D2 必须打通到 ProductFact；D3 必须纳入可引用 Research 快照。
- **P1**：决策重要的商品、履约与媒体事实，按 D1/D2/D3 同一链路传递。
- **P2**：条件字段、长尾属性和补充商业信息；确保有界、可追溯，Research 不要求全量消费。
- **Independent evidence**：ReviewEvidence 独立模块，不属于 Detail P0/P1/P2，不得通过 Detail 计划合并实体。
- **BLOCKED**：当前来源下不采集。

## 4. 字段规则

“主详情区”均指经 ASIN 绑定后的目标商品区域，不含广告、推荐卡、相邻商品或未选定变体。选择器仅是候选，必须经页面 fixture 验证；抽取结果需校验并可追踪到 CapturePackage/EvidenceStore。

| 字段 | 优先级 / 性质 | 页面区域 / 候选标签 | 解析与校验、缺失规则 | 目标归属 |
|---|---|---|---|---|
| `asin` | P0 / DIRECT_FACT | URL 与主详情身份锚点 | 规范为 10 位大写字母数字；URL 与页内锚点需一致，否则阻断 | `ProductFact.basic.asin` |
| `title` | P0 / DIRECT_FACT | `#productTitle` | 主详情容器；清理空白，缺失阻断 | `basic.title` |
| `brand` | P0 / DIRECT_FACT | byline/品牌链接、主规格表 Brand/Brand Name | 清理 “Visit the … Store” 等 UI 前缀；缺失不推断 | `basic.brand` |
| `productUrl` | P0 / DIRECT_FACT | 当前已绑定 URL | 规范化为当前 marketplace 与 ASIN 的商品 URL | `basic` / provenance |
| `marketplace` | P0 / DIRECT_FACT | 采集目标与已验证站点上下文 | 只允许本任务 Amazon US；与出口/页面市场验证相符 | `basic` / provenance |
| `price` | P0 / DIRECT_FACT | 主 Buy Box 价格标签 | 解析金额；价格区间不可解析为单值时保持缺失并诊断 | `basic.price` |
| `currency` | P0 / DIRECT_FACT | 同一价格节点符号/币种上下文 | 必须与金额同源；US 页面需确认 USD，不因 URL 猜币种 | `basic.price.currency` |
| `rating` | P0 / DIRECT_FACT | 主商品评价摘要 | 0–5 范围；不可解析则缺失 | `basic.rating` |
| `reviewCount` | P0 / DIRECT_FACT | 主商品评价摘要 | 去分隔符转非负整数；不得混入其他商品评价数 | `basic.reviewCount` |
| `bsrRanks` | P0 / DIRECT_FACT | 主商品 Product Details / best-seller rank 行 | 保存所有可解析的 `{rank, category}`；排名为正整数，类目保留页面语义 | `extended.bsrRanks`（既有 JSON 扩展） |
| `primaryBsr` | P0 / DERIVED_FACT | `bsrRanks` | 确定性主排名投影，记录投影规则版本；兼容 `market.bsr` 可映射此值但不取代数组 | `market.bsr` 兼容视图 + provenance |
| `categoryPath` | P0 / DIRECT_FACT | 主商品 breadcrumb | 按页面顺序保存非空路径；不从推荐内容推导 | `extended.categoryPath` |
| `dateFirstAvailable` | P0 / DIRECT_FACT | 主商品规格表 `Date First Available` 别名 | 保留可验证日期原值并规范化；不等同发布日期推断 | `market` / `extended` |
| `bulletPoints` | P0 / DIRECT_FACT | About this item / feature bullets | 主商品区域有界列表，过滤空项 | `basic` / `extended` |
| `mainImage` | P0 / DIRECT_FACT | 主图节点 | 仅主商品主图，规范化有效 URL | `basic.images` / `extended` |
| `material` | P1 / DIRECT_FACT | 主规格表 Material / Material Type | 保留页面值及来源，不从标题推断 | `extended.material` |
| `packageDimensions` | P1 / DIRECT_FACT | 明确标注 Package Dimensions 的主商品规格行 | 只接受包装标签；单位与维度保留/规范化；未出现则 null | `extended` JSON |
| `packageWeight` | P1 / DIRECT_FACT | Package Weight / Shipping Weight 等明确包装或运输标签 | 只接受标签映射确认的包装语义；不以 Item Weight 回填 | `extended` JSON |
| `itemDimensions` | P1 / DIRECT_FACT | Item Dimensions / Product Dimensions 主规格行 | 作为商品本体尺寸；绝不回填 packageDimensions | `extended` JSON |
| `itemWeight` | P1 / DIRECT_FACT | Item Weight 主规格行 | 作为商品本体重量；绝不回填 packageWeight | `extended` JSON |
| `seller` | P1 / DIRECT_FACT | 主 Buy Box Sold by 行 | 只取当前主报价卖家；无法绑定报价则缺失 | `extended.seller` |
| `shipsFrom` | P1 / DIRECT_FACT | 主 Buy Box Ships from 行 | 只取当前主报价发货方 | `extended.shipsFrom` |
| `fulfillment` | P1 / DERIVED_FACT | 已确认的 `seller`、`shipsFrom` | 规则确定性分类；需保存来源字段和规则版本；证据不足则 unknown | `extended.fulfillment` |
| `galleryImages` | P1 / DIRECT_FACT | 主商品图集 | 仅目标 ASIN 主图集，去重、有界 | `extended.images` |
| `ratingDistribution` | P1 / ESTIMATED_METRIC | 主商品评分分布面板 | 保留平台展示值与采集时间；分布为展示快照，不等同样本级评论统计 | `extended.ratingDistribution` |
| `variations` | P2 / CONDITIONAL_FACT | 主商品 variation selector | 仅保存可证明属于当前父子关系的选项；有界 | `extended.variations` |
| `parentAsin` | P2 / CONDITIONAL_FACT | 变体/父体关联信息 | 需有页面关系证据且格式合法，否则缺失 | `extended.parentAsin` |
| `listPrice` | P2 / CONDITIONAL_FACT | 主报价划线价 | 与当前报价同币种且来源清晰；缺失表示未显示 | `extended` JSON |
| `coupon` | P2 / CONDITIONAL_FACT | 主报价优惠区 | 保存页面优惠原文及结构化值；不把其他报价券合并 | `extended` JSON |
| `boughtPastMonth` | P2 / ESTIMATED_METRIC | 主商品 social proof | 结构见下方；不可转成精确月销量 | `extended.boughtPastMonth` |
| `rawSpecifications` | P2 / DIRECT_FACT | 主商品规格表（不含广告、推荐、评论、导航） | 保留原始 key/value；限制字段数量与每项 key/value 长度；丢弃非主商品行 | `extended.rawSpecifications` |
| `productDescription` | P2 / DIRECT_FACT | 主商品描述区 | 有界文本；A+ 模块不伪装成普通描述 | `extended` JSON |
| `aPlusPresence` | P2 / DIRECT_FACT | 主商品 A+ 区域 | 只记录是否可观察到及证据，不在本轮扩展 A+ 内容采集 | `extended` JSON |
| `reviewEvidence` | Independent evidence | Reviews 独立采集/导入路径 | 保持 `ReviewEvidence` + Source Evidence Attachment；本轮不实施其采集/导入，不映射 ProductFact | 独立 ReviewEvidence namespace；未来独立 citation bridge |
| `fbaFee` | BLOCKED | 详情页无可靠直接事实合同 | 不采集，不推测 | 无；需独立授权的其他数据源/流程 |
| `estimatedMonthlySales` / `estimatedMonthlyRevenue` | BLOCKED | Amazon 详情页不提供可证实精确事实 | 不采集、不从 `boughtPastMonth` 换算 | 无；第三方/模型估算须另行定义来源与性质 |

### 4.1 近似购买量结构

目标表达：

```ts
type BoughtPastMonth = {
  rawText: string;
  lowerBound: number | null;
  upperBound: number | null;
  qualifier: "exact" | "at_least" | "range" | "approximate" | "unknown";
  metricNature: "estimate";
};
```

例如 `1K+ bought in past month` 可解析 `lowerBound=1000`、`upperBound=null`、`qualifier="at_least"`；不可表达为精确 `monthlySales=1000`。原文为依据，无法稳妥解析时仍可保留 rawText、空边界和 `unknown`。

### 4.2 商品/包装属性隔离

`itemDimensions` ≠ `packageDimensions`，`itemWeight` ≠ `packageWeight`。别名必须按明确语义分类；含义模糊或只发现商品本体标签时，只填相应 item 字段，package 字段为空。任何 fallback 都不能跨这两组边界。

### 4.3 BSR 多排名表达

`bsrRanks: Array<{ rank: number; category: string }>` 是保真值；解析每条同属目标商品的排名行并去重。`primaryBsr` 由固定、可测试规则投影并记录版本。现有单值 `market.bsr` 是兼容消费形态，不是完整采集合同。类目文字不能因提取 rank 而丢弃。

## 5. 商品详情字段规则表（实现元数据要求）

代码中的内部类型可命名为 `AmazonDetailFieldRegistry`；面向协作与验收的中文名称统一为“商品详情字段规则表”。每条规则至少定义：

1. canonical field key；
2. `DIRECT_FACT` / `DERIVED_FACT` / `ESTIMATED_METRIC` / `CONDITIONAL_FACT` / `BLOCKED` 性质；
3. 主页面区域与标签别名；
4. 至少一个 selector candidate（允许多候选，候选需同一语义且可诊断）；
5. parser 与 validator；
6. missing / ambiguous / malformed 行为；
7. 目标存储位置及来源追踪；
8. 若为派生值，来源字段与确定性规则版本；若近似指标，原文和区间语义。

规则表必须对主商品容器设边界；无法证明实体归属时返回缺失或阻断，不以宽泛页面文本补偿。解析数量与原始规格长度均需有界。

## 6. 存储与 Research 消费合同

- 复用 CapturePackage extensions、EvidenceStore 版本记录及 ProductFact 可扩展字段完成 D2 对齐；目标 `DATABASE_SCHEMA_CHANGE=0`。具体目标字段不代表当前字段都已落库。
- 每个 ProductFact 字段需能回溯来源证据，ResearchFactSnapshot 和 `citationIndex` 必须以合法 `evidenceRefs` 暴露已确认事实。Research 能否消费以合法引用为准，不以 AI prompt 看见文本作为通过。
- ReviewEvidence 在 bundle 中保持独立输入；其引用类型/引用映射需单独桥接，禁止借用 ProductFact 引用或把评论正文伪装成产品事实。JEV-002 保持原样。
- `rawSpecifications` 允许保存有界长尾属性，Research 可只选择与分析相关且有来源的字段；不要求提示词吞入整张规格表。

## 7. 外部设计参考

本轮仅沿用定向调研并把可迁移思路写进本项目规则，不新增运行依赖：Playwright 继续为主浏览器控制方式；Crawl4AI 仅参考 schema 化提取思路；Scrapling 仅参考多候选与页面变化适应思路。参考：[Playwright](https://github.com/microsoft/playwright)、[Crawl4AI](https://github.com/unclecode/crawl4ai)、[Scrapling](https://github.com/D4Vinci/Scrapling)。Amazon 专项采集项目沿用本轮已有结论“字段目录 + 标签别名”，不对当前资料未标识的项目臆造链接。Browser Use 与 Jev Ultrafast 不纳入本轮正式实现。

## 8. 验收不变量

- 无页面事实，不生成 ProductFact 值；无合法证据引用，不进 Research 已验证叙述。
- 不能由 Review -> ProductFact；ReviewEvidence 与 ProductFact 并列进入 ResearchInputBundle。
- 商品本体尺寸/重量与包装尺寸/重量不互相回填。
- 所有 BSR 类目排名保留，兼容单值只作为确定性投影。
- 平台估算保持估算，`1K+` 不等于精确 `1000`。
- 缺失、歧义、页面变化均可诊断且 fail-closed / fail-soft 按字段合同处理，不跨商品取值。
- 本轮仅定稿，不更改实现或数据库结构。
