/**
 * 03 商品深研 → 产品改良假设（确定性派生，零 AI 自由度）
 *
 * 解决的真实缺口：研报里的 `causalInvestigations` 只回答「我们怀疑问题出在哪、证据是什么」，
 * 产品开发还需要回答「改哪里、怎么改、改完会牺牲什么、成本与合规未知在哪、下一步验证什么」。
 * 在此之前这层信息完全缺失，导致 03 只能停在「用户抱怨不好用 → 建议优化设计」。
 *
 * 硬边界（与既有架构一致）：
 * 1. 纯函数、只读派生：不新增采集、不写库、不调用模型。
 * 2. 归因分类是**对假设文本的归类**，不是已确认根因；`rootCauseStatus` 恒为 ROOT_CAUSE_UNVERIFIED。
 * 3. 改良对象 / 副作用 / 成本 / 合规一律来自**通用检查模板**，逐条标注 `source: "TEMPLATE_CHECK"`，
 *    不得被读成「本商品已确认的结论」。缺失信息保持缺失，不补数值。
 * 4. 证据只按已持久化线索的**条数**统计，且不得被读成独立证据 / 买家数 / 发生率 / 显著性 / 因果强度。
 * 5. 不产生 MOQ / 报价 / 交期 / 认证结果等任何供应链事实。
 * 6. 派生规则带版本号（`IMPROVEMENT_RULES_VERSION`）：规则版本 ≠ 研报版本 ≠ 需求单版本。
 *    版本号只保证「同一规则版本下输入相同则输出相同」，**不解决历史完全重放**——
 *    旧规则实现未保留时，无法保证用旧版本重算得到逐字相同的结果。
 */

import { classifyProblemNature, competitiveExplanationsFor, type CompetitiveExplanation, type ProblemNature } from "./competitiveExplanations";

export type ImprovementAttributionCategory =
  | "structure"
  | "material"
  | "size"
  | "ergonomics"
  | "installation"
  | "instructions"
  | "packaging"
  | "quality_consistency"
  | "expectation_mismatch"
  | "unclassified";

export type ImprovementEvidenceLevel = "no_support" | "single_mention" | "multiple_mentions" | "conflicting";

/**
 * 可改良性三态判断。
 *
 * - PRODUCT_ACTIONABLE：假设在讨论产品本身的工程 / 材料 / 尺寸 / 使用 / 质量 / 包装问题，
 *   可以派生出**模板候选**改良对象，但根因仍未确认。
 * - NON_PRODUCT：假设在讨论市场竞争结构、流量分配、排名、父子变体聚合、评论归属、
 *   广告投放、纯定价或运营表现；不得派生产品工程改良对象。
 * - MIXED_OR_UNCERTAIN：同时包含产品与市场因素且无法可靠区分，或现有确定性规则无法确认
 *   是否属于产品问题；不得自动给确定的改良对象，必须人工拆分或补证。
 */
export type ImprovementActionabilityStatus = "PRODUCT_ACTIONABLE" | "NON_PRODUCT" | "MIXED_OR_UNCERTAIN";

export const ACTIONABILITY_LABELS: Readonly<Record<ImprovementActionabilityStatus, string>> = {
  PRODUCT_ACTIONABLE: "产品问题（可改良）",
  NON_PRODUCT: "非产品问题（市场 / 运营层）",
  MIXED_OR_UNCERTAIN: "混合或不确定（需人工拆分）",
};

export type ImprovementVerificationCategory =
  | "competitor_comparison"
  | "review_recheck"
  | "dimension_measurement"
  | "material_structure_check"
  | "sample_test"
  | "supplier_process"
  | "cost_accounting"
  | "compliance_check"
  | "user_trial"
  | "other";

export type ImprovementCheckItem = {
  /** 检查项正文（通用模板或来源文本） */
  readonly text: string;
  /** TEMPLATE_CHECK = 通用检查模板，不是本商品结论；RESEARCH = 研报原文 */
  readonly source: "TEMPLATE_CHECK" | "RESEARCH";
};

export type ImprovementVerificationTask = {
  readonly category: ImprovementVerificationCategory;
  readonly label: string;
  readonly task: string;
  /** RESEARCH = 研报已给出的验证动作；SUGGESTED = 按类别补齐的建议项（尚未在研究中出现） */
  readonly source: "RESEARCH" | "SUGGESTED";
};

/**
 * 派生输入种类。
 *
 * - CAUSE_HYPOTHESIS：研究给出的**原因假设**（v1 深度研报的 competitionInsight.causalInvestigations）。
 * - PROBLEM_OBSERVATION：研究只给出**问题陈述**（v5 综合研报的 vocAnalysis.painPoints）。
 *   问题陈述没有原因结论，不得被读成「已找到原因」；它只用于指出候选方向，根因仍未确认。
 */
export type ImprovementPlanInputKind = "CAUSE_HYPOTHESIS" | "PROBLEM_OBSERVATION";

export const INPUT_KIND_LABELS: Readonly<Record<ImprovementPlanInputKind, string>> = {
  CAUSE_HYPOTHESIS: "原因假设（研究给出）",
  PROBLEM_OBSERVATION: "问题陈述（VOC 观察，无原因结论）",
};

/** 只有问题陈述、没有原因假设时的派生输入。 */
export type ImprovementPlanObservation = {
  readonly statement: string;
  /** 该陈述的来源引用（原样保留，不新增、不推断）。 */
  readonly evidenceRefs: readonly string[];
};

export type ImprovementHypothesisItem = {
  readonly index: number;
  readonly inputKind: ImprovementPlanInputKind;
  readonly inputKindLabel: string;
  readonly hypothesis: string;
  readonly rationale: string | null;
  readonly attribution: {
    readonly primary: ImprovementAttributionCategory;
    readonly primaryLabel: string;
    readonly all: readonly ImprovementAttributionCategory[];
    /** 命中依据：命中的关键词；未命中时为「未命中任何归因关键词」 */
    readonly basis: string;
  };
  /** 恒为 ROOT_CAUSE_UNVERIFIED：文本归类不等于已确认根因。 */
  readonly rootCauseStatus: "ROOT_CAUSE_UNVERIFIED";
  /** 三态可改良性判断——唯一权威判断来源。 */
  readonly actionabilityStatus: ImprovementActionabilityStatus;
  readonly actionabilityLabel: string;
  /**
   * 兼容字段：**只在** `actionabilityStatus === "PRODUCT_ACTIONABLE"` 时为 true。
   * 不得与 actionabilityStatus 出现两个相互矛盾的说法。
   */
  readonly productActionable: boolean;
  /** 非 PRODUCT_ACTIONABLE 时说明为什么不能派生（含混合 / 不确定的处置要求）。 */
  readonly actionabilityReason: string | null;
  /** 判定依据：命中的产品侧 / 市场侧信号，便于人工复核闸门是否误判。 */
  readonly actionabilityBasis: string;
  /**
   * 问题性质：属性观察 / 缺陷主张 / 不明确。
   * 「薄、软、尺寸差 1 英寸」属属性观察，不得直接当作需要改良的缺陷（P5-v6）。
   */
  readonly problemNature: ProblemNature;
  /** 与该问题相关的竞争性解释（未验证，附区分证据），最多 3 条。 */
  readonly competitiveExplanations: readonly CompetitiveExplanation[];
  readonly candidateTargets: readonly string[];
  /**
   * 候选对象状态（rules.v3）：
   * - ANCHORED：问题文本里出现了具体部位锚点，才输出对应的模板候选；
   * - UNRESOLVED：只识别到问题类别，没有足够部位关联 → 不输出整类模板，需人工确认部位；
   * - BLOCKED_BY_MISSING_CAUSE：只有问题陈述、没有原因假设 → 不输出任何改良对象（证据不足）；
   * - NOT_APPLICABLE：非产品问题，不派生。
   */
  readonly targetStatus: "ANCHORED" | "UNRESOLVED" | "BLOCKED_BY_MISSING_CAUSE" | "NOT_APPLICABLE";
  readonly partAnchors: readonly string[];
  readonly targetNote: string | null;
  readonly linkedDirections: readonly string[];
  readonly sideEffects: readonly ImprovementCheckItem[];
  readonly costUncertainties: readonly ImprovementCheckItem[];
  readonly complianceChecks: readonly ImprovementCheckItem[];
  readonly verificationTasks: readonly ImprovementVerificationTask[];
  readonly missingVerificationCategories: readonly ImprovementVerificationCategory[];
  readonly evidence: {
    readonly level: ImprovementEvidenceLevel;
    /** 线索口径标签（不是可信度评分）。 */
    readonly levelLabel: string;
    /** 固定标题：这些数字是「证据线索概况」，不是证据强度评分。 */
    readonly summaryLabel: string;
    readonly supportingCount: number;
    readonly counterCount: number;
    readonly unknownCount: number;
    readonly modelConfidence: "low" | "medium" | "high" | "unknown";
    readonly basis: string;
    /** 解读边界：不得当作独立证据数 / 买家数 / 发生率 / 统计显著性 / 因果可信度。 */
    readonly scopeNote: string;
  };
  readonly unknowns: readonly string[];
};

