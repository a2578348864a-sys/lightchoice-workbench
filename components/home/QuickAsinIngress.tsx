"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, Loader2, Search, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { buildAccessHeaders } from "@/lib/client/accessToken";

export function QuickAsinIngress() {
  const router = useRouter();
  const [asin, setAsin] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "error" | "info"; message: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = asin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/u.test(normalized)) {
      setNotice({ type: "error", message: "请输入 10 位 Amazon ASIN，例如 B0XXXXXXXX。" });
      return;
    }
    setBusy(true);
    setNotice({ type: "info", message: "正在核对已有采集证据；如不存在，将通过正式采集入口补齐。" });
    try {
      const res = await fetch("/api/quick-asin", {
        method: "POST",
        headers: { ...buildAccessHeaders(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ asin: normalized }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok || !json.data?.taskId) {
        throw new Error(json?.error?.message || "该 ASIN 暂时无法进入研究，请稍后重试。");
      }
      router.push(`/research/${encodeURIComponent(json.data.taskId)}`);
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "ASIN 研究入口暂时不可用。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 shadow-xs" aria-label="ASIN 快速研究入口">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-indigo-950"><Search className="size-4" />快速研究一个 ASIN</div>
          <p className="mt-1 text-xs text-indigo-800">已有采集资产会直接复用；缺少时才进入正式 Amazon 详情采集，再自动创建研究任务。</p>
        </div>
        <form className="flex w-full gap-2 lg:max-w-md" onSubmit={submit}>
          <input
            value={asin}
            onChange={(event) => setAsin(event.target.value.toUpperCase())}
            className="min-w-0 flex-1 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm font-mono uppercase outline-none ring-indigo-400 focus:ring-2"
            placeholder="输入 10 位 ASIN"
            maxLength={10}
            aria-label="Amazon ASIN"
            disabled={busy}
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <ArrowRight className="mr-1.5 size-4" />}
            开始研究
          </Button>
        </form>
      </div>
      {notice && (
        <div className={`mt-3 flex items-start gap-2 text-xs ${notice.type === "error" ? "text-rose-700" : "text-indigo-800"}`} role="status">
          {notice.type === "error" && <ShieldAlert className="mt-0.5 size-4 shrink-0" />}
          <span>{notice.message}</span>
        </div>
      )}
    </section>
  );
}
