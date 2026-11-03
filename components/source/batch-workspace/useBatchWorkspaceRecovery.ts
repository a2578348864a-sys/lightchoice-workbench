"use client";
import { useEffect, useRef } from "react";
import { BROWSE_KEY, BROWSE_PARAM, defaultBrowseState, readBrowseState, type BrowseState } from "./workspaceBrowseState";

type Store = { version: 1; at: number; last: string | null; batches: Record<string, BrowseState> };
function readStore(): Store {
  try {
    const value = JSON.parse(sessionStorage.getItem(BROWSE_KEY) ?? "null");
    if (value?.version === 1 && Date.now() - value.at < 86400000 && value.batches && typeof value.batches === "object") return value;
  } catch { /* Storage may be disabled. Browsing remains usable. */ }
  return { version: 1, at: Date.now(), last: null, batches: {} };
}
function readScroll(): BrowseState["scroll"] {
  const matrix = document.querySelector<HTMLElement>('[data-testid="matrix-scroll"]');
  const review = document.querySelector<HTMLElement>('[data-testid="batch-product-detail"]');
  return { page: window.scrollY, matrixTop: matrix?.scrollTop ?? 0, matrixLeft: matrix?.scrollLeft ?? 0, review: review?.scrollTop ?? 0 };
}

export function useBatchWorkspaceRecovery({ current, ready, listReady, batches, restore, notice }: {
  current: BrowseState | null; ready: boolean; listReady: boolean; batches: { id: string; archivedAt?: string | null }[];
  restore: (state: BrowseState | null) => void; notice: (message: string) => void;
}) {
  const latest = useRef({ current, ready, listReady, batches, restore, notice });
  latest.current = { current, ready, listReady, batches, restore, notice };
  const initialized = useRef(false), pendingScroll = useRef<BrowseState | null>(null);
  const freshBatch = useRef(false);
  const store = useRef<Store | null>(null);
  const storageNoticeShown = useRef(false);
  const save = () => {
    const { current: state, ready } = latest.current;
    if (!initialized.current || !ready || !state || pendingScroll.current || window.location.pathname !== "/source") return;
    const cache = store.current ?? readStore();
    const scroll = readScroll();
    if (state.view !== "matrix") {
      scroll.matrixTop = cache.batches[state.batchId]?.scroll.matrixTop ?? 0;
      scroll.matrixLeft = cache.batches[state.batchId]?.scroll.matrixLeft ?? 0;
    }
    const value = readBrowseState({ ...state, scroll }, state.batchId)!;
    cache.batches[state.batchId] = value; cache.last = state.batchId; cache.at = Date.now();
    // Bound tab-local UI history; no evidence or live server projections are stored.
    cache.batches = Object.fromEntries(Object.entries(cache.batches).slice(-12)); store.current = cache;
    try { sessionStorage.setItem(BROWSE_KEY, JSON.stringify(cache)); } catch {
      if (!storageNoticeShown.current) { storageNoticeShown.current = true; latest.current.notice("浏览器未能保存浏览位置，刷新后可能无法恢复；当前操作仍可继续。"); }
    }
    window.history.replaceState({ ...window.history.state, lcBrowse: value }, "", window.location.href);
  };
  const restoreFromUrl = (initial: boolean) => {
    const params = new URLSearchParams(window.location.search), cache = store.current ?? readStore(); store.current = cache;
    const explicit = params.has(BROWSE_PARAM);
    const batchId = explicit ? params.get(BROWSE_PARAM) : params.has("marketScanId") ? null : initial ? cache.last : null;
    initialized.current = true;
    if (!batchId) { pendingScroll.current = null; latest.current.restore(null); return; }
    const batch = latest.current.batches.find(b => b.id === batchId);
    if (!batch || batch.archivedAt) {
      pendingScroll.current = null; latest.current.restore(null);
      latest.current.notice("原批次不存在、已归档或当前不可访问，请从批次列表重新选择。");
      params.set(BROWSE_PARAM, ""); window.history.replaceState({ ...window.history.state, lcBrowse: null }, "", `?${params}`); return;
    }
    const saved = readBrowseState(window.history.state?.lcBrowse, batchId) ?? readBrowseState(cache.batches[batchId], batchId);
    freshBatch.current = !saved;
    const state = saved ?? defaultBrowseState(batchId);
    pendingScroll.current = state;
    latest.current.restore(state);
    if (!explicit) { params.set(BROWSE_PARAM, batchId); window.history.replaceState(window.history.state, "", `?${params}`); }
  };
  useEffect(() => {
    if (!listReady || initialized.current) return;
    restoreFromUrl(true);
  });
  useEffect(() => {
    const pop = () => { if (latest.current.listReady) restoreFromUrl(false); };
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(save, 120); };
    const previous = history.scrollRestoration; history.scrollRestoration = "manual";
    window.addEventListener("popstate", pop); window.addEventListener("pagehide", save);
    document.addEventListener("scroll", schedule, true);
    return () => { save(); clearTimeout(timer); history.scrollRestoration = previous; window.removeEventListener("popstate", pop); window.removeEventListener("pagehide", save); document.removeEventListener("scroll", schedule, true); };
  }, []);
  useEffect(() => {
    const state = pendingScroll.current;
    if (!ready || !state || current?.batchId !== state.batchId) { save(); return; }
    // Wait for restored panel/module and Next layout commit before applying scroll once.
    const timer = setTimeout(() => {
      const matrix = document.querySelector<HTMLElement>('[data-testid="matrix-scroll"]');
      matrix?.scrollTo(state.scroll.matrixLeft, state.scroll.matrixTop);
      document.querySelector<HTMLElement>('[data-testid="batch-product-detail"]')?.scrollTo(0, state.scroll.review);
      const workspace = document.getElementById("batch-workspace");
      window.scrollTo(0, freshBatch.current && workspace ? scrollY + workspace.getBoundingClientRect().top - 20 : state.scroll.page);
      pendingScroll.current = null; freshBatch.current = false; save();
    }, 160);
    return () => clearTimeout(timer);
  }, [current, ready]);
  return {
    navigate(batchId: string | null) {
      save();
      if (!batchId && store.current) {
        store.current.last = null;
        try { sessionStorage.setItem(BROWSE_KEY, JSON.stringify(store.current)); } catch { /* Non-blocking. */ }
      }
      const params = new URLSearchParams(window.location.search); params.set(BROWSE_PARAM, batchId ?? "");
      window.history.pushState({ ...window.history.state, lcBrowse: null }, "", `?${params}`);
      restoreFromUrl(false);
    },
    save,
  };
}