export type ImprovementPlanStatus =
  | "NO_ACTIONABLE_CAUSE"
  | "NO_PRODUCT_ACTIONABLE_CAUSE"
  | "MIXED_NEEDS_HUMAN_SPLIT"
  | "OBSERVATION_ONLY"
  | "NEEDS_MORE_EVIDENCE"
  | "NEEDS_VERIFICATION"
  | "READY_FOR_LOW_COST_VALIDATION";

export type ImprovementPlan = {
  readonly schema: "improvement-plan.v1";
  readonly status: ImprovementPlanStatus;
  readonly statusLabel: string;
  readonly statusReason: string;
  /** 派生规则版本（≠ 研报版本 ≠ 需求单版本）。 */
  readonly rulesVersion: string;
  readonly rulesVersionNote: string;
  /**
   * 派生结果摘要：同一规则版本 + 同一输入 = 同一摘要，用于人工比对「这次和上次是不是同一份派生」。
   * 不是证据哈希 / 事实哈希，不参与任何门禁与版本判定。
   */
  readonly derivationDigest: string;
  readonly items: readonly ImprovementHypothesisItem[];
  /** 本次派生实际用到的输入种类（用于说明「这是原因假设还是问题陈述」）。 */
  readonly inputKinds: readonly ImprovementPlanInputKind[];
  /**
   * 来源披露：研究契约是否缺少改良假设所需的字段。
   * 缺字段时如实列出，不补造内容（v5 综合研报没有原因假设层）。
   */
  readonly sourceDisclosure: {
    readonly sourceKind: "v1" | "v5" | "unknown";
    readonly missingFacts: readonly string[];
    readonly note: string;
  } | null;
  readonly actionabilityCounts: readonly {
    readonly status: ImprovementActionabilityStatus;
    readonly label: string;
    readonly count: number;
  }[];
  readonly attributionCounts: readonly {
    readonly category: ImprovementAttributionCategory;
    readonly label: string;
    readonly count: number;
  }[];
  readonly missingVerificationCategories: readonly ImprovementVerificationCategory[];
  /** 固定免责声明：改良假设不是开发要求，也不是已确认缺陷。 */
  readonly disclaimer: string;
};

/** 派生输入：只依赖已持久化的研报投影，不依赖原始模型输出。 */
export type ImprovementPlanCause = {
  readonly hypothesis: string;
  readonly rationale: string | null;
  readonly supportingEvidence: readonly string[];
  readonly counterevidence: readonly string[];
  readonly unknowns: readonly string[];
  readonly confidence: "low" | "medium" | "high" | "unknown";
  readonly verification: readonly string[];
};

/** 派生规则版本。规则逻辑变更时必须同步升级并在交付报告中说明升级原因。 */
export const IMPROVEMENT_RULES_VERSION = "improvement-plan.rules.v3";

export const IMPROVEMENT_RULES_VERSION_NOTE =
  "规则版本只标识「用哪一套确定性规则派生」，不等于研报版本，也不等于需求单版本；规则升级不会改动已保存的研报与需求单内容，但用新规则重算旧数据可能得到不同候选对象。";

export const IMPROVEMENT_DISCLAIMER =
  "以下为待验证的改良假设：归因分类只是对研报假设文本的归类，不代表已确认根因；改良对象、副作用、成本与合规均为通用检查模板，需人工与供应商确认后才可写入开发要求。";

export const ROOT_CAUSE_UNVERIFIED_LABEL = "根因未确认（ROOT_CAUSE_UNVERIFIED）";

/** 状态含义边界：防止「可进入验证」被读成「可以立项 / 可以生产」。 */
export const STATUS_MEANING_NOTE = "可进入低成本验证 ≠ 可以立项 ≠ 可以下发生产。";

export const EVIDENCE_SUMMARY_LABEL = "证据线索概况";

export const EVIDENCE_SCOPE_NOTE =
  "以上数字只是已持久化研究线索的条数，不是独立证据数、真实买家数、问题发生率或统计显著性，也不代表因果关系成立。";

type AttributionRule = {
  readonly category: ImprovementAttributionCategory;
  readonly label: string;
  readonly keywords: readonly string[];
  /** 候选对象必须带「部位锚点」：只有锚点出现在问题文本里才允许输出（rules.v3）。 */
  readonly targets: readonly { readonly text: string; readonly anchors: readonly string[] }[];
  readonly sideEffects: readonly string[];
  readonly costs: readonly string[];
  readonly compliance: readonly string[];
};

/**
 * 归因规则表。关键词按中文 / 英文双写，只用于把「假设文本」归到一类，
 * 不推断因果关系；同一假设可命中多类，取命中数最高者为主类。
 */
