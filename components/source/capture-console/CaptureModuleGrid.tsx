"use client";

import type { CSSProperties } from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  KeyRound,
  LayoutGrid,
  LineChart,
  MessageSquare,
  Package,
  Search,
  Store,
} from "lucide-react";

import type { ConsoleCapability, ConsoleIconName } from "./captureConsoleModel";
import styles from "./capture-console.module.css";

const ICONS: Record<ConsoleIconName, typeof Search> = {
  search: Search,
  detail: Package,
  variation: LayoutGrid,
  review: MessageSquare,
  market: Store,
  reverse: ArrowLeftRight,
  keyword: KeyRound,
  trend: LineChart,
};

function CapabilityCard({ capability, index }: { capability: ConsoleCapability; index: number }) {
  const Icon = ICONS[capability.icon];
  const barPercent = capability.total > 0 ? Math.min(100, capability.percent) : 0;
  return (
    <article
      className={styles.cap}
      data-module={capability.module}
      data-state={capability.tone}
      data-testid={`capture-console-module-${capability.module}`}
      style={{ "--i": index } as CSSProperties}
    >
      <div className={styles.capHead}>
        <span className={styles.capIcon} aria-hidden="true">
          <Icon />
        </span>
        <span className={styles.capName}>{capability.name}</span>
        <span className={styles.pill} data-tone={capability.tone}>
          <i className={styles.dot} aria-hidden="true" />
          {capability.stateLabel}
        </span>
      </div>
      <div className={styles.capMeta}>
        <b>{capability.evidenceCount}</b>
        <span className={styles.muted}>/ {capability.total} 件</span>
        {capability.detail ? <span>· {capability.detail}</span> : null}
      </div>
      <div className={styles.capBar} aria-hidden="true">
        <i style={{ "--p": `${barPercent}%` } as CSSProperties} />
      </div>
      {capability.problem ? <p className={styles.capProblem}>{capability.problem}</p> : null}
    </article>
  );
}

export function CaptureBasicCapabilities({
  capabilities,
  summary,
}: {
  capabilities: ConsoleCapability[];
  summary: string;
}) {
  return (
    <section className={styles.section} aria-labelledby="capture-console-basic-title">
      <div className={styles.sectionHead}>
        <h3 id="capture-console-basic-title">基础能力</h3>
        <span data-testid="capture-console-basic-summary">{summary}</span>
      </div>
      <div className={styles.basicGrid}>
        {capabilities.map((capability, index) => (
          <CapabilityCard key={capability.module} capability={capability} index={index} />
        ))}
      </div>
    </section>
  );
}

export function CaptureSupplementaryCapabilities({
  capabilities,
  summary,
}: {
  capabilities: ConsoleCapability[];
  summary: string;
}) {
  return (
    <details className={styles.supp} data-testid="capture-console-supplementary">
      <summary>
        <span className={styles.suppName}>补充能力</span>
        <span className={styles.suppMeta}>{summary}</span>
        <ChevronDown className={styles.suppChev} aria-hidden="true" />
      </summary>
      <div className={styles.suppList}>
        {capabilities.map((capability) => (
          <div
            key={capability.module}
            className={styles.suppRow}
            data-testid={`capture-console-module-${capability.module}`}
            data-state={capability.tone}
          >
            <span className={styles.name}>{capability.name}</span>
            <span className={styles.pill} data-tone={capability.tone}>
              <i className={styles.dot} aria-hidden="true" />
              {capability.stateLabel}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
