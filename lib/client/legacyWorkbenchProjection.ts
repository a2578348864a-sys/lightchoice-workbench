import type { ResearchProductImageDisplay } from "@/lib/productResearchImage";
import type { DecisionStatus } from "@/lib/tasks/decisionStatus";
import type { ResearchLifecycleSnapshot } from "@/lib/server/researchLifecycleReader";
import { resolveTaskProductDisplayName } from "@/lib/productDisplayName";
import { deriveResearchHistoryStatus, type ResearchHistoryStatus } from "@/lib/taskResearchHistoryPresentation";
import { collectPagedTasks, deriveProductProjectGroup } from "@/lib/researchLifecycle";
export { collectPagedTasks, ProductResearchTasksUnavailableError } from "@/lib/researchLifecycle";
/** Historical pure projection regressions retained when retiring the unused UI. */
export function resolveStartResearchHref(availableCount: number | null | undefined): { href: string | null; unavailable: boolean } {
  if (availableCount === null || availableCount === undefined) return { href: null, unavailable: true };
  if (availableCount > 0) return { href: "/opportunity-candidates?view=startable", unavailable: false };
  return { href: "/source", unavailable: false };
}

export type LocalTaskItem = {
  id: string;
  createdAt: string;
  updatedAt: string;
  type: string;
  decisionStatus: DecisionStatus;
  title: string | null;
  materialText: string;
  oneLineSummary: string;
  result: unknown;
  productImage: ResearchProductImageDisplay | null;
  productProjectKey: string;
  /** 服务端正式安全投影的 AI 运行状态（research_stale/running/waiting/failed_recoverable/failed_terminal/cancelled/completed/not_started）。 */
  aiRunStatus?: string;
  /** 服务端从该候选最新 V4ResearchRun 给出的 run.updatedAt（研究尝试真正时间源）；无 run 时不下发。 */
  runUpdatedAt?: string;
  /** Bridge V1 服务端 Reader 生命周期快照（列表行同名投影）：工作台状态展示的唯一口径，与商品详情页同源。 */
  researchLifecycle?: ResearchLifecycleSnapshot | null;
};

type LocalTasksResponse =
  | { ok: true; records?: LocalTaskItem[]; data?: { items?: LocalTaskItem[] }; page?: { hasMore?: boolean } }
  | { ok: false; error?: { message?: string } };

export type LocalProductProject = {
  key: string;
  task: LocalTaskItem;
  taskCount: number;
  productName: string;
  category: string;
  market: string;
  conclusion: string;
  researchStatus: ResearchHistoryStatus;
  group: "needs_action" | "researching" | "completed";
  statusLabel: string;
  nextLabel: string;
};

function isLocalRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** 市场代码 → 用户可读站点名（C 端不暴露内部主机/代码；未映射 → 诚实「市场待补充」）。 */
const LOCAL_MARKET_LABELS: Record<string, string> = {
  "amazon.com": "Amazon 美国站",
  "amazon.ca": "Amazon 加拿大站",
  "amazon.co.uk": "Amazon 英国站",
  "amazon.de": "Amazon 德国站",
  "amazon.fr": "Amazon 法国站",
  "amazon.it": "Amazon 意大利站",
  "amazon.es": "Amazon 西班牙站",
  "amazon_us": "Amazon 美国站",
  us: "美国站",
  uk: "英国站",
  "1688.com": "1688 供应",
  "1688": "1688 供应",
};

function localMarketLabel(marketplace: string | null): string {
  if (!marketplace) return "市场待补充";
  const trimmed = marketplace.trim();
  return LOCAL_MARKET_LABELS[trimmed.toLowerCase()] ?? LOCAL_MARKET_LABELS[trimmed] ?? "市场待补充";
}

function isLocalTaskItem(value: unknown): value is LocalTaskItem {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string"
    && typeof v.type === "string"
    && typeof v.decisionStatus === "string"
    && typeof v.updatedAt === "string"
    && typeof v.productProjectKey === "string"
    && v.productProjectKey.startsWith("ppk_");
}

function localProductMeta(result: unknown) {
  if (!isLocalRecord(result)) return { category: "类目尚未取得", market: "市场尚未取得" };
  const context = isLocalRecord(result.candidateAnalysisContext) ? result.candidateAnalysisContext : null;
  const facts = context && isLocalRecord(context.facts) ? context.facts : null;
  return {
    category: localText(facts?.category) || localText(facts?.rootCategory) || "类目尚未取得",
    market: localMarketLabel(localText(facts?.marketplace) || null),
  };
}