const ATTRIBUTION_RULES: readonly AttributionRule[] = [
  {
    category: "structure",
    label: "结构设计",
    keywords: ["结构", "形状", "开口", "内壁", "可拆", "拆开", "卡扣", "铰链", "倾倒", "重心", "底面", "接触面", "死角", "密封", "盖子", "structure", "shape", "opening", "wide mouth", "removable", "hinge", "lid", "tip over", "stability", "seal"],
    targets: [
      { text: "内壁形状与转折半径", anchors: ["内壁", "转折"] },
      { text: "开口尺寸与边缘形态", anchors: ["开口", "边缘", "瓶口"] },
      { text: "可拆结构（分体 / 卡扣 / 铰链）", anchors: ["卡扣", "铰链", "可拆", "拆开"] },
      { text: "底部接触面积与重心位置", anchors: ["底面", "底部", "重心", "接触面"] },
      { text: "密封与盖合结构", anchors: ["密封", "盖子", "盖合", "漏"] },
    ],
    sideEffects: ["结构强度与抗变形能力可能下降", "新增接缝或拆装位可能形成新的清洁死角", "拆装件存在丢失或误装风险", "密封性变化可能影响防漏表现"],
    costs: ["是否新增模具或改模，改模费用未知", "零件数量变化带来的装配工时与单件成本未知"],
    compliance: ["结构安全：是否存在夹手、锐边或可脱落小零件", "若用于食品接触场景，需确认结构可清洁性要求"],
  },
  {
    category: "material",
    label: "材料与表面",
    keywords: ["材质", "材料", "硅胶", "塑料", "橡胶", "表面", "涂层", "吸油", "粘", "残留", "油污", "清洗", "发黄", "异味", "material", "silicone", "surface", "coating", "stain", "residue", "grease", "clean", "odor", "yellow"],
    targets: [
      { text: "主体材质选型", anchors: ["材质", "材料", "硅胶", "塑料", "橡胶"] },
      { text: "表面处理（涂层 / 抛光 / 纹理）", anchors: ["表面", "涂层", "抛光", "纹理"] },
      { text: "接触油污部位的表面能特性", anchors: ["表面能", "油污", "残留", "吸油", "粘"] },
    ],
    sideEffects: ["更换材质可能影响手感、重量与耐用度", "表面处理可能降低耐磨性或增加掉层风险", "材质变化可能改变耐温与耐油表现"],
    costs: ["材料单价差异与最小采购批量未知", "新增表面处理工序的良率与成本未知"],
    compliance: ["食品接触材料合规（如 FDA / LFGB）需确认，当前无证据", "材料成分与可回收要求需供应商提供书面说明"],
  },
  {
    category: "size",
    label: "尺寸与容量",
    keywords: ["尺寸", "大小", "容量", "太长", "太短", "太小", "太大", "偏小", "偏大", "宽", "高", "size", "dimension", "capacity", "too small", "too large", "fit"],
    targets: [
      { text: "关键外形尺寸（长 / 宽 / 高 / 厚）", anchors: ["尺寸", "长度", "宽度", "厚度", "偏小", "偏大", "太小", "太大"] },
      { text: "容量与单次使用量匹配", anchors: ["容量", "单次"] },
      { text: "与目标收纳 / 安装空间的适配尺寸", anchors: ["收纳", "安装", "适配"] },
    ],
    sideEffects: ["放大尺寸可能影响收纳与携带", "缩小尺寸可能降低单次容量与使用次数", "尺寸变化可能影响既有配件兼容"],
    costs: ["尺寸变化是否触发改模与包装重做未知", "体积变化带来的头程与仓储费用变化未核算"],
    compliance: ["目标市场对尺寸标注与净含量的标示要求需确认"],
  },
  {
    category: "ergonomics",
    label: "人体工学与施力",
    keywords: ["太软", "刚性", "硬度", "施力", "用力", "手部", "手指", "握", "滑手", "疲劳", "省力", "ergonomic", "rigid", "stiff", "flexible", "soft", "grip", "force", "effort"],
    targets: [
      { text: "握持部位形态与摩擦", anchors: ["握", "手柄", "手部", "手指", "滑手", "打滑"] },
      { text: "整体刚性（厚度 / 加强筋）", anchors: ["刚性", "硬度", "太软", "过软", "偏软", "厚度", "加强筋"] },
      { text: "施力方向与受力支点", anchors: ["施力", "用力", "费力", "力度", "按压"] },
    ],
    sideEffects: ["提高刚性可能牺牲贴合度与手感", "增加握持纹理可能带来清洁负担", "重量上升可能影响长时间使用"],
    costs: ["加强筋或厚度变化带来的材料用量与成本变化未知"],
    compliance: ["重复施力类使用场景是否需要额外警示说明待确认"],
  },
  {
    category: "installation",
    label: "安装与组装",
    keywords: ["安装", "组装", "装配", "拼接", "对准", "装反", "install", "assembly", "attach", "mount"],
    targets: [
      { text: "安装接口与定位结构", anchors: ["安装", "接口", "定位"] },
      { text: "防呆设计（防装反 / 防漏装）", anchors: ["装反", "漏装", "对准"] },
      { text: "组装步骤数量", anchors: ["组装", "装配", "拼接"] },
    ],
    sideEffects: ["增加防呆结构可能提高模具复杂度", "简化安装可能降低连接强度"],
    costs: ["防呆结构带来的改模与装配成本未知"],
    compliance: ["安装不当导致的安全风险是否需要警示标识待确认"],
  },
  {
    category: "instructions",
    label: "使用说明与预期管理",
    keywords: ["说明", "说明书", "标注", "误解", "不知道", "以为", "教程", "instructions", "manual", "guide", "misunderst", "expect"],
    targets: [
      { text: "包装内使用说明与图示", anchors: ["说明", "说明书", "教程", "图示"] },
      { text: "Listing 使用场景与限制描述", anchors: ["listing", "卖点", "描述"] },
      { text: "首次使用提示", anchors: ["首次", "第一次", "初始"] },
    ],
    sideEffects: ["说明加长可能降低阅读率", "过度提示可能削弱卖点表达"],
    costs: ["印刷与包装改版成本未知"],
    compliance: ["必要警示语与语言版本需按目标市场确认"],
  },
  {
    category: "packaging",
    label: "包装与运输",
    keywords: ["包装", "运输", "破损", "变形", "压坏", "到货", "快递", "packaging", "shipping", "damaged", "dent", "crush"],
    targets: [
      { text: "内衬与固定方式", anchors: ["内衬", "固定", "包装"] },
      { text: "外箱强度与堆码", anchors: ["外箱", "纸箱", "堆码", "运输"] },
      { text: "易变形部位的支撑", anchors: ["变形", "压坏", "破损"] },
    ],
    sideEffects: ["加强包装可能提高体积重与运费", "缓冲材料增加可能影响开箱体验"],
    costs: ["包装升级带来的单件成本与体积重变化未核算"],
    compliance: ["包装材料环保与标示要求需确认"],
  },
  {
    category: "quality_consistency",
    label: "质量一致性",
    keywords: ["批次", "不一致", "掉色", "瑕疵", "色差", "quality", "batch", "inconsistent", "defect", "color difference"],
    targets: [
      { text: "来料检验项与抽检比例", anchors: ["批次", "不一致", "抽检", "来料"] },
      { text: "关键尺寸公差", anchors: ["公差", "尺寸偏差", "偏差"] },
      { text: "外观色差标准", anchors: ["色差", "掉色", "瑕疵"] },
    ],
    sideEffects: ["加严检验可能提高采购成本与交期", "公差收紧可能降低良率"],
    costs: ["全检 / 抽检方案的成本差异未知"],
    compliance: ["是否需要第三方检测报告待确认"],
  },
  {
    category: "expectation_mismatch",
    label: "用户预期不匹配",
    keywords: ["预期", "不如", "失望", "落差", "夸大", "disappoint", "expectation", "not as"],
    targets: [
      { text: "Listing 卖点与限制的表述", anchors: ["预期", "夸大", "描述", "卖点"] },
      { text: "主图与场景图的信息准确性", anchors: ["主图", "场景图", "图片"] },
    ],
    sideEffects: ["弱化卖点可能影响转化率", "补充限制说明可能降低点击意愿"],
    costs: ["无直接物料成本；改图与文案的运营成本未知"],
    compliance: ["宣传表述合规性需按目标市场广告规则确认"],
  },
];

