// Validators shared by settings (renderer) and the ssh argv builders (main). Kept tiny and
// dependency-free so main can import it without pulling in the settings/theme tables.

import type { RemoteRef, SshEnv } from "../types"
import { hasControlChar } from "./control-chars"

// Hostname / user characters only (IPv6 brackets, `%` zone ids): no shell metacharacters,
// which older ssh could pass to a ProxyCommand/Match exec via %h/%r (CVE-2023-51385).
const SSH_TARGET_RE = /^[A-Za-z0-9._@:%+[\]-]+$/

/** An ssh destination safe as argv: host/user characters only, no leading `-`. */
export function isSshTarget(v: unknown): v is string {
  return typeof v === "string" && v.length <= 255 && !v.startsWith("-") && SSH_TARGET_RE.test(v)
}

// A distro name as `wsl.exe -l -q` prints it (letters, digits, `.`, `-`, `_`).
const WSL_ENV_RE = /^wsl:([A-Za-z0-9._-]+)$/

/** A parsed SshEnv; null for a malformed one. */
export type ParsedSshEnv = { kind: "native" } | { kind: "wsl"; distro: string }

export function parseSshEnv(env: unknown): ParsedSshEnv | null {
  if (env === "native") return { kind: "native" }
  const m = typeof env === "string" ? WSL_ENV_RE.exec(env) : null
  return m ? { kind: "wsl", distro: m[1]! } : null
}

/** Type guard over parseSshEnv. */
export const isSshEnv = (v: unknown): v is SshEnv => parseSshEnv(v) !== null

/** The `ssh` settings block. Hosts come from ~/.ssh/config only: these are presentation
 *  and session-keeping preferences, never how to connect. */
export interface SshSettings {
  hidden: string[] // aliases you hid (on top of DEFAULT_HIDDEN_HOSTS; see effectiveHidden)
  shown: string[] // DEFAULT_HIDDEN_HOSTS entries you brought back
  pinned: string[] // hostIds kept in the sidebar
  keepAliveSeconds: number // ServerAliveInterval smterm adds (0 = add none, the config decides)
  restore: "auto" | "on-focus" // after a relaunch: reconnect at once, or when the pane is used
  autoReconnect: boolean // retry a dropped, established connection a few times (default on)
  colors: Record<string, string> // alias pattern ("prod-*") → a named colour or #rrggbb
  integration: string[] // alias patterns ("gpu-*", "!gpu-old") whose shells report to smterm
  integrationMode: "ask" | "all" | "off" // ask: the list only (+ a hint); all: all but `!alias`
}

/** Named host colours (theme tokens, so they follow light/dark). Anything else is #rrggbb. */
export const HOST_COLOR_NAMES = ["red", "amber", "blue"] as const
const HEX_COLOR = /^#[0-9a-f]{6}$/i
const MAX_SSH_COLORS = 100

/** A usable host colour value: a named one or #rrggbb. */
export const isHostColor = (v: unknown): v is string =>
  typeof v === "string" &&
  ((HOST_COLOR_NAMES as readonly string[]).includes(v.toLowerCase()) || HEX_COLOR.test(v))

/** Hidden until you show them (`ssh.shown`): git forges live in ssh configs but aren't places
 *  to open a shell. Kept apart from `ssh.hidden`, so a saved settings.json never freezes this
 *  list and a later addition here reaches everyone. */
export const DEFAULT_HIDDEN_HOSTS: readonly string[] = Object.freeze([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "ssh.dev.azure.com",
  "vs-ssh.visualstudio.com",
  "codeberg.org",
])
const MAX_SSH_PINNED = 200
const MAX_HOST_ID = 300 // a pinned id, as in parseRemoteRef

const DEFAULT_KEEPALIVE = 30
const MAX_KEEPALIVE = 3600
const MAX_SSH_HIDDEN = 1000

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {}

/** A list of host aliases: unique, trimmed, no control characters, capped. */
function aliasList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "" && x.length <= 255 && !hasControlChar(x))
  return [...new Set(out)].slice(0, MAX_SSH_HIDDEN)
}

/** What's actually hidden: your list, plus the defaults you haven't shown (case-insensitive,
 *  as ssh matches aliases). */
export function effectiveHidden(ssh: Pick<SshSettings, "hidden" | "shown">): string[] {
  const shown = new Set(ssh.shown.map((a) => a.toLowerCase()))
  return [...ssh.hidden, ...DEFAULT_HIDDEN_HOSTS.filter((a) => !shown.has(a.toLowerCase()))]
}

/** The `ssh` block, validated (fresh arrays every call). */
export function mergeSshSettings(input: unknown): SshSettings {
  const o = asObject(input)
  const hidden = aliasList(o.hidden)
  const shown = aliasList(o.shown)
  const pinned = Array.isArray(o.pinned)
    ? [
        ...new Set(
          o.pinned.filter(
            (x): x is string =>
              typeof x === "string" && x !== "" && x.length <= MAX_HOST_ID && !hasControlChar(x),
          ),
        ),
      ].slice(0, MAX_SSH_PINNED)
    : []
  const k = o.keepAliveSeconds
  const keepAliveSeconds =
    typeof k === "number" && Number.isFinite(k)
      ? Math.min(MAX_KEEPALIVE, Math.max(0, Math.round(k)))
      : DEFAULT_KEEPALIVE
  const restore = o.restore === "on-focus" ? "on-focus" : "auto"
  // Insertion order kept: the first matching pattern wins.
  // A Map while building: pattern keys like "constructor" / "__proto__" are ordinary here.
  const picked = new Map<string, string>()
  for (const [k, v] of Object.entries(Array.isArray(o.colors) ? {} : asObject(o.colors))) {
    const key = k.trim()
    if (!key || key.length > 255 || hasControlChar(key) || !isHostColor(v)) continue
    if (picked.size >= MAX_SSH_COLORS) break
    if (!picked.has(key)) picked.set(key, v.toLowerCase())
  }
  const colors = Object.fromEntries(picked) // own data properties, even for "__proto__"
  const autoReconnect = o.autoReconnect !== false
  const integration = aliasList(o.integration)
  const integrationMode =
    o.integrationMode === "all" || o.integrationMode === "off" ? o.integrationMode : "ask"
  return {
    hidden,
    shown,
    pinned,
    keepAliveSeconds,
    restore,
    autoReconnect,
    colors,
    integration,
    integrationMode,
  }
}

const MAX_LABEL = 200

/** A RemoteRef's identity (hostId, target, env; label → target), validated; null if unusable. */
export function parseRemoteRef(v: unknown): RemoteRef | null {
  if (!v || typeof v !== "object") return null
  const r = v as Record<string, unknown>
  const hostId = typeof r.hostId === "string" ? r.hostId : ""
  if (!hostId || hostId.length > MAX_HOST_ID || hasControlChar(hostId)) return null
  if (!isSshTarget(r.target) || !isSshEnv(r.env)) return null
  return { hostId, label: sshLabel(r.label, r.target), target: r.target, env: r.env }
}

/** A displayable host label: trimmed-non-empty, no control chars, capped; else `fallback`. */
export function sshLabel(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() && !hasControlChar(v) ? v.slice(0, MAX_LABEL) : fallback
}
