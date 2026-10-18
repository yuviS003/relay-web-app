export type LoadSample = {
  index: number;
  status: number;
  durationMs: number;
  bodyBytes: number;
  bodySignature: string;
  error: string | null;
};

export type LoadSummary = {
  total: number;
  succeeded: number;
  failed: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  averageMs: number;
  requestsPerSecond: number;
  statuses: Readonly<Record<string, number>>;
  bodyVariants: number;
};

/**
 * Small deterministic signature for response-drift detection. It is not a
 * cryptographic hash and is never used for security; it only answers "did two
 * responses differ?" without retaining every response body in memory.
 */
export function bodySignature(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function percentile(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank percentile: p95 over 20 samples is the 19th observation,
  // which is easier to explain than an interpolated latency no request had.
  const rank = Math.max(1, Math.ceil((value / 100) * sorted.length));
  return sorted[rank - 1] ?? sorted[sorted.length - 1] ?? 0;
}

export function summarizeLoad(
  samples: readonly LoadSample[],
  wallTimeMs: number,
): LoadSummary {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  for (const sample of samples) {
    const key = sample.status === 0 ? 'network error' : String(sample.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  const failed = samples.filter(
    (sample) => sample.error !== null || sample.status === 0 || sample.status >= 400,
  ).length;
  const sum = durations.reduce((total, duration) => total + duration, 0);

  return {
    total: samples.length,
    succeeded: samples.length - failed,
    failed,
    errorRate: samples.length === 0 ? 0 : failed / samples.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    minMs: durations[0] ?? 0,
    maxMs: durations[durations.length - 1] ?? 0,
    averageMs: durations.length === 0 ? 0 : Math.round(sum / durations.length),
    requestsPerSecond:
      wallTimeMs <= 0 ? 0 : Number(((samples.length * 1000) / wallTimeMs).toFixed(2)),
    statuses: Object.freeze(statuses),
    bodyVariants: new Set(samples.map((sample) => sample.bodySignature)).size,
  };
}

export type LoadPlan = {
  count: number;
  concurrency: number;
  delayMs: number;
};

export function validateLoadPlan(input: LoadPlan): string | null {
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 50) {
    return 'Requests must be an integer from 1 to 50.';
  }
  if (
    !Number.isSafeInteger(input.concurrency) ||
    input.concurrency < 1 ||
    input.concurrency > 5
  ) {
    return 'Concurrency must be an integer from 1 to 5.';
  }
  if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 50 || input.delayMs > 30_000) {
    return 'Delay must be an integer from 50ms to 30s.';
  }
  return null;
}
