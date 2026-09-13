// Read through the configured REST cap, even if it is lower than our page size.
export async function readReportPages(query: any): Promise<{ data: any[]; error: any }> {
  const rows: any[] = []
  const ordered = query.order('id', { ascending: true })
  for (let offset = 0; ; ) {
    const { data, error } = await ordered.range(offset, offset + 499)
    if (error) return { data: [], error }
    if (!data?.length) return { data: rows, error: null }
    rows.push(...data)
    offset += data.length
    if (offset > 1000000) throw new Error('Занадто великий звіт. Скоротіть період.')
  }
}
