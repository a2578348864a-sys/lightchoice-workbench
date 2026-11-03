import { describe, expect, it } from "vitest";
import { pruneSelection, resolveSelectedItems } from "./stableRowSelection";

type Row = { id: string; name: string };

const A: Row = { id: "scan-a", name: "硅胶烘焙垫" };
const B: Row = { id: "scan-b", name: "防烫手套" };
const C: Row = { id: "scan-c", name: "烤盘" };

describe("D0-001 稳定 ID 选中解析", () => {
  it("筛选后仍解析出原选中对象，而不是筛选结果的第一行", () => {
    // 用户先选 A；随后搜索只剩 B/C —— 旧实现会把下标 0 解析成 B。
    const selection = { "scan-a": true };
    const filtered = [B, C];
    expect(resolveSelectedItems(selection, filtered, (r) => r.id)).toEqual([]);
    // 完整数据集（列表按 ID 过滤）保持 A 为选中对象：
    expect(resolveSelectedItems(selection, [A, B, C], (r) => r.id)).toEqual([A]);
  });

  it("排序/翻页不改变选中对象身份", () => {
    const selection = { "scan-b": true };
    const sortedDesc = [C, B, A];
    expect(resolveSelectedItems(selection, sortedDesc, (r) => r.id).map((r) => r.id)).toEqual(["scan-b"]);
  });

  it("数据集刷新后清除已不存在的选中 ID", () => {
    const selection = { "scan-a": true, "scan-b": true };
    const refreshed = [A, C]; // B 已被删除/移出当前视角
    const pruned = pruneSelection(selection, refreshed, (r) => r.id);
    expect(pruned).toEqual({ "scan-a": true });
  });

  it("选中对象仍在数据集中时（仅被搜索隐藏）不清除", () => {
    const selection = { "scan-a": true };
    const pruned = pruneSelection(selection, [A, B, C], (r) => r.id);
    expect(pruned).toBe(selection);
  });

  it("无失效 ID 时返回原引用，避免无谓重渲染", () => {
    const selection = { "scan-a": true, "scan-b": false };
    expect(pruneSelection(selection, [A, B], (r) => r.id)).toBe(selection);
  });

  it("false 值的选中项不参与解析", () => {
    expect(resolveSelectedItems({ "scan-a": false }, [A], (r) => r.id)).toEqual([]);
  });
});
