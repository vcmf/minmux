// Lazy syntax highlighter. highlight.js core + a curated language set are pulled in
// on the FIRST preview open via dynamic import() — a separate vite chunk, so nothing
// here touches the startup bundle or the terminal hot path. Returns escaped HTML
// ready for dangerouslySetInnerHTML; falls back to escaped plain text on any miss.
import { escapeHtml, languageForPath } from "./file-preview"

type Hljs = import("highlight.js").HLJSApi
let hljsPromise: Promise<Hljs> | null = null

// Load core once and register only the languages file-preview maps to.
async function loadHljs(): Promise<Hljs> {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      const { default: hljs } = await import("highlight.js/lib/core")
      const langs: [string, () => Promise<{ default: unknown }>][] = [
        ["typescript", () => import("highlight.js/lib/languages/typescript")],
        ["javascript", () => import("highlight.js/lib/languages/javascript")],
        ["json", () => import("highlight.js/lib/languages/json")],
        ["css", () => import("highlight.js/lib/languages/css")],
        ["scss", () => import("highlight.js/lib/languages/scss")],
        ["xml", () => import("highlight.js/lib/languages/xml")],
        ["python", () => import("highlight.js/lib/languages/python")],
        ["rust", () => import("highlight.js/lib/languages/rust")],
        ["go", () => import("highlight.js/lib/languages/go")],
        ["bash", () => import("highlight.js/lib/languages/bash")],
        ["markdown", () => import("highlight.js/lib/languages/markdown")],
        ["yaml", () => import("highlight.js/lib/languages/yaml")],
        ["ini", () => import("highlight.js/lib/languages/ini")],
        ["c", () => import("highlight.js/lib/languages/c")],
        ["cpp", () => import("highlight.js/lib/languages/cpp")],
        ["java", () => import("highlight.js/lib/languages/java")],
        ["ruby", () => import("highlight.js/lib/languages/ruby")],
        ["sql", () => import("highlight.js/lib/languages/sql")],
        ["dockerfile", () => import("highlight.js/lib/languages/dockerfile")],
        ["makefile", () => import("highlight.js/lib/languages/makefile")],
      ]
      const mods = await Promise.all(langs.map(([, load]) => load()))
      langs.forEach(([name], i) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hljs.registerLanguage(name, mods[i]!.default as any)
      })
      return hljs
    })()
    // Don't cache a rejection: a transient chunk-fetch blip would otherwise disable
    // highlighting until restart. Drop it so the next preview retries the load.
    hljsPromise.catch(() => {
      hljsPromise = null
    })
  }
  return hljsPromise
}

/** Highlight `code` as `lang` → escaped HTML. Unknown/absent lang or any failure
 *  falls back to escaped plain text, so the preview always renders something safe. */
export async function highlightToHtml(code: string, lang: string | null): Promise<string> {
  if (!lang) return escapeHtml(code)
  try {
    const hljs = await loadHljs()
    if (!hljs.getLanguage(lang)) return escapeHtml(code)
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(code)
  }
}

// For markdown's fences, which render synchronously. `lang` is a language id or an extension.
/** A synchronous highlighter, once highlight.js has loaded. */
export async function syncHighlighter(): Promise<(code: string, lang: string) => string> {
  const hljs = await loadHljs() // a failed load rejects: the caller tries again later
  return (code, lang) => {
    const name = hljs.getLanguage(lang) ? lang : languageForPath(`x.${lang}`)
    if (!name || !hljs.getLanguage(name)) return escapeHtml(code)
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
    } catch {
      return escapeHtml(code)
    }
  }
}
