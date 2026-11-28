import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import { cspPlugin } from "./electron/csp"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      // Utility processes main forks: fs-worker (folder reads), sessions-worker (past sessions),
      // remote-host (remote control's server).
      lib: {
        entry: {
          main: "electron/main.ts",
          "fs-worker": "electron/fs-worker.ts",
          "sessions-worker": "electron/sessions-worker.ts",
          "remote-host": "electron/remote-host.ts",
          "remote-client": "electron/remote-client.ts",
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
      // remote.html: the phone's web app, served by the remote-host worker (never by Electron).
      rollupOptions: { input: { index: "index.html", remote: "remote.html" } },
    },
    plugins: [react(), cspPlugin()],
    // Web Workers (the highlighter) as ES modules: they load their languages lazily (chunks).
    worker: { format: "es" },
    server: { port: 1420, strictPort: true },
  },
})
