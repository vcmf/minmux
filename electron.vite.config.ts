import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      // Utility processes main forks: fs-worker (folder reads), sessions-worker (past sessions).
      lib: {
        entry: {
          main: "electron/main.ts",
          "fs-worker": "electron/fs-worker.ts",
          "sessions-worker": "electron/sessions-worker.ts",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: { entry: "electron/preload.ts" },
    },
  },
  renderer: {
    root: ".",
    build: {
      outDir: "out/renderer",
      rollupOptions: { input: { index: "index.html" } },
    },
    plugins: [react()],
    server: { port: 1420, strictPort: true },
  },
})
