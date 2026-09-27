/** Fetch every page; fail visibly instead of presenting a silently truncated history. */
export async function collectSalaryHistory<T extends { id: string }>(fetchPage: (page: number) => Promise<{ data: T[]; has_more: boolean }>): Promise<T[]> {
  const records = new Map<string, T>()
  for (let page = 1; ; page++) {
    const result = await fetchPage(page)
    const before = records.size
    for (const row of result.data) records.set(row.id, row)
    if (!result.has_more) return [...records.values()]
    if (result.data.length > 0 && records.size === before) throw new Error('Не вдалося отримати повну історію зарплати. Оновіть програму та повторіть.')
  }
}
