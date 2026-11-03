/** 业务演示数据 — 对齐真实研究报告与 API 语义，只读原型。 */
export type Role = "benchmark" | "pain_point" | "newcomer" | "sample";
export type GateStatus = "PENDING" | "PROCEED" | "VALIDATE_MORE" | "PAUSE" | "DROP";
export type Screen =
  | "explorer"
  | "overview"
  | "competition"
  | "keywords"
  | "voc"
  | "compare"
  | "gate";

export interface Sample {
  asin: string;
  name: string;
  brand?: string;
  role: Role;
  price: number;
  rating: number;
  reviews: number;
  reviewsAlt?: number;
  size: string;
  thickness: string;
  pack: string;
  unitPriceNote?: string;
  voc: number;
  pos: string;
  neg: string;
  comparable: boolean;
  note: string;
  conflict?: boolean;
  imageKind: "mat" | "box" | "cup";
  /** 正式环境为 ASIN 主图；演示为 null → 示意占位 */
  imageUrl?: string | null;
}

export const ROLE_LABEL: Record<Role, string> = {
  benchmark: "基准",
  pain_point: "痛点样本",
  newcomer: "新进入者",
  sample: "正式样本",
};

export const GATE_LABEL: Record<GateStatus, string> = {
  PENDING: "待处理",
  PROCEED: "通过",
  VALIDATE_MORE: "需补充验证",
  PAUSE: "暂缓",
  DROP: "放弃",
};

export const scan = {
  id: "cmv78ci4v0002dglj9gt6g6tq",
  site: "Amazon US",
  category: "厨房 · 硅胶烘焙垫（平铺半盘）",
  snapshotAt: "2026-10-13T22:05:26.673Z",
  sampleCount: 34,
  reportVersion: "v0.2",
  reportAt: "2026-10-18",
  reportStale: true,
  reportStaleReason: "来源快照已更新 2 次",
  researchQuestion: "收纳方式和尺寸标记是否影响烘焙垫使用？",
  excluded: "揉面垫 / 台面垫 / 打孔垫 / Snap Lock 不进价格统计",
  conclusions: [
    { tone: "fact" as const, text: "同用途平铺半盘垫价格带约 $4.99–$15.06，包价不可直接当单张价。" },
    { tone: "fact" as const, text: "样本内无达到复现门槛的负面问题；防滑明确负面仅 1 条。" },
    { tone: "ai" as const, text: "建议：值得有界深研，但不直接进入开发。" },
  ],
  findings: [
    "Luckyiren $5.99 / 975 评分为低价锚点",
    "Snap Lock 立边结构不进入平垫价格统计",
    "销量 / 品牌集中度全部 NOT_AVAILABLE",
  ],
  opportunities: [
    { title: "防滑 / 清洁体验", desc: "提及 3、明确负面 1；信号混合，待验证", score: "待验证" },
    { title: "厚度与挺括差异", desc: "0.4mm vs 0.7mm 影响收纳与成本", score: "观察" },
    { title: "Pack 组合策略", desc: "2 half + 1 quarter 成为主流组合", score: "结构参考" },
  ],
  risks: [
    { level: "高" as const, text: "评论数来源冲突未解决" },
    { level: "中" as const, text: "VOC 样本仅覆盖 1–2 个 ASIN" },
    { level: "中" as const, text: "无供应商报价与合规数据" },
  ],
  nextSteps: ["确认或改写市场研究问题", "通过市场闸门", "选择 1–50 个代表商品进入 03"],
  aiRecommend: {
    pick: "B0CWPNBC4Z Luckyiren 作为基准继续深研",
    why: "评论成熟度最高、价格锚点清晰、无明确负面；适合作为对照基线。",
    avoid: "不建议仅凭 3–9 条评论的高分新品下结论。",
    questions: [
      "包装参数与真实采购报价",
      "防滑 / 清洁主题是否跨 ASIN 复现",
      "单位经济与合规边界",
    ],
  },
};

export const priceBands = [
  { label: "$4.99–6.99", count: 8 },
  { label: "$6.99–9.99", count: 11 },
  { label: "$9.99–12.99", count: 9 },
  { label: "$12.99–15.06", count: 6 },
];

export const productTrend = [
  { m: "05", price: 8.2, rating: 4.5 },
  { m: "06", price: 7.9, rating: 4.55 },
  { m: "07", price: 8.4, rating: 4.6 },
  { m: "08", price: 8.1, rating: 4.58 },
  { m: "09", price: 7.7, rating: 4.62 },
  { m: "10", price: 7.5, rating: 4.6 },
];

