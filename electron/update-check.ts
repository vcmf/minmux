// Best-effort update check: ask GitHub for the latest published release and compare it to
// the running version. Network-only, off any hot path (runs on startup + a slow interval);
// any failure returns updateAvailable:false so the badge simply stays quiet. No auth needed
// (unauthenticated GitHub API is fine for a check every few hours).

import { isNewer, type UpdateStatus } from "../src/lib/version"

const REPO = "vcmf/minmux"
const RELEASES = `https://github.com/${REPO}/releases/latest`

/** Pull `tag_name` (+ `html_url`) out of a GitHub release JSON. Pure — tested. */
export function parseRelease(json: unknown): { tag: string; url: string | null } | null {
  if (!json || typeof json !== "object") return null
  const o = json as { tag_name?: unknown; html_url?: unknown }
  if (typeof o.tag_name !== "string") return null
  return { tag: o.tag_name, url: typeof o.html_url === "string" ? o.html_url : null }
}

export async function checkForUpdate(current: string): Promise<UpdateStatus> {
  const quiet: UpdateStatus = { current, latest: null, updateAvailable: false, url: RELEASES }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "minmux" },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return quiet
    const rel = parseRelease(await res.json())
    if (!rel) return quiet
    const latest = rel.tag.replace(/^v/, "")
    return {
      current,
      latest,
      updateAvailable: isNewer(latest, current),
      url: rel.url ?? RELEASES,
    }
  } catch {
    return quiet // offline / rate-limited / timeout → stay silent
  }
}
