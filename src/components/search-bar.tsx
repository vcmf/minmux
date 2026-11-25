import { useEffect, useRef, useState } from "react"
import { CaretUp, CaretDown, X, TextAa } from "@phosphor-icons/react"
import { TerminalManager } from "../terminal/terminal-manager"
import { focusedTerminal, useStore } from "../store"

/** ⌘F find-in-scrollback overlay — drives @xterm/addon-search on the focused pane. */
export function SearchBar() {
  const sessionId = useStore((s) => focusedTerminal(s) ?? null)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [results, setResults] = useState({ resultIndex: -1, resultCount: 0 })

  // Autofocus (and select existing text) whenever the bar opens.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Live match count from the focused pane's search addon.
  useEffect(() => {
    if (!sessionId) return
    return TerminalManager.onSearchResults(sessionId, setResults)
  }, [sessionId])

  // However the bar goes away (Esc, a view opening over the panes), its matches go with it.
  useEffect(
    () => () => {
      if (sessionId) TerminalManager.clearSearch(sessionId)
    },
    [sessionId],
  )

  // Search as you type (incremental so it doesn't leap between matches per keystroke).
  useEffect(() => {
    if (!sessionId) return
    if (query) TerminalManager.searchNext(sessionId, query, caseSensitive, true)
    else {
      TerminalManager.clearSearch(sessionId)
      setResults({ resultIndex: -1, resultCount: 0 })
    }
  }, [query, caseSensitive, sessionId])

  const next = () =>
    sessionId && query && TerminalManager.searchNext(sessionId, query, caseSensitive)
  const prev = () =>
    sessionId && query && TerminalManager.searchPrevious(sessionId, query, caseSensitive)
  const close = () => {
    if (sessionId) {
      TerminalManager.clearSearch(sessionId)
      TerminalManager.focus(sessionId)
    }
    setSearchOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (e.shiftKey) prev()
      else next()
    } else if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  const label = results.resultCount
    ? `${results.resultIndex + 1} / ${results.resultCount}`
    : query
      ? "No results"
      : ""

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        className="search-input"
        placeholder="Find"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="search-count">{label}</span>
      <button
        className={`iconbtn${caseSensitive ? " on" : ""}`}
        title="Match case"
        onMouseDown={(e) => {
          e.preventDefault()
          setCaseSensitive((v) => !v)
        }}
      >
        <TextAa size={14} />
      </button>
      <button
        className="iconbtn"
        title="Previous (⇧⏎)"
        onMouseDown={(e) => {
          e.preventDefault()
          prev()
        }}
      >
        <CaretUp size={14} />
      </button>
      <button
        className="iconbtn"
        title="Next (⏎)"
        onMouseDown={(e) => {
          e.preventDefault()
          next()
        }}
      >
        <CaretDown size={14} />
      </button>
      <button
        className="iconbtn"
        title="Close (Esc)"
        onMouseDown={(e) => {
          e.preventDefault()
          close()
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}
