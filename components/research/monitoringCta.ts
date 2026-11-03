export function shouldShowMonitoringCta(status: string | null | undefined): boolean {
  return status === "PROCEED";
}