const VERIFICATION_RULES: readonly {
  readonly category: ImprovementVerificationCategory;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly suggested: string;
}[] = [
  {
    category: "competitor_comparison",
    label: "对比现有竞品",
    keywords: ["竞品", "对比", "同类", "代表商品", "comparison", "competitor", "benchmark"],
    suggested: "与已选代表商品逐项对比该部位的结构与规格，确认差异是否真实存在。",
  },
  {
    category: "review_recheck",
    label: "复核买家反馈",
    keywords: ["评论", "反馈", "买家", "review", "feedback", "voice"],
    suggested: "扩大评论样本复核该问题出现频次与场景，确认是否为少数个案。",
  },
  {
    category: "dimension_measurement",
    label: "测量实际尺寸",
    keywords: ["测量", "尺寸", "公差", "measure", "dimension"],
    suggested: "实测样品关键尺寸与公差，核对是否与宣称规格一致。",
  },
  {
    category: "material_structure_check",
    label: "检查材料与结构方案",
    keywords: ["材料", "结构", "方案", "材质", "material", "structure"],
    suggested: "拆解样品确认材料牌号与结构受力方式，判断改动是否落在该部位。",
  },
  {
    category: "sample_test",
    label: "样品测试",
    keywords: ["样品", "打样", "对照", "清洗测试", "测试", "sample", "prototype", "test", "a/b"],
    suggested: "按对照条件打样并测试，记录可量化指标（如清洁耗时、施力次数）。",
  },
  {
    category: "supplier_process",
    label: "供应商工艺确认",
    keywords: ["供应商", "工艺", "工厂", "开模", "supplier", "process", "tooling"],
    suggested: "向供应商确认该改动在现有工艺与模具下能否实现，以及需要哪些改模。",
  },
  {
    category: "cost_accounting",
    label: "核算成本变化",
    keywords: ["成本", "报价", "价格", "费用", "cost", "price"],
    suggested: "核算改动带来的单件成本增量与目标售价空间；未取得报价前不得预估数值。",
  },
  {
    category: "compliance_check",
    label: "核查合规要求",
    keywords: ["合规", "认证", "法规", "标准", "compliance", "certification", "regulation"],
    suggested: "核查目标市场对该材质 / 用途的强制要求与标识义务。",
  },
  {
    category: "user_trial",
    label: "真实用户试用",
    keywords: ["用户", "试用", "体验", "user", "trial", "usability"],
    suggested: "以真实用户试用验证问题是否真的被解决，而不是只改外观。",
  },
];

const CATEGORY_LABELS: Readonly<Record<ImprovementAttributionCategory, string>> = {
  ...(Object.fromEntries(ATTRIBUTION_RULES.map((rule) => [rule.category, rule.label])) as Record<Exclude<ImprovementAttributionCategory, "unclassified">, string>),
  unclassified: "未归类（需人工判断）",
};

/** 没有足够部位关联时的统一说明：不输出整类模板，改为要求人工确认部位。 */
/** 只有问题陈述时的统一说明：先补原因，再谈改动。 */
const BLOCKED_BY_MISSING_CAUSE_NOTE =
  "目前只能确认存在用户反馈的问题，尚不足以判断具体改良方向。需先补充可区分的原因假设（例如材料弹性、尺寸配合、操作方式）并用实物/样品验证，再决定是否改动结构；此处不输出任何改良对象。";

const UNRESOLVED_TARGET_NOTE =
  "已识别该产品问题，但现有规则不足以确定具体改良部位与原因；需先复核实物结构与使用场景，确认具体部位后再谈改动（不输出整类模板）。";

type TargetSelection = {
  readonly targets: string[];
  readonly anchors: string[];
  readonly unresolved: boolean;
};

/**
 * 部位锚点选择（rules.v3）。
 *
 * 旧版只要归因命中「结构设计」就会把内壁 / 开口 / 底部 / 密封五条模板全倒出来，
 * 真实案例（卡扣按压费力）因此出现与卡扣毫无关系的「内壁形状」「底部接触面积」，
 * 制造了虚假的专业感。现在只有锚点词出现在问题文本里，才允许输出对应模板；
 * 一条都匹配不上就明确说"无法确定部位"，而不是拿整类模板凑数。
 */
function selectTargets(rule: AttributionRule | null, claim: string): TargetSelection {
  if (!rule) return { targets: [], anchors: [], unresolved: true };
  const haystack = normalize(claim);
  const matched = rule.targets.filter((target) => target.anchors.some((anchor) => haystack.includes(normalize(anchor))));
  if (!matched.length) return { targets: [], anchors: [], unresolved: true };
  const anchors = [...new Set(matched.flatMap((target) => target.anchors.filter((anchor) => haystack.includes(normalize(anchor)))))];
  return { targets: matched.slice(0, 2).map((target) => target.text), anchors, unresolved: false };
}

function normalize(value: string): string {
  return value.toLowerCase();
}

/**
 * 非产品复合词：先把它们从文本里摘掉，避免「市场结构」被当成「产品结构」。
 * 只处理已知的高混淆组合，不做通用语义理解。
 */
const NON_PRODUCT_PHRASES: readonly string[] = [
  "市场结构", "竞争结构", "流量结构", "评论结构", "价格结构", "成本结构", "listing结构", "listing 结构",
  "变体结构", "产品线结构", "渠道结构", "客群结构", "需求结构", "类目结构", "头部结构", "流量占比",
];

/**
 * 市场结构**强信号**：一旦出现在「原因段」，就说明讨论对象是市场位置 / 流量 / 变体聚合。
 * 注意：「变体」单独不再是强信号——真实反例「某变体尺寸过小导致安装失败」讨论的仍是产品。
 */
const MARKET_STRUCTURE_SIGNALS: readonly string[] = [
  "同父体", "父子变体", "父体流量", "变体共享", "共享流量", "共享评论", "评论归属", "流量分配", "自然流量",
  "子类头部", "市场份额", "市场结构", "竞争结构", "变体结构", "流量结构", "价格结构", "listing结构",
  "排名机制", "搜索排名", "广告投放", "曝光", "流量占比",
];

/** 市场 / 运营**弱信号**：单独出现不足以否决产品问题，仅用于「无法归类」时判非产品。 */
const MARKET_WEAK_SIGNALS: readonly string[] = [
  "变体", "流量", "排名", "bsr", "listing", "转化率", "广告", "搜索量", "销量", "定价", "价格带",
  "品牌", "竞争", "类目", "促销", "coupon", "评论数", "市场份额", "market",
];

/**
 * 产品侧**问题**信号：描述产品本身的缺陷 / 失效 / 使用困难。
 * 「可改良」的前提是假设里确实存在问题陈述，而不只是提到一个产品属性。
 */
const PRODUCT_PROBLEM_SIGNALS: readonly string[] = [
  "断裂", "开裂", "断开", "裂缝", "破损", "渗漏", "漏水", "漏油", "变形", "松动", "脱落", "掉漆", "掉色",
  "生锈", "氧化", "发黄", "异味", "残留", "油污", "粘", "吸附", "难洗", "难以清洗", "清洗困难", "清洁困难",
  "洗不净", "擦不净", "太滑", "打滑", "滑手", "太软", "过软", "太硬", "过硬", "太重", "太小", "太大",
  "过小", "过大", "偏小", "偏大", "不足", "不够", "无法", "不能", "难以", "失败", "装反", "装不上",
  "卡住", "卡死", "不耐用", "寿命", "磨损", "老化", "起皮", "掉渣", "划伤", "划痕", "色差", "瑕疵",
  "不良", "做工", "抱怨", "差评", "投诉", "退货", "退回", "撕不开", "变形",
  // 真实 v5 痛点常见措辞：厚度 / 施力 / 尺寸偏差 / 安装费力。只收「明确的负面体验」，
  // 不收「厚度」「尺寸」这类中性属性（那是部位线索，不是问题陈述）。
  "太薄", "偏薄", "过薄", "太厚", "偏厚", "费力", "较大力度", "力度过大", "费时", "难按", "按不动",
  "卡不紧", "不稳", "刮手", "硌手", "偏软", "偏硬", "短于", "长于", "吸附灰尘", "沾灰",
  // 比较式与程度式缺陷（真实 v5 痛点写法：「更薄」「比预期小」「非常薄」「偏滑」「柔软」）
  "薄", "比预期", "偏滑", "滑动", "很滑", "较滑", "柔软", "廉价", "不符", "偏差",
];

