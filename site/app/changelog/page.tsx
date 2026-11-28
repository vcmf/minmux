import type { Metadata } from "next"
import Link from "next/link"
// the SSR build: icons.tsx is for client components (the default build reads a React context)
import { ArrowSquareOut, Star } from "@phosphor-icons/react/dist/ssr"
import { GITHUB, TABS } from "@/components/minmux/data"
import {
  loadChangelog,
  parseChangelog,
  parseInline,
  type Release,
} from "@/components/minmux/changelog"

const DESCRIPTION = "What changed in each minmux release, newest first."

export const metadata: Metadata = {
  title: "Changelog · minmux",
  description: DESCRIPTION,
  alternates: { canonical: "/changelog" },
  openGraph: { title: "Changelog · minmux", description: DESCRIPTION, url: "/changelog" },
}

/** A release's anchor: `#v0.1.58`. */
const anchor = (r: Release) => (r.url ? `v${r.version}` : r.version.toLowerCase())

function Line({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((p, i) =>
        p.code ? (
          <code key={i}>{p.text}</code>
        ) : p.href ? (
          <a key={i} href={p.href}>
            {p.text}
          </a>
        ) : (
          p.text
        ),
      )}
    </>
  )
}

export default async function ChangelogPage() {
  const releases = parseChangelog(await loadChangelog())
  return (
    <div className="cl">
      <header className="cl-top">
        <Link href="/" className="mm-brand">
          <img src="/media/icon.png" alt="" width={20} height={20} />
          <span>minmux</span>
        </Link>
        <span className="mm-vr mm-only-stage" />
        {/* the landing's tabs, with this page's tab active and the others as links */}
        <div className="mm-tabs mm-only-stage">
          {TABS.map((t) => {
            const href = t.href ?? "/"
            return href === "/changelog" ? (
              <div key={t.name} className="mm-tab" data-active="true" aria-current="page">
                <span className="mm-dot" data-s="running" />
                <span>{t.name}</span>
              </div>
            ) : (
              <Link key={t.name} href={href} className="mm-tab">
                <span className="mm-dot" data-s="idle" />
                <span>{t.name}</span>
              </Link>
            )
          })}
        </div>
        <span className="mm-grow" />
        <a href={`${GITHUB}/releases`} className="mm-link">
          Releases
        </a>
        <a href={GITHUB} className="mm-btn mm-btn-solid mm-btn-sm">
          <Star size={13} weight="fill" className="mm-ph" aria-hidden="true" />
          <span>Star on GitHub</span>
        </a>
      </header>

      <main className="cl-main">
        <h1>Changelog</h1>
        <p className="cl-intro">
          {DESCRIPTION} Each line is a pull request; the same list is in{" "}
          <a href={`${GITHUB}/blob/main/CHANGELOG.md`}>CHANGELOG.md</a>.
        </p>

        {releases.map((r) => (
          <section key={r.version} id={anchor(r)} className="cl-release">
            <div className="cl-head">
              <h2>
                <a href={`#${anchor(r)}`}>{r.url ? `v${r.version}` : r.version}</a>
              </h2>
              {r.date && <time dateTime={r.date}>{r.date}</time>}
              {r.url && (
                <a href={r.url} className="cl-gh" aria-label={`v${r.version} on GitHub`}>
                  <ArrowSquareOut size={13} className="mm-ph" aria-hidden="true" />
                </a>
              )}
            </div>
            {r.notes.map((n, i) => (
              <p key={i} className="cl-note">
                <Line text={n} />
              </p>
            ))}
            {r.groups.map((g) => (
              <div key={g.title} className="cl-group">
                <h3 className="mm-label" data-group={g.title.toLowerCase()}>
                  {g.title}
                </h3>
                <ul>
                  {g.items.map((item, i) => (
                    <li key={i}>
                      <Line text={item} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}
      </main>
    </div>
  )
}