export const samples: Sample[] = [
  {
    asin: "B0CWPNBC4Z",
    name: "Luckyiren 2 Pack Half Sheet",
    brand: "Luckyiren",
    role: "benchmark",
    price: 5.99,
    rating: 4.6,
    reviews: 975,
    size: "16.54×11.62 in",
    thickness: "0.4mm · 480°F",
    pack: "2",
    unitPriceNote: "约 $3.00/张（按 2 张粗算，未扣尺寸差）",
    voc: 13,
    pos: "清洁便利 5 · 耐用 3",
    neg: "无明确负面",
    comparable: true,
    note: "读取样本仅 13/975",
    imageKind: "mat",
    imageUrl: null,
  },
  {
    asin: "B0CFTP6JR4",
    name: "Koolstuffs 3 Pack",
    brand: "Koolstuffs",
    role: "pain_point",
    price: 9.99,
    rating: 4.7,
    reviews: 3,
    reviewsAlt: 3354,
    size: "2×16.5×11.6 + 11.81×8.26",
    thickness: "-40–500°F",
    pack: "3 (2h+1q)",
    unitPriceNote: "含 1 张 1/4 垫，不能按 3 张同尺寸比",
    voc: 9,
    pos: "清洁便利 4 · 尺寸 3",
    neg: "防滑/清洗 1 · 清洁困难 1",
    comparable: true,
    conflict: true,
    note: "评论数冲突未解决",
    imageKind: "mat",
    imageUrl: null,
  },
  {
    asin: "B0DK94QVHR",
    name: "Ninsula 2 Pack",
    brand: "Ninsula",
    role: "sample",
    price: 4.99,
    rating: 4.6,
    reviews: 570,
    size: "16.5×11.6 in",
    thickness: "未知",
    pack: "2",
    unitPriceNote: "约 $2.50/张（粗算）",
    voc: 0,
    pos: "未读取",
    neg: "未读取",
    comparable: true,
    note: "无 VOC、无详情事实",
    imageKind: "mat",
    imageUrl: null,
  },
  {
    asin: "B0FFH8FSTZ",
    name: "HOTEC 3 Pack",
    brand: "HOTEC",
    role: "sample",
    price: 6.63,
    rating: 4.6,
    reviews: 420,
    size: "half + quarter",
    thickness: "未知",
    pack: "3 (2h+1q)",
    unitPriceNote: "含 quarter，单位价不可直接比",
    voc: 0,
    pos: "未读取",
    neg: "未读取",
    comparable: true,
    note: "pack 组成不同",
    imageKind: "mat",
    imageUrl: null,
  },
  {
    asin: "B0GF23LGWD",
    name: "GUANCI 2 Pack 0.7mm",
    brand: "GUANCI",
    role: "sample",
    price: 12.99,
    rating: 4.8,
    reviews: 3,
    size: "11.6×16.5 in",
    thickness: "0.7mm",
    pack: "2",
    unitPriceNote: "约 $6.50/张（粗算）",
    voc: 0,
    pos: "未读取",
    neg: "未读取",
    comparable: true,
    note: "评论仅 3 条",
    imageKind: "mat",
    imageUrl: null,
  },
  {
    asin: "B0HFS7K4GP",
    name: "Snap Lock Edge Mat",
    brand: "Leakproof",
    role: "newcomer",
    price: 15.88,
    rating: 5.0,
    reviews: 2,
    size: "立边结构",
    thickness: "未知",
    pack: "1",
    unitPriceNote: "结构不同，不进平垫单位价统计",
    voc: 2,
    pos: "功能正常 1",
    neg: "无",
    comparable: false,
    note: "非平铺式，不进价格统计",
    imageKind: "mat",
    imageUrl: null,
  },
];