/**
 * 产品侧**对象**信号：指向产品的结构 / 材料 / 尺寸 / 用法部位，用于确认讨论对象。
 * 只命中 1 个且没有问题陈述时不足以判定「产品问题」（例如「多尺寸 3 件装组合」是在讲组合定位）。
 */
const PRODUCT_SUBJECT_SIGNALS: readonly string[] = [
  "卡扣", "铰链", "内壁", "开口", "盖子", "密封", "缝隙", "接缝", "结构", "材质", "材料", "硅胶",
  "塑料", "橡胶", "表面", "涂层", "尺寸", "厚度", "容量", "底面", "底盘", "握持", "手柄", "垫体",
  "边缘", "支架", "卡槽", "螺纹", "做工", "安装", "组装",
];

/** 原因在前：「A 导致 B」中的 A 是原因。 */
const CAUSE_BEFORE_MARKERS: readonly string[] = ["导致", "造成", "使得", "引起", "带来", "从而", "因此", "进而", "以致", "决定"];

/** 原因在后：「A 来自 / 因为 B」中的 B 是原因。 */
const CAUSE_AFTER_MARKERS: readonly string[] = ["来自", "源于", "源自", "因为", "由于", "归因于", "取决于", "是因为"];

/** 对照尾：「……，而非 X」中的 X 是被否定的解释，判定原因时先摘掉。 */
const CONTRAST_MARKERS: readonly string[] = ["而非", "而不是", "并非", "而不是因为", "而不是由于"];

function hits(text: string, keywords: readonly string[]): string[] {
  const haystack = normalize(text);
  return keywords.filter((keyword) => haystack.includes(normalize(keyword)));
}

/** 摘掉「……，而非 X」这类被否定解释。 */
function stripContrastTail(text: string): string {
  let cut = text.length;
  for (const marker of CONTRAST_MARKERS) {
    const at = text.indexOf(marker);
    if (at >= 0 && at < cut) cut = at;
  }
  return cut === text.length ? text : text.slice(0, cut);
}

/**
 * 摘掉读侧投影加的方括号标签。
 *
 * 真实案例：v1 读侧投影会在假设前加
 * `【待验证原因假设】【待验证假设：引用仅关联触发观察，不能确认因果或工程原因；…】`。
 * 这段是**投影说明**，不是假设内容；但它含「不能」「工程原因」等词，会被闸门读成
 * 产品问题陈述，把「子类头部来自同父体变体共享流量」这类市场假设判成混合问题。
 * 投影标签不得参与可改良性判定。
 */
function stripProjectionLabels(text: string): string {
  let rest = text.trim();
  for (let guard = 0; guard < 5; guard += 1) {
    if (!rest.startsWith("【")) break;
    const end = rest.indexOf("】");
    if (end < 0) break;
    rest = rest.slice(end + 1).trim();
  }
  return rest.length ? rest : text;
}

/** 剥离非产品复合词后再做归因匹配，避免「市场结构」被读成「产品结构」。 */
function stripNonProductPhrases(text: string): string {
  let result = text;
  for (const phrase of NON_PRODUCT_PHRASES) result = result.split(phrase).join(" ");
  return result;
}

type CauseSegment = { readonly text: string; readonly marker: string | null };

/**
 * 抽取「原因段」：只看假设在讲什么原因，而不是它带来的市场结果。
 * 这是「市场词汇不误杀产品问题」的关键——「卡扣容易断裂，导致流量下降」的讨论对象是卡扣，
 * 不是流量。找不到因果标记时整句即原因段。
 */
function causeSegment(text: string): CauseSegment {
  let best: { at: number; marker: string; after: boolean } | null = null;
  const scan = (markers: readonly string[], after: boolean) => {
    for (const marker of markers) {
      const at = text.indexOf(marker);
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && marker.length > best.marker.length)) best = { at, marker, after };
    }
  };
  scan(CAUSE_BEFORE_MARKERS, false);
  scan(CAUSE_AFTER_MARKERS, true);
  if (!best) return { text, marker: null };
  const chosen = best as { at: number; marker: string; after: boolean };
  const segment = chosen.after
    ? text.slice(chosen.at + chosen.marker.length)
    : text.slice(0, chosen.at);
  return segment.trim().length ? { text: segment, marker: chosen.marker } : { text, marker: null };
}

type ActionabilityAnalysis = {
  readonly status: ImprovementActionabilityStatus;
  readonly reason: string | null;
  readonly basis: string;
};

/**
 * 三态可改良性闸门（v2）。
 *
 * 旧版是二元判断：命中「同父体 / 变体 / 流量」等词即否决。这解决了真实案例里
 * 「变体共享流量」被派生成「内壁形状」的错位，但也带来两个新问题：
 *  - 「卡扣容易断裂，导致流量下降」会因出现「流量」被误杀；
 *  - 「某变体尺寸过小导致安装失败」会因出现「变体」被误杀。
 * 因此改为：先定位**假设讨论的主要对象**（原因段），再看它是产品问题、市场结构，
 * 还是两者纠缠无法区分。
 */
function analyzeActionability(claim: string): ActionabilityAnalysis {
  const base = stripContrastTail(claim);
  const segment = causeSegment(base);
  // 判定前先摘掉「市场结构 / 变体结构」复合词，否则「市场结构」会被数成产品「结构」线索。
  const causeText = stripNonProductPhrases(segment.text);
  const phrases = NON_PRODUCT_PHRASES.filter((phrase) => normalize(base).includes(normalize(phrase)));
  const marketStrongCause = hits(segment.text, MARKET_STRUCTURE_SIGNALS);
  const marketWeakCause = hits(causeText, MARKET_WEAK_SIGNALS);
  const problemCause = hits(causeText, PRODUCT_PROBLEM_SIGNALS);
  const subjectCause = hits(causeText, PRODUCT_SUBJECT_SIGNALS);
  const strongCount = marketStrongCause.length + phrases.length;

  const basisParts = [
    `原因段：${segment.text.slice(0, 80)}`,
    subjectCause.length ? `产品部位线索：${subjectCause.slice(0, 4).join("、")}` : "产品部位线索：无",
    problemCause.length ? `产品问题线索：${problemCause.slice(0, 4).join("、")}` : "产品问题线索：无",
    strongCount || marketWeakCause.length
      ? `市场线索：${[...phrases, ...marketStrongCause, ...marketWeakCause].slice(0, 4).join("、")}`
      : "市场线索：无",
  ];
  const basis = basisParts.join("；");

  // 产品侧证据只认「原因段」内的问题陈述或部位线索。
  // 不能用整句兜底：市场句里常出现「难以获得曝光」这类通用否定词，会把市场问题读成产品问题。
  const productEvidence = problemCause.length > 0 || subjectCause.length >= 2;

  if (strongCount === 0) {
    if (productEvidence) {
      return { status: "PRODUCT_ACTIONABLE", reason: null, basis };
    }
    if (marketWeakCause.length >= 2) {
      return {
        status: "NON_PRODUCT",
        reason: "该假设指向市场 / 运营层（流量、排名、定价、广告或销量表现），没有可识别的产品工程问题，不派生改良对象；应回到 02 市场研究处理。",
        basis,
      };
    }
    return {
      status: "MIXED_OR_UNCERTAIN",
      reason: "现有确定性规则无法确认该假设是否属于产品问题（既无明确产品问题陈述，也无明确市场结构线索）。不派生候选改良对象，需人工确认假设所指部位后再判断。",
      basis,
    };
  }

  // 原因段同时出现产品与市场结构线索：不强行择一。
  if (productEvidence) {
    return {
      status: "MIXED_OR_UNCERTAIN",
      reason: "该假设同时包含产品层与市场层因素（原因段内既有产品问题/部位线索，也有市场结构线索），现有规则无法可靠区分主因。不派生确定的改良对象，需人工拆分假设或补充区分性证据。",
      basis,
    };
  }

  return {
    status: "NON_PRODUCT",
    reason: `命中市场 / 运营层结构线索：${[...phrases, ...marketStrongCause].slice(0, 5).join("、")}。这类假设讨论的是市场位置、流量、变体聚合或评论归属，不是产品本身的工程问题，不派生改良对象；应回到 02 市场研究处理。`,
    basis,
  };
}

