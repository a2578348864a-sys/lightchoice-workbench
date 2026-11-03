import { createElement, type Attributes, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";
import { Drawer } from "./Drawer";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * D0-005 弹层可访问性回归（静态契约部分）：
 * role=dialog / aria-modal / 可访问名称（aria-labelledby 指向真实标题，缺标题回退 aria-label）。
 * 焦点进入、Tab 循环、Escape 关闭与焦点归还由隔离浏览器验收覆盖。
 */
function attrOf(html: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  return match ? match[1] : null;
}

describe("D0-005 共享弹层可访问名称", () => {
  it("Dialog 有标题时：role=dialog + aria-modal + aria-labelledby 指向标题元素", () => {
    const html = renderToStaticMarkup(
      createElement(
        Dialog,
        { isOpen: true, onClose: vi.fn(), title: "确认删除市场研究画像" } as unknown as Attributes & ComponentProps<typeof Dialog>,
        "正文",
      ),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = attrOf(html, "aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain("确认删除市场研究画像");
  });

  it("Dialog 无标题时回退 aria-label，读屏仍能识别弹层", () => {
    const html = renderToStaticMarkup(
      createElement(
        Dialog,
        { isOpen: true, onClose: vi.fn() } as unknown as Attributes & ComponentProps<typeof Dialog>,
        "正文",
      ),
    );
    expect(attrOf(html, "aria-labelledby")).toBeNull();
    expect(attrOf(html, "aria-label")).toBeTruthy();
  });

  it("Drawer 有标题时暴露 aria-labelledby，指向抽屉标题", () => {
    const html = renderToStaticMarkup(
      createElement(
        Drawer,
        { isOpen: true, onClose: vi.fn(), title: "采集记录" } as unknown as Attributes & ComponentProps<typeof Drawer>,
        "正文",
      ),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = attrOf(html, "aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain("采集记录");
  });

  it("ConfirmDialog 标题通过 Dialog 进入可访问名称（含批量对象清单 testid）", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        isOpen: true,
        onClose: vi.fn(),
        onConfirm: vi.fn(),
        title: "批量归档市场研究画像",
        metrics: { totalCount: 1 },
        selectedItems: [{ id: "scan-1", label: "硅胶烘焙垫（US · scan-1）" }],
      }),
    );
    const labelledBy = attrOf(html, "aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(html).toContain("批量归档市场研究画像");
    // D0-001：确认框必须列出实际操作对象
    expect(html).toContain("confirm-selected-items");
    expect(html).toContain("硅胶烘焙垫（US · scan-1）");
    expect(html).toContain("scan-1");
  });
});
