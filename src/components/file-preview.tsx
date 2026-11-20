import { useEffect, useMemo, useState } from "react"
import { X, ArrowSquareOut, FolderOpen } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import {
  languageForPath,
  escapeHtml,
  formatSize,
  HIGHLIGHT_MAX,
  type PreviewData,
} from "../lib/file-preview"
import { highlightToHtml } from "../lib/highlighter"

/** Quick-look popup for a folder tab's right-click Preview: reads the file
 *  (size-guarded), lazily syntax-highlights small text files, and renders a line-numbered
 *  view. Binary / oversized / unreadable files get an explain-and-open-externally state. */
export function FilePreview() {
  const target = useStore((s) => s.preview)
  const close = () => useStore.getState().setPreview(null)

  const [data, setData] = useState<PreviewData | null>(null)
  const [html, setHtml] = useState<string | null>(null) // highlighted/escaped code HTML

  const abs = target?.abs
  const wsl = target?.wsl // read a WSL pane's path via its UNC share (translated in main)
  const lang = useMemo(() => (abs ? languageForPath(abs) : null), [abs])

  // Load + (lazily) highlight whenever the target changes; ignore a stale resolve if
  // the popup was closed or moved to another file mid-flight.
  useEffect(() => {
    if (!abs) return
    let live = true
    setData(null)
    setHtml(null)
    void ipc.readFilePreview(abs, wsl).then(async (d) => {
      if (!live) return
      setData(d)
      if (d.kind !== "text") return
      // Skip highlighting large files (a quarter-MB highlight would jank the open).
      const out = d.size <= HIGHLIGHT_MAX ? await highlightToHtml(d.text, lang) : escapeHtml(d.text)
      if (live) setHtml(out)
    })
    return () => {
      live = false
    }
  }, [abs, lang, wsl])

  // Escape closes.
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [target])

  // Count newlines without materializing a per-line array of the (up to 256KB) text.
  const lineCount = useMemo(() => {
    if (data?.kind !== "text") return 0
    let n = 1
    for (let i = 0; i < data.text.length; i++) if (data.text.charCodeAt(i) === 10) n++
    return n
  }, [data])
  // A parallel `1\n2\n…` column beside a no-wrap <pre>: each source line stays one
  // visual line, so numbers align by line-height without splitting hljs spans.
  const gutter = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1).join("\n"),
    [lineCount],
  )

  if (!target) return null

  return (
    <div className="palette-overlay" onMouseDown={close}>
      <div className="preview" onMouseDown={(e) => e.stopPropagation()}>
        <div className="preview-header">
          <span className="preview-name">{target.name}</span>
          {data?.kind === "text" && (
            <span className="preview-meta status-faint">
              {lang ?? "text"} · {formatSize(data.size)}
              {data.truncated && " · truncated"}
            </span>
          )}
          <span className="preview-actions">
            {/* Open/Reveal act on the Windows host, which can't resolve a WSL Linux path —
                hide them on a WSL preview until those are wired for WSL. */}
            {!wsl && (
              <>
                <button
                  className="iconbtn"
                  style={{ width: 24, height: 24 }}
                  title="Open in editor"
                  onClick={() => ipc.openFile("", target.abs)}
                >
                  <ArrowSquareOut size={14} />
                </button>
                <button
                  className="iconbtn"
                  style={{ width: 24, height: 24 }}
                  title="Reveal in file manager"
                  onClick={() => ipc.revealPath(target.abs)}
                >
                  <FolderOpen size={14} />
                </button>
              </>
            )}
            <button
              className="iconbtn"
              style={{ width: 24, height: 24 }}
              title="Close (Esc)"
              onClick={close}
            >
              <X size={14} />
            </button>
          </span>
        </div>

        <div className="preview-body">
          {!data && <div className="preview-note status-faint">Loading…</div>}
          {data?.kind === "error" && (
            <div className="preview-note status-faint">Can’t read this file.</div>
          )}
          {data?.kind === "binary" && (
            <div className="preview-note status-faint">
              Binary file — {formatSize(data.size)}.{!wsl && " Use Open in editor or Reveal above."}
            </div>
          )}
          {data?.kind === "too-large" && (
            <div className="preview-note status-faint">
              Too large to preview ({formatSize(data.size)}).
              {!wsl && " Use Open in editor or Reveal above."}
            </div>
          )}
          {data?.kind === "text" && html !== null && (
            <div className="lp-scroll">
              <div className="lp-grid">
                <pre className="lp-gutter">{gutter}</pre>
                <pre className="lp-code">
                  <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
                </pre>
              </div>
            </div>
          )}
          {data?.kind === "text" && html === null && (
            <div className="preview-note status-faint">Rendering…</div>
          )}
        </div>
      </div>
    </div>
  )
}
