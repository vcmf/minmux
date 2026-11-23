import { Terminal } from "@xterm/xterm"
import { WebglAddon } from "@xterm/addon-webgl"
import { ipc } from "./ipc"
import { latencyStats } from "./latency-stats"
import { renderMarkdownText } from "./markdown-client"
import { blockOf, topBlock } from "./markdown-scroll"
import { emptyShown, patchBlocks } from "./markdown-patch"
import type { Block } from "./markdown"

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// eslint-disable-next-line no-control-regex -- escape sequences are control characters
const CSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex -- escape sequences are control characters
const OSC = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g
/** PTY output without its CSI / OSC escape sequences. */
const stripEscapes = (s: string) => s.replace(CSI, "").replace(OSC, "")

// Keystroke latency: a key written to a real shell's PTY until its echo is parsed by xterm
// (renderer → main → pty → main → renderer → xterm). `load` keeps a firehose running in a
// second PTY for the whole loop, as a busy agent pane would.
/** Something running beside the keystroke loop (a busy view), with its own report. */
interface Beside {
  start(): void
  stop(): Promise<Record<string, unknown>>
}

/** Keystroke latency p50 / p95 / max over `keys` keys, optionally under load. */
async function measureInput(keys: number, load: boolean, beside?: Beside) {
  const { term, dispose } = hiddenTerm()
  const id = `perf-in-${Math.floor(now())}`
  await ipc.ptySpawn({ id, cols: 120, rows: 40, shell: "", args: [] })
  let waiter: { key: string; t0: number; done: (ms: number) => void } | null = null
  const off = ipc.onPtyData(id, (data) => {
    const w = waiter
    // The key's echo, not a letter inside an escape sequence (CSI / OSC) of a prompt redraw.
    if (w && stripEscapes(data).includes(w.key)) {
      waiter = null
      term.write(data, () => w.done(now() - w.t0))
    } else term.write(data)
  })
  let bg: ReturnType<typeof hiddenTerm> | null = null
  let bgOff = () => {}
  const bgId = `perf-bg-${Math.floor(now())}`
  await sleep(800) // let the shell settle
  if (load) {
    bg = hiddenTerm()
    await ipc.ptySpawn({ id: bgId, cols: 120, rows: 40, shell: "", args: [] })
    const t = bg.term
    bgOff = ipc.onPtyData(bgId, (d) => t.write(d))
    await sleep(800)
    ipc.ptyWrite(bgId, "yes 0123456789abcdefghijklmnopqrstuvwxyz\r") // until ptyKill below
    await sleep(300)
  }
  beside?.start()
  const samples: number[] = []
  let timeouts = 0
  const letters = "abcdefghijklmnopqrstuvwxyz"
  for (let i = 0; i < keys; i++) {
    const key = letters[i % letters.length]!
    const ms = await new Promise<number>((resolve) => {
      // This key's own wait: a late timer never touches a later key's.
      const w = {
        key,
        t0: now(),
        done: (v: number) => {
          clearTimeout(timer)
          resolve(v)
        },
      }
      const timer = setTimeout(() => {
        if (waiter !== w) return
        waiter = null
        resolve(-1) // no echo within 1 s: not counted
      }, 1000)
      waiter = w
      ipc.ptyWrite(id, key)
    })
    if (ms >= 0) samples.push(ms)
    else timeouts++
    if (i % 20 === 19) {
      ipc.ptyWrite(id, "\x15") // Ctrl-U: keep the line short…
      await sleep(150) // …and let its redraw land before the next key is timed
    }
    await sleep(15) // a fast typist, not a paste
  }
  const besideReport = beside ? await beside.stop() : undefined
  off()
  ipc.ptyKill(id)
  dispose()
  if (bg) {
    bgOff()
    ipc.ptyKill(bgId)
    bg.dispose()
  }
  // A stall over 1 s shows in `timeouts`, not in p95.
  return { ...latencyStats(samples), timeouts, ...(besideReport ? { beside: besideReport } : {}) }
}

