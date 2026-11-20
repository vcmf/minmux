# minmux.dev

The website for minmux: the landing page and `/changelog`. It lives in the app repo, in `site/`,
with its own `package.json`. Built with Next.js (App Router) and exported as a static site;
Vercel deploys it (Root Directory `site`).

## Develop

From this folder (or `make site` from the repo root):

```bash
npm install
npm run dev        # http://localhost:3000
```

## Build

```bash
npm run build      # static site written to out/
```

`next.config.mjs` sets `output: "export"`, so the build is a fully static site in `out/` that
you can host anywhere: GitHub Pages, Vercel, Netlify, Cloudflare Pages, S3, and so on.

Other scripts: `npm run lint`, `npm run format` (Prettier), `npm run format:check`.

`/changelog` is built from the repo's `CHANGELOG.md` (`../CHANGELOG.md`, written by git-cliff on
each release); the build fails if it can't be read. Vercel builds when a commit changes `site/`
or `CHANGELOG.md` (`vercel.json`'s `ignoreCommand`, checked against the commit before it; main
gets one squashed commit per PR), so a release's entry goes live with its release commit. Its
release link works once the Release workflow has published the release.

## Structure

The page is a scripted minmux window. On desktop it is a sticky 100vh stage: each scroll step
(snap) plays the next "turn", and the sessions sidebar is the table of contents. The story is
the tagline in four verbs (welcome → run → watch → read → ship → faq → install); watch and
read play a second beat on their own a few seconds in. On phones
(or short windows) the turns stack as plain sections with a tmux-style strip at the bottom.

```
app/
  layout.tsx          metadata (title, description, Open Graph)
  page.tsx            renders <Landing />
  tokens.css          palettes (the app's themes.ts values) + semantic tokens components use
  globals.css         layout, components, motion; semantic tokens only, no literal colours
  _fonts.css          bundled @font-face rules for Geist Mono + JetBrains Mono
components/minmux/
  data.ts             chapters (= sidebar sessions) and per-turn demo state
  turns.tsx           the turns (narration + scripted panes), SVG wordmark, Changes/Files panels
  agents-panel.tsx    the Agents panel (search, filters, grouped sessions, past sessions)
  pull-requests.tsx   the pull requests dialog (ship turn)
  agent-rotator.tsx   the hero's typed agent (claude → codex → opencode)
  landing.tsx         client shell: scroll → turn, ⌘K palette, light/dark toggle, panels
  copy-button.tsx     copy-to-clipboard for install commands
  icons.tsx           Phosphor icons (@phosphor-icons/react, as in the app) + the Claude mark
public/
  fonts/              Geist Mono, JetBrains Mono (woff2)
  media/              icon, logo, screenshots (Open Graph image)
```

Theming works like the app: `data-palette` on `<html>` is theme family × appearance
(`minimal-light` by default, `minimal-dark` from the toggle). Components read semantic tokens
(`--surface`, `--status-waiting`, `--code-keyword`, …) from `tokens.css`, never palette keys.

To change a turn's copy or script, edit `turns.tsx`; to change what the sidebar, tabs and
agents panel show at each turn, edit `data.ts`. Chapters are referenced by id (`turnOf("read")`),
never by number, so adding or reordering one is a single edit to `CHAPTER_IDS`. All headline and paragraph copy is real HTML
(h1/h2/p) and every turn is in the static export, so it stays indexable. Motion is CSS only
and switches off under `prefers-reduced-motion`.

## Notes

`app/_fonts.css` and `public/fonts/*` were extracted from the original design bundle and are not
meant to be hand-edited. Everything else is normal, editable source.
