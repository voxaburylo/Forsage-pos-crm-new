import { useRef, useState } from 'react'
import { Barcode, Check, ScanLine } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { productApi } from '@/features/products/productApi'
import { pickingApi, type EnrichedCustomerOrder } from './pickingApi'
import { exactScanProducts, findScanTarget, scanResultText, type ScanTarget } from './pickingScan'

/**
 * 24.11.2026 (слово власника): розкласти прибулий товар сканером — за бажанням. Панель згорнута, доки її не відкриють,
 * тож звичайній збірці не заважає. Відсканували — видно замовлення й комірку; позиція відмічається «надійшло».
 */
export function PickingScanPanel({ orders, onChanged }: { orders: EnrichedCustomerOrder[]; onChanged: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<{ target: ScanTarget; cell: string } | null>(null)
  const [problem, setProblem] = useState('')
  const [cell, setCell] = useState('')
  const input = useRef<HTMLInputElement>(null)

  async function scan() {
    const scanned = value.trim()
    if (!scanned || busy) return
    setBusy(true); setProblem('')
    try {
      // Картку шукаємо лише за точним кодом: схожа назва чи шматок артикула не рахуються.
      const found = await productApi.search(scanned, 10).then(answer => answer.data as Array<{ id: string; sku?: string | null; barcode?: string | null; additional_barcodes?: unknown }>, () => [])
      const target = findScanTarget(orders, scanned, exactScanProducts(scanned, found))
      if (!target) {
        setLast(null)
        setProblem(`«${scanned}»: такого товару не чекає жодне замовлення. Якщо товар прийшов під замовлення — перевірте артикул у замовленні або відкрийте його зі списку нижче.`)
        return
      }
      await pickingApi.pickItem(target.item.id, 'arrived')
      const orderCell = String(target.order.pickup_cell ?? '').trim()
      setLast({ target, cell: orderCell }); setCell(orderCell)
      await onChanged()
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : 'Не вдалося відмітити позицію')
    } finally {
      setBusy(false); setValue('')
      window.setTimeout(() => input.current?.focus(), 0)
    }
  }

  async function saveCell() {
    if (!last || !cell.trim() || busy) return
    setBusy(true)
    try {
      await pickingApi.updatePickupCell(last.target.order.id, cell.trim())
      setLast({ ...last, cell: cell.trim() })
      toast.success('Комірку записано')
      await onChanged()
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : 'Не вдалося записати комірку') }
    finally { setBusy(false); window.setTimeout(() => input.current?.focus(), 0) }
  }

  if (!open) return (
    <div>
      <Button variant="secondary" icon={<ScanLine size={16} />} onClick={() => { setOpen(true); window.setTimeout(() => input.current?.focus(), 0) }} data-picking-scan-open>
        Розкласти прибулий товар сканером
      </Button>
    </div>
  )
  const text = last ? scanResultText(last.target) : null
  return (
    <Card className="border border-gray-800 bg-[#1A1A1A] p-4" data-picking-scan>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex shrink-0 items-center gap-2 text-yellow-400"><Barcode size={22} /><span className="text-xs font-bold uppercase tracking-wider text-gray-300">Прибулий товар:</span></div>
        <input ref={input} type="text" value={value} disabled={busy} onChange={event => setValue(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void scan() } }}
          placeholder="Відскануйте штрихкод або введіть артикул і натисніть Enter" aria-label="Штрихкод або артикул прибулого товару"
          className="w-full flex-1 rounded-lg border border-gray-800 bg-[#242424] px-3 py-2 text-sm font-semibold text-white focus:border-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-400" />
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)} className="shrink-0">Згорнути</Button>
      </div>
      <p className="mt-2 text-xs text-gray-400">Програма сама знайде, для якого замовлення цей товар, відмітить позицію «надійшло» й покаже комірку. Товару без штрихкоду в картці вводьте артикул.</p>
      {problem && <p role="alert" className="mt-3 rounded-lg border border-red-500/50 bg-red-900/25 px-3 py-2 text-sm text-red-200" data-picking-scan-problem>{problem}</p>}
      {last && text && (
        <div className="mt-3 rounded-xl border border-emerald-500/50 bg-emerald-900/20 p-3" data-picking-scan-result>
          <p className="flex items-center gap-2 text-sm font-semibold text-white"><Check size={16} className="shrink-0 text-emerald-400" />{text.title}</p>
          <p className="mt-1 text-sm text-gray-200">{text.where}</p>
          {last.cell
            ? <p className="mt-2 text-2xl font-bold text-yellow-400" data-picking-scan-cell>Комірка: {last.cell}</p>
            : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-sm text-amber-200">Комірку для цього замовлення ще не призначено:</span>
                <input value={cell} onChange={event => setCell(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveCell() } }}
                  placeholder="напр. A-12" aria-label="Комірка видачі" maxLength={32}
                  className="w-32 rounded-lg border border-gray-700 bg-[#242424] px-3 py-1.5 text-sm font-semibold text-white focus:border-yellow-400 focus:outline-none" />
                <Button size="sm" loading={busy} disabled={!cell.trim()} onClick={() => void saveCell()}>Записати комірку</Button>
              </div>
            )}
          {text.more && <p className="mt-2 text-xs text-gray-300">{text.more}</p>}
        </div>
      )}
    </Card>
  )
}