function matchRule(text: string, keywords: readonly string[]): string[] {
  const haystack = normalize(text);
  return keywords.filter((keyword) => haystack.includes(normalize(keyword)));
}

function classify(text: string): { primary: ImprovementAttributionCategory; all: ImprovementAttributionCategory[]; basis: string } {
  const scored = ATTRIBUTION_RULES.map((rule) => ({ rule, hits: matchRule(text, rule.keywords) }))
    .filter((item) => item.hits.length > 0)
    .sort((left, right) => right.hits.length - left.hits.length);
  if (!scored.length) {
    return { primary: "unclassified", all: ["unclassified"], basis: "未命中任何归因关键词" };
  }
  const primary = scored[0]!;
  return {
    primary: primary.rule.category,
    all: scored.map((item) => item.rule.category),
    basis: `命中「${primary.rule.label}」关键词：${primary.hits.slice(0, 5).join("、")}`,
  };
}

function ruleOf(category: ImprovementAttributionCategory): AttributionRule | null {
  return ATTRIBUTION_RULES.find((rule) => rule.category === category) ?? null;
}

function templateItems(list: readonly string[]): ImprovementCheckItem[] {
  return list.map((text) => ({ text, source: "TEMPLATE_CHECK" as const }));
}

function classifyVerification(action: string): ImprovementVerificationCategory {
  const scored = VERIFICATION_RULES.map((rule) => ({ rule, hits: matchRule(action, rule.keywords) }))
    .filter((item) => item.hits.length > 0)
    .sort((left, right) => right.hits.length - left.hits.length);
  return scored[0]?.rule.category ?? "other";
}

function labelOfVerification(category: ImprovementVerificationCategory): string {
  return VERIFICATION_RULES.find((rule) => rule.category === category)?.label ?? "其他验证";
}

/**
 * 把「研究里已有的差异化方向」与单条原因关联起来。
 *
 * 中文没有词边界，按空格切词会全部落空，因此复用归因规则的关键词表做交集：
 * 方向文本命中的关键词必须**同时出现在原因文本里**才算关联，避免把无关方向硬挂上来。
 * 匹配不上就返回空数组，宁可不关联也不制造对应关系。
 */
function linkDirections(directions: readonly string[], text: string): string[] {
  const haystack = normalize(text);
  return directions.filter((direction) => {
    const keywords = ATTRIBUTION_RULES.flatMap((rule) => matchRule(direction, rule.keywords));
    if (!keywords.length) return false;
    return keywords.some((keyword) => haystack.includes(normalize(keyword)));
  }).slice(0, 4);
}

/**
 * 证据线索概况。
 *
 * 只数已持久化线索的条数。以下解读一律禁止：独立证据数、独立买家数、问题发生率、
 * 统计显著性、因果可信度。同一评论被摘要两次、多个模型摘要指向同一评论，都会让条数虚高。
 */
function evidenceOf(cause: ImprovementPlanCause): ImprovementHypothesisItem["evidence"] {
  const supportingCount = cause.supportingEvidence.length;
  const counterCount = cause.counterevidence.length;
  const unknownCount = cause.unknowns.length;
  const basis = `支持线索 ${supportingCount} 条 / 反证线索 ${counterCount} 条 / 未知事项 ${unknownCount} 条（按已持久化线索计数）`;
  const base = {
    supportingCount,
    counterCount,
    unknownCount,
    modelConfidence: cause.confidence,
    summaryLabel: EVIDENCE_SUMMARY_LABEL,
    basis,
    scopeNote: EVIDENCE_SCOPE_NOTE,
  } as const;
  if (supportingCount === 0) {
    return { ...base, level: "no_support", levelLabel: "无支持线索" };
  }
  if (counterCount > 0) {
    return { ...base, level: "conflicting", levelLabel: "存在反证线索（需先区分）" };
  }
  if (supportingCount === 1) {
    return { ...base, level: "single_mention", levelLabel: "单条支持线索（不足以定论）" };
  }
  return { ...base, level: "multiple_mentions", levelLabel: "多条支持线索（可能来自同一来源，仍未确认因果）" };
}

function buildItem(cause: ImprovementPlanCause, index: number, directions: readonly string[]): ImprovementHypothesisItem {
  const text = [cause.hypothesis, cause.rationale ?? "", ...cause.unknowns].join(" ");
  // 可改良性与归因只看**假设句本身**。
  // 真实案例（#5 第 3 条）：假设句是「太滑/难洗净来自硅胶表面与垫体过软」——明确的产品问题，
  // 但 rationale/unknowns 里写了「评论归属无法区分」，若把整段并入判定，就会把这条
  // 正确的产品假设误判成市场问题而整体屏蔽掉。证据机制的描述不能否决假设本身的性质。
  const claim = stripProjectionLabels(cause.hypothesis);
  const actionability = analyzeActionability(claim);
  const actionable = actionability.status === "PRODUCT_ACTIONABLE";
  // 归因匹配前先摘掉「市场结构 / 变体结构」这类非产品复合词，避免归错类。
  const attribution = classify(stripNonProductPhrases(claim));
  const rule = actionable ? ruleOf(attribution.primary) : null;
  const selection = actionable ? selectTargets(rule, claim) : { targets: [], anchors: [], unresolved: false };
  const verificationTasks: ImprovementVerificationTask[] = cause.verification.map((task) => {
    const category = classifyVerification(task);
    return { category, label: labelOfVerification(category), task, source: "RESEARCH" as const };
  });
  const covered = new Set(verificationTasks.map((task) => task.category));
  const missing = VERIFICATION_RULES
    .filter((item) => !covered.has(item.category))
    .map((item) => item.category);
  const notProduct: ImprovementCheckItem[] = [{
    text: actionability.status === "NON_PRODUCT"
      ? "该假设不属于产品可改良范围，不派生改良对象、副作用、成本或合规检查；请回到 02 市场研究按市场 / 竞争结论处理。"
      : "该假设的处理方式尚未确定，不派生改良对象、副作用、成本或合规检查；需人工拆分或补充区分性证据后再判断。",
    source: "TEMPLATE_CHECK",
  }];
  return {
    index,
    inputKind: "CAUSE_HYPOTHESIS",
    inputKindLabel: INPUT_KIND_LABELS.CAUSE_HYPOTHESIS,
    hypothesis: cause.hypothesis,
    rationale: cause.rationale,
    attribution: {
      primary: actionable ? attribution.primary : "unclassified",
      primaryLabel: actionable ? CATEGORY_LABELS[attribution.primary] : ACTIONABILITY_LABELS[actionability.status],
      all: attribution.all,
      basis: actionable
        ? attribution.basis
        : actionability.status === "NON_PRODUCT"
          ? "该假设讨论市场 / 流量 / 变体结构，不参与产品归因"
          : "该假设的产品 / 市场属性无法可靠区分，不参与产品归因",
    },
    rootCauseStatus: "ROOT_CAUSE_UNVERIFIED",
    actionabilityStatus: actionability.status,
    actionabilityLabel: ACTIONABILITY_LABELS[actionability.status],
    productActionable: actionable,
    actionabilityReason: actionability.reason,
    actionabilityBasis: actionability.basis,
    problemNature: classifyProblemNature(claim).nature,
    competitiveExplanations: competitiveExplanationsFor(claim),
    candidateTargets: actionable ? selection.targets : [],
    targetStatus: actionable ? (selection.unresolved ? "UNRESOLVED" : "ANCHORED") : "NOT_APPLICABLE",
    partAnchors: selection.anchors,
    targetNote: actionable && selection.unresolved ? UNRESOLVED_TARGET_NOTE : null,
    linkedDirections: actionable ? linkDirections(directions, text) : [],
    sideEffects: actionable ? templateItems(rule ? rule.sideEffects : ["需人工列出改动后可能牺牲的其他性能（当前假设未指向具体部位，无法给出通用副作用清单）。"]) : notProduct,
    costUncertainties: actionable ? templateItems(rule ? rule.costs : ["需人工核算改动带来的成本变化；未取得报价前不得预估数值。"]) : notProduct,
    complianceChecks: actionable ? templateItems(rule ? rule.compliance : ["需人工核查该改动涉及的合规要求。"]) : notProduct,
    verificationTasks,
    missingVerificationCategories: actionable || actionability.status === "MIXED_OR_UNCERTAIN" ? missing : [],
    evidence: evidenceOf(cause),
    unknowns: cause.unknowns,
  };
}

