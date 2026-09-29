import { Terminal } from "@xterm/xterm"
import { WebglAddon } from "@xterm/addon-webgl"
import { ipc } from "./ipc"

// Load-test harness (dev only). Run with `MINMUX_PERF=1 make run`, or call
// window.__minmuxPerf() from devtools. Measures the two throughput paths that
// matter for a terminal + resource use, and prints a [PERF] JSON report.

const now = () => performance.now()
const MB = 1024 * 1024

function hiddenTerm(): { term: Terminal; host: HTMLDivElement; dispose: () => void } {
  const host = document.createElement("div")
  host.style.cssText = "position:absolute;left:-9999px;width:900px;height:600px"
  document.body.appendChild(host)
  const term = new Terminal({ cols: 120, rows: 40, scrollback: 1000 })
  term.open(host)
  try {
    term.loadAddon(new WebglAddon())
  } catch {
    // DOM renderer fallback
  }
  const dispose = () => {
    term.dispose()
    host.remove()
  }
  return { term, host, dispose }
}

/** Renderer path: how fast can xterm parse+render N MB (WebGL, real GPU)? */
async function measureRenderer(mb: number) {
  const { term, dispose } = hiddenTerm()
  // A realistic mix: coloured text + a wrapped line, ~1 KB per unit.
  const unit = `\x1b[32muser@host\x1b[0m:\x1b[34m~/src\x1b[0m$ ${"lorem ipsum dolor ".repeat(3)}\r\n`
  const chunk = unit.repeat(Math.ceil(4096 / unit.length)) // ~4 KB chunks, like a PTY
  const chunks = Math.ceil((mb * MB) / chunk.length)
  const bytes = chunks * chunk.length

  const ms = await new Promise<number>((resolve) => {
    const t0 = now()
    for (let i = 0; i < chunks; i++) {
      const last = i === chunks - 1
      term.write(chunk, last ? () => resolve(now() - t0) : undefined)
    }
  })
  dispose()
  return {
    mb: +(bytes / MB).toFixed(1),
    ms: +ms.toFixed(1),
    mbPerSec: +(bytes / MB / (ms / 1000)).toFixed(1),
  }
}

/** End-to-end path: shell → node-pty → IPC → term.write. Reveals IPC overhead. */
async function measureE2E(lines: number) {
  const { term, dispose } = hiddenTerm()
  const id = `perf-${Math.floor(now())}`
  await ipc.ptySpawn({ id, cols: 120, rows: 40, shell: "", args: [] })

  const result = await new Promise<{ mb: number; ms: number; mbPerSec: number; msgs: number }>(
    (resolve) => {
      let started = false
      let bytes = 0
      let msgs = 0
      let t0 = 0
      let carry = ""
      const off = ipc.onPtyData(id, (data) => {
        term.write(data)
        const s = carry + data
        if (!started && s.includes("<<PS>>")) {
          started = true
          t0 = now()
          bytes = 0
          msgs = 0
        }
        if (started) {
          bytes += data.length
          msgs += 1
        }
        if (started && s.includes("<<PE>>")) {
          const ms = now() - t0
          off()
          resolve({
            mb: +(bytes / MB).toFixed(1),
            ms: +ms.toFixed(1),
            mbPerSec: +(bytes / MB / (ms / 1000)).toFixed(1),
            msgs,
          })
        }
        carry = s.slice(-8)
      })
      // A deterministic firehose bracketed by markers. The markers are built by
      // concatenation ('<<P''S>>' → <<PS>>) so the shell's ECHO of the command
      // line doesn't itself contain them — only the real output triggers timing.
      const cmd = `printf '%s' '<<P''S>>'; yes 0123456789abcdefghijklmnopqrstuvwxyz | head -n ${lines}; printf '%s\\n' '<<P''E>>'\r`
      setTimeout(() => ipc.ptyWrite(id, cmd), 600) // let the shell settle
    },
  )
  ipc.ptyKill(id)
  dispose()
  return result
}

async function idleCpu(ms: number) {
  const pick = (arr: { type: string; cpu: number; memoryKB: number }[]) => ({
    main: arr.find((m) => m.type === "Browser"),
    gpu: arr.find((m) => m.type === "GPU"),
    renderer: arr.find((m) => m.type === "Tab" || m.type === "renderer"),
  })
  await new Promise((r) => setTimeout(r, ms))
  const m = pick(await ipc.appMetrics())
  return {
    cpuMainPct: m.main?.cpu ?? 0,
    cpuRendererPct: m.renderer?.cpu ?? 0,
    rssMainMB: +(((m.main?.memoryKB ?? 0) * 1024) / MB).toFixed(1),
    rssRendererMB: +(((m.renderer?.memoryKB ?? 0) * 1024) / MB).toFixed(1),
    rssGpuMB: +(((m.gpu?.memoryKB ?? 0) * 1024) / MB).toFixed(1),
  }
}

export async function runPerfSuite() {
  const report: Record<string, unknown> = {}
  report.renderer = await measureRenderer(20)
  report.e2e = await measureE2E(400_000)
  report.idle = await idleCpu(3000)
  console.log(`[PERF] ${JSON.stringify(report)}`)
  return report
}

// Expose for manual runs from devtools.
if (typeof window !== "undefined") {
  ;(window as unknown as { __minmuxPerf: () => Promise<unknown> }).__minmuxPerf = runPerfSuite
}