/** 演示用单品趋势（非全市场）；正式环境替换为该 ASIN 真实序列 */
export const asinTrends: Record<string, { date: string; price: number; rating: number }[]> = {
  B0CWPNBC4Z: [
    { date: "2026-05", price: 6.49, rating: 4.55 },
    { date: "2026-06", price: 6.29, rating: 4.58 },
    { date: "2026-07", price: 5.99, rating: 4.6 },
    { date: "2026-08", price: 5.99, rating: 4.6 },
    { date: "2026-09", price: 5.79, rating: 4.62 },
    { date: "2026-10", price: 5.99, rating: 4.6 },
  ],
  B0CFTP6JR4: [
    { date: "2026-05", price: 11.49, rating: 4.65 },
    { date: "2026-06", price: 10.99, rating: 4.7 },
    { date: "2026-07", price: 10.49, rating: 4.7 },
    { date: "2026-08", price: 9.99, rating: 4.7 },
    { date: "2026-09", price: 9.99, rating: 4.7 },
    { date: "2026-10", price: 9.99, rating: 4.7 },
  ],
  B0HFS7K4GP: [], // 无真实历史 → 缺失状态
};

export const opportunityDetail: Record<
  string,
  { support: string[]; counter: string[]; products: string[]; questions: string[] }
> = {
  "防滑 / 清洁体验": {
    support: ["Koolstuffs 4★ 原文提及清洗时台面打滑", "同主题另有 tolerated / uncertain 各 1"],
    counter: ["明确负面仅 1 条，未达复现门槛", "Luckyiren 13 条已读无明确负面"],
    products: ["B0CFTP6JR4", "B0CWPNBC4Z"],
    questions: ["扩样后防滑 complaint 是否 ≥4？", "表面处理是否影响不粘？"],
  },
  "厚度与挺括差异": {
    support: ["Luckyiren 0.4mm · GUANCI 0.7mm", "「very thin」出现在部分评论"],
    counter: ["厚度数据多数样本缺失", "无对照实验"],
    products: ["B0CWPNBC4Z", "B0GF23LGWD"],
    questions: ["目标厚度与成本权衡？"],
  },
  "Pack 组合策略": {
    support: ["2 half + 1 quarter 主流组合", "单位价不可直接比 pack 价"],
    counter: ["组合影响体积重与客单", "无成交证据支持高价组合"],
    products: ["B0CFTP6JR4", "B0CWPNBC4Z"],
    questions: ["组合比例如何匹配目标客群？"],
  },
};

export const keywords = [
  { kw: "silicone baking mat", vol: null, buy: null, rate: null, source: "SellerSprite 缺口", limit: true },
  { kw: "baking mat half sheet", vol: 12400, buy: 380, rate: 3.1, source: "SellerSprite 估算", limit: false },
  { kw: "silicone pastry mat", vol: 8900, buy: 210, rate: 2.4, source: "SellerSprite 估算", limit: false },
  { kw: "non stick baking mat", vol: 15600, buy: 520, rate: 3.3, source: "SellerSprite 估算", limit: false },
  { kw: "cookie baking mat set", vol: null, buy: null, rate: null, source: "未采集", limit: true },
];

export const asinFlow = [
  { asin: "B0CWPNBC4Z", words: ["baking mat", "half sheet", "silicone mat"], evidence: "SellerSprite 反查" },
  { asin: "B0CFTP6JR4", words: ["baking mat set", "non stick mat"], evidence: "SellerSprite 反查" },
];

export const keywordEvidence = [
  { id: "EV-KW-01", text: "关键词月搜索量为第三方估算，非 Amazon 确认事实", nature: "provider-derived" },
  { id: "EV-KW-02", text: "购买次数 / 购买率仅在有估算覆盖时显示", nature: "estimated" },
  { id: "EV-KW-03", text: "缺失值保持 null，不填 0", nature: "unknown" },
];

