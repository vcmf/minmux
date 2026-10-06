import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      // fs-worker: the utility process for folder reads (fs-worker-client forks it).
      lib: { entry: { main: "electron/main.ts", "fs-worker": "electron/fs-worker.ts" } },
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