function localConclusion(task: LocalTaskItem): string {
  // 第十一轮（Bug 1）：与任务详情同口径——只允许真实 AI/研究结论字段；
  // oneLineSummary 是任务摘要不是 AI 判断；无真实结论返回空串（不渲染假文案）。
  const result = isLocalRecord(task.result) ? task.result : null;
  const legacy = result && isLocalRecord(result.legacyListSummary) ? result.legacyListSummary : null;
  const presentation = legacy && isLocalRecord(legacy.presentation) ? legacy.presentation : null;
  const conclusions = Array.isArray(presentation?.researchConclusions)
    ? presentation.researchConclusions.map(localText).filter(Boolean)
    : [];
  if (conclusions[0]) return conclusions[0];
  const workflow = legacy && isLocalRecord(legacy.workflow) ? legacy.workflow : null;
  const verdict = localText(workflow?.verdictLabel);
  if (verdict && !["暂无", "未知", "待确认"].includes(verdict)) return verdict;
  if (result) {
    const summary = isLocalRecord(result.summary) ? result.summary : null;
    const decisionReason = localText(summary?.decisionReason);
    if (decisionReason) return decisionReason;
  }
  return "";
}

/** 服务端正式投影状态 → 三组语义。失败/取消终态优先于旧研究/决定（§2.4）。 */
function localProjectState(task: LocalTaskItem) {
  // 轮 6：与 /research 共用同一口径（唯一分类器）。
  // 第十二轮：快照优先——列表 DTO 已带服务端 Reader 快照时，卡片状态与商品详情页同一 Snapshot 同语义。
  return deriveProductProjectGroup({
    aiRunStatus: task.aiRunStatus,
    decisionStatus: task.decisionStatus,
    result: task.result,
    oneLineSummary: task.oneLineSummary,
    lifecycle: task.researchLifecycle ?? null,
  });
}

/** §2.1 正式工作台数据域读取（完整分页 + 只保留正式商品研究任务）；任何失败 → unavailable。 */
export type WorkbenchTasksLoadResult =
  | { status: "ready"; tasks: LocalTaskItem[] }
  | { status: "unavailable" };

export async function loadWorkbenchTasks(
  fetchPage: (offset: number) => Promise<{ items: LocalTaskItem[]; hasMore: boolean } | null>,
): Promise<WorkbenchTasksLoadResult> {
  let all: LocalTaskItem[] | null = null;
  try {
    all = await collectPagedTasks(fetchPage);
  } catch {
    all = null;
  }
  if (!all) return { status: "unavailable" };
  return { status: "ready", tasks: all.filter((task) => task.type === "workflow") };
}

function taskTime(task: LocalTaskItem) {
  const value = Date.parse(task.updatedAt || task.createdAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * §6 项目时间戳：max(最新 run 更新, 任务更新时间)。
 * 研究尝试的最新性以服务端 runUpdatedAt 为准（V4ResearchRun.updatedAt），
 * 不能只依赖可能未随 run 更新的任务 updatedAt。
 */
function taskRecency(task: LocalTaskItem) {
  const runValue = Date.parse(task.runUpdatedAt ?? "");
  const runTime = Number.isFinite(runValue) ? runValue : Number.MIN_SAFE_INTEGER;
  return Math.max(runTime, taskTime(task));
}

/**
 * 最终确定性排序契约（与 Formal v2 文档一致）：
 * 1) max(runUpdatedAt, task.updatedAt) 降序（项目新鲜度）
 * 2) task.updatedAt 降序
 * 3) task.id 字典序升序
 * 结果与 API 输入顺序无关。
 */
function compareTaskFreshness(left: LocalTaskItem, right: LocalTaskItem): number {
  const recencyDiff = taskRecency(right) - taskRecency(left);
  if (recencyDiff !== 0) return recencyDiff;
  const timeDiff = taskTime(right) - taskTime(left);
  if (timeDiff !== 0) return timeDiff;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareProjectFreshness(left: LocalProductProject, right: LocalProductProject): number {
  return compareTaskFreshness(left.task, right.task);
}

export function buildLocalProductProjects(tasks: LocalTaskItem[]): LocalProductProject[] {
  const groups = new Map<string, LocalTaskItem[]>();
  for (const task of tasks) {
    const key = localText(task.productProjectKey) || `task:${task.id}`;
    const existing = groups.get(key);
    if (existing) existing.push(task);
    else groups.set(key, [task]);
  }

  return Array.from(groups.entries())
    .map(([key, groupedTasks]) => {
      const sorted = groupedTasks.toSorted(compareTaskFreshness);
      // 规则（§6/最终冻结）：项目代表 = max(max(runUpdatedAt, updatedAt)) 降序 → updatedAt 降序 → id 字典序升序
      const task = sorted[0];
      const meta = localProductMeta(task.result);
      const researchStatus = deriveResearchHistoryStatus({
        result: task.result,
        decisionStatus: task.decisionStatus,
        oneLineSummary: task.oneLineSummary,
      });
      const state = localProjectState(task);
      return {
        key,
        task,
        taskCount: sorted.length,
        productName: resolveTaskProductDisplayName({
          resultProductName: isLocalRecord(task.result) ? task.result.productName : "",
          taskTitle: task.title,
          materialText: task.materialText,
          fallback: "商品名称尚未取得",
        }),
        category: meta.category,
        market: meta.market,
        conclusion: localConclusion(task),
        researchStatus,
        ...state,
      };
    })
    .toSorted(compareProjectFreshness);
}

