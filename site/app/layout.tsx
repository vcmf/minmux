import type { Metadata, Viewport } from "next"
import { MAKER, SITE_URL, TEAM } from "@/components/minmux/data"
import "./globals.css"

const TITLE = "minmux — open-source terminal for running coding agents"
const DESCRIPTION =
  "Free, open-source (MIT) terminal for running Claude Code, Codex and OpenCode: tabs, split panes, real shells, agent status and notifications, git diffs and a file browser. macOS, Linux, Windows and WSL."
const OG_IMAGE = {
  url: "/media/og.png",
  width: 1200,
  height: 630,
  alt: "The minmux landing page: a minmux window with sessions, a terminal pane and the Agents panel",
}

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "minmux",
  authors: [MAKER, TEAM],
  creator: MAKER.name,
  category: "developer tools",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  icons: { icon: "/media/icon.png", apple: "/media/icon.png" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "minmux",
    locale: "en_US",
    title: TITLE,
    description:
      "You run the agents. You still read the code. A cross-platform terminal with an agents board, git diffs and a files browser.",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: "You run the agents. You still read the code.",
    images: [OG_IMAGE],
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // light is the default palette (tokens.css --bg)
  themeColor: "#fafafa",
}

/** Applies a saved dark choice before first paint, so a dark visitor never sees a light flash. */
const PREPAINT = `try{if(localStorage.getItem("mm-appearance")==="dark")document.documentElement.dataset.palette="minimal-dark"}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // the pre-paint script may set data-palette before hydration
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />
        <link rel="alternate" type="text/plain" href="/llms.txt" title="minmux for LLMs" />
      </head>
      <body>{children}</body>
    </html>
  )
}
