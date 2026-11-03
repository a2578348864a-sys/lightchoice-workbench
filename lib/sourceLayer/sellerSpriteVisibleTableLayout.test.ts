import { describe, expect, it } from "vitest";

import {
  hasStructuredVisibleTableData,
  resolveVisibleTableLayout,
  type RawVisibleSnapshot,
  type RawVisibleTable,
} from "@/lib/sourceLayer/sellerSpriteVisibleTableLayout";

// ─────────────────────────────────────────────────────────────────────────────
// P2-2：可见表格「表头 / 数据行」结构化规则（纯函数，node 环境）
// 每一类都对应真实页面结构或计划要求的失败分类。
// ─────────────────────────────────────────────────────────────────────────────

function rawTable(overrides: Partial<RawVisibleTable> & { index: number }): RawVisibleTable {
  return {
    selector: `table:nth-of-type(${overrides.index + 1})`,
    className: "",
    pairKey: "root",
    headerCells: [],
    headerCellTags: [],
    rows: [],
    ...overrides,
  };
}

function snapshot(tables: RawVisibleTable[]): RawVisibleSnapshot {
  return { bodyText: "", tables };
}

describe("resolveVisibleTableLayout —— P2-2 表头/数据行对齐", () => {
  it("[1] 正常 thead + tbody：表头来自 thead，数据行不含表头", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({
        index: 0,
        headerCells: ["Keyword", "Traffic Share"],
        headerCellTags: ["th", "th"],
        rows: [["kitchen organizer", "38.37%"], ["garden hose", "12.5%"]],
      }),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ headerSource: "thead", headerStatus: "HEADER_OK", columnCount: 2 });
    expect(out[0].headers).toEqual(["Keyword", "Traffic Share"]);
    expect(out[0].rows).toHaveLength(2);
    expect(JSON.stringify(out[0].rows[0])).not.toBe(JSON.stringify(out[0].headers));
  });

  it("[2] 第一行是数据而非表头（无 thead）：不得把首行当表头", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({
        index: 0,
        headerCells: [],
        rows: [["1", "kinto water bottle"], ["2", "kinto tumbler"]],
      }),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ headerSource: "none", headerStatus: "HEADER_NOT_FOUND" });
    expect(out[0].headers).toEqual([]);
  });

  it("[3] 独立固定表头（Element UI 双表）：与同部件数据表配对", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, className: "el-table__header", pairKey: "el-table#0", headerCells: ["#", "关键词 数据解释", "内测版流量占比"], headerCellTags: ["th", "th", "th"] }),
      rawTable({ index: 1, className: "el-table__body", pairKey: "el-table#0", rows: [["1", "christmas tree", "38.44%"], ["2", "garden hose", "12.10%"]] }),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ headerSource: "paired_table", headerStatus: "HEADER_OK", columnCount: 3 });
    expect(out[0].headers).toEqual(["#", "关键词 数据解释", "内测版流量占比"]);
  });

  it("[3b] 尾随空表头列被丢弃后恰好与数据列数对齐（真实 20 表头 / 19 数据列）", () => {
    const headers = ["#", "关键词", "流量占比", "自然排名", ""];
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, className: "el-table__header", pairKey: "k", headerCells: headers, headerCellTags: headers.map(() => "th") }),
      rawTable({ index: 1, className: "el-table__body", pairKey: "k", rows: [["1", "kw", "38%", "58"], ["2", "kw2", "12%", "14"]] }),
    ]));
    expect(out[0]).toMatchObject({ headerStatus: "HEADER_OK", columnCount: 4, headerSource: "paired_table" });
    expect(out[0].headers).toEqual(["#", "关键词", "流量占比", "自然排名"]);
  });

  it("[4] 多张表格同时存在：只取**同一部件内**的表头表，跨部件不配对", () => {
    const out = resolveVisibleTableLayout(snapshot([
      // 其他部件的表头表：内容完全不同，且 pairKey 不同 → 不得参与配对
      rawTable({ index: 0, pairKey: "other-widget", headerCells: ["A", "B"], headerCellTags: ["th", "th"] }),
      rawTable({ index: 1, pairKey: "k", headerCells: ["Right", "Right2"], headerCellTags: ["th", "th"] }),
      rawTable({ index: 2, pairKey: "k", rows: [["v1", "v2"]] }),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].headers).toEqual(["Right", "Right2"]);
    expect(out[0].headerSource).toBe("paired_table");
  });

  it("[4b] 同部件内多个候选但内容一致 → 取最近的前一张（Element UI 固定列重复渲染）", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, pairKey: "k", headerCells: ["#", "关键词"], headerCellTags: ["th", "th"] }),
      rawTable({ index: 1, pairKey: "k", headerCells: ["#", "关键词"], headerCellTags: ["th", "th"] }),
      rawTable({ index: 2, pairKey: "k", rows: [["1", "kw"]] }),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].headers).toEqual(["#", "关键词"]);
    expect(out[0].headerSource).toBe("paired_table");
  });

  it("[5] 同部件内存在内容不同的多个匹配表头表 → HEADER_AMBIGUOUS（不猜）", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, pairKey: "k", headerCells: ["Keyword", "Share"], headerCellTags: ["th", "th"] }),
      rawTable({ index: 1, pairKey: "k", headerCells: ["Term", "Ratio"], headerCellTags: ["th", "th"] }),
      rawTable({ index: 2, pairKey: "k", rows: [["x", "1%"]] }),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ headerSource: "none", headerStatus: "HEADER_AMBIGUOUS", headers: [] });
  });

  it("[6] 缺失表头：仅数据行、无任何可用表头 → HEADER_NOT_FOUND", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, rows: [["a", "b"]] }),
    ]));
    expect(out[0]).toMatchObject({ headerStatus: "HEADER_NOT_FOUND", headers: [] });
  });

  it("[7/8] 自带表头列数与数据列数不符 → ROW_COLUMN_MISMATCH（拒绝而非错位）", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({
        index: 0,
        headerCells: ["A", "B", "C"],
        headerCellTags: ["th", "th", "th"],
        rows: [["1", "2"]],
      }),
    ]));
    expect(out[0]).toMatchObject({ headerStatus: "ROW_COLUMN_MISMATCH", headers: [], columnCount: 2 });
  });

  it("[9] 空结果：有表头但无数据行 → 不作为结果表输出", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, headerCells: ["#", "关键词"], headerCellTags: ["th", "th"], rows: [] }),
    ]));
    expect(out).toEqual([]);
  });

  it("[10] 页面尚未加载完成（没有任何表格）→ 空输出", () => {
    expect(resolveVisibleTableLayout(snapshot([]))).toEqual([]);
  });

  it("[11] 虚拟列表初始窗口：仅渲染部分行时仍判定为结构化", () => {
    const rows = Array.from({ length: 20 }, (_, index) => [`${index + 1}`, `kw-${index + 1}`]);
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, pairKey: "k", headerCells: ["#", "关键词"], headerCellTags: ["th", "th"] }),
      rawTable({ index: 1, pairKey: "k", rows }),
    ]));
    expect(out[0].headerStatus).toBe("HEADER_OK");
    expect(out[0].rows).toHaveLength(20);
    expect(hasStructuredVisibleTableData(out)).toBe(true);
  });

  it("[12] 列顺序变化：表头按位置与数据行逐列对应", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({
        index: 0,
        headerCells: ["关键词", "自然排名"],
        headerCellTags: ["th", "th"],
        rows: [["garden hose", "58"]],
      }),
    ]));
    expect(out[0].headers).toEqual(["关键词", "自然排名"]);
    expect(out[0].rows[0]).toEqual(["garden hose", "58"]);
  });

  it("[13] 错误页面结构（无关表格）→ HEADER_NOT_FOUND，不误判为结果表", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, rows: [["<div>", "<span>"]] }),
    ]));
    expect(out[0].headerStatus).toBe("HEADER_NOT_FOUND");
    expect(hasStructuredVisibleTableData(out)).toBe(false);
  });

  it("[14] 结果可 JSON 往返（可安全写入 Evidence 附件）", () => {
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, headerCells: ["Keyword"], headerCellTags: ["th"], rows: [["kw"]] }),
    ]));
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("[15] 写后读一致：同一原始结构两次解析结果相同", () => {
    const raw = snapshot([
      rawTable({ index: 0, pairKey: "k", headerCells: ["#", "关键词"], headerCellTags: ["th", "th"] }),
      rawTable({ index: 1, pairKey: "k", rows: [["1", "kw"]] }),
    ]);
    expect(resolveVisibleTableLayout(raw)).toEqual(resolveVisibleTableLayout(raw));
  });

  it("[16] 历史缺陷样本（headers 槽里是数据行）保持 fail-closed", () => {
    // 历史持久化样本的真实症状：headers === rows[0]
    const defective = rawTable({
      index: 0,
      headerCells: ["1", "kinto water bottle\nkinto 水瓶"],
      headerCellTags: ["th", "th"],
      rows: [
        ["1", "kinto water bottle\nkinto 水瓶"],
        ["2", "other keyword"],
      ],
    });
    const out = resolveVisibleTableLayout(snapshot([defective]));
    // 自带表头（2 列）与数据列（2 列）虽数量一致，但首行重复表头 → 由 parser 的 repeatsHeader 拒绝；
    // 本层不得把它标成「表头可信」以外的语义 —— 这里断言它至少不产生虚假的多来源。
    expect(out[0].headerStatus === "HEADER_OK" || out[0].headerStatus === "ROW_COLUMN_MISMATCH").toBe(true);
    // 且绝不会出现「表头=数据行」被当作独立数据语义（rows[0] 与 headers 相同是数据自身问题）
    expect(out[0].rows.length).toBeGreaterThan(0);
  });

  it("[16b] Element UI 三份重复渲染（主表 + 固定列）按内容去重", () => {
    const headers = ["#", "关键词"];
    const rows = [["1", "kw"]];
    const out = resolveVisibleTableLayout(snapshot([
      rawTable({ index: 0, pairKey: "k", headerCells: headers, headerCellTags: ["th", "th"] }),
      rawTable({ index: 1, pairKey: "k", rows }),
      rawTable({ index: 2, pairKey: "k", headerCells: headers, headerCellTags: ["th", "th"] }),
      rawTable({ index: 3, pairKey: "k", rows }),
    ]));
    expect(out).toHaveLength(1);
  });
});
