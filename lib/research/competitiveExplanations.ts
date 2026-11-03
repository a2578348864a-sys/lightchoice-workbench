/**
 * 产品属性 vs 产品缺陷：竞争性解释（确定性、可复用）。
 *
 * 真实问题（P5-v6）：硅胶垫「薄、软、尺寸差 1 英寸」这类描述被直接当成"产品缺陷"，
 * 进而暗示"应该加厚加硬/改尺寸"。但同一个属性至少有 5 类竞争性解释：
 * 品类固有设计取舍、价格段成本约束、宣传与实测不一致、用户预期偏差、批次一致性。
 *
 * 本模块只做两件事：
 *  1. 判断一条问题陈述更像「属性观察」还是「缺陷主张」（用于展示口径，不做因果判断）；
 *  2. 给出与该属性相关的**竞争性解释清单**，每条都标明"用什么证据才能区分"。
 *
 * 硬边界：这些解释是**待验证假设**，不是本商品已确认原因；不得据此派生改良动作。
 */

export type ProblemNature = "PROPERTY_OBSERVATION" | "DEFECT_CLAIM" | "UNCLEAR";

export type CompetitiveExplanation = {
  /** 解释类别（竞争性，非结论）。 */
  readonly label: string;
  /** 若成立，应能观察到什么差异。 */
  readonly observable: string;
  /** 用什么证据才能把这条解释与"产品缺陷"区分开。 */
  readonly discriminatingEvidence: string;
};

type PropertyFamily = {
  readonly key: string;
  readonly propertyTokens: readonly string[];
  /** 出现这些词更可能是在主张缺陷（未达规格/损坏/失效），而不是描述属性。 */
  readonly defectTokens: readonly string[];
  readonly explanations: readonly CompetitiveExplanation[];
};

const FAMILIES: readonly PropertyFamily[] = [
  {
    key: "thickness",
    propertyTokens: ["薄", "厚", "厚度"],
    defectTokens: ["未达", "不符", "短于", "少于", "缺斤", "谎称", "宣传"],
    explanations: [
      { label: "品类固有设计取舍", observable: "同价位/同类目多数产品同样偏薄", discriminatingEvidence: "抽取 3 个同价位竞品实测厚度做对照" },
      { label: "价格段成本约束", observable: "同规格更厚的产品售价明显更高", discriminatingEvidence: "对比同尺寸不同厚度的售价与克重" },
      { label: "宣传与实测不一致", observable: "页面标注的厚度/规格与实际到货不符", discriminatingEvidence: "以页面原始规格文本 + 实测量具记录对照" },
      { label: "用户预期偏差", observable: "描述中未标注厚度，买家按主观印象预期", discriminatingEvidence: "检查 listing 是否标注厚度与公差" },
    ],
  },
  {
    key: "softness",
    propertyTokens: ["软", "硬", "弹性", "刚性", "柔软"],
    defectTokens: ["断裂", "裂", "变形", "损坏", "不耐用"],
    explanations: [
      { label: "品类材质固有特性", observable: "同类硅胶/橡胶制品同样柔软", discriminatingEvidence: "同材质竞品手感与硬度对照（邵氏硬度）" },
      { label: "使用方式不匹配", observable: "仅在刀具/尖锐物等超出设计用途的场景出现问题", discriminatingEvidence: "核对评论中的具体使用动作与产品说明用途" },
      { label: "批次一致性", observable: "同期不同批次手感差异明显", discriminatingEvidence: "多批次样品硬度测试" },
      { label: "与竞品同类属性对比", observable: "竞品以「更硬」作为卖点且价格更高", discriminatingEvidence: "对比竞品规格与卖点表述" },
    ],
  },
  {
    key: "dimension",
    propertyTokens: ["尺寸", "英寸", "大小", "偏小", "偏大", "比预期小", "比预期大"],
    defectTokens: ["实测", "短于", "长于", "不符", "差 ", "少了"],
    explanations: [
      { label: "宣传规格与实测差异", observable: "实测值系统性小于标称值", discriminatingEvidence: "同批次 3 件以上实测并与页面标称值比对" },
      { label: "用户预期偏差", observable: "评论显示买家未读尺寸或按图片估算", discriminatingEvidence: "核对 listing 尺寸标注位置与主图比例" },
      { label: "变体选择错误", observable: "问题集中在特定变体（如大尺寸款）", discriminatingEvidence: "按变体拆分评论与销量" },
      { label: "使用场景适配差异", observable: "仅特定台面/烤盘尺寸的用户反馈偏小", discriminatingEvidence: "统计评论中提到的使用场景" },
    ],
  },
  {
    key: "surface",
    propertyTokens: ["滑", "粘", "灰尘", "残留", "清洁", "油污"],
    defectTokens: ["洗不掉", "无法清洁", "失效", "掉涂层"],
    explanations: [
      { label: "表面处理工艺差异", observable: "同款不同批次表面手感/摩擦力不同", discriminatingEvidence: "样品表面摩擦系数与批次对照" },
      { label: "使用前清洗习惯", observable: "按说明先清洗的用户反馈更少", discriminatingEvidence: "核对评论是否提及首次清洗" },
      { label: "洗涤剂/油污残留", observable: "使用特定洗涤剂后更滑", discriminatingEvidence: "控制变量的清洗测试" },
      { label: "环境灰尘与静电", observable: "干燥季节/环境更明显", discriminatingEvidence: "不同环境条件下的静置测试" },
    ],
  },
  {
    key: "installation",
    propertyTokens: ["安装", "卡扣", "费力", "力度", "按压", "装不上", "对准"],
    defectTokens: ["断裂", "卡死", "装反", "失效", "漏"],
    explanations: [
      { label: "首次使用不熟悉", observable: "同一买家后续评论/追评表示习惯后改善", discriminatingEvidence: "查找追评与「用几次就顺手」类表述" },
      { label: "操作角度与手法", observable: "按图示角度操作时明显更省力", discriminatingEvidence: "按说明书图示 vs 随意操作做对照测试" },
      { label: "结构公差与配合", observable: "不同样品之间所需力度差异明显", discriminatingEvidence: "多件样品测按压力值（N）与扣合次数" },
      { label: "材料硬度与厚度", observable: "更软/更厚的同结构版本更省力", discriminatingEvidence: "同结构不同硬度/厚度对照测试" },
      { label: "说明书图示不足", observable: "评论集中抱怨「不知道怎么扣」", discriminatingEvidence: "核对说明书与详情页是否给出扣合示意" },
    ],
  },
];

