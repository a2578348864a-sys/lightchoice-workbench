import { ProductIdentity } from "@/components/ui/ProductIdentity";
export type DisplaySample = { asin: string; title: string | null; imageUrl: string | null; brand?: string | null; category?: string | null; price?: number | null; priceCurrency?: string | null; rating?: number | null; reviewCount?: number | null };
export function MarketSampleIdentity({ item, marketplace, chineseHint, translatedTitle, translationPending }: { item: DisplaySample; marketplace: string; chineseHint?: string | null; translatedTitle?: string; translationPending?: boolean }) {
  return (
    <div className="min-w-[240px]">
      <ProductIdentity image={item.imageUrl} title={translatedTitle ?? (translationPending ? "商品标题待翻译" : item.title)} asin={item.asin} marketplace={marketplace} brand={item.brand} category={item.category} size="sm" showAmazonLink />
      {(translatedTitle || translationPending) && <details className="mt-1 text-xs text-slate-500"><summary className="cursor-pointer">查看英文原名{translatedTitle ? "（中文为译文）" : "（尚未翻译）"}</summary><p className="mt-1 leading-relaxed" lang="en">{item.title ?? "来源未提供标题"}</p></details>}
      {chineseHint ? <p className="mt-1 text-[12px] leading-4 text-slate-500">辅助分类：{chineseHint}（不是标题译文）</p> : null}
    </div>
  );
}
export function MarketSamplePrice({ item }: { item: DisplaySample }) {
  const amount = item.price;
  return <span className="font-mono text-xs font-medium text-slate-900">{typeof amount === "number" && Number.isFinite(amount) ? `${item.priceCurrency === "USD" || !item.priceCurrency ? "$" : item.priceCurrency + " "}${amount.toFixed(2)}` : "— 未提供"}</span>;
}
export function MarketSampleRating({ item }: { item: DisplaySample }) {
  return <div className="flex flex-col text-xs"><span className="font-medium text-amber-700">{typeof item.rating === "number" ? item.rating.toFixed(1) : "—"}</span><span className="text-[12px] text-slate-400">{typeof item.reviewCount === "number" ? `${item.reviewCount.toLocaleString()} 条评价` : "评论数未提供"}</span></div>;
}
