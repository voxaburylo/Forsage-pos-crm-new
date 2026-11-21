import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { Card } from '@/components/ui'
import { desktopBridge, type NegativeStockRow } from '@/lib/desktopBridge'
import { formatDateTime } from '@/lib/utils'

/**
 * «Аналітика → Перерахунок» (рішення власника 21.11.2026): продаж у мінус дозволено, а товари з
 * від'ємним залишком збираються тут. Рядок зникає сам після ревізії або приходу, який виводить
 * залишок у плюс. Нічого не змінює — лише показує, що перерахувати на полиці.
 */
export default function NegativeStockPage() {
  const [rows, setRows] = useState<NegativeStockRow[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const load = desktopBridge()?.catalog?.negativeStock
    if (!load) { setError('Список доступний у програмі каси на ПК.'); setRows([]); return }
    let alive = true
    load().then(data => { if (alive) setRows(data) }).catch(() => { if (alive) { setError('Не вдалося завантажити список.'); setRows([]) } })
    return () => { alive = false }
  }, [])
  return (
    <Layout title="Товари потребують інвентаризації">
      <div className="max-w-4xl space-y-4">
        <p className="text-sm text-gray-600">Ці товари продано більше, ніж було за програмою (продаж у мінус). Перерахуйте їх на полиці й проведіть ревізію або прихід — рядок зникне сам.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {rows === null && <p className="text-sm text-gray-500">Завантаження…</p>}
        {rows?.length === 0 && !error && <Card><p className="text-sm text-gray-600">Товарів у мінусі немає.</p></Card>}
        {!!rows?.length && (
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr><th className="px-3 py-2">Товар</th><th className="px-3 py-2 text-right">Залишок</th><th className="px-3 py-2">Останній продаж</th><th className="px-3 py-2">Хто продав</th></tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-t border-gray-100">
                    <td className="px-3 py-2"><Link to={`/products/${row.id}`} className="font-medium text-blue-700 hover:underline">{row.name}</Link>{row.sku ? <span className="ml-2 text-xs text-gray-500">{row.sku}</span> : null}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-red-700">{row.qty_on_hand} {row.unit ?? ''}</td>
                    <td className="px-3 py-2 text-gray-600">{row.last_sale_at ? formatDateTime(row.last_sale_at) : '—'}</td>
                    <td className="px-3 py-2 text-gray-600">{row.last_cashier ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        <p className="text-xs text-gray-500">Перерахунок: <Link to="/inventory" className="underline">Інвентаризація</Link> · Прихід: <Link to="/suppliers/invoices" className="underline">Поступлення товарів</Link></p>
      </div>
    </Layout>
  )
}
