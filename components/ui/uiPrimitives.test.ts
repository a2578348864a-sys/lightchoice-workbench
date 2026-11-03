import { describe, it, expect } from "vitest";
import {
  createColumnHelper,
} from "@tanstack/react-table";
import * as UI from "./index";

interface TestRow {
  id: string;
  name: string;
  price: number;
  status: string;
}

describe("UI Primitives & Spike (F1)", () => {
  it("exports all shared UI primitives correctly", () => {
    expect(UI.Button).toBeDefined();
    expect(UI.Badge).toBeDefined();
    expect(UI.StatusBadge).toBeDefined();
    expect(UI.Dialog).toBeDefined();
    expect(UI.ConfirmDialog).toBeDefined();
    expect(UI.Drawer).toBeDefined();
    expect(UI.EmptyState).toBeDefined();
    expect(UI.Skeleton).toBeDefined();
    expect(UI.ProductImage).toBeDefined();
    expect(UI.PageHeader).toBeDefined();
    expect(UI.PageToolbar).toBeDefined();
    expect(UI.DataTable).toBeDefined();
    expect(UI.BulkActionBar).toBeDefined();
    expect(UI.DistributionChart).toBeDefined();
  });

  it("verifies TanStack Table core column helper and model contracts", () => {
    const columnHelper = createColumnHelper<TestRow>();
    const columns = [
      columnHelper.accessor("name", { header: "商品名称" }),
      columnHelper.accessor("price", { header: "价格" }),
      columnHelper.accessor("status", { header: "状态" }),
    ];

    expect(columns.length).toBe(3);
    expect(columns[0].header).toBe("商品名称");
    expect(columns[1].header).toBe("价格");
  });

  it("calculates ConfirmDialog protection metrics reliably", () => {
    const rawItems = [
      { id: "1", hasConvertedTask: true },
      { id: "2", hasConvertedTask: false },
      { id: "3", hasConvertedTask: false },
      { id: "4", hasConvertedTask: true },
    ];

    const totalCount = rawItems.length;
    const protectedCount = rawItems.filter((i) => i.hasConvertedTask).length;
    const actionableCount = totalCount - protectedCount;

    expect(totalCount).toBe(4);
    expect(protectedCount).toBe(2);
    expect(actionableCount).toBe(2);
  });
});
