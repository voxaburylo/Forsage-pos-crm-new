import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SupplyInvoice } from '@/types/supplier'
import { Modal, Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'
import { DEFAULT_LABEL, LabelPreview, loadProductLabelSettings, printLabels } from '@/features/labels/LabelDesigner'

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
  const items = invoice.items?.filter((i) => i.product) ?? []
  const [labelSettings, setLabelSettings] = useState(DEFAULT_LABEL)

  useEffect(() => {
    if (!open) return
    let alive = true
    loadProductLabelSettings()
      .then((settings) => { if (alive) setLabelSettings(settings) })
      .catch(() => {})
    return () => { alive = false }
  }, [open])

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
      const settings = await loadProductLabelSettings()
      setLabelSettings(settings)
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
          <span className="text-xs text-gray-400">Формат: {labelSettings.width_mm}мм × {labelSettings.height_mm}мм</span>
        </div>

        {/* Preview label */}
        <div className="border border-dashed border-gray-300 rounded-xl p-3 flex flex-col items-center">
          <p className="text-xs text-gray-400 mb-2 self-start">Зразок етикетки:</p>
          {items[0]?.product && (
            <div className="max-w-full overflow-x-auto">
              <LabelPreview settings={labelSettings} product={items[0].product as any} />
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
        </div>
      </div>
    </Modal>
  )
}
