"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { WorkspaceSidebar } from "@/components/WorkspaceSidebar";
import { WorkspaceChrome } from "@/components/ui/WorkspaceChrome";
export function WorkspaceFrame({ children, header, modeLabel, footerNote, hideSidebar = false }: {
  children: ReactNode; header?: ReactNode; modeLabel?: string; footerNote?: string; hideSidebar?: boolean;
}) {
  const pathname = usePathname() || "/";
  const scoped = pathname === "/" || pathname === "/home" || pathname.startsWith("/market-analysis");
  return <div className={`lc-workspace ${hideSidebar ? "lc-without-rail" : ""}${scoped ? " lc-site-v6" : ""}`}>
    {!hideSidebar && <WorkspaceSidebar />}
    <div className="lc-workspace-body">
      <WorkspaceChrome modeLabel={modeLabel} />
      <main id="workspace-content" className="lc-workspace-main">{header}{children}</main>
      {footerNote && <footer className="lc-workspace-footer">{footerNote}</footer>}
    </div>
  </div>;
}