/**
 * 由「问题陈述」派生（v5 综合研报路径）。
 *
 * v5 研报有真实 VOC 痛点与引用，但**没有**原因假设 / 提出理由 / 逐条反证 / 逐条未知 / 验证动作。
 * 因此这里只做三件确定的事：
 *   1. 用同一套三态闸门判断这条问题陈述讨论的是产品还是市场；
 *   2. 对产品问题给出模板候选方向（根因仍未确认）；
 *   3. 明确写出缺什么（没有原因、没有验证动作），不补造。
 */
function buildObservationItem(observation: ImprovementPlanObservation, index: number): ImprovementHypothesisItem {
  const statement = stripProjectionLabels(observation.statement);
  const actionability = analyzeActionability(statement);
  const actionable = actionability.status === "PRODUCT_ACTIONABLE";
  const attribution = classify(stripNonProductPhrases(statement));
  const rule = actionable ? ruleOf(attribution.primary) : null;
  const selection = actionable ? selectTargets(rule, statement) : { targets: [], anchors: [], unresolved: false };
  const refCount = observation.evidenceRefs.length;
  const basis = `引用 ${refCount} 条（VOC 观察；同一评论可能被多次引用，不代表独立买家数）`;
  const evidence: ImprovementHypothesisItem["evidence"] = {
    level: refCount === 0 ? "no_support" : refCount === 1 ? "single_mention" : "multiple_mentions",
    levelLabel: refCount === 0 ? "无支持线索" : refCount === 1 ? "单条支持线索（不足以定论）" : "多条支持线索（可能来自同一来源，仍未确认因果）",
    summaryLabel: EVIDENCE_SUMMARY_LABEL,
    supportingCount: refCount,
    counterCount: 0,
    unknownCount: 0,
    modelConfidence: "unknown",
    basis,
    scopeNote: `${EVIDENCE_SCOPE_NOTE} 该研报没有逐条反证与未知事项字段，缺失不等于没有。`,
  };
  const missing = VERIFICATION_RULES.map((item) => item.category);
  const notProduct: ImprovementCheckItem[] = [{
    text: actionability.status === "NON_PRODUCT"
      ? "该问题陈述不属于产品可改良范围，不派生改良对象；请回到 02 市场研究按市场 / 竞争结论处理。"
      : "该问题陈述的产品 / 市场属性无法可靠区分，不派生确定的改良对象；需人工拆分或补充区分性证据。",
    source: "TEMPLATE_CHECK",
  }];
  return {
    index,
    inputKind: "PROBLEM_OBSERVATION",
    inputKindLabel: INPUT_KIND_LABELS.PROBLEM_OBSERVATION,
    hypothesis: observation.statement,
    rationale: null,
    attribution: {
      primary: actionable ? attribution.primary : "unclassified",
      primaryLabel: actionable ? CATEGORY_LABELS[attribution.primary] : ACTIONABILITY_LABELS[actionability.status],
      all: attribution.all,
      basis: actionable ? `问题归类：${attribution.basis}` : "该问题陈述讨论市场 / 运营层，不参与产品归因",
    },
    rootCauseStatus: "ROOT_CAUSE_UNVERIFIED",
    actionabilityStatus: actionability.status,
    actionabilityLabel: ACTIONABILITY_LABELS[actionability.status],
    productActionable: actionable,
    actionabilityReason: actionability.reason,
    actionabilityBasis: actionability.basis,
    // 只有问题陈述、没有原因假设时，绝不输出具体改良对象（避免「卡扣费力 → 应该改卡扣」的跳跃）。
    problemNature: classifyProblemNature(statement).nature,
    competitiveExplanations: competitiveExplanationsFor(statement),
    candidateTargets: [],
    targetStatus: actionable ? "BLOCKED_BY_MISSING_CAUSE" : "NOT_APPLICABLE",
    partAnchors: selection.anchors,
    targetNote: actionable ? BLOCKED_BY_MISSING_CAUSE_NOTE : null,
    linkedDirections: [],
    sideEffects: actionable ? templateItems(rule ? rule.sideEffects : ["需人工列出改动后可能牺牲的其他性能。"]) : notProduct,
    costUncertainties: actionable ? templateItems(rule ? rule.costs : ["需人工核算改动带来的成本变化；未取得报价前不得预估数值。"]) : notProduct,
    complianceChecks: actionable ? templateItems(rule ? rule.compliance : ["需人工核查该改动涉及的合规要求。"]) : notProduct,
    // v5 没有验证动作字段：留空并标为「研报未给出」，不写建议动作冒充研究结论。
    verificationTasks: [],
    missingVerificationCategories: actionable ? missing : [],
    evidence,
    unknowns: [],
  };
}

const STATUS_LABELS: Readonly<Record<ImprovementPlanStatus, string>> = {
  NO_ACTIONABLE_CAUSE: "无可执行改良假设",
  NO_PRODUCT_ACTIONABLE_CAUSE: "无产品可改良假设（仅有市场 / 运营层原因）",
  MIXED_NEEDS_HUMAN_SPLIT: "混合假设（需人工拆分后再判断）",
  OBSERVATION_ONLY: "仅有问题陈述（缺原因假设与验证动作）",
  NEEDS_MORE_EVIDENCE: "证据不足，先补证据",
  // 旧标签「可进入低成本验证」会被读成「已经可以往下走」，改成必须先做区分性验证。
  NEEDS_VERIFICATION: "需先做区分性验证",
  READY_FOR_LOW_COST_VALIDATION: "具备低成本验证条件（≠ 可以立项）",
};

