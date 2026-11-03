/**
 * SellerSprite 可见表格的结构化布局层（P2-2 修复）。
 *
 * 分两层，避免「DOM 遍历」与「表头对齐规则」混在一起：
 * 1. `collectRawVisibleTables()` —— 自包含的**页内**采集器，只用 DOM，不做任何语义判断；
 *    （写为 ES5 安全的简单语句，可被 `page.evaluate` 以函数源注入浏览器执行）
 * 2. `resolveVisibleTableLayout()` —— **纯函数**，在 Node 侧把原始结构解析为
 *    `{headers, rows, headerSource, headerStatus}`，规则可单测。
 *
 * 铁律（P2-2）：
 * - 表头只能来自 `thead` 单元格，或**同一个小部件内配对**的表头表（Element UI 的双表结构）；
 * - **绝不**把第一条数据行当表头（禁止 `tr:first-child` 猜测）；
 * - 数据行必须排除表头行；列数不匹配一律拒绝，不做位置猜测；
 * - 无法确定表头时输出 `headers: []` + `HEADER_NOT_FOUND`（fail-closed）。
 */

export type RawVisibleTable = {
  readonly index: number;
  readonly selector: string;
  readonly className: string;
  /** 同一表格小部件（Element UI 的 .el-table 容器等）的稳定路径键，用于配对表头表与数据表。 */
  readonly pairKey: string;
  /** `thead` 行单元格文本（无 `thead` 则为空数组）；允许空串（占位列）。 */
  readonly headerCells: readonly string[];
  readonly headerCellTags: readonly string[];
  /** 数据行（已排除表头行与全 `th` 行）。 */
  readonly rows: readonly (readonly (string | null)[])[];
};

export type RawVisibleSnapshot = {
  readonly bodyText: string;
  readonly tables: readonly RawVisibleTable[];
};

export type VisibleTableLayout = {
  readonly selector: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly headerSource: "thead" | "paired_table" | "none";
  readonly headerStatus: "HEADER_OK" | "HEADER_NOT_FOUND" | "HEADER_AMBIGUOUS" | "ROW_COLUMN_MISMATCH";
  readonly columnCount: number;
};

/**
 * 页内采集器：只读取可见表格的原始结构，不做任何语义判断。
 *
 * ⚠️ 该函数会被 `page.evaluate` 序列化后在浏览器里执行 —— 必须**自包含**：
 * 不引用模块级标识符，只用简单语句（避免 `for...of` / 展开 / 可选链等可能被
 * 转译器插入 helper 的写法）。
 */
