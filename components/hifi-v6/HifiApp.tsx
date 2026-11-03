"use client";
import App from "./App";
import { HifiProvider, useHifi, type HifiLive } from "./HifiProvider";
import type { Screen } from "./data";
export function HifiApp({ initialScreen = "explorer", scanId }: { initialScreen?: Screen; scanId?: string }) {
  return <HifiProvider initialScreen={initialScreen} scanId={scanId}><App initialScreen={initialScreen} /></HifiProvider>;
}
export { useHifi };
export type { HifiLive };
