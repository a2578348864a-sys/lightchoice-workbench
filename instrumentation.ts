export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { continuousMonitoringSchedulerConfigEnabled, startContinuousMonitoringScheduler } =
    await import("@/lib/server/continuousMonitoringScheduler");
  // Same helper backs the read-only status probe, so the UI can never report a
  // scheduler that this gate would refuse to start.
  if (continuousMonitoringSchedulerConfigEnabled()) {
    await startContinuousMonitoringScheduler();
  }

  if (
    process.env.V5_ENABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER === "1"
    && process.env.V5_DISABLE_BATCH_DETAIL_ENRICHMENT_SCHEDULER !== "1"
  ) {
    const { startBatchDetailEnrichmentScheduler } = await import("@/lib/server/batchDetailEnrichmentScheduler");
    await startBatchDetailEnrichmentScheduler();
  }
}