export function collectRawVisibleTables(): RawVisibleSnapshot {
  // 全部常量必须内联：该函数以源码形式在浏览器执行，模块级标识符不可见。
  var MAX_TABLES_INLINE = 20;
  var MAX_CELLS_INLINE = 64;
  var MAX_ROWS_INLINE = 250;
  var cleanText = function (value: string | null | undefined, limit: number): string {
    if (value === null || value === undefined) return "";
    return String(value).replace(/\s+/gu, " ").trim().slice(0, limit);
  };
  var isVisible = function (element: Element): boolean {
    var html = element as HTMLElement;
    var rect = html.getBoundingClientRect();
    var style = window.getComputedStyle(html);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  var pathKey = function (element: Element): string {
    var parts: string[] = [];
    var cursor: Element | null = element;
    var guard = 0;
    while (cursor && cursor.nodeType === 1 && guard < 8) {
      var parent: Element | null = cursor.parentElement;
      var tag = cursor.tagName.toLowerCase();
      var index = 0;
      if (parent) {
        var siblings = parent.children;
        for (var i = 0; i < siblings.length; i += 1) {
          if (siblings[i] === cursor) { index = i; break; }
        }
      }
      parts.unshift(tag + ":" + index);
      cursor = parent;
      guard += 1;
    }
    return parts.join("/");
  };
  var allTables = Array.prototype.slice.call(document.querySelectorAll("table")) as Element[];
  var visibleTables: Element[] = [];
  for (var t = 0; t < allTables.length && visibleTables.length < MAX_TABLES_INLINE; t += 1) {
    if (isVisible(allTables[t])) visibleTables.push(allTables[t]);
  }
  var tables: RawVisibleTable[] = [];
  for (var v = 0; v < visibleTables.length; v += 1) {
    var table = visibleTables[v];
    var className = cleanText(String((table as HTMLElement).className || ""), 160);
    var ownIndex = allTables.indexOf(table);
    var selector = table.id ? "#" + table.id : "table:nth-of-type(" + (ownIndex + 1) + ")";
    // 配对键：向上找最近的 `.el-table` 根容器（Element UI 双表结构的分组边界）。
    // 必须做**精确类名 token 匹配**：`el-table__header-wrapper` 之类的子元素不算根容器。
    var pairKey = pathKey(table);
    var scope: Element | null = table.parentElement;
    var depth = 0;
    while (scope && depth < 4) {
      var scopeTokens = String((scope as HTMLElement).className || "").split(/\s+/u);
      var isRoot = false;
      for (var s = 0; s < scopeTokens.length; s += 1) {
        if (scopeTokens[s] === "el-table") { isRoot = true; break; }
      }
      if (isRoot) { pairKey = pathKey(scope); break; }
      scope = scope.parentElement;
      depth += 1;
    }
    var theadRow = table.querySelector("thead tr");
    var headerCells: string[] = [];
    var headerCellTags: string[] = [];
    if (theadRow) {
      var headerCellEls = Array.prototype.slice.call(theadRow.querySelectorAll("th, td")) as Element[];
      for (var h = 0; h < headerCellEls.length; h += 1) {
        headerCells.push(cleanText(headerCellEls[h].textContent, 160));
        headerCellTags.push(headerCellEls[h].tagName.toLowerCase());
      }
    }
    var bodyRows = Array.prototype.slice.call(table.querySelectorAll("tbody tr")) as Element[];
    if (bodyRows.length === 0) {
      var looseRows = Array.prototype.slice.call(table.querySelectorAll("tr")) as Element[];
      for (var r = 0; r < looseRows.length; r += 1) {
        if (!looseRows[r].closest("thead")) bodyRows.push(looseRows[r]);
      }
    }
    var rows: Array<Array<string | null>> = [];
    for (var b = 0; b < bodyRows.length && rows.length < MAX_ROWS_INLINE; b += 1) {
      var cellEls = Array.prototype.slice.call(bodyRows[b].querySelectorAll("th, td")) as Element[];
      if (cellEls.length === 0) continue;
      var allHeaderCells = true;
      for (var c = 0; c < cellEls.length; c += 1) {
        if (cellEls[c].tagName.toLowerCase() !== "th") { allHeaderCells = false; break; }
      }
      if (allHeaderCells) continue; // 全 TH 行属于表头样式，不是数据行
      var row: Array<string | null> = [];
      for (var k = 0; k < cellEls.length && k < MAX_CELLS_INLINE; k += 1) {
        var text = cleanText(cellEls[k].textContent, 500);
        row.push(text ? text : null);
      }
      rows.push(row);
    }
    tables.push({ index: ownIndex, selector: selector, className: className, pairKey: pairKey, headerCells: headerCells, headerCellTags: headerCellTags, rows: rows });
  }
  var bodyText = document.body ? cleanText(document.body.innerText, 20_000) : "";
  return { bodyText: bodyText, tables: tables };
}

function dropTrailingEmptyHeaders(cells: readonly string[]): string[] {
  const out = cells.slice();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

function dominantColumnCount(rows: readonly (readonly (string | null)[])[]): number {
  const counts = new Map<number, number>();
  for (const row of rows) {
    if (row.length === 0) continue;
    counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [count, frequency] of counts) {
    if (frequency > bestCount || (frequency === bestCount && count > best)) {
      best = count;
      bestCount = frequency;
    }
  }
  return best;
}

/** 纯函数：把原始结构解析为可消费的表格布局（表头对齐 + 状态分类）。 */
export function resolveVisibleTableLayout(raw: RawVisibleSnapshot): VisibleTableLayout[] {
  const out: VisibleTableLayout[] = [];
  const rawTables = Array.isArray(raw?.tables) ? raw.tables : [];
  const headerProviders = rawTables.filter((table) => dropTrailingEmptyHeaders(table.headerCells).some((cell) => cell.trim() !== ""));

  for (const table of rawTables) {
    const columnCount = dominantColumnCount(table.rows);
    if (table.rows.length === 0 || columnCount === 0) continue; // 表头表 / 空表：不作为结果表输出

    const ownHeaders = dropTrailingEmptyHeaders(table.headerCells);
    const ownUsable = ownHeaders.some((cell) => cell.trim() !== "");

    if (ownUsable && ownHeaders.length === columnCount) {
      out.push({ selector: table.selector, headers: ownHeaders, rows: table.rows, headerSource: "thead", headerStatus: "HEADER_OK", columnCount });
      continue;
    }
    if (ownUsable && ownHeaders.length !== columnCount) {
      // 本表自带表头但列数不符：拒绝，不做位置猜测
      out.push({ selector: table.selector, headers: [], rows: table.rows, headerSource: "none", headerStatus: "ROW_COLUMN_MISMATCH", columnCount });
      continue;
    }

    // 无自带表头 → 在同一个小部件内配对（Element UI：表头表 + 数据表分离）
    const candidates = headerProviders.filter((provider) => provider.pairKey === table.pairKey && provider.index < table.index);
    const matched = candidates.filter((provider) => dropTrailingEmptyHeaders(provider.headerCells).length === columnCount);
    if (matched.length === 0) {
      out.push({ selector: table.selector, headers: [], rows: table.rows, headerSource: "none", headerStatus: "HEADER_NOT_FOUND", columnCount });
      continue;
    }
    const nearest = matched.reduce((left, right) => (right.index > left.index ? right : left));
    const distinct = new Set(matched.map((provider) => JSON.stringify(dropTrailingEmptyHeaders(provider.headerCells))));
    if (distinct.size > 1) {
      out.push({ selector: table.selector, headers: [], rows: table.rows, headerSource: "none", headerStatus: "HEADER_AMBIGUOUS", columnCount });
      continue;
    }
    out.push({ selector: table.selector, headers: dropTrailingEmptyHeaders(nearest.headerCells), rows: table.rows, headerSource: "paired_table", headerStatus: "HEADER_OK", columnCount });
  }

  // Element UI 会把同一逻辑表同时渲染成主表 + 左侧固定列 + 右侧固定列，
  // 三者表头与数据完全相同 → 按内容去重，避免下游按倍数重复计数。
  const seen = new Set<string>();
  return out.filter((layout) => {
    if (layout.headerStatus !== "HEADER_OK") return true;
    const signature = JSON.stringify({ headers: layout.headers, rows: layout.rows });
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/** 是否含有结构化的可见表格数据（表头与数据行同一逻辑表且均非空）。 */
export function hasStructuredVisibleTableData(layouts: readonly VisibleTableLayout[]): boolean {
  return layouts.some((layout) =>
    layout.headerStatus === "HEADER_OK"
      && layout.headers.some((header) => header.trim() !== "")
      && layout.rows.some((row) => row.some((cell) => cell !== null && cell.trim() !== "")),
  );
}
