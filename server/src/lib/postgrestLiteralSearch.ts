// Quote PostgREST's logical-filter grammar AND escape SQL LIKE wildcards.
// Never interpolate user text directly into .or().
export function literalContainsFilter(columns: string[], search: string): string {
  const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%'
  const literal = '"' + pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  return columns.map(column => `${column}.ilike.${literal}`).join(',')
}
