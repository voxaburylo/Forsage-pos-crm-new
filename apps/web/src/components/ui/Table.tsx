interface Column<T> {
  key: string
  header: string
  className?: string
  render: (row: T) => React.ReactNode
}

interface Props<T> {
  columns: Column<T>[]
  data: T[]
  keyFn: (row: T) => string
  loading?: boolean
  empty?: React.ReactNode
}

export function Table<T>({ columns, data, keyFn, loading, empty }: Props<T>) {
  return (
    <div className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-100">
          <tr>
            {columns.map((col) => (
              <th key={col.key} className={`text-left px-4 py-3 text-gray-500 font-medium ${col.className ?? ''}`}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {loading ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 text-sm">
                Завантаження...
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 text-sm">
                {empty ?? 'Нічого не знайдено'}
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr key={keyFn(row)} className="hover:bg-gray-50 transition-colors">
                {columns.map((col) => (
                  <td key={col.key} className={`px-4 py-3 ${col.className ?? ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
