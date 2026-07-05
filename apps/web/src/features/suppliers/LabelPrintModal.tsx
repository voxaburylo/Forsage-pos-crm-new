import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SupplyInvoice } from '@/types/supplier'
import { Modal, Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'
import { printLabels, DEFAULT_LABEL } from '@/features/labels/LabelDesigner'
import { adminApi } from '@/features/admin/adminApi'
import { PrintService } from '@/lib/printService'

interface Props {
  open:     boolean
  onClose:  () => void
  invoice:  SupplyInvoice
}

interface LabelQty {
  itemId: string
  qty:    number
}


export function LabelPrintModal({ open, onClose, invoice }: Props) {
  const navigate = useNavigate()
  const printAreaRef = useRef<HTMLDivElement>(null)
  const items = invoice.items?.filter((i) => i.product) ?? []
  const today = new Date().toLocaleDateString('uk-UA')

  function handleSendToQueue() {
    const queueItems = items.flatMap((item) => {
      const count = getQty(item.id)
      if (count <= 0) return []
      return [{ id: item.product!.id, copies: count }]
    })

    if (queueItems.length === 0) {
      toast.error('Оберіть кількість етикеток для відправки')
      return
    }

    const current = localStorage.getItem('forsage_labels_import')
    let queue: Array<{ id: string; copies: number }> = []
    if (current) {
      try {
        queue = JSON.parse(current)
        if (!Array.isArray(queue)) queue = []
      } catch {
        queue = []
      }
    }

    queueItems.forEach(item => {
      const existing = queue.find(q => q.id === item.id)
      if (existing) {
        existing.copies += item.copies
      } else {
        queue.push(item)
      }
    })

    localStorage.setItem('forsage_labels_import', JSON.stringify(queue))
    toast.success(`Додано ${queueItems.length} товарів до черги друку. Перенаправлення...`)
    setTimeout(() => {
      navigate('/labels')
    }, 800)
  }

  const [qtys, setQtys] = useState<LabelQty[]>(
    items.map((i) => ({ itemId: i.id, qty: Math.ceil(i.qty) }))
  )

  function getQty(itemId: string) {
    return qtys.find((q) => q.itemId === itemId)?.qty ?? 1
  }
  function setQty(itemId: string, qty: number) {
    setQtys((prev) => prev.map((q) => q.itemId === itemId ? { ...q, qty: Math.max(0, qty) } : q))
  }

  const [printingThermal, setPrintingThermal] = useState(false)
  async function handleThermalPrint() {
    setPrintingThermal(true)
    try {
      const settingsRes = await adminApi.getSettings()
      const settings = settingsRes.data.label_settings || DEFAULT_LABEL
      const printItems = items.flatMap((item) => {
        const count = getQty(item.id)
        if (count <= 0) return []
        return Array(count).fill(item.product)
      })
      printLabels(settings as any, printItems, false)
    } catch {
      toast.error('Помилка друку')
    } finally {
      setPrintingThermal(false)
    }
  }

  function handlePrint() {
    const style = document.createElement('style')
    style.id = 'label-print-style'
    style.innerHTML = `
      @page { size: A4 portrait; margin: 8mm; }
      @media print {
        body > *:not(#label-print-portal) { display: none !important; }
        #label-print-portal {
          display: grid !important;
          grid-template-columns: repeat(3, 58mm);
          grid-auto-rows: 40mm;
          gap: 3mm;
          width: 190mm;
          margin: 0;
          padding: 0;
        }
        .label-item {
          width: 58mm; height: 40mm; border: 0.3mm solid #000;
          padding: 2mm 3mm; margin: 0; page-break-inside: avoid;
          font-family: Arial, sans-serif; box-sizing: border-box;
          overflow: hidden;
        }
        .label-shop  { font-size: 7pt; font-weight: bold; color: #555; border-bottom: 0.3mm solid #ccc; margin-bottom: 1mm; padding-bottom: 1mm; }
        .label-name  { font-size: 8pt; font-weight: bold; line-height: 1.2; margin-bottom: 1mm; }
        .label-sku   { font-size: 7pt; color: #333; }
        .label-barcode { font-size: 6pt; letter-spacing: 1px; font-family: monospace; margin: 1mm 0; color: #555; }
        .label-price { font-size: 12pt; font-weight: bold; margin-top: 1mm; }
        .label-date  { font-size: 6pt; color: #777; }
      }
    `

    const portal = document.createElement('div')
    portal.id = 'label-print-portal'

    // Назви/артикули приходять з імпортованих прайсів — обов'язково екрануємо,
    // інакше HTML у назві товару виконається прямо в основному вікні застосунку
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    items.forEach((item) => {
      const count = getQty(item.id)
      const p = item.product
      if (!p) return
      for (let i = 0; i < count; i++) {
        const div = document.createElement('div')
        div.className = 'label-item'
        div.innerHTML = `
          <div class="label-shop">ФОРСАЖ</div>
          <div class="label-name">${esc(p.name)}</div>
          <div class="label-sku">Арт: ${esc(p.sku)}</div>
          ${p.barcode ? '<div class="label-barcode">' + esc(p.barcode) + '</div>' : ''}
          <div class="label-price">${formatMoney(p.retail_price)}</div>
          <div class="label-date">${today}</div>
        `
        portal.appendChild(div)
      }
    })

    document.head.appendChild(style)
    document.body.appendChild(portal)

    let cleanupTimer: number | null = null
    const cleanup = () => {
      if (cleanupTimer !== null) window.clearTimeout(cleanupTimer)
      if (document.head.contains(style)) document.head.removeChild(style)
      if (document.body.contains(portal)) document.body.removeChild(portal)
    }
    window.addEventListener('afterprint', cleanup, { once: true })
    try {
      const started = PrintService.printCurrentPage()
      if (!started) {
        window.removeEventListener('afterprint', cleanup)
        cleanup()
        toast.error('Попереднє вікно друку ще відкрите')
      } else {
        cleanupTimer = window.setTimeout(cleanup, 120000)
      }
    } catch (error) {
      window.removeEventListener('afterprint', cleanup)
      cleanup()
      toast.error(error instanceof Error ? error.message : 'Не вдалося відкрити друк')
    }
  }

  const totalLabels = qtys.reduce((s, q) => s + q.qty, 0)

  return (
    <Modal open={open} onClose={onClose} title="Друк етикеток" size="md">
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Вкажіть кількість етикеток для кожного товару. За замовчуванням — кількість з накладної.
        </p>

        <div className="border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-2 text-left text-xs text-gray-500 font-medium">Товар</th>
                <th className="px-3 py-2 text-center text-xs text-gray-500 font-medium w-24">Кількість</th>
                <th className="px-4 py-2 text-right text-xs text-gray-500 font-medium w-28">Ціна</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-2">
                    <p className="font-medium text-gray-900 text-sm">{item.product!.name}</p>
                    <p className="text-xs text-gray-400">{item.product!.sku}</p>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={0}
                      max={999}
                      value={getQty(item.id)}
                      onChange={(e) => setQty(item.id, parseInt(e.target.value) || 0)}
                      className="w-full text-center border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
                    />
                  </td>
                  <td className="px-4 py-2 text-right font-medium text-gray-700">
                    {formatMoney(item.product!.retail_price)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Preview */}
        <div className="bg-gray-50 rounded-xl p-3 text-sm text-gray-600 flex items-center justify-between">
          <span>Всього етикеток: <strong className="text-gray-900">{totalLabels}</strong></span>
          <span className="text-xs text-gray-400">Формат: 58мм × 40мм</span>
        </div>

        {/* Preview label */}
        <div className="border border-dashed border-gray-300 rounded-xl p-3 flex flex-col items-center">
          <p className="text-xs text-gray-400 mb-2 self-start">Зразок етикетки:</p>
          {items[0]?.product && (
            <div className="inline-block border border-gray-400 rounded p-2 text-xs font-mono bg-white" style={{ width: 190 }}>
              <div className="text-gray-400 text-[9px] border-b border-gray-200 mb-1 pb-1">ФОРСАЖ</div>
              <div className="font-bold text-[10px] leading-tight mb-0.5 truncate">{items[0].product!.name}</div>
              <div className="text-gray-500 text-[9px]">Арт: {items[0].product!.sku}</div>
              {items[0].product!.barcode && (
                <div className="text-[7.5px] text-gray-400 font-mono tracking-tighter my-0.5 truncate">{items[0].product!.barcode}</div>
              )}
              <div className="font-bold text-sm mt-1">{formatMoney(items[0].product!.retail_price)}</div>
              <div className="text-[8px] text-gray-400">{today}</div>
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 sm:justify-end pt-2">
          <Button variant="secondary" onClick={onClose} className="w-full sm:w-auto">Скасувати</Button>
          <Button variant="secondary" onClick={handleSendToQueue} disabled={totalLabels === 0} className="w-full sm:w-auto">
            📥 В чергу друку
          </Button>
          <Button variant="outline" onClick={handleThermalPrint} disabled={totalLabels === 0} loading={printingThermal} className="w-full sm:w-auto">
            Друк на термопринтері
          </Button>
          <Button onClick={handlePrint} disabled={totalLabels === 0} className="w-full sm:w-auto">
            Друк на А4 ({totalLabels} шт.)
          </Button>
        </div>
      </div>

      {/* Hidden print area (fallback, not used — we use DOM injection) */}
      <div ref={printAreaRef} className="hidden" />
    </Modal>
  )
}
