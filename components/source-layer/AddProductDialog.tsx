"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Chrome,
  Database,
  FileSpreadsheet,
  Layers,
  Loader2,
  PenTool,
  X,
} from "lucide-react";

import { AMAZON_US_TOP_LEVEL_CATEGORIES } from "@/lib/productBatchPresentation";
import { buildAccessHeaders } from "@/lib/client/accessToken";

export function AddProductDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [tab, setTab] = useState<"batch" | "plugin" | "manual">("batch");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manual entry fields
  const [asin, setAsin] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [title, setTitle] = useState("");
  const [imagesText, setImagesText] = useState("");
  const [price, setPrice] = useState("");
  const [rating, setRating] = useState("");
  const [reviewCount, setReviewCount] = useState("");
  const [bsrRank, setBsrRank] = useState("");
  const [bsrCategory, setBsrCategory] = useState("");
  const [keywordsText, setKeywordsText] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function handleBridgeBatch() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/source-layer/from-product-batch", {
        method: "POST",
        headers: {
          ...buildAccessHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const data = await res.json() as {
        ok?: boolean;
        error?: { message?: string };
        data?: { batchName?: string; totalDrafts?: number; readyCount?: number };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "批次接入失败，请检查批次状态。");
      }
      onSuccess(`成功从批次「${data.data?.batchName || "当前批次"}」接入 ${data.data?.totalDrafts || 0} 个商品证据！`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "批次接入发生异常。");
    } finally {
      setBusy(false);
    }
  }

  async function handleManualSubmit(e: FormEvent) {
    e.preventDefault();
    const cleanAsin = asin.trim().toUpperCase();
    const cleanUrl = productUrl.trim();
    if (!cleanAsin) {
      setError("请输入商品 ASIN。");
      return;
    }
    if (!cleanUrl) {
      setError("请输入商品 URL（用于来源证明追溯）。");
      return;
    }

    setBusy(true);
    setError(null);

    const payload: Record<string, unknown> = {
      asin: cleanAsin,
      title: title.trim() || undefined,
      productUrl: cleanUrl,
      images: imagesText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      keywords: keywordsText
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };

    if (price.trim()) {
      const num = Number(price.trim());
      if (!Number.isNaN(num) && num > 0) {
        // 正式 manual_entry 契约是扁平形状：price 为数字，currency 为独立键。
        // 发送 { amount, currency } 对象会被 adapter 判为不可解析并静默丢弃为 missing。
        payload.price = num;
        payload.currency = "USD";
      }
    }
    if (rating.trim()) {
      const num = Number(rating.trim());
      if (!Number.isNaN(num)) payload.rating = num;
    }
    if (reviewCount.trim()) {
      const num = Number(reviewCount.trim());
      if (!Number.isNaN(num)) payload.reviewCount = num;
    }
    if (bsrRank.trim()) {
      const rank = Number(bsrRank.trim());
      if (!Number.isNaN(rank)) {
        payload.bsrRank = Math.round(rank);
        if (bsrCategory) payload.bsrCategory = bsrCategory;
      }
    }

    try {
      const res = await fetch("/api/source-layer/ingest", {
        method: "POST",
        headers: {
          ...buildAccessHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceType: "manual_entry",
          sourceUrl: cleanUrl,
          payload,
        }),
      });
      const data = await res.json() as {
        ok?: boolean;
        error?: { message?: string };
        data?: { totalDrafts?: number; readyCount?: number; blockedCount?: number; reviewCount?: number };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "手工录入失败。");
      }
      // 诚实提示：状态由校验器决定，不能一律报「成功」。
      const ready = data.data?.readyCount ?? 0;
      const blocked = data.data?.blockedCount ?? 0;
      const review = data.data?.reviewCount ?? 0;
      if (ready > 0) {
        onSuccess(`已录入商品 ${cleanAsin} 来源证据，校验通过，可进入市场扫描或商品研究。`);
      } else {
        const reasons = [
          blocked > 0 ? `${blocked} 条已阻断` : null,
          review > 0 ? `${review} 条需复核` : null,
        ].filter(Boolean).join("、");
        onSuccess(`已录入商品 ${cleanAsin} 来源证据，但校验未通过（${reasons || "未满足准入条件"}）。缺失字段不会被自动补全。`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "录入提交发生异常。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative w-full max-w-xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 bg-slate-50/80">
            <div>
              <h3 className="text-base font-semibold text-slate-900">接入新商品资料</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                选择适合的渠道录入商品来源证明，通过校验后即可用于市场扫描或深入研究。
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600 focus:outline-none"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Connectors Tab */}
          <div className="border-b border-slate-200 bg-white px-6 flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setTab("batch");
                setError(null);
              }}
              className={`flex items-center gap-2 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                tab === "batch"
                  ? "border-sky-600 text-sky-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <FileSpreadsheet className="h-4 w-4" /> 接入卖家精灵批次
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("plugin");
                setError(null);
              }}
              className={`flex items-center gap-2 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                tab === "plugin"
                  ? "border-sky-600 text-sky-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <Chrome className="h-4 w-4" /> 插件数据接入
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("manual");
                setError(null);
              }}
              className={`flex items-center gap-2 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                tab === "manual"
                  ? "border-sky-600 text-sky-700"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <PenTool className="h-4 w-4" /> 手工录入单品
            </button>
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {error && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {tab === "batch" && (
              <div className="source-layer-bridge space-y-4">
                <div className="rounded-xl border border-sky-100 bg-sky-50/50 p-4 text-xs text-sky-900 space-y-2">
                  <p className="font-semibold text-sky-950 flex items-center gap-1.5">
                    <Database className="h-4 w-4 text-sky-600" /> 从当前商品批次接入来源证据
                  </p>
                  <p className="leading-relaxed text-sky-800/90">
                    系统将从已有 SellerSprite 导入批次中读取原始商品数据，经校验器判定后归档为来源证据。
                    该操作为只读桥接，<strong className="font-semibold">不会修改批次本身</strong>，也不会产生重复污染。
                  </p>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleBridgeBatch}
                    className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-sky-500 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {busy ? "正在接入批次商品..." : "一键接入批次商品"}
                  </button>
                </div>
              </div>
            )}

            {tab === "plugin" && (
              <div className="space-y-4 text-xs text-slate-600">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                  <h4 className="font-semibold text-slate-800 flex items-center gap-2">
                    <Chrome className="h-4 w-4 text-slate-500" /> 插件通道当前状态
                  </h4>
                  <ul className="list-disc list-inside space-y-2 text-slate-600 leading-relaxed">
                    <li>本页的插件通道是<strong className="font-semibold text-slate-800">数据接收端</strong>：工作台已实现卖家精灵插件行数据接入接口，可接收符合既有插件契约的商品行，经服务端校验后归档为来源证据。</li>
                    <li>工作台<strong className="font-semibold text-slate-800">当前不包含、也不提供可安装的 Amazon 采集插件</strong>；插件采集由浏览器端完成，采集完成后数据需通过既有插件流程接入。</li>
                    <li>当前需通过既有插件流程接入。若暂时没有该外部工具，请改用本弹窗内的「接入卖家精灵批次」或「手工录入单品」。</li>
                  </ul>
                </div>
                <p className="text-[13px] text-slate-400">
                  * 网页端不提供跨进程抓取按钮，也不会代为采集；所有来源数据都必须来自可追溯的既有流程。
                </p>
                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    我知道了
                  </button>
                </div>
              </div>
            )}

            {tab === "manual" && (
              <form onSubmit={handleManualSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-1">
                    <label className="block text-xs font-semibold text-slate-700">
                      ASIN <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="B0XXXXXXXX"
                      value={asin}
                      onChange={(e) => setAsin(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono uppercase text-slate-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                    />
                  </div>
                  <div className="col-span-1">
                    <label className="block text-xs font-semibold text-slate-700">
                      商品页面链接 <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="url"
                      required
                      placeholder="https://www.amazon.com/dp/..."
                      value={productUrl}
                      onChange={(e) => setProductUrl(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">商品标题（可选）</label>
                  <input
                    type="text"
                    placeholder="输入商品标题或简短描述"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>

                {/* Collapsible Advanced Info */}
                <div className="border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center gap-1 text-xs font-medium text-sky-600 hover:text-sky-700"
                  >
                    {showAdvanced ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    {showAdvanced ? "收起详细市场字段" : "补充详细市场字段（价格、评分、排名等）"}
                  </button>

                  {showAdvanced && (
                    <div className="mt-3 space-y-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-[13px] font-medium text-slate-600">售价 (USD)</label>
                          <input
                            type="number"
                            step="0.01"
                            placeholder="29.99"
                            value={price}
                            onChange={(e) => setPrice(e.target.value)}
                            className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-[13px] font-medium text-slate-600">评分 (1-5)</label>
                          <input
                            type="number"
                            step="0.1"
                            placeholder="4.5"
                            value={rating}
                            onChange={(e) => setRating(e.target.value)}
                            className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-[13px] font-medium text-slate-600">评论数</label>
                          <input
                            type="number"
                            placeholder="120"
                            value={reviewCount}
                            onChange={(e) => setReviewCount(e.target.value)}
                            className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[13px] font-medium text-slate-600">BSR 排名</label>
                          <input
                            type="number"
                            placeholder="1500"
                            value={bsrRank}
                            onChange={(e) => setBsrRank(e.target.value)}
                            className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-[13px] font-medium text-slate-600">BSR 类目</label>
                          <select
                            value={bsrCategory}
                            onChange={(e) => setBsrCategory(e.target.value)}
                            className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                          >
                            <option value="">选择类目</option>
                            {AMAZON_US_TOP_LEVEL_CATEGORIES.map((cat) => (
                              <option key={cat.value} value={cat.value}>
                                {cat.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-[13px] font-medium text-slate-600">主图图片链接（每行一个）</label>
                        <textarea
                          rows={2}
                          placeholder="https://images-na.ssl-images-amazon.com/..."
                          value={imagesText}
                          onChange={(e) => setImagesText(e.target.value)}
                          className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-[13px] font-medium text-slate-600">核心关键词（逗号或换行分隔）</label>
                        <input
                          type="text"
                          placeholder="例：insulated water bottle（英文关键词）"
                          value={keywordsText}
                          onChange={(e) => setKeywordsText(e.target.value)}
                          className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-sky-500 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {busy ? "正在保存证据..." : "确认录入"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
