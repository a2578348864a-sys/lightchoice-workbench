import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPlaywright: vi.fn(),
  captureEnvelope: vi.fn(),
  readV3ModuleEvidence: vi.fn(),
  pageClose: vi.fn(),
  browserClose: vi.fn(),
  connectOverCDP: vi.fn(),
  newPage: vi.fn(),
}));

vi.mock("@/lib/server/playwrightRuntime", () => ({ loadPlaywright: mocks.loadPlaywright }));
vi.mock("@/lib/sourceLayer/browserVisibleModuleCapture", () => ({
  captureBrowserVisibleV3Envelope: mocks.captureEnvelope,
}));
vi.mock("@/lib/sourceLayer/v3ModuleEvidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sourceLayer/v3ModuleEvidence")>();
  return { ...actual, readV3ModuleEvidence: mocks.readV3ModuleEvidence };
});

import {
  captureSellerSpriteVisibleQuery,
  sellerSpriteQueryFingerprint,
  sellerSpriteVisibleQuerySnapshotFingerprint,
  type SellerSpriteVisibleCaptureJobBinding,
  type SellerSpriteVisibleCaptureWindowCheckpoint,
  type SellerSpriteQuerySnapshot,
} from "@/lib/server/sellerSpriteVisibleQuery";
import { identifySellerSpriteVisibleRows } from "@/lib/sourceLayer/sellerSpriteVisibleRowIdentity";
import { sha256OfRawArtifact } from "@/lib/sourceLayer/rawArtifact";
import type { AccessContext } from "@/lib/server/accessPassword";

function querySnapshot(overrides: Partial<SellerSpriteQuerySnapshot> = {}): SellerSpriteQuerySnapshot {
  return {
    pageTitle: "SellerSprite Keyword Mining",
    bodyText: "",
    tables: [],
    queryInputs: [],
    marketplaceEcho: "US",
    loading: false,
    gate: null,
    empty: false,
    queryError: false,
    ...overrides,
  };
}

