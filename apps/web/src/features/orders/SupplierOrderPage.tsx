import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Copy, PackageCheck, RefreshCw } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge } from '@/lib/desktopBridge'
import { groupSupplierLines, supplierOrderText, type SupplierOrderGroup, type SupplierOrderLine } from './supplierOrderModel'

const quantity = (value: number) => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))

/**
 * 23.11.2026 (план C3): «Замовити в постачальника». Що з відкритих замовлень ще не замовлено — за постачальниками.
 * Скопіювати список для постачальника й одним рухом відмітити «замовлено». Дані й дії — на головному ПК.
 */
export default function SupplierOrderPage() {
  const [lines, setLines] = useState<SupplierOrderLine[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    const read = desktopBridge()?.orders?.supplierLines
    if (!read) { setError('Список доступний лише на касі або через головний ПК.'); return }
    setError('')
    try { setLines(await read()) } catch (reason) {
      setLines(null)
      setError(reason instanceof Error ? reason.message : 'Не вдалося завантажити список')
    }
  }, [])
  useEffect(() => { void load() }, [load])
  const groups = useMemo(() => groupSupplierLines(lines ?? []), [lines])

  async function copy(group: SupplierOrderGroup) {
    try {
      await navigator.clipboard.writeText(supplierOrderText(group))
      toast.success('Список скопійовано — вставте в месенджер постачальника')
    } catch { toast.error('Не вдалося скопіювати. Виділіть список і скопіюйте вручну.') }
  }

  async function markOrdered(group: SupplierOrderGroup) {
    const mark = desktopBridge()?.orders?.bulkOrdered
    if (!mark || busy) return
    if (!window.confirm(`Відмітити «замовлено» ${group.lines.length} поз. (${group.title})?`)) return
    setBusy(group.key)
    try {
      const result = await mark(group.lines.map(line => line.item_id))
      toast.success(`Відмічено «замовлено»: ${result.updated}`)
      await load()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Не вдалося відмітити')
    } finally { setBusy('') }
  }

  return (
    <Layout title="Замовити в постачальника">
      <div className="mx-auto max-w-4xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-sm text-gray-600">Позиції відкритих замовлень, які ще не замовлено. Скопіюйте список, надішліть постачальнику й відмітьте «замовлено».</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}><RefreshCw size={14} /> Оновити</Button>
        </div>
        {error && <Card className="p-4"><p role="alert" className="text-sm text-red-700">{error}</p></Card>}
        {!lines && !error && <p role="status" className="text-sm text-gray-500">Завантаження…</p>}
        {lines && groups.length === 0 && <Card className="p-4 text-sm text-gray-600">Усе замовлено — чекати нічого не треба.</Card>}
        {groups.map(group => (
          <Card key={group.key} className="overflow-hidden" data-supplier-group={group.key}>
            <div className="flex flex-wrap items-center gap-2 border-b bg-gray-50 px-4 py-3">
              <h2 className="flex-1 font-semibold text-gray-900">{group.title} <span className="font-normal text-gray-500">· {group.lines.length} поз.</span></h2>
              <Button size="sm" variant="secondary" onClick={() => void copy(group)}><Copy size={14} /> Скопіювати список</Button>
              <Button size="sm" loading={busy === group.key} disabled={Boolean(busy)} onClick={() => void markOrdered(group)}><PackageCheck size={14} /> Замовлено</Button>
            </div>
            <ul className="divide-y text-sm">
              {group.lines.map(line => (
                <li key={line.item_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2">
                  <span className="min-w-0 flex-1">
                    {line.sku && <span className="mr-2 font-mono text-gray-700">{line.sku}</span>}
                    <span className="text-gray-900">{line.name}</span>
                    <span className="ml-2 font-semibold">× {quantity(line.qty)}</span>
                  </span>
                  <Link to={`/orders/${line.order_id}`} className="text-xs text-blue-700 hover:underline">
                    № {line.order_number}{line.customer_name ? ` · ${line.customer_name}` : ''}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </Layout>
  )
}
