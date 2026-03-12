export interface TerminalPerformanceSample {
  count?: number;
  bytes?: number;
  durationMs?: number;
  queueDepth?: number;
}

export interface TerminalPerformanceMeter {
  record(sample?: TerminalPerformanceSample): void;
}

const LOG_INTERVAL_MS = 2000;

export function createTerminalPerformanceMeter(
  label: string,
  enabled: boolean,
): TerminalPerformanceMeter {
  let lastLogAt = 0;
  let totalCount = 0;
  let totalBytes = 0;
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let maxQueueDepth = 0;

  const reset = () => {
    totalCount = 0;
    totalBytes = 0;
    totalDurationMs = 0;
    maxDurationMs = 0;
    maxQueueDepth = 0;
  };

  return {
    record(sample) {
      if (!enabled) {
        return;
      }

      totalCount += sample?.count ?? 1;
      totalBytes += sample?.bytes ?? 0;
      totalDurationMs += sample?.durationMs ?? 0;
      maxDurationMs = Math.max(maxDurationMs, sample?.durationMs ?? 0);
      maxQueueDepth = Math.max(maxQueueDepth, sample?.queueDepth ?? 0);

      const now = performance.now();
      if (lastLogAt === 0) {
        lastLogAt = now;
        return;
      }

      if (now - lastLogAt < LOG_INTERVAL_MS) {
        return;
      }

      console.debug(`[termbag:perf] ${label}`, {
        count: totalCount,
        bytes: totalBytes,
        avgDurationMs:
          totalCount > 0 ? Number((totalDurationMs / totalCount).toFixed(3)) : 0,
        maxDurationMs: Number(maxDurationMs.toFixed(3)),
        maxQueueDepth,
      });
      lastLogAt = now;
      reset();
    },
  };
}
