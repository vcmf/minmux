// An agent's reply as markdown, for the phone's chat (docs/design/REMOTE_CONTROL.md). Raw HTML is
// never rendered (markdown-it escapes it), images stay text (the page loads none from outside),
// and only web and mail links become links, opened outside the page. Pure.
import MarkdownIt from "markdown-it"

const md = new MarkdownIt({ html: false, linkify: true })
md.disable("image")
// Absolute http(s) and mailto only: a relative link means nothing on the phone.
md.validateLink = (url) => /^(?:https?:\/\/|mailto:)/i.test(url.trim())

const openLink = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  tokens[idx]!.attrSet("target", "_blank")
  tokens[idx]!.attrSet("rel", "noopener noreferrer")
  return openLink ? openLink(tokens, idx, opts, env, self) : self.renderToken(tokens, idx, opts)
}

// A wide table scrolls sideways in its own box (the page never does).
md.renderer.rules.table_open = () => '<div class="md-table"><table>\n'
md.renderer.rules.table_close = () => "</table></div>\n"

/** The reply's HTML: safe to set as innerHTML (every tag comes from markdown, none from the text). */
export const chatMarkdown = (text: string): string => md.render(text)
