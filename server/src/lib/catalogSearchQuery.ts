// Search only: never use this normalization to merge cards or rewrite articles.
// Mirrored in desktop/server because they have separate TypeScript build roots;
// a parity test keeps the implementations identical.
export function isArticleSearch(value: string): boolean {
  const compact = value.replace(/[\s./_-]/g, '')
  return /^[a-z0-9][a-z0-9\s./_-]*$/i.test(value) && compact.length >= 4 && (compact.match(/\d/g)?.length ?? 0) >= 2
}
export function normalizeCatalogSearchQuery(value: string): string {
  const query = String(value ?? '').normalize('NFKC').replace(/[\u0000-\u0020\u007f]+/g, ' ').trim()
  // Only the detached supplier tags reported by the owner. W, WA, WL, etc.
  // remain part of a manufacturer's article. BO1457434310 is NOT stripped.
  const tagged = query.match(/^(?:BO|WX|HBJ)(?:\s+|:\s*)(.+)$/i)
  return tagged && isArticleSearch(tagged[1]) ? tagged[1].trim() : query
}
export function articleSearchTerms(value: string): string[] {
  const query = normalizeCatalogSearchQuery(value)
  if (!isArticleSearch(query)) return []
  const tight = query.replace(/\s+/g, '')
  const terms = new Set([query, tight, tight.replace(/[./_-]/g, '')])
  // WA9428 and WA 9428 are formatting variants; the WA must never disappear.
  const split = tight.match(/^([a-z]{1,5})(\d[0-9./_-]*)$/i)
  if (split) { terms.add(split[1] + ' ' + split[2]); terms.add(split[1] + '-' + split[2]) }
  return [...terms]
}
