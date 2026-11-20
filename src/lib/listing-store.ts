// Folder listings shared by every folder view (docs/design/WORKDIR_OBJECTS.md): two views on
// one folder read it once and show the same listing. Bounded: past `cap` folders, the least
// recently updated go. A scope keeps a WSL distro's Linux paths apart from the host's.
import type { DirListing } from "./dir-listing"
import { sameListing } from "./file-tree"

export const LISTINGS_CAP = 2000

type Listings = Record<string, DirListing>
const EMPTY: Listings = {}

/** Listings per scope, with a change signal for React (useSyncExternalStore). */
export class ListingStore {
  private scopes = new Map<string, Listings>()
  private lru = new Map<string, [scope: string, dir: string]>() // insertion order = LRU → MRU
  private listeners = new Set<() => void>()
  constructor(private readonly cap = LISTINGS_CAP) {}

  /** A scope's listings: the same object until one of them changes. */
  get(scope: string): Listings {
    return this.scopes.get(scope) ?? EMPTY
  }

  /** Store a read; false (and nothing notified) when it changed nothing. A failed re-read
   *  keeps the listing we had. */
  set(scope: string, dir: string, listing: DirListing): boolean {
    const cur = this.get(scope)
    const had = cur[dir]
    const key = `${scope}\0${dir}`
    // Every read counts as a use, changed or not: a folder on screen (re-read on each
    // change and focus) never ages out under ones read once.
    if (had) {
      this.lru.delete(key)
      this.lru.set(key, [scope, dir])
    }
    if (sameListing(had, listing) || (listing.error && had)) return false
    this.scopes.set(scope, { ...cur, [dir]: listing })
    this.lru.delete(key)
    this.lru.set(key, [scope, dir])
    while (this.lru.size > this.cap) {
      const [oldKey, [s, d]] = this.lru.entries().next().value!
      this.lru.delete(oldKey)
      const rest = { ...this.get(s) }
      delete rest[d]
      this.scopes.set(s, rest)
    }
    this.listeners.forEach((fn) => fn())
    return true
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

/** The app's listings (one per renderer). */
export const listings = new ListingStore()
