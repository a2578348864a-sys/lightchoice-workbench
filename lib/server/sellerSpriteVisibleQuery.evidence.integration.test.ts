import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadPlaywright: vi.fn() }));
vi.mock("@/lib/server/playwrightRuntime", () => ({ loadPlaywright: mocks.loadPlaywright }));

import type { AccessContext } from "@/lib/server/accessPassword";
import { captureSellerSpriteVisibleQuery, type SellerSpriteQuerySnapshot } from "@/lib/server/sellerSpriteVisibleQuery";
import {
  captureEvidenceAttachmentThroughGateway,
  captureThroughGateway,
} from "@/lib/sourceLayer/server/captureGateway";
import { createEvidenceStore } from "@/lib/sourceLayer/server/evidenceStore";
import { readV3ModuleEvidence } from "@/lib/sourceLayer/v3ModuleEvidence";

const OWNER: AccessContext = { mode: "owner", token: "" };
const SUBJECT = "amazon:US:B012345678";
const SEED = "insulated bottle";
const QUERY_URL = "https://www.sellersprite.com/v3/keyword-miner/";

function snapshot(overrides: Partial<SellerSpriteQuerySnapshot> = {}): SellerSpriteQuerySnapshot {
  return {
    pageTitle: "SellerSprite Keyword Mining fixture",
    bodyText: "搜索结果数: 1",
    tables: [{ headers: ["关键词", "月搜索量"], rows: [[SEED, "12500"]] }],
    queryInputs: [SEED],
    visibleControls: [{ label: "站点", value: "US" }],
    marketplaceEcho: "US",
    loading: false,
    gate: null,
    empty: false,
    queryError: false,
    traversal: {
      page: 1,
      pageNumber: 1,
      pageCount: 1,
      scrollY: 0,
      scrollTarget: null,
      clientHeight: 800,
      scrollHeight: 800,
      hasNextPage: false,
      nextPageDisabled: true,
      sourceLimitDeclared: false,
      reportedTotalRows: 1,
      accessibleRows: null,
      unavailableRows: null,
    },
    ...overrides,
  };
}

const rawSnapshot = () => ({
  bodyText: "搜索结果数: 1",
  tables: [{
    index: 0,
    selector: "table:nth-of-type(1)",
    className: "",
    pairKey: "table-root",
    headerCells: ["关键词", "月搜索量"],
    headerCellTags: ["th", "th"],
    rows: [[SEED, "12500"]],
  }],
});

