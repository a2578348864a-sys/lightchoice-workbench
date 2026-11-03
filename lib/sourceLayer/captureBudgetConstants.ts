/**
 * 采集预算唯一常量与推导（客户端安全、零依赖）。
 *
 * 单独成模块的原因：`lib/server/batchCaptureRun.ts` 依赖服务端链路，无法进入浏览器 bundle；
 * 但 UI 必须显示与**服务端完全一致**的预算数字（曾出现「前端 210 / 后端 607」的差异）。
 * 因此把常量与推导放在无依赖模块，服务端与前端共用同一实现，保证单一事实来源。
 */

/** 单次采集授权商品数硬上限（本阶段产品上限；>200 以后单独评估）。 */
export const HARD_MAX_AUTHORIZED_ITEMS = 200 as const;
/** 未显式授权时的安全默认值（绝不默认 60/200）。 */
export const DEFAULT_AUTHORIZED_ITEMS = 5 as const;
/** 每页搜索结果的经验样本数，用于由授权数量推导搜索页数。 */
export const SEARCH_ITEMS_PER_PAGE = 30 as const;
/** 搜索页数硬上限（防止把「大数量授权」误解为无限翻页）。 */
export const HARD_MAX_SEARCH_PAGES = 10 as const;
/** 每个自动模块对每个 ASIN 允许的导航次数经验值。 */
export const NAVIGATIONS_PER_ITEM_PER_MODULE = 1 as const;
/** 导航预算的安全下限。 */
export const MIN_NAVIGATION_BUDGET = 30 as const;

/** 由授权数量推导搜索页数：不超过 HARD_MAX_SEARCH_PAGES。 */
export function deriveSearchPages(authorizedItemLimit: number): number {
  return Math.min(HARD_MAX_SEARCH_PAGES, Math.max(1, Math.ceil(authorizedItemLimit / SEARCH_ITEMS_PER_PAGE)));
}

/**
 * 由授权数量推导**导航预算上限**：授权商品数 × 自动模块数 + 搜索页数，且不低于安全下限。
 * 关键：授权 200 件 **不等于** 无限页面访问 —— 导航预算始终是独立且有限的上限。
 * 前端与服务端必须使用本函数，避免出现两套数字。
 */
export function deriveNavigationBudget(authorizedItemLimit: number, autoModuleCount: number, searchPages: number): number {
  const items = Math.max(0, authorizedItemLimit);
  const modules = Math.max(0, autoModuleCount);
  return Math.max(MIN_NAVIGATION_BUDGET, items * modules * NAVIGATIONS_PER_ITEM_PER_MODULE + searchPages);
}

/** 自动采集模块数（与 `AUTO_BATCH_MODULES` 一致；此处避免引入服务端依赖）。 */
export const AUTO_CAPTURE_MODULE_COUNT = 4 as const;

/**
 * 导航预算的**绝对硬顶**（含显式追加后的总额）。
 *
 * 取值依据：推导上限的极端情形是 200 件 × 4 个自动模块 + 7 页搜索 = 807；
 * 硬顶必须高于它，否则「追加额度」的封顶会反过来**压低**正常授权（真实回归风险）。
 * 1600 ≈ 807 × 2，既给重试留出空间，又保证任何路径都不会无限扩额。
 */
export const HARD_MAX_NAVIGATION_BUDGET = 1600 as const;

/** 单次预算追加授权允许申请的最大增量（防止一次把上限抬到硬顶）。 */
export const MAX_NAVIGATION_TOP_UP = 120 as const;

/**
 * 追加额度的相对上限：追加后总额不得超过**推导上限的两倍**。
 * 与绝对硬顶共同构成「双封顶」：既不能无限加，也不能把小额授权放大成大额采集。
 */
export const MAX_NAVIGATION_TOP_UP_RATIO = 1 as const;

