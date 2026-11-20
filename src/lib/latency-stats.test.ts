import { describe, it, expect } from "vitest"
import { latencyStats } from "./latency-stats"

describe("latencyStats", () => {
  it("nearest-rank percentiles", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    expect(latencyStats(xs)).toEqual({ n: 100, p50: 50, p95: 95, max: 100 })
  })

  it("order doesn't matter, and it rounds to 0.1 ms", () => {
    expect(latencyStats([3.14159, 1, 2])).toEqual({ n: 3, p50: 2, p95: 3.1, max: 3.1 })
  })

  it("no samples: zeros", () => {
    expect(latencyStats([])).toEqual({ n: 0, p50: 0, p95: 0, max: 0 })
  })
})