/** 32 位 FNV-1a：稳定、纯 JS、可在浏览器与服务端得到同一结果。 */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 派生结果摘要：只覆盖「派生判定」字段，不覆盖原文与证据，避免被误读为事实哈希。
 * 用途：人工比对同一规则版本下两次派生是否一致。
 */
function derivationDigestOf(input: {
  readonly rulesVersion: string;
  readonly status: ImprovementPlanStatus;
  readonly items: readonly ImprovementHypothesisItem[];
}): string {
  const payload = JSON.stringify({
    rulesVersion: input.rulesVersion,
    status: input.status,
    items: input.items.map((item) => ({
      index: item.index,
      inputKind: item.inputKind,
      hypothesis: item.hypothesis,
      actionabilityStatus: item.actionabilityStatus,
      attribution: item.attribution.primary,
      targets: item.candidateTargets,
      targetStatus: item.targetStatus,
      verification: item.verificationTasks.map((task) => task.category),
    })),
  });
  return `ipd-${fnv1a32(`${input.rulesVersion}|${payload}`)}`;
}

export function buildImprovementPlan(input: {
  readonly causes?: readonly ImprovementPlanCause[];
  /** v5 路径：只有问题陈述，没有原因假设。 */
  readonly observations?: readonly ImprovementPlanObservation[];
  readonly differentiationDirections?: readonly string[];
  /** 研究契约缺字段时的披露（来自读侧投影，不由派生层推断）。 */
  readonly sourceDisclosure?: {
    readonly sourceKind: "v1" | "v5" | "unknown";
    readonly missingFacts: readonly string[];
  };
}): ImprovementPlan {
  const directions = input.differentiationDirections ?? [];
  const causes = input.causes ?? [];
  const observations = input.observations ?? [];
  const items: ImprovementHypothesisItem[] = [
    ...causes
      .filter((cause) => cause.hypothesis.trim().length > 0)
      .map((cause, index) => buildItem(cause, index, directions)),
    ...observations
      .filter((observation) => observation.statement.trim().length > 0)
      .map((observation, index) => buildObservationItem(observation, index + causes.filter((cause) => cause.hypothesis.trim().length > 0).length)),
  ];
  const inputKinds: ImprovementPlanInputKind[] = items.some((item) => item.inputKind === "CAUSE_HYPOTHESIS")
    ? (items.some((item) => item.inputKind === "PROBLEM_OBSERVATION") ? ["CAUSE_HYPOTHESIS", "PROBLEM_OBSERVATION"] : ["CAUSE_HYPOTHESIS"])
    : (items.some((item) => item.inputKind === "PROBLEM_OBSERVATION") ? ["PROBLEM_OBSERVATION"] : []);
  const sourceDisclosure = input.sourceDisclosure
    ? {
        sourceKind: input.sourceDisclosure.sourceKind,
        missingFacts: input.sourceDisclosure.missingFacts,
        note: input.sourceDisclosure.missingFacts.length
          ? `该研报缺少改良假设所需的 ${input.sourceDisclosure.missingFacts.length} 类字段（${input.sourceDisclosure.missingFacts.join("、")}）；缺的字段不补造，改用可直接引用的内容并明确降级。`
          : "该研报包含改良假设所需的字段。",
      }
    : null;

  const actionable = items.filter((item) => item.productActionable);
  const mixed = items.filter((item) => item.actionabilityStatus === "MIXED_OR_UNCERTAIN");
  // 归因分布只统计「产品可改良」的假设：市场 / 运营层原因混进来会让分布失真。
  const counts = new Map<ImprovementAttributionCategory, number>();
  for (const item of actionable) counts.set(item.attribution.primary, (counts.get(item.attribution.primary) ?? 0) + 1);
  const attributionCounts = [...counts.entries()]
    .map(([category, count]) => ({ category, label: CATEGORY_LABELS[category], count }))
    .sort((left, right) => right.count - left.count);

  const actionabilityCounts = (["PRODUCT_ACTIONABLE", "NON_PRODUCT", "MIXED_OR_UNCERTAIN"] as const)
    .map((status) => ({
      status,
      label: ACTIONABILITY_LABELS[status],
      count: items.filter((item) => item.actionabilityStatus === status).length,
    }))
    .filter((entry) => entry.count > 0);

  // 所有可改良条目都缺的验证类别 = 整份计划层面的共同盲区
  const missingVerificationCategories = VERIFICATION_RULES
    .map((rule) => rule.category)
    .filter((category) => actionable.length > 0 && actionable.every((item) => item.missingVerificationCategories.includes(category)));

  let status: ImprovementPlanStatus;
  let statusReason: string;
  if (!items.length) {
    status = "NO_ACTIONABLE_CAUSE";
    statusReason = "研报未提出可执行的原因假设，无法派生改良方向；不要在此状态下编写开发要求。";
  } else if (!actionable.length) {
    if (mixed.length) {
      status = "MIXED_NEEDS_HUMAN_SPLIT";
      statusReason = "研报提出的原因里既有市场层判断，也有无法确认归属的部分；本页不派生确定的改良方向，需人工拆分假设或补充区分性证据。";
    } else {
      status = "NO_PRODUCT_ACTIONABLE_CAUSE";
      statusReason = "研报提出的原因都指向市场 / 流量 / 变体结构，不是产品本身的工程问题；本页不派生改良方向，请回到 02 市场研究处理。";
    }
  } else if (!causes.some((cause) => cause.hypothesis.trim().length > 0) && observations.length > 0) {
    status = "OBSERVATION_ONLY";
    statusReason = "研报只给出问题陈述（VOC 观察），没有逐项原因假设与验证动作；因此不输出任何改良对象，只列出问题与需要补充的验证。需先补原因假设与区分性验证，不能据此立项。";
  } else if (actionable.every((item) => item.evidence.level === "no_support")) {
    status = "NEEDS_MORE_EVIDENCE";
    statusReason = "所有产品层原因假设都缺少可追溯支持线索，先补证据再谈改良。";
  } else if (actionable.some((item) => item.evidence.level === "conflicting" || item.evidence.level === "single_mention")
    || actionable.every((item) => item.verificationTasks.length === 0)) {
    status = "NEEDS_VERIFICATION";
    statusReason = `存在反证线索、单条线索或缺少验证动作的假设，必须先做区分性验证，不能直接进入开发。${STATUS_MEANING_NOTE}`;
  } else {
    status = "READY_FOR_LOW_COST_VALIDATION";
    statusReason = `至少一条假设具备多条支持线索与验证动作，可进入低成本验证。${STATUS_MEANING_NOTE}`;
  }

  return {
    schema: "improvement-plan.v1",
    status,
    statusLabel: STATUS_LABELS[status],
    statusReason,
    rulesVersion: IMPROVEMENT_RULES_VERSION,
    rulesVersionNote: IMPROVEMENT_RULES_VERSION_NOTE,
    derivationDigest: derivationDigestOf({ rulesVersion: IMPROVEMENT_RULES_VERSION, status, items }),
    items,
    inputKinds,
    sourceDisclosure,
    actionabilityCounts,
    attributionCounts,
    missingVerificationCategories,
    disclaimer: IMPROVEMENT_DISCLAIMER,
  };
}

/** 供 UI / 导出复用的建议验证项文本（按缺失类别）。 */
export function suggestedVerificationText(category: ImprovementVerificationCategory): string | null {
  return VERIFICATION_RULES.find((rule) => rule.category === category)?.suggested ?? null;
}
