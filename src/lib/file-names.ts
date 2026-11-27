// Files named in a dialog ("a.ts", or "src/index.ts" beside "test/index.ts"). Pure.

const parts = (p: string) => p.split(/[\\/]/).filter(Boolean)

/** Each distinct path's name, with its folder when another has the same name. */
export function shortNames(paths: string[]): string[] {
  const unique = [...new Set(paths)]
  const base = (p: string) => parts(p).pop() ?? p
  const count = new Map<string, number>()
  for (const p of unique) count.set(base(p), (count.get(base(p)) ?? 0) + 1)
  return unique.map((p) => {
    if ((count.get(base(p)) ?? 0) < 2) return base(p)
    return parts(p).slice(-2).join("/")
  })
}
