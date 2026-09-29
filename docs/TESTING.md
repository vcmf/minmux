# minmux — Quality: Linting & Testing

> A terminal app is OS-specific (macOS, Linux, Windows + WSL from one codebase), full of async
> edges (PTY output, resize races, hook events arriving out of order) and silent failure modes
> (a garbled WebGL atlas, a leaked PTY, a stale focus). Most of that is pushed into pure,
> exhaustively tested functions; the thin glue that can't be unit-tested is checked in the real
> app.

## 1. Where tests live

| Layer                                  | Tool                                                     | What it covers                                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure logic (`src/lib`, `src/settings`) | Vitest                                                   | pane-tree (split / surfaces / move), workspace persistence + migration, session status, session colour, drop zones, themes (incl. contrast), schema, parsers — **test exhaustively**, including malformed input and no-op cases. |
| Main-process modules (`electron/*`)    | Vitest, real `fs` in temp dirs                           | coalescer, output buffer, transcript folds, agent-meta tracker, pane-git service, hook writer, shell integration; `git.integration.test.ts` runs real `git` in a throwaway repo.                                                 |
| Components + store                     | Vitest + Testing Library (jsdom)                         | most chrome components, store actions, an App smoke test.                                                                                                                                                                        |
| The real app                           | Playwright `_electron` — the **`run-minmux` skill** (§4) | terminal-manager, real PTYs, WebGL, focus, drag & drop, themes, Claude hook/transcript flows.                                                                                                                                    |

`make test` runs the first three (~600 tests, a few seconds). Not unit-testable: `node-pty`
(an Electron-ABI native module — Vitest can't load it) and WebGL (absent in jsdom), so
`terminal-manager.ts` is verified in the real app.

## 2. Gates

`make check` = `make lint` + `make test`. lefthook: **pre-commit** runs eslint `--fix` + prettier on
staged files, **pre-push** runs the tests. `make lint` = `tsc` for the renderer **and** the
electron project, eslint (flat config: typescript-eslint, react-hooks), `prettier --check`.
Both tsconfigs are `strict`; the renderer one adds `noUncheckedIndexedAccess`.

**CI** (`.github/workflows/ci.yml`): `lint-test` on ubuntu (typecheck, lint, format check,
`vitest --coverage` → Codecov) + `build` on macOS / Ubuntu / Windows (electron-rebuild of
`node-pty`, then `electron-vite build`) to catch native-module and bundling breakage per OS.

## 3. Patterns that work here

- **The ipc seam is stubbed globally.** `src/test/setup.ts` installs a `window.minmux` stub of the
  whole preload surface; override per test with `vi.mocked(ipc.x).mockResolvedValue(…)`. A new
  channel needs an entry there or components crash on mount.
- **Mock `TerminalManager` in component tests** (`vi.mock("../terminal/terminal-manager", …)`) —
  and add any new method you call to the mocks in `terminal-pane.test.tsx` / `app.test.tsx`.
- **Reset the singleton store** with `resetStore()` (`src/test/helpers.ts`); add new state
  fields there too, or state leaks between tests.
- **jsdom has no `DragEvent`:** coordinates passed to `fireEvent.dragOver` are dropped. Build the
  event with `createEvent` and `Object.defineProperty(ev, "clientX", …)`, and stub
  `getBoundingClientRect` (see the drag tests in `terminal-pane.test.tsx`).
- **Time-based logic** (debounces, TTL caches, backoffs): inject `now()` / a debounce interval,
  or use `vi.useFakeTimers()` with `advanceTimersByTimeAsync`.
- **Main-process file readers:** write real files under `fs.mkdtempSync(os.tmpdir())`; use a tiny
  chunk size to force lines across chunk boundaries.
- **Test the invariants, not just the happy path:** "same reference when nothing changed",
  "a stale / out-of-order event is ignored", "an older build can still read this file".

## 4. Verifying in the real app

Anything touching real terminals, focus, rendering or Claude integration gets checked in the
**built** app with the `run-minmux` skill (`.claude/skills/run-minmux/` — `SKILL.md` + a
Playwright driver): isolated `HOME` / user-data dir (never the user's real layout or hook
settings), DOM renderer for text assertions, screenshots for visuals, simulated Claude hook
events. Look at the screenshots — a blank or garbled frame is a failure even if selectors matched.

## 5. Coverage

`make coverage` (v8 → `coverage/lcov.info`, uploaded to Codecov from CI). It measures `src/**` and the
unit-tested `electron/*` modules (the `main.ts` / `preload.ts` wiring is left to the real-app checks). Coverage is a floor,
not a goal: the pure modules should be near 100% including edge cases; UI glue and
`terminal-manager.ts` are covered by the real-app checks above instead.

## 6. Performance

Hot-path changes (PTY → renderer → xterm) are measured, not guessed: `MINMUX_PERF=1` runs the
load harness — see `PERF.md`.
