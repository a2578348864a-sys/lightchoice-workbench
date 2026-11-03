import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspace = readFileSync(
  resolve(process.cwd(), "components/source/CaptureTaskWorkspace.tsx"),
  "utf8",
);
const panel = readFileSync(
  resolve(process.cwd(), "components/source/BatchCaptureRunPanel.tsx"),
  "utf8",
);

/**
 * 驾驶舱读取循环合同：父级传入的对象/回调每次渲染都会新建，
 * overview 读取只能按批次、刷新令牌和值键触发，不能按对象身份触发。
 */
describe("CaptureTaskWorkspace 驾驶舱读取循环合同", () => {
  it("overview effect 不再依赖每次渲染新建的回调和对象", () => {
    expect(workspace).not.toContain("[loadOverview, refreshToken]");
    expect(workspace).toContain("const loadOverviewRef = useRef(loadOverview)");
    expect(workspace).toContain("void loadOverviewRef.current()");
  });

  it("父级对象变化按值键触发，数据实际变化时仍会刷新", () => {
    expect(workspace).toContain("const sampleGateKey = sampleGate");
    expect(workspace).toContain("const deepResearchKey = deepResearchItems");
    expect(workspace).toMatch(
      /\[batchId, refreshToken, sampleGateKey, deepResearchKey\]/,
    );
  });

  it("读取仍会回报 loading / present / absent / error 快照", () => {
    expect(workspace).toContain('onSnapshot?.({ state: "loading" })');
    expect(workspace).toContain('{ state: "present", run, view, at: Date.now() }');
    expect(workspace).toContain('{ state: "absent", at: Date.now() }');
    expect(workspace).toContain('state: "error"');
  });

  it("运行面板的 reload 也不再依赖每次渲染新建的 onSnapshot", () => {
    expect(panel).toContain("const onSnapshotRef = useRef(onSnapshot)");
    expect(panel).toContain("onSnapshotRef.current?.(result.run");
    expect(panel).not.toContain("[batchId, load, onSnapshot]");
  });
});
