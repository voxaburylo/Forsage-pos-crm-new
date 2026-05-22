import { useState, useEffect } from 'react'
import { X, Zap } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'

interface MarkupRule {
  minPrice: number
  maxPrice: number
  markupPct: number
}

interface Props {
  initialSku?: string
  onClose: () => void
  onCreated: () => void
}

export function CreateOrderModal({ initialSku, onClose, onCreated }: Props) {
  // Customer
  const [searchCust, setSearchCust] = useState('')
  const [customers, setCustomers] = useState<Array<{ id: string; phone: string; full_name: string | null }>>([])
  const [selectedCust, setSelectedCust] = useState<{ id: string; phone: string; full_name: string | null } | null>(null)
  const [quickPhone, setQuickPhone] = useState('')
  const [quickName, setQuickName] = useState('')

  // Items
  const [items, setItems] = useState<Array<{
    sku: string; name: string; supplier_id: string; buyPrice: number; sellPrice: number; qty: number
  }>>([])
  const [sku, setSku] = useState(initialSku ?? '')
  const [itemName, setItemName] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [buyPrice, setBuyPrice] = useState('')
  const [sellPrice, setSellPrice] = useState('')
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [markupRules, setMarkupRules] = useState<MarkupRule[]>([])

  // Payment
  const [prepayment, setPrepayment] = useState('')
  const [payMethod, setPayMethod] = useState<'cash' | 'card' | 'transfer'>('cash')
  const [isFiscal, setIsFiscal] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    Promise.all([
      api.get<{ data: Array<{ id: string; name: string }> }>('/api/v1/suppliers?per_page=200'),
      api.get<{ data: { markup_rules?: MarkupRule[] } }>('/api/v1/settings'),
    ]).then(([suppRes, settRes]) => {
      setSuppliers(suppRes.data)
      if (settRes.data.markup_rules) setMarkupRules(settRes.data.markup_rules)
    }).catch(() => { /* ignore */ })
  }, [])

  function calcSellPrice(buy: number): number {
    const rule = markupRules.find((r) => buy >= r.minPrice && buy < r.maxPrice)
    if (rule) return Math.round(buy * (1 + rule.markupPct / 100))
    return Math.round(buy * 1.3)
  }

  function handleBuyPriceChange(val: string) {
    setBuyPrice(val)
    const kopecks = Math.round(parseFloat(val || '0') * 100)
    if (kopecks > 0) setSellPrice((calcSellPrice(kopecks) / 100).toFixed(2))
  }

  async function searchCustomer(q: string) {
    setSearchCust(q)
    if (q.length < 2) { setCustomers([]); return }
    try {
      const res = await api.get<any>(`/api/v1/customers?search=${encodeURIComponent(q)}&per_page=5`)
      setCustomers(res.data ?? [])
    } catch {
      /* ignore */
    }
  }

  async function addItem() {
    if (!itemName.trim()) { toast.error('Введіть назву товару'); return }
    const buyKopecks = Math.round(parseFloat(buyPrice || '0') * 100)
    const sellKopecks = Math.round(parseFloat(sellPrice || '0') * 100)
    if (sellKopecks <= 0) { toast.error('Вкажіть роздрібну ціну'); return }

    setItems((prev) => [...prev, {
      sku: sku.trim(), name: itemName.trim(),
      supplier_id: supplierId, buyPrice: buyKopecks,
      sellPrice: sellKopecks, qty: 1,
    }])
    setSku(''); setItemName(''); setBuyPrice(''); setSellPrice(''); setSupplierId('')
  }

  async function handleSave() {
    if (!selectedCust && !quickPhone.trim()) { toast.error('Виберіть клієнта'); return }
    if (items.length === 0) { toast.error('Додайте хоча б один товар'); return }

    setSaving(true)
    try {
      let customerId = selectedCust?.id

      // Швидке створення клієнта
      if (!customerId && quickPhone.trim()) {
        const res = await api.post<any>('/api/v1/customers/quick', {
          phone: quickPhone.trim(), full_name: quickName.trim() || 'Клієнт',
        })
        customerId = res.data.id
      }

      const prepayKopecks = Math.round(parseFloat(prepayment || '0') * 100)

      await api.post('/api/v1/customer-orders', {
        customer_id: customerId,
        comment: null,
        source: 'walk_in',
        prepayment: prepayKopecks,
        prepayment_method: prepayKopecks > 0 ? payMethod : null,
        prepayment_is_fiscal: isFiscal,
        items: items.map((i) => ({
          sku: i.sku || null, name: i.name,
          supplier_id: i.supplier_id || null,
          source_type: i.supplier_id ? 'supplier' : 'supplier',
          buy_price: i.buyPrice, sell_price: i.sellPrice, qty: i.qty,
        })),
      })

      toast.success('Замовлення створено!')
      onCreated()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
    finally { setSaving(false) }
  }

  const totalAmount = items.reduce((s, i) => s + i.sellPrice * i.qty, 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-white rounded-2xl border w-full max-w-lg mx-4 p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Zap size={20} className="text-yellow-500" /> Швидке замовлення
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        {/* Customer */}
        <div className="space-y-3 mb-5 pb-5 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">1. Клієнт</h3>
          {selectedCust ? (
            <div className="flex items-center justify-between bg-green-50 rounded-lg px-3 py-2">
              <span className="font-medium text-gray-800">{selectedCust.full_name ?? selectedCust.phone}</span>
              <button onClick={() => setSelectedCust(null)} className="text-gray-400 hover:text-red-500 text-xs">Змінити</button>
            </div>
          ) : (
            <>
              <input value={searchCust} onChange={(e) => searchCustomer(e.target.value)}
                placeholder="Пошук клієнта за телефоном або ім'ям..."
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              {customers.length > 0 && (
                <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-lg divide-y">
                  {customers.map((c) => (
                    <button key={c.id} onClick={() => setSelectedCust(c)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                      {c.full_name && <span className="font-medium">{c.full_name} </span>}
                      <span className="text-gray-400">{c.phone}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="text-xs text-gray-400 text-center">або створити швидко:</div>
              <div className="flex gap-2">
                <input value={quickPhone} onChange={(e) => setQuickPhone(e.target.value)}
                  placeholder="Телефон *" className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
                <input value={quickName} onChange={(e) => setQuickName(e.target.value)}
                  placeholder="Ім'я" className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
            </>
          )}
        </div>

        {/* Items */}
        <div className="space-y-3 mb-5 pb-5 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">2. Товари</h3>

          {items.length > 0 && (
            <div className="bg-gray-50 rounded-lg divide-y text-sm max-h-40 overflow-y-auto">
              {items.map((item, i) => (
                <div key={i} className="flex items-center justify-between px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{item.name}</p>
                    <p className="text-xs text-gray-400">{item.sku || '—'}</p>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <p className="font-semibold">{(item.sellPrice / 100).toFixed(2)} ₴</p>
                    <button onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-xs text-red-500">×</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <input value={sku} onChange={(e) => setSku(e.target.value)}
              placeholder="Артикул" className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
            <input value={itemName} onChange={(e) => setItemName(e.target.value)}
              placeholder="Назва деталі *" className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="">— Постачальник —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input type="number" min="0" step="0.01" value={buyPrice}
              onChange={(e) => handleBuyPriceChange(e.target.value)}
              placeholder="Закуп. ціна (грн)" className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" min="0" step="0.01" value={sellPrice}
              onChange={(e) => setSellPrice(e.target.value)}
              placeholder="Роздріб. ціна *" className="border border-gray-200 rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-accent" />
            <button onClick={addItem}
              className="px-3 py-2 bg-yellow-400 text-black font-semibold rounded-lg hover:bg-yellow-300 text-sm transition-colors">
              + Додати
            </button>
          </div>
        </div>

        {/* Payment */}
        <div className="space-y-3 mb-5 pb-5 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">3. Передоплата (необов'язково)</h3>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" min="0" step="0.01" value={prepayment}
              onChange={(e) => setPrepayment(e.target.value)}
              placeholder="Сума передоплати" className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
            <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="cash">Готівка</option>
              <option value="card">Картка</option>
              <option value="transfer">Переказ</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={isFiscal} onChange={(e) => setIsFiscal(e.target.checked)}
              className="w-4 h-4 accent-yellow-400" />
            🧾 Фіскальний чек (ПРРО)
          </label>
        </div>

        {/* Summary & Save */}
        <div className="space-y-3">
          <div className="text-right">
            <span className="text-gray-500 text-sm">Разом: </span>
            <span className="text-2xl font-bold text-gray-900">{(totalAmount / 100).toFixed(2)} ₴</span>
          </div>
          <button onClick={handleSave} disabled={saving}
            className="w-full py-3 rounded-xl bg-yellow-400 text-black font-bold hover:bg-yellow-300 disabled:opacity-40 transition-colors">
            {saving ? 'Створення...' : '✅ Створити замовлення'}
          </button>
        </div>
      </div>
    </div>
  )
}
