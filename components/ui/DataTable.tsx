"use client";

import * as React from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
  RowSelectionState,
  VisibilityState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  SlidersHorizontal,
} from "lucide-react";
import { TableSkeleton } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { Button } from "./Button";

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  isLoading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyActionText?: string;
  onEmptyAction?: () => void;
  onRowClick?: (row: TData) => void;
  enableRowSelection?: boolean;
  rowSelection?: RowSelectionState;
  setRowSelection?: React.Dispatch<React.SetStateAction<RowSelectionState>>;
  onRowSelectionChange?: (selectedRows: TData[]) => void;
  getRowId?: (originalRow: TData, index: number) => string;
  pageSize?: number;
  showPagination?: boolean;
  dense?: boolean;
  toolbar?: React.ReactNode;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  isLoading = false,
  emptyTitle = "暂无数据",
  emptyDescription = "未找到符合当前条件的记录。",
  emptyActionText,
  onEmptyAction,
  onRowClick,
  enableRowSelection = false,
  rowSelection: externalRowSelection,
  setRowSelection: externalSetRowSelection,
  onRowSelectionChange,
  getRowId,
  pageSize = 20,
  showPagination = true,
  dense = false,
  toolbar,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [internalRowSelection, setInternalRowSelection] = React.useState<RowSelectionState>({});
  const rowSelection = externalRowSelection ?? internalRowSelection;
  const setRowSelection = externalSetRowSelection ?? setInternalRowSelection;
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});

  // Augment columns with selection checkbox if enableRowSelection is true
  const tableColumns = React.useMemo(() => {
    if (!enableRowSelection) return columns;
    if (columns.some((col) => (col as { id?: string }).id === "select")) return columns;

    const selectColumn: ColumnDef<TData, any> = {
      id: "select",
      header: ({ table }) => (
        <input
          type="checkbox"
          checked={table.getIsAllPageRowsSelected()}
          onChange={(e) => table.toggleAllPageRowsSelected(!!e.target.checked)}
          aria-label="全选当前页"
          className="size-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={row.getIsSelected()}
          onChange={(e) => {
            e.stopPropagation();
            row.toggleSelected(!!e.target.checked);
          }}
          aria-label="选择行"
          className="size-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
        />
      ),
      enableSorting: false,
      enableHiding: false,
      size: 40,
    };

    return [selectColumn, ...columns];
  }, [columns, enableRowSelection]);

  const table = useReactTable({
    data,
    columns: tableColumns,
    getRowId,
    state: {
      sorting,
      rowSelection,
      columnVisibility,
    },
    initialState: {
      pagination: {
        pageSize,
      },
    },
    enableRowSelection,
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  // Notify parent on selection change
  React.useEffect(() => {
    if (onRowSelectionChange) {
      const selected = table.getSelectedRowModel().rows.map((r) => r.original);
      onRowSelectionChange(selected);
    }
  }, [rowSelection, onRowSelectionChange, table]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-2xs overflow-hidden">
        <TableSkeleton rows={pageSize > 10 ? 8 : pageSize} cols={columns.length + (enableRowSelection ? 1 : 0)} />
      </div>
    );
  }

  const rows = table.getRowModel().rows;

  return (
    <div className="space-y-3">
      {toolbar}

      <div className="rounded-xl border border-slate-200 bg-white shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-slate-200 bg-slate-50/80">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const isSorted = header.column.getIsSorted();

                    return (
                      <th
                        key={header.id}
                        className={`text-xs font-semibold uppercase tracking-wider text-slate-500 px-3.5 py-3 select-none ${
                          canSort ? "cursor-pointer hover:bg-slate-100/70" : ""
                        }`}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <div className="flex items-center gap-1.5">
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                          {canSort && (
                            <span className="text-slate-400">
                              {isSorted === "asc" ? (
                                <ArrowUp className="size-3.5 text-emerald-600 font-bold" />
                              ) : isSorted === "desc" ? (
                                <ArrowDown className="size-3.5 text-emerald-600 font-bold" />
                              ) : (
                                <ArrowUpDown className="size-3 opacity-40 hover:opacity-100" />
                              )}
                            </span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>

            <tbody className="divide-y divide-slate-100 text-[15px] leading-6 text-slate-700">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={tableColumns.length} className="p-0">
                    <EmptyState
                      title={emptyTitle}
                      description={emptyDescription}
                      actionText={emptyActionText}
                      onAction={onEmptyAction}
                      className="border-none my-0 rounded-none bg-transparent"
                    />
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => onRowClick && onRowClick(row.original)}
                    className={`transition-colors hover:bg-slate-50/80 ${
                      row.getIsSelected() ? "bg-emerald-50/40" : ""
                    } ${onRowClick ? "cursor-pointer" : ""}`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={`px-3.5 ${dense ? "py-2" : "py-3"} align-middle text-slate-800`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        {showPagination && data.length > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 py-3 border-t border-slate-200 bg-slate-50/50 text-sm text-slate-500 gap-3">
            <div className="flex items-center gap-2">
              {enableRowSelection && (
                <span>
                  已选 <strong className="text-slate-800">{Object.keys(rowSelection).length}</strong> 项 /
                </span>
              )}
              <span>
                共 <strong className="text-slate-800">{data.length}</strong> 条记录
              </span>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <span>每页显示</span>
                <select
                  value={table.getState().pagination.pageSize}
                  onChange={(e) => table.setPageSize(Number(e.target.value))}
                  className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                >
                  {[10, 20, 50, 100].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
                <span>条</span>
              </div>

              <div className="flex items-center gap-1">
                <span>
                  第 <strong>{table.getState().pagination.pageIndex + 1}</strong> /{" "}
                  <strong>{table.getPageCount() || 1}</strong> 页
                </span>

                <div className="flex items-center gap-0.5 ml-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => table.setPageIndex(0)}
                    disabled={!table.getCanPreviousPage()}
                    aria-label="首页"
                  >
                    <ChevronsLeft className="size-3.5" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => table.previousPage()}
                    disabled={!table.getCanPreviousPage()}
                    aria-label="上一页"
                  >
                    <ChevronLeft className="size-3.5" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => table.nextPage()}
                    disabled={!table.getCanNextPage()}
                    aria-label="下一页"
                  >
                    <ChevronRight className="size-3.5" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                    disabled={!table.getCanNextPage()}
                    aria-label="末页"
                  >
                    <ChevronsRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
