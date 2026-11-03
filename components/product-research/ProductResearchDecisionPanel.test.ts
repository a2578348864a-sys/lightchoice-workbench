import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PRODUCT_RESEARCH_DECISION_OPTIONS } from "@/lib/productResearchDecisionContract";
import {
  submitProductResearchDecision,
  syncProductResearchDecisionToFeishu,
} from "@/components/product-research/ProductResearchDecisionPanel";

const panelSource = readFileSync(
  resolve(process.cwd(), "components/product-research/ProductResearchDecisionPanel.tsx"),
  "utf8",
);

describe("versioned product research decision panel", () => {
  it("uses the shared three-state contract without exposing the internal research fingerprint", () => {
    expect(PRODUCT_RESEARCH_DECISION_OPTIONS.map((option) => option.label)).toEqual([
      "可做（推进立项）",
      "待观察（需补资料）",
      "不做（排除放弃）",
    ]);
    expect(panelSource).toContain("PRODUCT_RESEARCH_DECISION_OPTIONS");
    expect(panelSource).toContain("decisionEvents");
    expect(panelSource).toContain("researchHashFingerprint");
    expect(panelSource).toContain("/api/research-export/lark-sync");
    expect(panelSource).toContain("重新同步");
    expect(panelSource).toContain("决策已本地保存，但同步飞书失败");
    expect(panelSource).toContain("已同步到飞书");
    expect(panelSource).not.toContain("研究指纹");
    expect(panelSource).not.toMatch(/researchHash\s*:/);
    expect(panelSource).toContain('event.actorMode === "owner" ? "管理员" : "访客"');
  });

  it("uses the dedicated GET/PATCH contract with stable decision IDs and conflict reload", () => {
    expect(panelSource).toContain("/research-decision`");
    expect(panelSource).toContain('method: "PATCH"');
    expect(panelSource).toContain("expectedRevision: state.record?.revision ?? 1");
    expect(panelSource).toContain("decisionIdRef.current = createBrowserUuid()");
    expect(panelSource).toContain('data.error.code === "research_record_conflict"');
    expect(panelSource).toContain("await fetchProductResearchDecisionState(input.taskId, fetcher)");
  });

  it("keeps the unified create/completed panel and does not auto-trigger retired creative tools", () => {
    expect(panelSource).not.toContain('data-testid="legacy-research-decision"');
    expect(panelSource).not.toContain("旧版研究记录");
    expect(panelSource).toContain('data-testid="product-research-decision-create"');
    expect(panelSource).toContain('data-testid="product-research-decision-readonly-completed"');
    expect(panelSource).toContain("保存人工决定");
    expect(panelSource).not.toMatch(/Listing|Image Studio/i);
    expect(panelSource).not.toContain("/api/tasks/${encodeURIComponent(taskId)}/listing-pack");
    expect(panelSource).not.toContain("/api/tasks/${encodeURIComponent(taskId)}/image-draft");
  });

  it("guides the user on missing requirements in create mode", () => {
    expect(panelSource).toContain("请先选择人工决定并填写原因；信息完整后即可保存。");
    expect(panelSource).toContain("选择『待观察（需补资料）』时，还需要填写下一步动作。");
    expect(panelSource).toContain('data-testid="need-info-nextstep-hint"');
    expect(panelSource).toContain('data-testid="save-requirements-guidance"');
    expect(panelSource).toContain("保存前待完成：");
    expect(panelSource).toContain("填写决定原因");
    expect(panelSource).toContain("填写下一步动作（待观察时必填）");
    expect(panelSource).toContain('data-testid="save-requirements-guidance-update"');
  });

  it("reloads the latest server revision after a PATCH conflict", async () => {
    const latest = {
      taskId: "task-1",
      legacy: false,
      readOnly: false,
      record: {
        schema: "product-research-record.v1" as const,
        revision: 4,
        researchHashFingerprint: "abc123abc123",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T04:00:00.000Z",
        latestDecision: {
          revision: 4,
          status: "abandoned" as const,
          reason: "The latest server decision.",
          nextAction: null,
          researchHashFingerprint: "abc123abc123",
          decidedAt: "2026-08-03T04:00:00.000Z",
          actorMode: "owner" as const,
        },
        decisionEvents: [],
      },
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: { code: "research_record_conflict", message: "refresh", currentRevision: 4 },
      }), { status: 409, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: latest }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const result = await submitProductResearchDecision({
      taskId: "task-1",
      expectedRevision: 3,
      decisionId: "44444444-4444-4444-8444-444444444444",
      status: "needs_information",
      reason: "Stale form.",
      nextAction: "Refresh.",
      fetcher,
    });
    expect(result).toEqual({ kind: "conflict", state: latest });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ cache: "no-store" });
  });

  it("returns Feishu sync failures as a separate result so the UI can retry", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: { code: "lark_sync_failed", message: "配置缺失" },
      }), { status: 502, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await expect(syncProductResearchDecisionToFeishu("task-1", fetcher)).resolves.toEqual({
      kind: "failed",
      message: "配置缺失",
    });
    await expect(syncProductResearchDecisionToFeishu("task-1", fetcher)).resolves.toEqual({ kind: "synced" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });
});