export const voc = {
  summary: { read: 22, themes: 6, complaints: 2, coverage: "2 / 34 ASIN" },
  themes: [
    { name: "清洁便利", count: 9, tone: "pos" as const, insight: "正面为主，清洗不粘是主卖点" },
    { name: "防滑 / 稳定", count: 3, tone: "mixed" as const, insight: "提及 3：明确负面 1 · 可接受 1 · 待核对 1" },
    { name: "耐用 / 挺括", count: 3, tone: "pos" as const, insight: "耐用反馈正面，厚度影响挺括" },
    { name: "尺寸合适", count: 3, tone: "pos" as const, insight: "半盘尺寸匹配主流烤盘" },
    { name: "材质手感", count: 2, tone: "uncertain" as const, insight: "材质/手感不确定 2" },
    { name: "收纳不便", count: 1, tone: "uncertain" as const, insight: "收纳不便不确定 1" },
  ],
  quotes: [
    {
      id: "Q1",
      asin: "B0CFTP6JR4",
      stars: 4,
      text: "When washing with soap after flipping, it was very slippery and moved on the countertop.",
      tag: "防滑 · complaint",
      nature: "规则投影 · 非人工复核",
    },
    {
      id: "Q2",
      asin: "B0CFTP6JR4",
      stars: 4,
      text: "My main issue arises in cleaning them.",
      tag: "清洁困难 · complaint",
      nature: "可能与 Q1 同一条评论",
    },
    {
      id: "Q3",
      asin: "B0CWPNBC4Z",
      stars: 5,
      text: "Cookies slid right off — cleanup was effortless.",
      tag: "清洁便利 · positive",
      nature: "来源观察",
    },
    {
      id: "Q4",
      asin: "B0CFTP6JR4",
      stars: 5,
      text: "A bit slippery at first, improved after two washes.",
      tag: "防滑 · uncertain",
      nature: "待核对",
    },
  ],
  hypotheses: [
    {
      title: "边缘防滑纹理是否必要？",
      status: "待验证",
      evidence: "明确负面仅 1 条，未达 weak/recurring 门槛",
    },
    {
      title: "厚度 0.4 → 0.7mm 的成本与体验权衡",
      status: "观察",
      evidence: "GUANCI 0.7mm 样本评论少",
    },
  ],
};

export const compareQuestions = [
  "同用途半盘垫，包价与单张价如何公平比较？",
  "防滑抱怨是产品缺陷还是使用场景差异？",
  "是否值得把 Snap Lock 结构纳入开发方向？",
];

export const readiness = [
  { label: "正式样本已锁定", ok: true, note: null as string | null },
  { label: "可比身份已核对", ok: true, note: null as string | null },
  { label: "证据冲突已解决", ok: false, note: "B0CFTP6JR4 评论数冲突" },
  { label: "研究问题已保存", ok: false, note: null as string | null },
  { label: "AI 报告版本有效", ok: false, note: "来源已更新" },
];

export const explorer = {
  focus: {
    product: "硅胶烘焙垫",
    category: "厨房用品",
    status: "待人工判断",
    next: "核实评论依据与商业成本，再决定下一步",
    questions: [
      "防滑抱怨是否达到复现门槛？",
      "包装参数与真实采购报价是否补齐？",
      "是否值得进入正式深研？",
    ],
  },
  progress: [
    { stage: "01 市场采集", label: "烘焙垫 34 件快照已锁定", state: "done" as const, time: "10-13" },
    { stage: "02 市场研究", label: "市场竞争已读，闸门待确认", state: "active" as const, time: "今天" },
    { stage: "03 商品深研", label: "未开始", state: "todo" as const, time: "—" },
    { stage: "04 需求单", label: "未开始", state: "todo" as const, time: "—" },
  ],
  alerts: [
    {
      tone: "warn" as const,
      title: "AI 报告可能过期",
      body: "烘焙垫竞争对比基于 10-13 快照，来源已更新 2 次",
      action: "重新生成报告",
    },
    {
      tone: "info" as const,
      title: "SellerSprite 补证待处理",
      body: "关键词搜索量有 3 条缺口，建议定向补证",
      action: "打开补证",
    },
    {
      tone: "risk" as const,
      title: "证据冲突未解决",
      body: "B0CFTP6JR4 评论数：快照 3 / 详情 3354",
      action: "查看冲突",
    },
  ],
  recent: [
    {
      name: "硅胶烘焙垫",
      role: "痛点样本",
      status: "待人工判断",
      insight: "防滑明确负面仅 1 条，未达复现门槛",
    },
    {
      name: "大号收纳箱",
      role: "基准商品",
      status: "待补证据",
      insight: "提手断裂模式具体，但仅 1 个 ASIN 有正式 complaint",
    },
    {
      name: "随行保温杯",
      role: "新进入者",
      status: "研究中",
      insight: "样本不足，等待关键词补证",
    },
  ],
  stats: [
    { label: "进行中研究", value: "3", hint: "1 个待判断" },
    { label: "待处理提醒", value: "3", hint: "含 1 条冲突" },
    { label: "正式样本", value: "34", hint: "烘焙垫快照" },
    { label: "下一步动作", value: "确认闸门", hint: "02 市场研究" },
  ],
};

export const moreEntries = [
  { id: "tools", label: "更多工作区" },
  { id: "sep" },
  { id: "feishu", label: "飞书研究中心" },
  { id: "diagnostics", label: "系统诊断" },
] as const;
