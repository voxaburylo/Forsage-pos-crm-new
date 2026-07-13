import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '@/lib/api'
import { usePOSStore } from '@/stores/posStore'
import { toast } from '@/components/ui/Toast'
import { searchProductsOffline } from '@/lib/offlineDB'
import { useAuthStore } from '@/stores/authStore'
import { desktopBridge } from '@/lib/desktopBridge'

type Kind = 'tire_service' | 'free_sale'
type Staff = { id: string; full_name: string; role: string }

export function QuickChargeModal({
  open, kind, staff, offline = false, onClose,
}: {
  open: boolean
  kind: Kind
  staff: Staff[]
  offline?: boolean
  onClose: () => void
}) {
  const store = usePOSStore()
  const scopeKey = useAuthStore((state) => state.session?.user?.id ?? '')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setAmount('')
    setDescription('')
    setWorkerId(store.managerId ?? '')
  }, [open, kind])

  if (!open) return null
  const isTire = kind === 'tire_service'

  async function add() {
    if (savingRef.current) return
    const normalizedAmount = amount.trim().replace(',', '.')
    const price = Math.round(Number(normalizedAmount) * 100)
    if (!Number.isFinite(price) || price <= 0) {
      toast.error('Вкажіть суму більше 0')
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      const sku = isTire ? 'POS-TIRE-SERVICE' : 'POS-FREE-SALE'
      let data: { id: string; sku: string; name: string; unit: string; retail_price: number } | null = null
      const cached = await searchProductsOffline(sku, 10, scopeKey).catch(() => [])
      data = cached.find((product) => product.sku === sku) ?? null
      if (!data && !offline) {
        const response = await api.post<{ data: NonNullable<typeof data> }>(
          '/api/v1/sales/quick-item',
          { kind },
          undefined,
          { timeoutMs: 8_000, silent: true },
        )
        data = response.data
      }
      if (!data) {
        throw new Error('Службова позиція ще не кешована. Відкрийте касу один раз з інтернетом')
      }

      // Desktop: гарантуємо, що службовий товар (POS-FREE-SALE / POS-TIRE-SERVICE)
      // є в локальній SQLite-базі, інакше локальний продаж впаде з LOCAL_PRODUCT_NOT_FOUND
      // (його могло не бути в бутстрапі, бо він створюється на сервері на вимогу).
      const desktop = desktopBridge()
      if (desktop) {
        await desktop.catalog.upsertProduct({
          id: data.id,
          sku: data.sku,
          name: data.name,
          unit: data.unit,
          retail_price: data.retail_price,
          qty_on_hand: 0,
          is_service: true,
          is_active: true,
        }).catch((err) => {
          console.error('Failed to cache service product locally', err)
        })
      }

      // У чеку має бути одна підсумкова сума такого типу. Повторне введення
      // замінює її, а не множить попередню ціну на кількість.
      if (store.items.some((item) => item.productId === data.id)) {
        store.removeItem(data.id)
      }
      store.addItem({
        productId: data.id,
        sku: data.sku,
        name: data.name,
        unit: data.unit,
        qty: 1,
        unitPrice: price,
        discount: 0,
        qtyOnHand: 999999,
        requiresCoreReturn: false,
        coreDepositAmount: 0,
      })
      if (workerId) store.setManagerId(workerId)
      if (description.trim()) {
        const prefix = isTire ? 'Шиномонтаж' : 'Вільний продаж'
        store.setNotes([store.notes, `${prefix}: ${description.trim()}`].filter(Boolean).join('\n'))
      }
      toast.success('Позицію додано в чек')
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не вдалося додати позицію')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-gray-700 bg-[#1A1A1A] p-5 text-white shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">{isTire ? 'Шиномонтаж' : 'Продаж за вільною ціною'}</h2>
            <p className="mt-1 text-xs text-gray-400">
              {isTire ? 'Сума може відрізнятися від прайсу' : 'Для б·у речі або товару, якого немає в каталозі'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Закрити"><X size={20} /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs text-gray-400">Сума до оплати, ₴</label>
            <input autoFocus type="number" min="0.01" step="0.01" inputMode="decimal"
              value={amount} onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add() }}
              className="w-full rounded-xl border border-gray-700 bg-[#2C2C2C] px-4 py-3 text-center text-2xl font-bold outline-none focus:border-yellow-400" />
          </div>

          <div>
            <label className="mb-1 block text-xs text-gray-400">
              {isTire ? 'Хто виконав роботу' : 'Хто здійснив продаж'}
            </label>
            <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}
              className="w-full rounded-xl border border-gray-700 bg-[#2C2C2C] px-3 py-3 text-sm outline-none focus:border-yellow-400">
              <option value="">Поточний касир</option>
              {staff.map((person) => (
                <option key={person.id} value={person.id}>{person.full_name || person.id.slice(0, 6)}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs text-gray-400">Що зробили / що продали (необов’язково)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder={isTire ? 'Напр.: ремонт проколу, балансування' : 'Напр.: б/у колесо R15'}
              className="w-full rounded-xl border border-gray-700 bg-[#2C2C2C] px-3 py-3 text-sm outline-none focus:border-yellow-400" />
          </div>

          <button onClick={add} disabled={saving}
            className="w-full rounded-xl bg-yellow-400 py-3.5 font-bold text-black hover:bg-yellow-300 disabled:opacity-50">
            {saving ? 'Додаємо...' : 'Додати в чек'}
          </button>
        </div>
      </div>
    </div>
  )
}