/** A markdown document of about `kb` KB: headings, prose, lists, tables, code and some math. */
function markdownDoc(kb: number): string {
  const part = (i: number) =>
    [
      `## Section ${i}`,
      "",
      `Agents write plans like this one, paragraph ${i}: **bold**, \`code\`, a [link](https://example.com/${i}) and a reference to #${i}. `.repeat(
        3,
      ),
      "",
      `- [x] step ${i}.1 done`,
      `- [ ] step ${i}.2 with \`inline\` code`,
      `- a plain item with $x_${i}^2$ math`,
      "",
      "| column | value | note |",
      "| ------ | ----: | ---- |",
      `| a${i} | ${i * 3} | first |`,
      `| b${i} | ${i * 7} | second |`,
      "",
      "```ts",
      `export function step${i}(n: number): number {`,
      `  return n * ${i} // a comment`,
      "}",
      "```",
      "",
    ].join("\n")
  let out = "# A long plan\n\n"
  for (let i = 1; out.length < kb * 1024; i++) out += part(i)
  return out
}

// What a markdown file tab's Preview does while an agent rewrites the file (markdown-view.tsx):
// the text changes, the worker renders it, and the HTML goes in with one write that keeps the
// block in view. A section is added at the top each time (the hard case for keeping place).
// On screen, scrolled to the middle, so its layout and content-visibility are the real ones.
/** A markdown Preview re-rendering every `everyMs` beside the keystroke loop. */
function markdownBeside(kb: number, everyMs: number): Beside {
  const scroller = document.createElement("div")
  scroller.style.cssText = "position:fixed;inset:0;overflow:auto;z-index:-1;background:var(--bg)"
  const body = document.createElement("div")
  body.className = "md-view"
  scroller.appendChild(body)
  let text = markdownDoc(kb)
  let running = false
  let loop: Promise<void> = Promise.resolve()
  const writes: number[] = []
  const renders: number[] = []
  let htmlKB = 0
  const shown = emptyShown()
  const write = (blocks: Block[]) => {
    const t0 = now()
    const size = blocks.reduce((n, b) => n + b.html.length, 0)
    const keep = scroller.scrollTop > 0 ? topBlock(scroller, body) : null
    body.classList.toggle("big", size > 50 * 1024) // markdown-view's BIG_HTML
    patchBlocks(body, shown, blocks)
    if (keep) {
      const b = blockOf(body, keep)
      if (b) scroller.scrollTop = b.offsetTop + keep.off // reads layout: its cost is counted
    }
    writes.push(now() - t0)
    htmlKB = Math.round(size / 1024)
  }
  return {
    start() {
      document.body.appendChild(scroller)
      running = true
      loop = (async () => {
        let n = 0
        while (running) {
          const t0 = now()
          text = `## Added ${++n}\n\nA new section at the top.\n\n${text}`
          const r = await renderMarkdownText(text)
          renders.push(now() - t0)
          if (r) write(r.blocks)
          if (n === 1) scroller.scrollTop = scroller.scrollHeight / 2
          await sleep(Math.max(0, everyMs - (now() - t0)))
        }
      })()
    },
    async stop() {
      running = false
      await loop
      scroller.remove()
      return {
        kb,
        everyMs,
        htmlKB,
        rerenders: writes.length,
        writeMs: latencyStats(writes),
        renderMs: latencyStats(renders), // worker round trip, text in to HTML back
      }
    },
  }
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
  report.input = await measureInput(200, false)
  report.inputUnderLoad = await measureInput(200, true)
  // A markdown file tab an agent is rewriting, at the fastest each size re-reads (file-view.tsx:
  // RELOAD_MS under 100 KB, BIG_RELOAD_MS above).
  report.inputBesideMarkdown100k = await measureInput(200, false, markdownBeside(100, 200))
  report.inputBesideMarkdown900k = await measureInput(200, false, markdownBeside(900, 2000))
  report.idle = await idleCpu(3000)
  console.log(`[PERF] ${JSON.stringify(report)}`)
  return report
}

// Expose for manual runs from devtools.
if (typeof window !== "undefined") {
  ;(window as unknown as { __minmuxPerf: () => Promise<unknown> }).__minmuxPerf = runPerfSuite
}
