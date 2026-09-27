// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.).
import "@testing-library/jest-dom/vitest"
import { vi } from "vitest"

// The renderer talks to the main process only through `window.smterm` (see
// src/lib/ipc.ts, which captures it at import time). Under jsdom there is no
// preload, so install a stub of the whole surface with sane defaults. Tests
// override individual methods via `vi.mocked(ipc.x).mockResolvedValue(...)`.
const noop = () => {}
const unsub = () => noop

const smtermStub = {
  ptySpawn: vi.fn(async () => {}),
  onPtyData: vi.fn(unsub),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  ptyKill: vi.fn(),
  listShells: vi.fn(async () => []),
  readSettings: vi.fn(async () => ""),
  writeSettings: vi.fn(async () => {}),
  settingsPath: vi.fn(async () => "/tmp/smterm/settings.json"),
  onSettingsChanged: vi.fn(unsub),
  onAgentEvents: vi.fn(unsub),
  onAgentMeta: vi.fn(unsub),
  agentMetaSnapshot: vi.fn(async () => []),
  resumePlan: vi.fn(async () => ({})),
  resumeConsume: vi.fn(),
  shellIdle: vi.fn(),
  clipboardWrite: vi.fn(),
  clipboardRead: vi.fn(async () => ""),
  readdir: vi.fn(async () => ({ entries: [], truncated: false })),
  readFilePreview: vi.fn(async () => ({ kind: "text", text: "", truncated: false, size: 0 })),
  pickDirectory: vi.fn(async () => null),
  pathIsDir: vi.fn(async () => true),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  openFile: vi.fn(),
  revealPath: vi.fn(),
  editorInfo: vi.fn(async () => ({ available: false, name: "" })),
  notify: vi.fn(),
  minimizeWindow: vi.fn(),
  setWindowBackground: vi.fn(),
  maximizeWindow: vi.fn(),
  closeWindow: vi.fn(),
  isMaximized: vi.fn(async () => false),
  onMaximizeChange: vi.fn(unsub),
  platformInfo: vi.fn(async () => ({
    platform: "darwin",
    label: "macOS",
    release: "test",
    home: "/Users/test",
    profile: "",
  })),
  paneGitInfo: vi.fn(async () => ({})),
  gitStatus: vi.fn(async () => ({
    isRepo: false,
    root: "",
    branch: "",
    ahead: 0,
    behind: 0,
    files: [],
    add: 0,
    del: 0,
  })),
  gitDiff: vi.fn(async () => []),
  readWorkspace: vi.fn(async () => ""),
  writeWorkspace: vi.fn(),
  appMetrics: vi.fn(async () => []),
  perfMode: vi.fn(async () => false),
  appVersion: vi.fn(async () => "0.1.24"),
  checkUpdate: vi.fn(async () => ({
    current: "0.1.24",
    latest: null,
    updateAvailable: false,
    url: "",
  })),
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).smterm = smtermStub

// jsdom lacks ResizeObserver (used by TerminalPane).
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
