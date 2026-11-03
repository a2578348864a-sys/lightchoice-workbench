import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sourcePage = readFileSync(new URL("../source/SourceManagementClient.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../source-layer/SellerSpriteKeywordCapturePanel.tsx", import.meta.url), "utf8");

describe("P4-UX1A more tools disclosure behavior (source contract)", () => {
  it("uses disclosure semantics instead of fake ARIA menu", () => {
    expect(sourcePage).toContain('aria-expanded={moreToolsOpen}');
    expect(sourcePage).toContain('aria-controls="more-tools-popover"');
    expect(sourcePage).not.toContain('role="menu"');
    expect(sourcePage).not.toContain('role="menuitem"');
    expect(sourcePage).toContain('role="group"');
  });

  it("closes on Escape and restores focus to trigger", () => {
    expect(sourcePage).toContain('event.key !== "Escape"');
    expect(sourcePage).toContain("moreToolsButtonRef.current?.focus()");
  });

  it("closes on outside pointer down", () => {
    expect(sourcePage).toContain('document.addEventListener("mousedown", onPointer)');
    expect(sourcePage).toContain("root.contains(event.target)");
  });

  it("keeps job prepare vs run semantics", () => {
    expect(panel).toContain('data-testid="sellersprite-depth-prepare"');
    expect(panel).toContain('"准备采集"');
    expect(panel).toContain('onClick={()=>void prepareJob()}');
    expect(panel).toContain("开始采集（下一段）");
    const prepare = panel.slice(panel.indexOf("async function prepareJob()"), panel.indexOf("async function runWindow("));
    expect(prepare).toContain('action: "prepare"');
    expect(prepare).not.toMatch(/runWindow\s*\(|action:\s*["']run["']/);
    expect(panel).toContain('onClick={()=>void runWindow()}');
  });
});
