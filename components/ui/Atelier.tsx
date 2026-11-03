import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
export function AtelierHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="lc-heading"><div><p className="lc-eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{actions && <div className="lc-heading-actions">{actions}</div>}</header>;
}
export function ResearchLandscape({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <section className="lc-landscape"><p className="lc-eyebrow">{eyebrow}</p><h2>{title}</h2><div className="lc-landscape-cards">{children}</div></section>;
}
export function LandscapeNote({ number, title, children, href }: { number: string; title: string; children: ReactNode; href?: string }) {
  return <div className="lc-landscape-note"><span className="lc-note-number">{number}</span><h3>{title}</h3><p>{children}</p>{href && <Link href={href} aria-label={`前往${title}`}><ArrowUpRight size={17} /></Link>}</div>;
}
export function NextMoves() {
  const moves = [
    ["采集", "先补齐，别急着下结论", "收集商品、规格与真实来源", "/source"],
    ["市场", "回到市场，看清差异", "整理市场样本与待验证问题", "/market-analysis"],
    ["需求", "给想法一个可讨论的形状", "把已知与未知写进需求草稿", "/product-brief"],
  ];
  return <aside className="lc-next-moves"><p className="lc-eyebrow">快速入口</p><h2>常用工作入口</h2><div>{moves.map(([n, title, detail, href]) => <Link href={href} key={n}><span>{n}</span><div><strong>{title}</strong><small>{detail}</small></div><ArrowUpRight size={16} /></Link>)}</div></aside>;
}
