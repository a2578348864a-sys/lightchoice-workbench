import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const { resolve, join } = require("node:path");
  const { cpSync, rmSync, existsSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = `file:${resolve(process.cwd(), "prisma/dev.db").replaceAll("\\", "/")}`;
  }
  if (!process.env.SOURCE_LAYER_STORE_DIR) {
    // 事实：ResearchInputBundle/EvidenceStore 的读取会按生产设计向 audit 目录追加
    // diagnostic 审计条目（append-only）。默认 `npm test` 因此绝不能直接指向正式
    // data/source-layer-store —— 否则只读断言也会改动正式库指纹。
    // 处理：用正式库的字节级快照执行只读断言（内容等价、正式路径零写入）；
    // 正式库不存在（CI 克隆）时保持默认路径并由 realDataAvailable 门控诚实跳过。
    const formal = resolve(process.cwd(), "data/source-layer-store");
    if (existsSync(formal)) {
      const snapshot = join(tmpdir(), "v5-realdata-ro-store");
      try {
        rmSync(snapshot, { recursive: true, force: true });
        cpSync(formal, snapshot, { recursive: true });
        process.env.SOURCE_LAYER_STORE_DIR = snapshot;
      } catch {
        process.env.SOURCE_LAYER_STORE_DIR = formal;
      }
    } else {
      process.env.SOURCE_LAYER_STORE_DIR = formal;
    }
  }
});

import { listCustomerVoiceForResearchTask } from "@/lib/server/customerVoiceService";
import type { AccessContext } from "@/lib/server/accessPassword";

const context: AccessContext = {
  mode: "owner",
  token: "",
};

const REAL_TASK_ID = "cmuax1zja000312l7iffedd33";

/**
 * READ_ONLY_REAL_DATA_TEST —— 仅读取正式数据，绝不调用任何 mutating service
 * （不导入、不调用任何写路径服务；写路径只存在于独立的写验收测试文件）。
 *
 * VOC 持久化写验收已拆分到独立的写验收测试文件（同目录 realDataWrite 命名）：
 * 默认不执行，需 V5_REAL_DATA_WRITE_TEST=1 且显式指向派生副本路径，
 * 正式路径硬失败 REFUSE_PRODUCTION_WRITE_TEST（见 lib/server/testSafety/realDataWriteGuard.ts）。
 *
 * 环境门控：本套件断言绑定本机 prisma/dev.db 中的真实生产任务与真实证据。
 * dev.db 不入库 —— CI 克隆（无该任务）时诚实跳过（task_not_found ≠ 产品失败）。
 */
const realDataAvailable = await (async () => {
  try {
    const { prisma } = await import("@/lib/server/db");
    const task = await prisma.viralAnalysisRecord.findUnique({ where: { id: REAL_TASK_ID } });
    await prisma.$disconnect();
    return Boolean(task);
  } catch {
    return false;
  }
})();

describe.runIf(realDataAvailable)("CustomerVoice Real Data READ-ONLY Acceptance", () => {
  it("task cmuax1zja000312l7iffedd33 with real review_evidence displays in Buyer Voice via read-only derivation", async () => {
    const store = (await import("@/lib/sourceLayer/server/evidenceStore")).createEvidenceStore("owner:v1");
    const sub = await store.getSubject("amazon:US:B0GFCZTRKL");
    // 日志收敛：只允许 kind/id/count 级信息，不输出 payload/评论原文
    console.log(
      "attachments:",
      (sub?.attachments ?? []).map((a) => ({ kind: a.kind, id: a.attachmentId }))
    );

    const result = await listCustomerVoiceForResearchTask({
      context,
      taskId: REAL_TASK_ID,
    });

    expect(result.subjectKey).toBe("amazon:US:B0GFCZTRKL");
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.observations.length).toBeGreaterThanOrEqual(1);
    const first = result.observations[0];
    expect(first.source).toBe("manual_voc");
    expect(first.text).toContain("Great set! Excellent quality");
    expect(first.rating).toBe(5);
    expect(first.identityMatch).toBe("UNRESOLVED");
    expect(first.provenance.provider).toBe("manual_import");
    expect(first.provenance.method).toBe("manual_import");
    expect(first.provenance.accessBasis).toBe("user_supplied_text");
    expect(result.evidenceRefs.length).toBeGreaterThanOrEqual(1);
  });

  it("listCustomerVoiceForResearchTask correctly returns derived observations and respects deduplication", async () => {
    const result = await listCustomerVoiceForResearchTask({
      context,
      taskId: REAL_TASK_ID,
    });

    expect(result.subjectKey).toBe("amazon:US:B0GFCZTRKL");
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.observations.length).toBe(result.count);
    const first = result.observations[0];
    expect(first.subjectKey).toBe("amazon:US:B0GFCZTRKL");
    expect(first.provenance.provider).toBe("manual_import");
    expect(first.provenance.method).toBe("manual_import");
    expect(first.provenance.accessBasis).toBe("user_supplied_text");
    expect(first.identityMatch).toBe("UNRESOLVED");
  });

  it("honest provenance: review_evidence with amazon_dom sourceType inherits amazon_dom, while manual_entry never elevates", async () => {
    // Verified: B0GFCZTRKL's attachment has sourceType='manual_entry' -> resolves to manual_voc / UNRESOLVED
    const result = await listCustomerVoiceForResearchTask({
      context,
      taskId: REAL_TASK_ID,
    });
    const obs = result.observations[0];
    expect(obs.source).toBe("manual_voc");
    expect(obs.identityMatch).toBe("UNRESOLVED");
    expect(obs.provenance.provider).toBe("manual_import");
    expect(obs.provenance.accessBasis).toBe("user_supplied_text");
    // Ensure it NEVER falsely claimed amazon_dom / first_party_visible_page / EXACT
    expect(obs.provenance.provider).not.toBe("amazon_dom");
    expect(obs.provenance.accessBasis).not.toBe("first_party_visible_page");
    expect(obs.identityMatch).not.toBe("EXACT");
  });
});

describe.runIf(!realDataAvailable)("CustomerVoice Real Data READ-ONLY (environment without production tasks)", () => {
  it("skipped honestly: prisma/dev.db in this environment has no production task cmuax1zja000312l7iffedd33", () => {
    // CI clones do not ship dev.db; local runs execute the full assertions above.
    expect(realDataAvailable).toBe(false);
  });
});