describe("SellerSprite row evidence: disposable fixture through real Gateway and EvidenceStore", () => {
  let tempRoot = "";
  let previousStoreDir: string | undefined;
  let pageClose: ReturnType<typeof vi.fn>;
  let browserClose: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    previousStoreDir = process.env.SOURCE_LAYER_STORE_DIR;
    tempRoot = mkdtempSync(join(tmpdir(), "v5-sellersprite-row-evidence-"));
    process.env.SOURCE_LAYER_STORE_DIR = join(tempRoot, "evidence-store");
    process.env.SELLERSPRITE_CDP_ENDPOINT = "http://127.0.0.1:9222";
    pageClose = vi.fn().mockResolvedValue(undefined);
    browserClose = vi.fn().mockResolvedValue(undefined);

    await captureThroughGateway({
      context: OWNER,
      source: "manual",
      payload: {
        asin: "B012345678",
        title: "Disposable EvidenceStore binding fixture",
        productUrl: "https://www.amazon.com/dp/B012345678",
        images: ["https://images.example.test/fixture.jpg"],
        price: 19.99,
        currency: "USD",
        rating: 4.5,
        reviewCount: 120,
      },
      sourceUrl: "https://www.amazon.com/dp/B012345678",
      subjectKey: SUBJECT,
      marketplace: "US",
      now: new Date("2026-10-10T00:00:00.000Z"),
    });

    let current = snapshot();
    const before = snapshot({ bodyText: "", tables: [], queryInputs: [], traversal: undefined });
    const after = snapshot();
    current = before;
    const page = {
      close: pageClose,
      evaluate: vi.fn(async (fn: { name?: string }) => {
        if (fn?.name === "collectRawVisibleTables") return current === before ? { bodyText: "", tables: [] } : rawSnapshot();
        if (fn?.name === "scrollNextVisibleResultWindow") return { advanced: false, scrollY: 0, clientHeight: 800, scrollHeight: 800 };
        return current;
      }),
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue(QUERY_URL),
      title: vi.fn().mockResolvedValue("SellerSprite Keyword Mining fixture"),
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
    const connectOverCDP = vi.fn().mockResolvedValue({
      newBrowserCDPSession: async () => ({
        send: async () => ({ arguments: ["--user-data-dir=" + process.cwd().replaceAll("\\", "/") + "/.playwright-profile/sellersprite-v3"] }),
        detach: async () => undefined,
      }),
      close: browserClose,
      contexts: () => [{ newPage: vi.fn().mockResolvedValue(page) }],
    });
    mocks.loadPlaywright.mockResolvedValue({ chromium: { connectOverCDP } });
  });

  afterEach(() => {
    if (previousStoreDir === undefined) delete process.env.SOURCE_LAYER_STORE_DIR;
    else process.env.SOURCE_LAYER_STORE_DIR = previousStoreDir;
    delete process.env.SELLERSPRITE_CDP_ENDPOINT;
    if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
    vi.clearAllMocks();
  });

  it("fails closed when Gateway receives no product base Evidence", async () => {
    const missingSubject = "amazon:US:B099999999";
    const store = createEvidenceStore("owner:v1");

    await expect(captureEvidenceAttachmentThroughGateway({
      context: OWNER,
      subjectKey: missingSubject,
      source: "sellersprite_plugin",
      kind: "v3_keyword_mining_trend_v1",
      payload: { module: "keyword_mining_trend", queryIdentity: { subjectKey: missingSubject, query: SEED } },
      sourceUrl: QUERY_URL,
      sourceFingerprint: "disposable-missing-base-evidence",
      capturedAt: new Date("2026-10-10T00:02:00.000Z"),
    })).rejects.toMatchObject({ code: "evidence_missing" });

    expect(await store.getSubject(missingSubject)).toBeNull();
    expect((await store.listSubjects()).some((entry) => entry.subjectKey === missingSubject)).toBe(false);
  });

  it("reuses a duplicate Gateway attachment and reads the single stored copy back", async () => {
    const input = {
      context: OWNER,
      subjectKey: SUBJECT,
      source: "sellersprite_plugin" as const,
      kind: "v3_keyword_mining_trend_v1" as const,
      payload: {
        module: "keyword_mining_trend",
        subjectKey: SUBJECT,
        identity: { keyword: SEED },
        data: { queryIdentity: { subjectKey: SUBJECT, query: SEED }, rowEvidenceBindings: [{ rowKey: "fixture-row-1", rowContentHash: "a".repeat(64) }] },
      },
      sourceUrl: QUERY_URL,
      sourceFingerprint: "disposable-duplicate-attachment",
      capturedAt: new Date("2026-10-10T00:03:00.000Z"),
    };

    const first = await captureEvidenceAttachmentThroughGateway(input);
    const duplicate = await captureEvidenceAttachmentThroughGateway(input);
    const subject = await createEvidenceStore("owner:v1").getSubject(SUBJECT);

    expect(first).toMatchObject({ created: true, duplicate: false });
    expect(duplicate).toMatchObject({ created: false, duplicate: true, attachment: { attachmentId: first.attachment.attachmentId, contentHash: first.attachment.contentHash } });
    expect(subject?.versions).toHaveLength(1);
    expect(subject?.attachments).toHaveLength(1);
    expect(subject?.attachments?.[0]).toMatchObject({
      attachmentId: first.attachment.attachmentId,
      contentHash: first.attachment.contentHash,
      payload: input.payload,
    });
  });

  it("writes row bindings through Capture Gateway and reads the same hashes back from a disposable EvidenceStore", async () => {
    const result = await captureSellerSpriteVisibleQuery({
      context: OWNER,
      module: "keyword_mining_trend",
      sourceUrl: QUERY_URL,
      subjectKey: SUBJECT,
      identity: { keyword: SEED, sourceSurface: "fixture visible query" },
      queryInput: { module: "keyword_mining_trend", seedKeyword: SEED, marketplace: "US" },
      accountAccessFingerprint: "disposable-fixture-scope",
      attemptGeneration: 1,
      maxWindows: 1,
      now: new Date("2026-10-10T00:01:00.000Z"),
    });

    expect(result.status).toBe("captured");
    expect(result.traversal).toMatchObject({
      finalStatus: "COMPLETE",
      limitationReason: "query_finished",
      counters: { reportedTotalRows: 1, accessibleRows: null, capturedUniqueRows: 1, structuredValidRows: 1, persistedEvidenceRows: 1, unavailableRows: null },
      diagnostics: { actualVisibleRows: 1, duplicatesRejected: 0, windowsProcessed: 1 },
    });
    expect(pageClose).toHaveBeenCalledTimes(1);
    expect(browserClose).not.toHaveBeenCalled();

    const readBack = await readV3ModuleEvidence({ context: OWNER, subjectKey: SUBJECT, module: "keyword_mining_trend" });
    const moduleEvidence = readBack.modules[0];
    const subject = await createEvidenceStore("owner:v1").getSubject(SUBJECT);
    expect(moduleEvidence).toMatchObject({
      subjectKey: SUBJECT,
      module: "keyword_mining_trend",
      marketplace: "US",
      provider: "SellerSprite",
      metricNature: "provider_estimate",
      identity: { keyword: SEED },
    });
    const data = moduleEvidence?.data as Record<string, unknown>;
    const queryIdentity = data.queryIdentity as Record<string, unknown>;
    expect(queryIdentity).toMatchObject({ subjectKey: SUBJECT, marketplace: "US", module: "keyword_mining_trend", query: SEED });
    const bindings = data.rowEvidenceBindings as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ keyword: SEED, status: "valid", rowKey: expect.any(String), rowContentHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });

    const attachmentRef = result.windows?.[0]?.evidenceRefs.find((ref) => ref.startsWith("attachment:"));
    const artifactRef = result.windows?.[0]?.evidenceRefs.find((ref) => ref.startsWith("raw-artifact:"));
    const attachmentId = attachmentRef?.slice("attachment:".length);
    const artifactId = artifactRef?.slice("raw-artifact:".length);
    const storedAttachment = subject?.attachments?.find((item) => item.attachmentId === attachmentId);
    const storedArtifact = subject?.rawArtifacts?.find((item) => item.artifactId === artifactId);
    expect(storedAttachment?.payload).toMatchObject({ metricNature: "provider_estimate", data: { rowEvidenceBindings: bindings } });
    expect(storedArtifact?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(storedArtifact?.provenance).toMatchObject({ provider: "SellerSprite", sourceSurface: "SellerSprite keyword_mining_trend visible query window", acquisitionMode: "dom_direct" });
  });
});
