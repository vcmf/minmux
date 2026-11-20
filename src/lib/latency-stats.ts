// Summary of latency samples for the perf harness (lib/perf.ts): nearest-rank percentiles.

export interface LatencyStats {
  n: number
  p50: number
  p95: number
  max: number
}

/** p50 / p95 / max of `samples` (ms), rounded to 0.1 ms; zeros when there are none. */
export function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
  const r = (x: number) => Math.round(x * 10) / 10
  return {
    n: sorted.length,
    p50: r(rank(0.5)),
    p95: r(rank(0.95)),
    max: r(sorted[sorted.length - 1]!),
  }
}
