import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text-summary", "lcov"],
      // Main-process modules are unit-tested too (ledger, parsers, trackers) — count them. The
      // Electron wiring (main.ts, preload.ts) is exercised by the real-app checks instead, and
      // so is the perf harness (lib/perf.ts: real PTYs and WebGL, run with MINMUX_PERF=1).
      include: ["src/**/*.{ts,tsx}", "electron/**/*.ts"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "electron/**/*.test.ts",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "electron/main.ts",
        "electron/preload.ts",
        "src/lib/perf.ts",
      ],
    },
  },
})