describe("SellerSprite visible query collector with mocked CDP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SELLERSPRITE_CDP_ENDPOINT = "http://127.0.0.1:9222";
    mocks.readV3ModuleEvidence.mockResolvedValue({ evidenceStore: null });
    mocks.pageClose.mockResolvedValue(undefined);
    mocks.browserClose.mockResolvedValue(undefined);
    mocks.captureEnvelope.mockImplementation(async ({ envelope }: { envelope: Record<string, unknown> }) => {
      const moduleEvidence = {
        schemaVersion: "capture-system-v3-module-evidence.v1",
        module: envelope.module,
        subjectKey: envelope.subjectKey,
        metricNature: envelope.metricNature,
        identity: envelope.identity,
        data: envelope.data,
      };
      const attachment = { attachmentId: "attachment-1", contentHash: "a".repeat(64), payload: moduleEvidence };
      const artifact = { artifactId: "raw-1", sha256: "b".repeat(64) };
      return {
        moduleEvidence,
        attachment,
        rawArtifact: { artifact },
        evidenceStore: { attachments: [attachment], rawArtifacts: [artifact] },
        downstream: { subjectKey: envelope.subjectKey, attachmentId: attachment.attachmentId, rawArtifactId: artifact.artifactId },
      };
    });
  });

  it.each([{count:0,code:"SELLERSPRITE_QUERY_INPUT_MISSING",waits:8},{count:2,code:"SELLERSPRITE_QUERY_INPUT_NOT_UNIQUE",waits:0}])("distinguishes missing async form from ambiguous visible fields ($count)",async({count,code,waits})=>{
    const waitForTimeout=vi.fn().mockResolvedValue(undefined),fill=vi.fn();
    const snapshot=querySnapshot({pageTitle:"Fixture source",visibleControls:[{label:"站点",value:"US"}]});
    const page={goto:vi.fn(),url:()=>"https://www.sellersprite.com/v3/keyword-miner/",close:mocks.pageClose,waitForTimeout,
      evaluate:vi.fn(async(fn:{name?:string})=>fn.name==="collectRawVisibleTables"?{bodyText:"",tables:[]}:snapshot),
      locator:()=>({count:async()=>count,nth:()=>({isVisible:async()=>true,fill})})};
    mocks.newPage.mockResolvedValue(page);mocks.connectOverCDP.mockResolvedValue({contexts:()=>[{newPage:mocks.newPage}],close:mocks.browserClose,newBrowserCDPSession:async()=>({send:async()=>({arguments:["--user-data-dir="+process.cwd().replaceAll("\\","/")+"/.playwright-profile/sellersprite-v3"]}),detach:async()=>undefined})});
    mocks.loadPlaywright.mockResolvedValue({chromium:{connectOverCDP:mocks.connectOverCDP}});
    const result=await captureSellerSpriteVisibleQuery({context:{} as AccessContext,module:"keyword_mining_trend",sourceUrl:page.url(),subjectKey:"amazon:US:B012345678",identity:{keyword:"insulated bottle"},queryInput:{module:"keyword_mining_trend",seedKeyword:"insulated bottle",marketplace:"US"}});
    expect(result.errorCode).toBe(code);expect(result.inputDiagnostics?.visibleMatches).toBe(count);expect(waitForTimeout).toHaveBeenCalledTimes(waits);expect(fill).not.toHaveBeenCalled();expect(mocks.captureEnvelope).not.toHaveBeenCalled();expect(mocks.pageClose).toHaveBeenCalledOnce();expect(mocks.browserClose).not.toHaveBeenCalled();
  });

  it("binds resume snapshots to the visible query, marketplace, and selected period", () => {
    const queryInput = { module: "keyword_mining_trend" as const, seedKeyword: "insulated bottle", marketplace: "US" as const };
    const base = querySnapshot({
      queryInputs: ["insulated bottle"],
      visibleControls: [{ label: "周期", value: "近30天" }, { label: "站点", value: "US" }],
      traversal: {
        page: 1, pageNumber: null, pageCount: null, scrollY: 0, scrollTarget: "table",
        clientHeight: 600, scrollHeight: 1200, hasNextPage: false, nextPageDisabled: true,
        sourceLimitDeclared: false, reportedTotalRows: 2, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["insulated bottle", "12500"]] }],
    });
    const fingerprint = sellerSpriteVisibleQuerySnapshotFingerprint({ module: "keyword_mining_trend", queryInput, snapshot: base });
    expect(sellerSpriteVisibleQuerySnapshotFingerprint({
      module: "keyword_mining_trend",
      queryInput,
      snapshot: querySnapshot({ ...base, visibleControls: [...base.visibleControls!].reverse() }),
    })).toBe(fingerprint);
    expect(sellerSpriteVisibleQuerySnapshotFingerprint({
      module: "keyword_mining_trend",
      queryInput,
      snapshot: querySnapshot({ ...base, visibleControls: [{ label: "周期", value: "近90天" }, { label: "站点", value: "US" }] }),
    })).not.toBe(fingerprint);
    expect(sellerSpriteVisibleQuerySnapshotFingerprint({
      module: "keyword_mining_trend",
      queryInput,
      snapshot: querySnapshot({ ...base, marketplaceEcho: "CA" }),
    })).not.toBe(fingerprint);
  });

  it("honors a stop signal after query confirmation and before EvidenceStore persistence", async () => {
    const before = querySnapshot({
      queryInputs: ["previous keyword"],
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["previous keyword", "100"]] }],
    });
    const after = querySnapshot({
      queryInputs: ["insulated bottle"],
      traversal: {
        page: 1, pageNumber: null, pageCount: null, scrollY: 0, scrollTarget: "table",
        clientHeight: 600, scrollHeight: 600, hasNextPage: false, nextPageDisabled: true,
        sourceLimitDeclared: false, reportedTotalRows: 1, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["insulated bottle", "12500"]] }],
    });
    let current = before;
    const rawOf = (snap: SellerSpriteQuerySnapshot) => ({
      bodyText: snap.bodyText,
      tables: (snap.tables ?? []).map((table, index) => ({
        index,
        selector: `table:nth-of-type(${index + 1})`,
        className: "",
        pairKey: "root",
        headerCells: table.headers,
        headerCellTags: table.headers.map(() => "th"),
        rows: table.rows,
      })),
    });
    const coreOf = (snap: SellerSpriteQuerySnapshot) => {
      const { tables: _tables, ...core } = snap;
      return core;
    };
    const page = {
      close: mocks.pageClose,
      evaluate: vi.fn(async (fn: { name?: string }) => {
        if (fn?.name === "collectRawVisibleTables") return rawOf(current);
        return coreOf(current);
      }),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://www.sellersprite.com/v3/keyword-mining/"),
      title: vi.fn().mockResolvedValue("SellerSprite Keyword Mining"),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        count: vi.fn().mockResolvedValue(1),
        isVisible: vi.fn().mockResolvedValue(true),
        nth: vi.fn(() => ({
          fill: vi.fn().mockResolvedValue(undefined),
          getAttribute: vi.fn().mockResolvedValue("text"),
          isVisible: vi.fn().mockResolvedValue(true),
          press: vi.fn(async () => { current = after; }),
        })),
      })),
    };
    mocks.connectOverCDP.mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage.mockResolvedValue(page) }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP: mocks.connectOverCDP } });
    let stopChecks = 0;

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "keyword_mining_trend",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      subjectKey: "amazon:US:B012345678",
      identity: { keyword: "insulated bottle" },
      queryInput: { module: "keyword_mining_trend", seedKeyword: "insulated bottle", marketplace: "US" },
      accountAccessFingerprint: "test-scope",
      captureJobFingerprint: "d".repeat(64),
      attemptGeneration: 1,
      maxWindows: 1,
      shouldStop: async () => { stopChecks += 1; return stopChecks >= 5; },
    });

    expect(result).toMatchObject({ status: "failed", errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED" });
    expect(result.traversal).toMatchObject({ limitationReason: "cancelled", errorCode: "SELLERSPRITE_CAPTURE_JOB_STOPPED" });
    expect(mocks.captureEnvelope).not.toHaveBeenCalled();
    expect(mocks.pageClose).toHaveBeenCalledTimes(1);
  });

  it("D2-1F）9222 上是外来 Chrome（Profile 不匹配）→ 拒绝且不创建任何页面", async () => {
    mocks.connectOverCDP.mockResolvedValueOnce({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=D:/other/daily-chrome"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage }],
    });

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "keyword_mining_trend",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      subjectKey: "amazon:US:B012345678",
      identity: { keyword: "insulated bottle" },
      queryInput: { module: "keyword_mining_trend", seedKeyword: "insulated bottle", marketplace: "US" },
      accountAccessFingerprint: "test-scope",
      captureJobFingerprint: "d".repeat(64),
      attemptGeneration: 1,
      maxWindows: 1,
    });

    expect(result).toMatchObject({ status: "unavailable", errorCode: "SELLERSPRITE_BROWSER_IDENTITY_MISMATCH" });
    // 拒绝路径：不创建页面、不导航、不采集，也绝不关闭对方浏览器。
    expect(mocks.newPage).not.toHaveBeenCalled();
    expect(mocks.pageClose).not.toHaveBeenCalled();
    expect(mocks.captureEnvelope).not.toHaveBeenCalled();
  });

  it("D2-1F）身份无法验证（外部实例无自动化标记）→ 拒绝且不创建任何页面", async () => {
    mocks.connectOverCDP.mockResolvedValueOnce({
      newBrowserCDPSession: async () => ({
        send: async () => { throw new Error("Command line not returned because --enable-automation not set."); },
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage }],
    });

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "keyword_mining_trend",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      subjectKey: "amazon:US:B012345678",
      identity: { keyword: "insulated bottle" },
      queryInput: { module: "keyword_mining_trend", seedKeyword: "insulated bottle", marketplace: "US" },
      accountAccessFingerprint: "test-scope",
      captureJobFingerprint: "d".repeat(64),
      attemptGeneration: 1,
      maxWindows: 1,
    });

    expect(result).toMatchObject({ status: "unavailable", errorCode: "SELLERSPRITE_BROWSER_IDENTITY_UNVERIFIED" });
    expect(mocks.newPage).not.toHaveBeenCalled();
    expect(mocks.captureEnvelope).not.toHaveBeenCalled();
  });

  it("captures only the changed page result and closes its owned page, never external Chrome", async () => {
    const snapshots = [
      querySnapshot({ tables: [{ headers: ["关键词", "月搜索量"], rows: [["stale", "10"]] }] }),
      querySnapshot({
        queryInputs: ["insulated bottle"],
      traversal: {
        page: 1, pageNumber: null, pageCount: null, scrollY: 0, scrollTarget: null,
        clientHeight: 600, scrollHeight: 600, hasNextPage: false, nextPageDisabled: true,
        sourceLimitDeclared: false, reportedTotalRows: 1, accessibleRows: null, unavailableRows: null,
      },
        tables: [{ headers: ["关键词", "月搜索量"], rows: [["insulated bottle", "12500"]] }],
      }),
    ];
    // readQuerySnapshot 每次读快照会 evaluate 两次：先 core、再 raw 表格。
    // 该 mock 据此区分：core 调用推进快照，raw 调用返回当前快照对应的原始表格结构。
    let current = snapshots[0];
    const rawOf = (snap: SellerSpriteQuerySnapshot) => ({
      bodyText: snap.bodyText,
      tables: (snap.tables ?? []).map((table, index) => ({
        index,
        selector: `table:nth-of-type(${index + 1})`,
        className: "",
        pairKey: "root",
        headerCells: table.headers,
        headerCellTags: table.headers.map(() => "th"),
        rows: table.rows,
      })),
    });
    const coreOf = (snap: SellerSpriteQuerySnapshot) => {
      const { tables: _tables, ...core } = snap;
      return core;
    };
    const page = {
      close: mocks.pageClose,
      evaluate: vi.fn(async (fn: { name?: string }) => {
        if (fn && fn.name === "collectRawVisibleTables") return rawOf(current);
        current = snapshots.shift() ?? current;
        return coreOf(current);
      }),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://www.sellersprite.com/v3/keyword-mining/"),
      title: vi.fn().mockResolvedValue("SellerSprite Keyword Mining"),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        count: vi.fn().mockResolvedValue(1),
        isVisible: vi.fn().mockResolvedValue(true),
        nth: vi.fn(() => ({
          fill: vi.fn().mockResolvedValue(undefined),
          getAttribute: vi.fn().mockResolvedValue("text"),
          isVisible: vi.fn().mockResolvedValue(true),
          press: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    };
    mocks.connectOverCDP.mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage.mockResolvedValue(page) }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP: mocks.connectOverCDP } });

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "keyword_mining_trend",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      subjectKey: "amazon:US:B012345678",
      identity: { keyword: "insulated bottle" },
      queryInput: { module: "keyword_mining_trend", seedKeyword: "insulated bottle", marketplace: "US" },
      accountAccessFingerprint: "scope-hash",
      attemptGeneration: 3,
      maxWindows: 2,
      now: new Date("2026-10-08T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ status: "captured", errorCode: null });
    expect(result.traversal).toMatchObject({ finalStatus: "COMPLETE", counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 } });
    expect(mocks.captureEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: "sellersprite_plugin",
      sourceFingerprint: expect.stringContaining(":g1:window:"),
      envelope: expect.objectContaining({
        evidenceOnly: true,
        data: expect.objectContaining({
          queryInput: { module: "keyword_mining_trend", seedKeyword: "insulated bottle", marketplace: "US" },
          queryIdentity: expect.objectContaining({
            subjectKey: "amazon:US:B012345678",
            marketplace: "US",
            module: "keyword_mining_trend",
            query: "insulated bottle",
            queryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
            captureJobFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
          visibleSnapshot: expect.objectContaining({ tables: [{ headers: ["关键词", "月搜索量"], rows: [["insulated bottle", "12500"]] }] }),
          rowEvidenceBindings: [expect.objectContaining({ keyword: "insulated bottle", status: "valid" })],
          captureWindow: expect.objectContaining({ windowBudget: 2 }),
        }),
        identity: expect.objectContaining({ keyword: "insulated bottle" }),
      }),
    }));
    expect(mocks.pageClose).toHaveBeenCalledTimes(1);
    expect(mocks.browserClose).not.toHaveBeenCalled();
  });

  it.each([
    {
      module: "keyword_mining_trend" as const,
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      identity: { keyword: "insulated bottle" },
      queryInput: { module: "keyword_mining_trend" as const, seedKeyword: "insulated bottle", marketplace: "US" as const },
    },
    {
      module: "reverse_asin" as const,
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      identity: { asin: "B012345678" },
      queryInput: { module: "reverse_asin" as const, targetAsin: "B012345678", marketplace: "US" as const },
    },
  ])("persists a duplicate-only terminal window for $module without increasing unique row coverage", async ({ module, sourceUrl, identity, queryInput }) => {
    const row = ["insulated bottle", "12500"];
    const queryEcho = module === "reverse_asin" ? "B012345678" : "insulated bottle";
    const snapshots = [
      querySnapshot({
        queryInputs: [queryEcho],
        traversal: {
          page: 1, pageNumber: null, pageCount: null, scrollY: 0, scrollTarget: "table",
          clientHeight: 600, scrollHeight: 1200, hasNextPage: false, nextPageDisabled: false,
          sourceLimitDeclared: false, reportedTotalRows: 1, accessibleRows: null, unavailableRows: null,
        },
        tables: [{ headers: ["关键词", "月搜索量"], rows: [row] }],
      }),
      querySnapshot({
        queryInputs: [queryEcho],
        traversal: {
          page: 1, pageNumber: null, pageCount: null, scrollY: 600, scrollTarget: "table",
          clientHeight: 600, scrollHeight: 1200, hasNextPage: false, nextPageDisabled: true,
          sourceLimitDeclared: false, reportedTotalRows: 1, accessibleRows: null, unavailableRows: null,
        },
        tables: [{ headers: ["关键词", "月搜索量"], rows: [row] }],
      }),
    ];
    let current = querySnapshot({
      queryInputs: ["previous keyword"],
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["previous keyword", "100"]] }],
    });
    const rawOf = (snap: SellerSpriteQuerySnapshot) => ({
      bodyText: snap.bodyText,
      tables: (snap.tables ?? []).map((table, index) => ({
        index,
        selector: `table:nth-of-type(${index + 1})`,
        className: "",
        pairKey: "root",
        headerCells: table.headers,
        headerCellTags: table.headers.map(() => "th"),
        rows: table.rows,
      })),
    });
    const coreOf = (snap: SellerSpriteQuerySnapshot) => {
      const { tables: _tables, ...core } = snap;
      return core;
    };
    const page = {
      close: mocks.pageClose,
      evaluate: vi.fn(async (fn: { name?: string }) => {
        if (fn?.name === "collectRawVisibleTables") return rawOf(current);
        if (fn?.name === "scrollNextVisibleResultWindow") {
          current = snapshots[1];
          return { advanced: true };
        }
        return coreOf(current);
      }),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue(sourceUrl),
      title: vi.fn().mockResolvedValue(module === "reverse_asin" ? "SellerSprite Reverse ASIN" : "SellerSprite Keyword Mining"),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        count: vi.fn().mockResolvedValue(1),
        isVisible: vi.fn().mockResolvedValue(true),
        nth: vi.fn(() => ({
          fill: vi.fn().mockResolvedValue(undefined),
          getAttribute: vi.fn().mockResolvedValue("text"),
          isVisible: vi.fn().mockResolvedValue(true),
          press: vi.fn(async () => { current = snapshots[0]; }),
        })),
      })),
    };
    const envelopes: Record<string, unknown>[] = [];
    mocks.captureEnvelope.mockImplementation(async ({ envelope }: { envelope: Record<string, unknown> }) => {
      envelopes.push(envelope);
      const data = envelope.data as Record<string, unknown>;
      const moduleEvidence = {
        schemaVersion: "capture-system-v3-module-evidence.v1",
        module: envelope.module,
        subjectKey: envelope.subjectKey,
        metricNature: envelope.metricNature,
        identity: envelope.identity,
        data,
      };
      const index = envelopes.length;
      const attachment = { attachmentId: `attachment-${index}`, contentHash: `${String(index).repeat(64).slice(0, 64)}`, payload: moduleEvidence };
      const artifact = { artifactId: `raw-${index}`, sha256: `${String(index + 1).repeat(64).slice(0, 64)}` };
      return {
        moduleEvidence,
        attachment,
        rawArtifact: { artifact },
        evidenceStore: { attachments: [attachment], rawArtifacts: [artifact] },
        downstream: { subjectKey: envelope.subjectKey, attachmentId: attachment.attachmentId, rawArtifactId: artifact.artifactId },
      };
    });
    mocks.connectOverCDP.mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage.mockResolvedValue(page) }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP: mocks.connectOverCDP } });

    const checkpoints: Array<{ evidenceRefs: readonly string[]; persistedRowKeys: readonly string[]; counters: Record<string, number | null> }> = [];
    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module,
      sourceUrl,
      subjectKey: "amazon:US:B012345678",
      identity,
      queryInput,
      accountAccessFingerprint: "scope-hash",
      captureJobFingerprint: "a".repeat(64),
      attemptGeneration: 1,
      onWindowCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
        return true;
      },
    });

    expect(result.traversal).toMatchObject({
      finalStatus: "COMPLETE",
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
      diagnostics: { actualVisibleRows: 2, duplicatesRejected: 1, windowsProcessed: 2 },
    });
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1].data).toMatchObject({
      rowScope: "traversal_checkpoint_only",
      captureWindow: { page: 1, scrollY: 600, nextPageDisabled: true },
      rowEvidenceBindings: [expect.objectContaining({ keyword: "insulated bottle", status: "valid" })],
    });
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1].persistedRowKeys).toEqual([]);
    expect(checkpoints[1].counters.persistedEvidenceRows).toBe(1);
    expect(checkpoints[1].evidenceRefs).toEqual(["attachment:attachment-2", "raw-artifact:raw-2"]);
  });

  it("stops at a CAPTCHA gate without invoking capture", async () => {    const page = {
      close: mocks.pageClose,
      evaluate: vi.fn(async () => querySnapshot({ gate: "captcha" })),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://www.sellersprite.com/v3/keyword-mining/"),
      locator: vi.fn(),
    };
    mocks.connectOverCDP.mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage.mockResolvedValue(page) }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP: mocks.connectOverCDP } });

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "keyword_mining_trend",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      subjectKey: "amazon:US:B012345678",
      identity: { keyword: "insulated bottle" },
      queryInput: { module: "keyword_mining_trend", seedKeyword: "insulated bottle", marketplace: "US" },
    });

    expect(result.status).toBe("human_required");
    expect(mocks.captureEnvelope).not.toHaveBeenCalled();
    expect(mocks.pageClose).toHaveBeenCalledTimes(1);
    expect(mocks.browserClose).not.toHaveBeenCalled();
  });

  it("captures one already-visible membership-limited window and stops before traversal", async () => {
    const queryInput = { module: "reverse_asin" as const, targetAsin: "B012345678", marketplace: "US" as const };
    const before = querySnapshot({ pageTitle: "SellerSprite Reverse ASIN" });
    const limited = querySnapshot({
      pageTitle: "SellerSprite Reverse ASIN",
      bodyText: "主人~ 您当前的会员版本无法查看全部结果\n搜索结果数: 517",
      queryInputs: ["B012345678"],
      traversal: {
        page: 1, pageNumber: 1, pageCount: 2, scrollY: 0, scrollTarget: "table",
        clientHeight: 600, scrollHeight: 1_200, hasNextPage: true, nextPageDisabled: false,
        sourceLimitDeclared: true, reportedTotalRows: 517, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["Keyword", "Traffic Share"], rows: [["visible example", "12.5%"]] }],
    });
    let current = before;
    const coreOf = (snapshot: SellerSpriteQuerySnapshot) => {
      const { tables: _tables, ...core } = snapshot;
      return core;
    };
    const rawOf = (snapshot: SellerSpriteQuerySnapshot) => ({
      bodyText: snapshot.bodyText,
      tables: (snapshot.tables ?? []).map((table, index) => ({
        index,
        selector: `table:nth-of-type(${index + 1})`,
        className: "",
        pairKey: "root",
        headerCells: table.headers,
        headerCellTags: table.headers.map(() => "th"),
        rows: table.rows,
      })),
    });
    const page = {
      close: mocks.pageClose,
      evaluate: vi.fn(async (fn: { name?: string }) => fn?.name === "collectRawVisibleTables"
        ? rawOf(current)
        : coreOf(current)),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://www.sellersprite.com/v3/keyword-reverse/"),
      title: vi.fn().mockResolvedValue("SellerSprite Reverse ASIN"),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        count: vi.fn().mockResolvedValue(1),
        nth: vi.fn(() => ({
          fill: vi.fn().mockResolvedValue(undefined),
          isVisible: vi.fn().mockResolvedValue(true),
          press: vi.fn(async () => { current = limited; }),
        })),
      })),
    };
    mocks.connectOverCDP.mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage.mockResolvedValue(page) }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP: mocks.connectOverCDP } });
    const checkpoints: SellerSpriteVisibleCaptureWindowCheckpoint[] = [];

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "reverse_asin",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      subjectKey: "amazon:US:B012345678",
      identity: { asin: "B012345678" },
      queryInput,
      captureJobFingerprint: "c".repeat(64),
      maxWindows: 2,
      onWindowCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); return true; },
    });

    expect(result.status).toBe("limited");
    expect(result.traversal).toMatchObject({
      finalStatus: "PARTIAL",
      limitationReason: "source_limit_declared",
      counters: {
        reportedTotalRows: 517,
        accessibleRows: null,
        capturedUniqueRows: 1,
        structuredValidRows: 1,
        persistedEvidenceRows: 1,
        unavailableRows: null,
      },
      diagnostics: { actualVisibleRows: 1, windowsProcessed: 1 },
    });
    expect(result.windows).toHaveLength(1);
    expect(result.windows?.[0]?.rowKeys).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
    expect(mocks.captureEnvelope).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
    expect(page.locator).toHaveBeenCalledTimes(1);
    expect(page.evaluate.mock.calls.map(([fn]) => fn.name)).not.toContain("scrollNextVisibleResultWindow");
  });

  it("does not bind or label a source limit while the page is still loading (identity unconfirmed)", async () => {
    const queryInput = { module: "reverse_asin" as const, targetAsin: "B012345678", marketplace: "US" as const };
    const before = querySnapshot({ pageTitle: "SellerSprite Reverse ASIN" });
    const limitedLoading = querySnapshot({
      pageTitle: "SellerSprite Reverse ASIN",
      bodyText: "主人~ 您当前的会员版本无法查看全部结果\n搜索结果数: 517",
      queryInputs: ["B012345678"],
      loading: true,
      traversal: {
        page: 1, pageNumber: null, pageCount: null, scrollY: 0, scrollTarget: "table",
        clientHeight: 600, scrollHeight: 1_200, hasNextPage: true, nextPageDisabled: false,
        sourceLimitDeclared: true, reportedTotalRows: 517, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["visible example", "100"]] }],
    });
    let current = before;
    const coreOf = (snapshot: SellerSpriteQuerySnapshot) => {
      const { tables: _tables, ...core } = snapshot;
      return core;
    };
    const rawOf = (snapshot: SellerSpriteQuerySnapshot) => ({
      bodyText: snapshot.bodyText,
      tables: (snapshot.tables ?? []).map((table, index) => ({
        index,
        selector: `table:nth-of-type(${index + 1})`,
        className: "",
        pairKey: "root",
        headerCells: table.headers,
        headerCellTags: table.headers.map(() => "th"),
        rows: table.rows,
      })),
    });
    const page = {
      close: mocks.pageClose,
      evaluate: vi.fn(async (fn: { name?: string }) => {
        if (fn?.name === "collectRawVisibleTables") return rawOf(current);
        return coreOf(current);
      }),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://www.sellersprite.com/v3/keyword-reverse/"),
      title: vi.fn().mockResolvedValue("SellerSprite Reverse ASIN"),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        count: vi.fn().mockResolvedValue(1),
        nth: vi.fn(() => ({
          fill: vi.fn().mockResolvedValue(undefined),
          isVisible: vi.fn().mockResolvedValue(true),
          press: vi.fn(async () => { current = limitedLoading; }),
        })),
      })),
    };
    mocks.newPage.mockResolvedValue(page);
    mocks.connectOverCDP.mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP: mocks.connectOverCDP } });
    const onSnapshot = vi.fn(async (input: { snapshotFingerprint: string }) => ({
      captureGeneration: 2,
      snapshotFingerprint: input.snapshotFingerprint,
      cursorWindowFingerprint: null,
      cursor: null,
      rowKeys: [],
      structuredValidRowKeys: [],
      persistedRowKeys: [],
      counters: {
        reportedTotalRows: 517, accessibleRows: null, capturedUniqueRows: 0,
        structuredValidRows: 0, persistedEvidenceRows: 0, unavailableRows: null,
      },
      diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
    }));

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "reverse_asin",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      subjectKey: "amazon:US:B012345678",
      identity: { asin: "B012345678" },
      queryInput,
      captureJobFingerprint: "a".repeat(64),
      onSnapshot,
      // 页面永远停在 loading：用注入时钟把等待超时压缩到约 1.5s。
      now: new Date(Date.now() - 30_000 + 1_500),
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SELLERSPRITE_QUERY_IDENTITY_UNCONFIRMED_AT_SOURCE_LIMIT");
    expect(result.traversal).toBeUndefined();
    expect(result.capture).toBeNull();
    expect(result.windows ?? []).toEqual([]);
    // 未确认的快照不得提前绑定到持久任务。
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(mocks.captureEnvelope).not.toHaveBeenCalled();
  });

  it("retries row Evidence after restoring a checkpoint whose write failed", async () => {
    const stale = querySnapshot({
      queryInputs: ["previous keyword"],
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["previous keyword", "100"]] }],
    });
    const target = querySnapshot({
      queryInputs: ["insulated bottle"],
      traversal: {
        page: 1, pageNumber: null, pageCount: null, scrollY: 0, scrollTarget: null,
        clientHeight: 600, scrollHeight: 600, hasNextPage: false, nextPageDisabled: true,
        sourceLimitDeclared: false, reportedTotalRows: 1, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["insulated bottle", "12500"]] }],
    });
    let current = stale;
    const checkpointState: { value?: SellerSpriteVisibleCaptureJobBinding } = {};
    let snapshotFingerprint = "";
    const rawOf = (snap: SellerSpriteQuerySnapshot) => ({
      bodyText: snap.bodyText,
      tables: (snap.tables ?? []).map((table, index) => ({
        index,
        selector: `table:nth-of-type(${index + 1})`,
        className: "",
        pairKey: "root",
        headerCells: table.headers,
        headerCellTags: table.headers.map(() => "th"),
        rows: table.rows,
      })),
    });
    const coreOf = (snap: SellerSpriteQuerySnapshot) => {
      const { tables: _tables, ...core } = snap;
      return core;
    };
    const page = {
      close: mocks.pageClose,
      evaluate: vi.fn(async (fn: { name?: string }) => {
        if (fn?.name === "collectRawVisibleTables") return rawOf(current);
        if (fn?.name === "restoreVisibleResultWindow") return true;
        return coreOf(current);
      }),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://www.sellersprite.com/v3/keyword-mining/"),
      title: vi.fn().mockResolvedValue("SellerSprite Keyword Mining"),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn(() => ({
        count: vi.fn().mockResolvedValue(1),
        nth: vi.fn(() => ({
          fill: vi.fn().mockResolvedValue(undefined),
          isVisible: vi.fn().mockResolvedValue(true),
          press: vi.fn(async () => { current = target; }),
        })),
      })),
    };
    mocks.newPage.mockImplementation(async () => { current = stale; return page; });
    mocks.connectOverCDP.mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP: mocks.connectOverCDP } });
    mocks.captureEnvelope.mockRejectedValueOnce(new Error("EVIDENCE_WRITE_INTERRUPTED"));

    const input = {
      context: {} as AccessContext,
      module: "keyword_mining_trend" as const,
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      subjectKey: "amazon:US:B012345678",
      identity: { keyword: "insulated bottle" },
      queryInput: { module: "keyword_mining_trend" as const, seedKeyword: "insulated bottle", marketplace: "US" as const },
      accountAccessFingerprint: "scope-hash",
      captureJobFingerprint: "a".repeat(64),
      attemptGeneration: 1,
      onSnapshot: async (value: { snapshotFingerprint: string; reportedTotalRows: number | null; accessibleRows: number | null; unavailableRows: number | null }) => {
        snapshotFingerprint = value.snapshotFingerprint;
        if (checkpointState.value) return { ...checkpointState.value, snapshotFingerprint };
        return {
          captureGeneration: 1,
          snapshotFingerprint,
          cursor: null,
          rowKeys: [],
          structuredValidRowKeys: [],
          persistedRowKeys: [],
          counters: {
            reportedTotalRows: value.reportedTotalRows,
            accessibleRows: value.accessibleRows,
            capturedUniqueRows: 0,
            structuredValidRows: 0,
            persistedEvidenceRows: 0,
            unavailableRows: value.unavailableRows,
          },
          diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
        };
      },
      onWindowCheckpoint: async (value: SellerSpriteVisibleCaptureWindowCheckpoint) => {
        checkpointState.value = { captureGeneration: 1, snapshotFingerprint, ...value };
        return true;
      },
    };

    const firstAttempt = await captureSellerSpriteVisibleQuery(input);
    expect(firstAttempt.traversal).toMatchObject({
      finalStatus: "PARTIAL",
      errorCode: "EVIDENCE_WRITE_INTERRUPTED",
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 0 },
    });
    expect(checkpointState.value?.rowKeys).toEqual([expect.stringContaining("generation:1:")]);
    expect(checkpointState.value?.persistedRowKeys).toEqual([]);

    const resumed = await captureSellerSpriteVisibleQuery({ ...input, attemptGeneration: 2 });
    expect(resumed.traversal).toMatchObject({
      finalStatus: "COMPLETE",
      counters: { capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1 },
      diagnostics: { cursorRestored: true },
    });
    expect(mocks.captureEnvelope).toHaveBeenCalledTimes(2);
  });

  it("rotates the capture generation when a resumed cursor window changed", async () => {
    const stale = querySnapshot({
      queryInputs: ["previous keyword"],
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["previous keyword", "100"]] }],
    });
    const pageOne = querySnapshot({
      queryInputs: ["insulated bottle"],
      traversal: {
        page: 1, pageNumber: 1, pageCount: 2, scrollY: 0, scrollTarget: null,
        clientHeight: 600, scrollHeight: 600, hasNextPage: true, nextPageDisabled: false,
        sourceLimitDeclared: false, reportedTotalRows: 2, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["first keyword", "100"]] }],
    });
    const pageTwo = (volume: string) => querySnapshot({
      queryInputs: ["insulated bottle"],
      traversal: {
        page: 2, pageNumber: 2, pageCount: 2, scrollY: 0, scrollTarget: null,
        clientHeight: 600, scrollHeight: 600, hasNextPage: false, nextPageDisabled: true,
        sourceLimitDeclared: false, reportedTotalRows: 2, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["second keyword", volume]] }],
    });
    let current = stale;
    let run = 0;
    const jobState: { value?: SellerSpriteVisibleCaptureJobBinding } = {};
    let snapshotFingerprint = "";
    const rawOf = (snap: SellerSpriteQuerySnapshot) => ({
      bodyText: snap.bodyText,
      tables: (snap.tables ?? []).map((table, index) => ({
        index,
        selector: `table:nth-of-type(${index + 1})`,
        className: "",
        pairKey: "root",
        headerCells: table.headers,
        headerCellTags: table.headers.map(() => "th"),
        rows: table.rows,
      })),
    });
    const coreOf = (snap: SellerSpriteQuerySnapshot) => {
      const { tables: _tables, ...core } = snap;
      return core;
    };
    const page = {
      close: mocks.pageClose,
      evaluate: vi.fn(async (fn: { name?: string }) => {
        if (fn?.name === "collectRawVisibleTables") return rawOf(current);
        if (fn?.name === "restoreVisibleResultWindow") return true;
        return coreOf(current);
      }),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://www.sellersprite.com/v3/keyword-mining/"),
      title: vi.fn().mockResolvedValue("SellerSprite Keyword Mining"),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((selector: string) => selector.includes(".el-pagination") ? ({
        count: vi.fn().mockResolvedValue(1),
        nth: vi.fn(() => ({
          isVisible: vi.fn().mockResolvedValue(true),
          isEnabled: vi.fn().mockResolvedValue(true),
          click: vi.fn(async () => { current = run === 1 ? pageTwo("200") : pageTwo("201"); }),
        })),
      }) : ({
        count: vi.fn().mockResolvedValue(1),
        nth: vi.fn(() => ({
          fill: vi.fn().mockResolvedValue(undefined),
          isVisible: vi.fn().mockResolvedValue(true),
          press: vi.fn(async () => { current = pageOne; }),
        })),
      })),
    };
    mocks.newPage.mockImplementation(async () => { run += 1; current = stale; return page; });
    mocks.connectOverCDP.mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP: mocks.connectOverCDP } });
    const defaultCapture = mocks.captureEnvelope.getMockImplementation();
    expect(defaultCapture).toBeDefined();
    mocks.captureEnvelope.mockImplementationOnce(defaultCapture!);
    mocks.captureEnvelope.mockRejectedValueOnce(new Error("EVIDENCE_WRITE_INTERRUPTED"));

    const input = {
      context: {} as AccessContext,
      module: "keyword_mining_trend" as const,
      sourceUrl: "https://www.sellersprite.com/v3/keyword-mining/",
      subjectKey: "amazon:US:B012345678",
      identity: { keyword: "insulated bottle" },
      queryInput: { module: "keyword_mining_trend" as const, seedKeyword: "insulated bottle", marketplace: "US" as const },
      accountAccessFingerprint: "scope-hash",
      captureJobFingerprint: "a".repeat(64),
      onSnapshot: async (value: { snapshotFingerprint: string; reportedTotalRows: number | null; accessibleRows: number | null; unavailableRows: number | null; forceNewGeneration?: boolean }) => {
        snapshotFingerprint = value.snapshotFingerprint;
        if (value.forceNewGeneration && jobState.value) {
          jobState.value = {
            ...jobState.value,
            captureGeneration: jobState.value.captureGeneration + 1,
            snapshotFingerprint,
            cursor: null,
            cursorWindowFingerprint: null,
            rowKeys: [],
            structuredValidRowKeys: [],
            persistedRowKeys: [],
            counters: {
              reportedTotalRows: value.reportedTotalRows,
              accessibleRows: value.accessibleRows,
              capturedUniqueRows: 0,
              structuredValidRows: 0,
              persistedEvidenceRows: 0,
              unavailableRows: value.unavailableRows,
            },
            diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
          };
          return jobState.value;
        }
        if (jobState.value) return { ...jobState.value, snapshotFingerprint };
        jobState.value = {
          captureGeneration: 1,
          snapshotFingerprint,
          cursor: null,
          rowKeys: [],
          structuredValidRowKeys: [],
          persistedRowKeys: [],
          counters: {
            reportedTotalRows: value.reportedTotalRows,
            accessibleRows: value.accessibleRows,
            capturedUniqueRows: 0,
            structuredValidRows: 0,
            persistedEvidenceRows: 0,
            unavailableRows: value.unavailableRows,
          },
          diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
        };
        return jobState.value;
      },
      onWindowCheckpoint: async (value: SellerSpriteVisibleCaptureWindowCheckpoint) => {
        const previous = jobState.value!;
        jobState.value = {
          ...previous,
          cursor: value.cursor,
          cursorWindowFingerprint: value.cursorWindowFingerprint,
          rowKeys: [...new Set([...previous.rowKeys, ...value.rowKeys])],
          structuredValidRowKeys: [...new Set([...previous.structuredValidRowKeys, ...value.structuredValidRowKeys])],
          persistedRowKeys: [...new Set([...previous.persistedRowKeys, ...value.persistedRowKeys])],
          counters: value.counters,
          diagnostics: value.diagnostics,
        };
        return true;
      },
    };

    const firstAttempt = await captureSellerSpriteVisibleQuery(input);
    expect(firstAttempt.traversal).toMatchObject({
      finalStatus: "PARTIAL",
      errorCode: "EVIDENCE_WRITE_INTERRUPTED",
      counters: { capturedUniqueRows: 2, structuredValidRows: 2, persistedEvidenceRows: 1 },
      cursor: { page: 2, scrollY: 0 },
    });
    expect(jobState.value?.cursorWindowFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const resumed = await captureSellerSpriteVisibleQuery({ ...input, attemptGeneration: 2 });
    expect(resumed.traversal).toMatchObject({
      finalStatus: "PARTIAL",
      errorCode: "SELLERSPRITE_ROW_SNAPSHOT_DRIFT_NEW_GENERATION_REQUIRED",
      captureGeneration: 2,
      cursor: null,
      counters: { capturedUniqueRows: 0, structuredValidRows: 0, persistedEvidenceRows: 0 },
    });
    expect(mocks.captureEnvelope).toHaveBeenCalledTimes(2);
  });

  // ---------- 定向回归：来源限制边界（2026-10-24 修复） ----------

  function limitSnapshotFixture(overrides: Partial<SellerSpriteQuerySnapshot> = {}): SellerSpriteQuerySnapshot {
    return querySnapshot({
      pageTitle: "SellerSprite Reverse ASIN",
      bodyText: "主人~ 您当前的会员版本无法查看全部结果\n搜索结果数: 20",
      queryInputs: ["B01ACUA8HC"],
      traversal: {
        page: 1, pageNumber: 1, pageCount: null, scrollY: 0, scrollTarget: "table",
        clientHeight: 600, scrollHeight: 900, hasNextPage: false, nextPageDisabled: true,
        sourceLimitDeclared: true, reportedTotalRows: 20, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["kitchen mat", "9900"], ["non slip mat", "5400"]] }],
      ...overrides,
    });
  }

  function limitPageFixture(sequence: SellerSpriteQuerySnapshot[]) {
    let step = 0;
    let current = sequence[0];
    const advance = () => { step = Math.min(step + 1, sequence.length - 1); current = sequence[step]; };
    const coreOf = (snapshot: SellerSpriteQuerySnapshot) => {
      const { tables: _tables, ...core } = snapshot;
      return core;
    };
    const rawOf = (snapshot: SellerSpriteQuerySnapshot) => ({
      bodyText: snapshot.bodyText,
      tables: (snapshot.tables ?? []).map((table, index) => ({
        index,
        selector: `table:nth-of-type(${index + 1})`,
        className: "",
        pairKey: "root",
        headerCells: table.headers,
        headerCellTags: table.headers.map(() => "th"),
        rows: table.rows,
      })),
    });
    const page = {
      close: mocks.pageClose,
      evaluate: vi.fn(async (fn: { name?: string }) => {
        if (fn?.name === "collectRawVisibleTables") return rawOf(current);
        if (fn?.name === "restoreVisibleResultWindow") return true;
        return coreOf(current);
      }),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://www.sellersprite.com/v3/keyword-reverse/"),
      title: vi.fn().mockResolvedValue("SellerSprite Reverse ASIN"),
      waitForTimeout: vi.fn(async () => { advance(); }),
      locator: vi.fn((selector: string) => selector.includes(".el-pagination") ? ({
        count: vi.fn().mockResolvedValue(1),
        nth: vi.fn(() => ({
          isVisible: vi.fn().mockResolvedValue(true),
          isEnabled: vi.fn().mockResolvedValue(true),
          click: vi.fn(async () => { advance(); }),
        })),
      }) : ({
        count: vi.fn().mockResolvedValue(1),
        nth: vi.fn(() => ({
          fill: vi.fn().mockResolvedValue(undefined),
          isVisible: vi.fn().mockResolvedValue(true),
          press: vi.fn(async () => { advance(); }),
        })),
      })),
      __state: () => current,
    };
    return page;
  }

  function stubBrowser(page: unknown) {
    mocks.newPage.mockResolvedValue(page);
    mocks.connectOverCDP.mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: mocks.browserClose,
      contexts: () => [{ newPage: mocks.newPage }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP: mocks.connectOverCDP } });
  }

  it("saves the 20 visible rows together with the membership limit banner (limit arrives during loading first)", async () => {
    const queryInput = { module: "reverse_asin" as const, targetAsin: "B01ACUA8HC", marketplace: "US" as const };
    const initial = querySnapshot({ pageTitle: "SellerSprite Reverse ASIN" });
    const loadingLimited = limitSnapshotFixture({ loading: true });
    const settled = limitSnapshotFixture();
    const page = limitPageFixture([initial, loadingLimited, settled, settled]);
    stubBrowser(page);
    const checkpoints: SellerSpriteVisibleCaptureWindowCheckpoint[] = [];

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "reverse_asin",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      subjectKey: "amazon:US:B01ACUA8HC",
      identity: { asin: "B01ACUA8HC" },
      queryInput,
      captureJobFingerprint: "b".repeat(64),
      maxWindows: 2,
      onWindowCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); return true; },
    });

    expect(result.status).toBe("limited");
    expect(result.traversal).toMatchObject({
      finalStatus: "PARTIAL",
      limitationReason: "source_limit_declared",
      errorCode: null,
      counters: {
        reportedTotalRows: 20, capturedUniqueRows: 2, structuredValidRows: 2, persistedEvidenceRows: 2,
      },
    });
    expect(result.windows).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
    expect(mocks.captureEnvelope).toHaveBeenCalledTimes(1);
  });

  it("keeps prior evidence and counters when the same query returns unchanged rows (recheck idempotent)", async () => {
    const queryInput = { module: "reverse_asin" as const, targetAsin: "B01ACUA8HC", marketplace: "US" as const };
    const initial = querySnapshot({ pageTitle: "SellerSprite Reverse ASIN" });
    const settled = limitSnapshotFixture();
    const page = limitPageFixture([initial, settled, settled]);
    stubBrowser(page);
    const bindingState: { value?: SellerSpriteVisibleCaptureJobBinding } = {};
    const checkpoints: SellerSpriteVisibleCaptureWindowCheckpoint[] = [];

    const first = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "reverse_asin",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      subjectKey: "amazon:US:B01ACUA8HC",
      identity: { asin: "B01ACUA8HC" },
      queryInput,
      captureJobFingerprint: "c".repeat(64),
      maxWindows: 2,
      onSnapshot: async (value) => {
        bindingState.value = {
          captureGeneration: 1,
          snapshotFingerprint: value.snapshotFingerprint,
          cursorWindowFingerprint: null,
          cursor: null,
          rowKeys: [],
          structuredValidRowKeys: [],
          persistedRowKeys: [],
          counters: {
            reportedTotalRows: value.reportedTotalRows, accessibleRows: value.accessibleRows,
            capturedUniqueRows: 0, structuredValidRows: 0, persistedEvidenceRows: 0, unavailableRows: value.unavailableRows,
          },
          diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
        };
        return bindingState.value;
      },
      onWindowCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
        if (bindingState.value) {
          bindingState.value = {
            ...bindingState.value,
            cursor: checkpoint.cursor,
            cursorWindowFingerprint: checkpoint.cursorWindowFingerprint,
            rowKeys: [...new Set([...bindingState.value.rowKeys, ...checkpoint.rowKeys])],
            structuredValidRowKeys: [...new Set([...bindingState.value.structuredValidRowKeys, ...checkpoint.structuredValidRowKeys])],
            persistedRowKeys: [...new Set([...bindingState.value.persistedRowKeys, ...checkpoint.persistedRowKeys])],
            counters: checkpoint.counters,
            diagnostics: checkpoint.diagnostics,
          };
        }
        return true;
      },
    });
    expect(first.status).toBe("limited");
    expect(first.traversal?.counters.persistedEvidenceRows).toBe(2);
    expect(mocks.captureEnvelope).toHaveBeenCalledTimes(1);

    // 第二次核验同一查询：EvidenceStore 已有本轮行哈希 → 结果未变化 → 不重复写证据，保留既有计数。
    const persistedRowIdentity = identifySellerSpriteVisibleRows("reverse_asin", settled.tables);
    const persistedTable = settled.tables[0];
    const payload = {
      schemaVersion: "capture-system-v3-module-evidence.v1",
      module: "reverse_asin",
      subjectKey: "amazon:US:B01ACUA8HC",
      marketplace: "US",
      capturedAt: "2026-10-24T00:00:00.000Z",
      provider: "sellersprite",
      sourceSurface: "SellerSprite reverse_asin visible query window",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      providerUpdatedAt: null,
      freshnessMetricKey: null,
      acquisitionMode: "DOM_DIRECT",
      metricNature: "provider_estimate",
      status: "AVAILABLE_WITH_LIMITATION",
      limitations: ["visible_dom_window_only"],
      identity: { asin: "B01ACUA8HC" },
      evidenceOnly: true,
      data: {
        queryIdentity: {
          captureJobFingerprint: "c".repeat(64),
          queryFingerprint: sellerSpriteQueryFingerprint(queryInput, "not_verified"),
        },
        captureWindow: {
          captureWindowKey: "1".repeat(64),
          captureGeneration: 1,
          snapshotFingerprint: "2".repeat(64),
        },
        rowEvidenceBindings: persistedRowIdentity.rowKeys.map((rowKey, index) => ({
          rowKey,
          rowContentHash: createHash("sha256").update(JSON.stringify({
            headers: persistedTable.headers, row: persistedTable.rows[index],
          })).digest("hex"),
          status: "valid",
        })),
        visibleSnapshot: { tables: [] },
      },
    };
    const expectedRawHash = sha256OfRawArtifact(new TextEncoder().encode(`${JSON.stringify({
      schemaVersion: payload.schemaVersion,
      acquisitionMode: payload.acquisitionMode,
      evidence: payload,
    }, null, 2)}\n`));
    mocks.readV3ModuleEvidence.mockResolvedValue({
      evidenceStore: {
        subjectKey: "amazon:US:B01ACUA8HC",
        attachments: [{ attachmentId: "att-1", contentHash: "a".repeat(64), payload, capturedAt: payload.capturedAt }],
        rawArtifacts: [{
          artifactId: "raw-1", subjectKey: "amazon:US:B01ACUA8HC", sha256: expectedRawHash,
          capturedAt: payload.capturedAt, sourceType: "sellersprite_plugin",
        }],
      },
    });

    const second = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "reverse_asin",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      subjectKey: "amazon:US:B01ACUA8HC",
      identity: { asin: "B01ACUA8HC" },
      queryInput,
      captureJobFingerprint: "c".repeat(64),
      maxWindows: 2,
      onSnapshot: async (value) => ({
        ...(bindingState.value ?? {
          captureGeneration: 1,
          cursor: null,
          rowKeys: [],
          structuredValidRowKeys: [],
          persistedRowKeys: [],
          counters: {
            reportedTotalRows: value.reportedTotalRows, accessibleRows: value.accessibleRows,
            capturedUniqueRows: 0, structuredValidRows: 0, persistedEvidenceRows: 0, unavailableRows: value.unavailableRows,
          },
          diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
        }),
        snapshotFingerprint: value.snapshotFingerprint,
      }),
      onWindowCheckpoint: async () => true,
    });
    expect(second.status).toBe("limited");
    expect(second.traversal).toMatchObject({
      finalStatus: "PARTIAL",
      limitationReason: "source_limit_declared",
      counters: { capturedUniqueRows: 2, structuredValidRows: 2, persistedEvidenceRows: 2 },
    });
    expect(second.windows?.[0]?.rowKeys).toEqual([]);
    expect(mocks.captureEnvelope).toHaveBeenCalledTimes(1);
  });

  it("resumes an old cursor, accepts the limit page with confirmed identity, and saves its rows", async () => {
    const queryInput = { module: "reverse_asin" as const, targetAsin: "B01ACUA8HC", marketplace: "US" as const };
    const initial = querySnapshot({ pageTitle: "SellerSprite Reverse ASIN" });
    const pageOne = limitSnapshotFixture({
      traversal: {
        page: 1, pageNumber: 1, pageCount: 3, scrollY: 0, scrollTarget: null,
        clientHeight: 600, scrollHeight: 600, hasNextPage: true, nextPageDisabled: false,
        sourceLimitDeclared: false, reportedTotalRows: 40, accessibleRows: null, unavailableRows: null,
      },
      bodyText: "",
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["page one keyword", "8000"]] }],
    });
    const limitedPageTwo = limitSnapshotFixture({
      queryInputs: ["B01ACUA8HC"],
      traversal: {
        page: 2, pageNumber: 2, pageCount: 3, scrollY: 0, scrollTarget: null,
        clientHeight: 600, scrollHeight: 600, hasNextPage: false, nextPageDisabled: true,
        sourceLimitDeclared: true, reportedTotalRows: 40, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["page two keyword", "7000"]] }],
    });
    const page = limitPageFixture([initial, pageOne, pageOne, limitedPageTwo]);
    stubBrowser(page);
    const onSnapshot = vi.fn(async (value: { snapshotFingerprint: string; reportedTotalRows: number | null; accessibleRows: number | null; unavailableRows: number | null }) => ({
      captureGeneration: 1,
      snapshotFingerprint: value.snapshotFingerprint,
      cursorWindowFingerprint: null,
      cursor: { page: 2, scrollY: 0, scrollTarget: "document" as const },
      rowKeys: ["generation:1:earlier-row"],
      structuredValidRowKeys: ["generation:1:earlier-row"],
      persistedRowKeys: ["generation:1:earlier-row"],
      counters: {
        reportedTotalRows: value.reportedTotalRows, accessibleRows: value.accessibleRows,
        capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1, unavailableRows: value.unavailableRows,
      },
      diagnostics: { actualVisibleRows: 1, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 1, cursorRestored: null },
    }));

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "reverse_asin",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      subjectKey: "amazon:US:B01ACUA8HC",
      identity: { asin: "B01ACUA8HC" },
      queryInput,
      captureJobFingerprint: "d".repeat(64),
      maxWindows: 2,
      resumeCursor: { page: 2, scrollY: 0, scrollTarget: "document" },
      onSnapshot,
    });

    expect(result.status).toBe("limited");
    expect(result.traversal).toMatchObject({
      finalStatus: "PARTIAL",
      limitationReason: "source_limit_declared",
      counters: { capturedUniqueRows: 2, structuredValidRows: 2, persistedEvidenceRows: 2 },
      diagnostics: { cursorRestored: false },
    });
    expect(result.windows).toHaveLength(1);
    expect(result.windows?.[0]?.rowKeys).toHaveLength(1);
    expect(mocks.captureEnvelope).toHaveBeenCalledTimes(1);
  });

  it("reports a technical failure instead of a source limit when identity is lost during cursor restoration", async () => {
    const queryInput = { module: "reverse_asin" as const, targetAsin: "B01ACUA8HC", marketplace: "US" as const };
    const initial = querySnapshot({ pageTitle: "SellerSprite Reverse ASIN" });
    const pageOne = limitSnapshotFixture({
      bodyText: "",
      traversal: {
        page: 1, pageNumber: 1, pageCount: 3, scrollY: 0, scrollTarget: null,
        clientHeight: 600, scrollHeight: 600, hasNextPage: true, nextPageDisabled: false,
        sourceLimitDeclared: false, reportedTotalRows: 40, accessibleRows: null, unavailableRows: null,
      },
      tables: [{ headers: ["关键词", "月搜索量"], rows: [["page one keyword", "8000"]] }],
    });
    const limitedNoIdentity = limitSnapshotFixture({
      queryInputs: [],
      traversal: {
        page: 2, pageNumber: 2, pageCount: 3, scrollY: 0, scrollTarget: null,
        clientHeight: 600, scrollHeight: 600, hasNextPage: false, nextPageDisabled: true,
        sourceLimitDeclared: true, reportedTotalRows: 40, accessibleRows: null, unavailableRows: null,
      },
      tables: [],
    });
    const page = limitPageFixture([initial, pageOne, pageOne, limitedNoIdentity]);
    stubBrowser(page);
    const onSnapshot = vi.fn(async (value: { snapshotFingerprint: string; reportedTotalRows: number | null; accessibleRows: number | null; unavailableRows: number | null }) => ({
      captureGeneration: 1,
      snapshotFingerprint: value.snapshotFingerprint,
      cursorWindowFingerprint: null,
      cursor: { page: 2, scrollY: 0, scrollTarget: "document" as const },
      rowKeys: ["generation:1:earlier-row"],
      structuredValidRowKeys: ["generation:1:earlier-row"],
      persistedRowKeys: ["generation:1:earlier-row"],
      counters: {
        reportedTotalRows: value.reportedTotalRows, accessibleRows: value.accessibleRows,
        capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1, unavailableRows: value.unavailableRows,
      },
      diagnostics: { actualVisibleRows: 1, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 1, cursorRestored: null },
    }));

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "reverse_asin",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      subjectKey: "amazon:US:B01ACUA8HC",
      identity: { asin: "B01ACUA8HC" },
      queryInput,
      captureJobFingerprint: "e".repeat(64),
      maxWindows: 2,
      resumeCursor: { page: 2, scrollY: 0, scrollTarget: "document" },
      onSnapshot,
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("SELLERSPRITE_QUERY_IDENTITY_LOST_DURING_TRAVERSAL");
    expect(result.traversal).toMatchObject({
      finalStatus: "PARTIAL",
      limitationReason: "technical_error",
    });
    expect(result.windows).toEqual([]);
    expect(mocks.captureEnvelope).not.toHaveBeenCalled();
  });

  it("reports a confirmed-identity limit with zero visible rows without binding or writing evidence", async () => {
    const queryInput = { module: "reverse_asin" as const, targetAsin: "B01ACUA8HC", marketplace: "US" as const };
    const initial = querySnapshot({ pageTitle: "SellerSprite Reverse ASIN" });
    const settledEmpty = limitSnapshotFixture({ tables: [] });
    const page = limitPageFixture([initial, settledEmpty, settledEmpty]);
    stubBrowser(page);
    const onSnapshot = vi.fn(async (value: { snapshotFingerprint: string }) => ({
      captureGeneration: 1,
      snapshotFingerprint: value.snapshotFingerprint,
      cursorWindowFingerprint: null,
      cursor: null,
      rowKeys: [],
      structuredValidRowKeys: [],
      persistedRowKeys: [],
      counters: {
        reportedTotalRows: 20, accessibleRows: null, capturedUniqueRows: 0,
        structuredValidRows: 0, persistedEvidenceRows: 0, unavailableRows: null,
      },
      diagnostics: { actualVisibleRows: 0, duplicatesRejected: 0, rejectedRows: 0, windowsProcessed: 0 },
    }));

    const result = await captureSellerSpriteVisibleQuery({
      context: {} as AccessContext,
      module: "reverse_asin",
      sourceUrl: "https://www.sellersprite.com/v3/keyword-reverse/",
      subjectKey: "amazon:US:B01ACUA8HC",
      identity: { asin: "B01ACUA8HC" },
      queryInput,
      captureJobFingerprint: "f".repeat(64),
      onSnapshot,
    });

    expect(result.status).toBe("limited");
    expect(result.errorCode).toBe("SELLERSPRITE_SOURCE_LIMIT_WITHOUT_VISIBLE_ROWS");
    expect(result.traversal).toBeUndefined();
    expect(result.capture).toBeNull();
    // 空受限页不产生窗口采集，也不绑定快照。
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(mocks.captureEnvelope).not.toHaveBeenCalled();
  });
});
