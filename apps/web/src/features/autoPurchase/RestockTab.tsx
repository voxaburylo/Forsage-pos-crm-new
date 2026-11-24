import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, FileSpreadsheet, RefreshCw } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'
import { useStaffRights } from '@/lib/staffRights'
import { purchaseApi } from './purchaseApi'
import { groupRestock, initialPick, readPickQty, restockFileName, restockSheetRows, restockText, type RestockGroup, type RestockRow } from './restockModel'

const num = (value: number) => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))

/**
 * «Що закінчується» — товари з низьким залишком за постачальниками (слово власника 24.11.2026). Кількість можна
 * виправити або поставити 0, щоб рядок не пішов у лист. Лист — текстом у буфер або файлом Excel. Нічого не замовляє
 * й не змінює саме: це список для людини.
 */
export function RestockTab() {
  const [rows, setRows] = useState<RestockRow[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<Map<string, number>>(new Map())
  const [openKey, setOpenKey] = useState<string | null>(null)
  const canSeePurchase = useStaffRights().purchase_prices

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = (await purchaseApi.restockNeeds()).data as RestockRow[]
      setRows(data); setPicked(initialPick(data)); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не вдалося порахувати список') } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => groupRestock(rows ?? []), [rows])
  const setQty = (id: string, text: string) => setPicked(current => new Map(current).set(id, readPickQty(text)))

  async function copy(group: RestockGroup) {
    const text = restockText(group, picked)
    if (!text) { toast.error('У листі немає жодної позиції з кількістю'); return }
    try { await navigator.clipboard.writeText(text); toast.success('Лист замовлення скопійовано') } catch { toast.error('Не вдалося скопіювати') }
  }

  async function excel(group: RestockGroup) {
    const data = restockSheetRows(group, picked)
    if (!data.length) { toast.error('У листі немає жодної позиції з кількістю'); return }
    try {
      const XLSX = await import('xlsx')
      const sheet = XLSX.utils.json_to_sheet(data)
      sheet['!cols'] = [{ wch: 5 }, { wch: 22 }, { wch: 60 }, { wch: 11 }]
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, 'Замовлення')
      XLSX.writeFile(book, restockFileName(group.title))
      toast.success('Файл Excel збережено')
    } catch { toast.error('Не вдалося зберегти Excel') }
  }

  return (
    <div className="space-y-3" data-restock>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm text-gray-600">Товари, які продавались за останні 90 днів, а залишку менше, ніж продано за місяць. Розкладено за постачальником, від якого товар приходив востаннє.</p>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void load()}>Оновити</Button>
      </div>
      {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p>}
      {!rows && !error && <p role="status" className="py-10 text-center text-sm text-gray-400">Рахуємо…</p>}
      {rows && rows.length === 0 && <p className="py-10 text-center text-sm text-gray-500">Нічого не закінчується: усе, що продавалось, є на залишку з запасом.</p>}
      {groups.map(group => {
        const open = openKey === group.key
        const chosen = group.rows.filter(row => (picked.get(row.product_id) ?? 0) > 0).length
        return (
          <Card key={group.key}>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setOpenKey(open ? null : group.key)} className="min-w-0 flex-1 text-left" aria-expanded={open} data-restock-group={group.key}>
                <span className="font-semibold text-gray-900">{group.title}</span>
                <span className="text-sm text-gray-500"> · {group.rows.length} поз.{canSeePurchase && group.total > 0 ? ' · приблизно ' + formatMoney(group.total) : ''}</span>
              </button>
              <Button size="sm" variant="secondary" icon={<Copy size={14} />} onClick={() => void copy(group)}>Скопіювати лист ({chosen})</Button>
              <Button size="sm" variant="secondary" icon={<FileSpreadsheet size={14} />} onClick={() => void excel(group)}>Excel</Button>
            </div>
            {open && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="py-2 pr-3 font-medium">Товар</th><th className="py-2 pr-3 font-medium">Залишок</th><th className="py-2 pr-3 font-medium">Продано за 30 / 90 дн.</th><th className="py-2 font-medium">Замовити</th>
                  </tr></thead>
                  <tbody>
                    {group.rows.map(row => (
                      <tr key={row.product_id} className="border-b border-gray-50 last:border-b-0">
                        <td className="py-2 pr-3"><span className="font-medium text-gray-900">{row.name}</span><span className="block text-xs text-gray-500">{row.sku}</span></td>
                        <td className={`py-2 pr-3 ${row.qty_on_hand <= 0 ? 'font-semibold text-red-600' : 'text-gray-700'}`}>{num(row.qty_on_hand)}</td>
                        <td className="py-2 pr-3 text-gray-700">{num(row.sold_30)} / {num(row.sold_90)}</td>
                        <td className="py-2"><input inputMode="decimal" aria-label={'Замовити: ' + row.name} defaultValue={num(row.suggest_qty)} onChange={event => setQty(row.product_id, event.target.value)}
                          className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}
