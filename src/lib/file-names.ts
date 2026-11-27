// Files named in a dialog ("a.ts", or "src/index.ts" beside "test/index.ts"). Pure.

const parts = (p: string) => p.split(/[\\/]/).filter(Boolean)

/** Each distinct path's name, with as many of its folders as tell it from the others. */
export function shortNames(paths: string[]): string[] {
  const unique = [...new Set(paths)]
  const split = unique.map(parts)
  return split.map((ps, i) => {
    for (let n = 1; n < ps.length; n++) {
      const tail = ps.slice(-n).join("/")
      const clash = split.some((o, j) => j !== i && o.slice(-n).join("/") === tail)
      if (!clash) return tail
    }
    return ps.join("/") || unique[i]!
  })
}