const DEFECT_FRAME_TOKENS: readonly string[] = ["未达", "不符", "短于", "断裂", "裂", "损坏", "失效", "漏", "退货", "投诉", "差评", "瑕疵"];
/** 明确"未达规格/实测不符"——这才把属性讨论升级为缺陷主张。 */
const SPEC_MISMATCH_TOKENS: readonly string[] = ["未达", "不符", "短于", "长于", "少于", "实测", "差 ", "谎称"];
/** 误用/超范围使用导致的损坏，不等于产品缺陷。 */
const USAGE_CONTEXT_TOKENS: readonly string[] = ["使用刀", "刀具", "尖锐", "误用", "超出", "用力过猛", "使用不当"];
/** 描述"用起来费劲/需要更大力"——是使用难度观察，不是纯属性描述。 */
const DIFFICULTY_TOKENS: readonly string[] = ["需要", "费力", "费劲", "困难", "难以", "无法", "不能", "不方便", "不容易"];

function hits(text: string, tokens: readonly string[]): string[] {
  return tokens.filter((token) => text.includes(token));
}

export function classifyProblemNature(text: string): { nature: ProblemNature; propertyTokens: string[]; family: string | null } {
  const families = FAMILIES.filter((family) => hits(text, family.propertyTokens).length > 0);
  const propertyTokens = [...new Set(families.flatMap((family) => hits(text, family.propertyTokens)))];
  const family = families[0]?.key ?? null;
  if (!propertyTokens.length) {
    return { nature: hits(text, DEFECT_FRAME_TOKENS).length ? "DEFECT_CLAIM" : "UNCLEAR", propertyTokens, family: null };
  }
  // 误用/超范围使用导致的损坏，不等于产品缺陷。
  if (hits(text, USAGE_CONTEXT_TOKENS).length > 0) return { nature: "PROPERTY_OBSERVATION", propertyTokens, family };
  // 明确"未达规格/实测不符"才算缺陷主张。
  if (hits(text, SPEC_MISMATCH_TOKENS).length > 0) return { nature: "DEFECT_CLAIM", propertyTokens, family };
  // "需要更大力/费劲"是使用难度观察，既不等于属性描述，也不等于缺陷结论。
  if (hits(text, DIFFICULTY_TOKENS).length > 0) return { nature: "UNCLEAR", propertyTokens, family };
  return { nature: "PROPERTY_OBSERVATION", propertyTokens, family };
}

/** 与文本相关的竞争性解释（最多 3 条）；无关时返回空数组，不硬塞模板。 */
export function competitiveExplanationsFor(text: string): CompetitiveExplanation[] {
  const families = FAMILIES.filter((family) => hits(text, family.propertyTokens).length > 0);
  return families.flatMap((family) => family.explanations).slice(0, 3);
}
