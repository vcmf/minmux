import { FAQ, GITHUB, MAKER, SITE_URL, TEAM } from "./data"

/** schema.org JSON-LD for search and AI answer engines. Built from the same data the page
 *  renders (FAQ, links), so the markup never claims what the visible page doesn't say. */
const GRAPH = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: "minmux",
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#app`,
      name: "minmux",
      url: `${SITE_URL}/`,
      description:
        "A fast, cross-platform terminal for people who run coding agents all day: tabs, split panes and real shells, plus panels that show what the agents did — per-session status and notifications, a git Changes panel, a Files browser with preview, and an Agents board for Claude Code, Codex and OpenCode sessions.",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "Terminal emulator",
      operatingSystem: "macOS, Linux, Windows, WSL",
      isAccessibleForFree: true,
      license: "https://opensource.org/licenses/MIT",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      downloadUrl: `${GITHUB}#install`,
      installUrl: `${GITHUB}#install`,
      sameAs: [GITHUB],
      image: `${SITE_URL}/media/og.png`,
      featureList: [
        "Tabs and resizable split panes with your own shell",
        "Per-session status: running, needs input, idle",
        "Native notifications when a background pane needs input",
        "Changes panel: git diff for the focused pane's directory",
        "Files panel with breadcrumb and file preview",
        "Agents board for Claude Code, Codex and OpenCode: sessions, sub-agents, status and tokens",
        "Agent sessions resume in the same pane when minmux reopens",
        "Search past agent conversations and resume one in a split",
        "See the processes each agent session runs",
        "Pull requests dialog: review, comment, approve, follow live CI and merge, via your own gh",
        "SSH host picker from ~/.ssh/config",
        "Theme families in light and dark, configured in one JSON file",
      ],
      author: { "@id": `${SITE_URL}/#maker` },
      contributor: { "@type": "Organization", name: TEAM.name, url: TEAM.url },
    },
    {
      "@type": "Person",
      "@id": `${SITE_URL}/#maker`,
      name: MAKER.name,
      url: MAKER.url,
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      mainEntity: FAQ.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ],
}

// `<` escaped so the JSON can never close the script element
const JSON_LD = JSON.stringify(GRAPH).replace(/</g, "\\u003c")

export function StructuredData() {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />
}
