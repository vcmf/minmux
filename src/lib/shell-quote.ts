/** A POSIX shell single-quoted word: `it's` → `'it'\''s'` (nothing inside is expanded). */
export const posixQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
