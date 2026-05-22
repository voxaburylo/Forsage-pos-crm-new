import { useState, useEffect } from 'react'
import { RotateCcw, Search, Package, AlertTriangle, Info } from 'lucide-react'
import { returnApi } from './returnApi'
import { saleApi } from './saleApi'
import type {
  ReturnReason,
  RefundMethod,
  StockAction,
  ItemCondition,
  SaleItemForReturn,
} from '@/types/return'
import {
  RETURN_REASON_LABELS,
  REFUND_METHOD_LABELS,
  STOCK_ACTION_LABELS,
  ITEM_CONDITION_LABELS,
  CONDITION_ALLOWED_ACTIONS,
  DEFAULT_STOCK_ACTION_FOR_CONDITION,
  CONDITION_DESCRIPTIONS,
} from '@/types/return'
import { Layout } from '@/components/Layout'
import { Button, Card, Input, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

const REASONS = Object.entries(RETURN_REASON_LABELS) as [ReturnReason, string][]
const METHODS = Object.entries(REFUND_METHOD_LABELS) as [RefundMethod, string][]
const STOCK_ACTIONS_LIST = Object.entries(STOCK_ACTION_LABELS) as [StockAction, string][]
const CONDITIONS = Object.entries(ITEM_CONDITION_LABELS) as [ItemCondition, string][]

interface FoundSale {
  id: string
  sale_number: string
  total: number
  status: string
}

interface SelectedItem {
  id: string
  product_id: string
  product_name: string
  sku: string
  unit: string
  unit_price: number
  available_qty: number
  qty: number
  condition: ItemCondition
}

// Загальний condition для всіх позицій (спрощення для MVP)

export default function ReturnForm() {
  const [step, setStep] = useState(1)
  const [saleNumber, setSaleNumber] = useState('')
  const [found, setFound] = useState<FoundSale | null>(null)
  const [saleItems, setSaleItems] = useState<SaleItemForReturn[]>([])
  const [selected, setSelected] = useState<SelectedItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [searching, setSearching] = useState(false)

  const [reason, setReason] = useState<ReturnReason>('defective')
  const [reasonNote, setReasonNote] = useState('')
  const [method, setMethod] = useState<RefundMethod>('cash')

  // Condition — глобальний для всіх позицій (спрощення)
  const [globalCondition, setGlobalCondition] = useState<ItemCondition>('good')

  // Stock action — синхронізується з condition
  const [stockAction, setStockAction] = useState<StockAction>('return_to_stock')

  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  // Коли змінюється condition — автопідбираємо stock_action
  useEffect(() => {
    const allowed = CONDITION_ALLOWED_ACTIONS[globalCondition] ?? []
    const defaultAction = DEFAULT_STOCK_ACTION_FOR_CONDITION[globalCondition] ?? 'return_to_stock'

    // Якщо поточний stock_action не дозволений для нового condition — міняємо на дефолтний
    if (!allowed.includes(stockAction)) {
      setStockAction(defaultAction)
    }
  }, [globalCondition])

  const activeItems = selected.filter((i) => i.qty > 0)
  const totalRefund = activeItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const hasSelection = activeItems.length > 0

  // Дозволені stock_action для поточного condition
  const allowedStockActions = CONDITION_ALLOWED_ACTIONS[globalCondition] ?? []
  const filteredStockActions = STOCK_ACTIONS_LIST.filter(
    ([val]) => allowedStockActions.includes(val),
  )

  // Step 1: search sale
  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!saleNumber.trim()) return

    setSearching(true)
    setFound(null)
    setSaleItems([])
    setSelected([])
    setStep(1)

    try {
      const result = await saleApi.list({ sale_number: saleNumber.trim() })
      const sales = (result as unknown as { data: FoundSale[] }).data ?? []
      const sale = sales[0] ?? null
      if (!sale) {
        toast.error('Чек не знайдено')
        return
      }
      setFound(sale)

      setLoadingItems(true)
      const itemsResult = await returnApi.getSaleItems(sale.id)
      const data = itemsResult.data
      setSaleItems(data.items)

      const initSelected: SelectedItem[] = data.items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        product_name: item.product_name,
        sku: item.sku,
        unit: item.unit,
        unit_price: item.unit_price,
        available_qty: item.available_qty,
        qty: 0,
        condition: 'good' as ItemCondition,
      }))
      setSelected(initSelected)
      setStep(2)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка пошуку чека')
    } finally {
      setSearching(false)
      setLoadingItems(false)
    }
  }

  function updateQty(id: string, qty: number) {
    setSelected((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item
        const clamped = Math.max(0, Math.min(qty, item.available_qty))
        return { ...item, qty: clamped }
      })
    )
  }

  function toggleSelectAll(val: boolean) {
    setSelected((prev) =>
      prev.map((item) => ({
        ...item,
        qty: val ? item.available_qty : 0,
      }))
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!found || !hasSelection) return

    if (reason === 'other' && !reasonNote.trim()) {
      toast.error('Уточніть причину')
      return
    }

    setSubmitting(true)
    try {
      await returnApi.create({
        sale_id: found.id,
        reason,
        reason_note: reasonNote || null,
        refund_method: method,
        stock_action: stockAction,
        items: activeItems.map((i) => ({
          sale_item_id: i.id,
          product_id: i.product_id,
          quantity: i.qty,
          condition: globalCondition,
        })),
      })
      toast.success('Повернення оформлено')
      setDone(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка оформлення повернення')
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    setDone(false)
    setFound(null)
    setSaleItems([])
    setSelected([])
    setSaleNumber('')
    setReason('defective')
    setReasonNote('')
    setMethod('cash')
    setGlobalCondition('good')
    setStockAction('return_to_stock')
    setStep(1)
  }

  // ===== DONE STATE =====
  if (done) {
    return (
      <Layout title="Повернення">
        <Card className="max-w-md text-center py-10 mx-auto">
          <RotateCcw size={40} className="text-green-500 mx-auto mb-3" />
          <p className="text-lg font-semibold text-gray-900 mb-1">Повернення оформлено</p>
          <p className="text-gray-500 text-sm mb-2">
            {'Повернуто позицій: ' + activeItems.length + ', сума: ' + formatMoney(totalRefund)}
          </p>
          <p className="text-gray-500 text-sm mb-2">
            {ITEM_CONDITION_LABELS[globalCondition] + ' → ' + STOCK_ACTION_LABELS[stockAction]}
          </p>
          <p className="text-gray-500 text-sm mb-6">
            {REFUND_METHOD_LABELS[method]}
          </p>
          <Button onClick={reset}>Нове повернення</Button>
        </Card>
      </Layout>
    )
  }

  // ===== MAIN FORM =====
  return (
    <Layout title="Оформити повернення">
      <div className="max-w-3xl space-y-4">

        {/* STEP 1: Search sale */}
        <Card>
          <h3 className="font-semibold text-gray-800 mb-3">Крок 1 — Знайдіть чек</h3>
          <form onSubmit={handleSearch} className="flex gap-3">
            <Input
              value={saleNumber}
              onChange={(e) => setSaleNumber(e.target.value)}
              placeholder="Номер чека (напр. 000001)"
              className="flex-1"
              autoFocus
            />
            <Button type="submit" loading={searching} variant="secondary">
              <Search size={16} />
              Знайти
            </Button>
          </form>

          {found && (
            <div
              className={
                'mt-3 rounded-xl px-4 py-3 border text-sm font-medium ' +
                (found.status === 'returned'
                  ? 'bg-red-50 border-red-200 text-red-700'
                  : 'bg-blue-50 border-blue-200 text-blue-700')
              }
            >
              {found.status === 'returned'
                ? '⛔ Цей чек вже повернуто'
                : 'Чек #' + found.sale_number + ' — сума: ' + formatMoney(found.total) + ' (' + saleItems.length + ' поз.)'}
            </div>
          )}
        </Card>

        {/* STEP 2: Select items */}
        {step >= 2 && found && found.status !== 'returned' && (
          <Card>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-800">Крок 2 — Виберіть товари для повернення</h3>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => toggleSelectAll(true)}>Всі</Button>
                <Button size="sm" variant="ghost" onClick={() => toggleSelectAll(false)}>Скасувати</Button>
              </div>
            </div>

            {loadingItems ? (
              <p className="text-gray-400 text-sm text-center py-4">Завантаження...</p>
            ) : selected.length === 0 ? (
              <div className="text-center py-6 text-gray-400">
                <Package size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Всі позиції вже повернуто</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {selected.map((item) => {
                  const origItem = saleItems.find((si) => si.id === item.id)
                  const alreadyReturned = origItem?.already_returned_qty ?? 0
                  const isFullyReturned = item.available_qty <= 0
                  return (
                    <div
                      key={item.id}
                      className={
                        'flex items-center gap-3 p-3 rounded-xl border ' +
                        (item.qty > 0
                          ? 'bg-yellow-50 border-yellow-300'
                          : isFullyReturned
                            ? 'bg-gray-50 border-gray-200 opacity-50'
                            : 'border-gray-200 hover:border-gray-300')
                      }
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{item.product_name}</p>
                        <p className="text-xs text-gray-400">
                          {item.sku + ' | ' + formatMoney(item.unit_price) + ' / ' + item.unit}
                        </p>
                        {alreadyReturned > 0 && (
                          <p className="text-xs text-orange-500">
                            {'Вже повернуто: ' + alreadyReturned + ' ' + item.unit}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {!isFullyReturned && (
                          <>
                            <input
                              type="number"
                              min="0"
                              max={item.available_qty}
                              value={item.qty}
                              onChange={(e) => updateQty(item.id, parseInt(e.target.value) || 0)}
                              className="w-16 px-2 py-1 text-sm text-center border border-gray-200 rounded-lg"
                            />
                            <span className="text-xs text-gray-400">{'/' + item.available_qty}</span>
                          </>
                        )}
                        {isFullyReturned && (
                          <Badge color="gray">Повернуто</Badge>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {hasSelection && (
              <div className="mt-3 flex items-center gap-3">
                <Button size="sm" variant="ghost" onClick={() => setStep(3)}>
                  {'Далі: Причина і оплата (' + activeItems.length + ' поз.)'}
                </Button>
                <span className="text-sm font-semibold text-gray-700">
                  {'Сума: ' + formatMoney(totalRefund)}
                </span>
              </div>
            )}
          </Card>
        )}

        {/* STEP 3: Reason + condition + stock_action + method */}
        {step >= 3 && hasSelection && (
          <form onSubmit={handleSubmit}>
            <Card className="space-y-5">
              <h3 className="font-semibold text-gray-800">Крок 3 — Причина та умови</h3>

              {/* Reason */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Причина повернення *</label>
                <div className="grid grid-cols-2 gap-2">
                  {REASONS.map(([value, label]) => (
                    <label
                      key={value}
                      className={
                        'flex items-center gap-2 p-3 rounded-xl border cursor-pointer transition-colors text-sm ' +
                        (reason === value
                          ? 'bg-yellow-50 border-yellow-400'
                          : 'border-gray-200 hover:border-gray-300')
                      }
                    >
                      <input
                        type="radio"
                        name="reason"
                        value={value}
                        checked={reason === value}
                        onChange={() => setReason(value)}
                        className="accent-yellow-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {reason === 'other' && (
                <Input
                  label="Уточніть причину *"
                  value={reasonNote}
                  onChange={(e) => setReasonNote(e.target.value)}
                  placeholder="Опишіть причину..."
                  required
                />
              )}

              {/* Condition — СТАН ТОВАРУ */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Стан товару *</label>
                <div className="space-y-2">
                  {CONDITIONS.map(([value, label]) => {
                    const isDefective = value === 'defective'
                    return (
                      <label
                        key={value}
                        className={
                          'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ' +
                          (globalCondition === value
                            ? 'bg-yellow-50 border-yellow-400'
                            : 'border-gray-200 hover:border-gray-300')
                        }
                      >
                        <input
                          type="radio"
                          name="condition"
                          value={value}
                          checked={globalCondition === value}
                          onChange={() => setGlobalCondition(value as ItemCondition)}
                          className="accent-yellow-500 mt-0.5"
                        />
                        <div>
                          <span className={
                            'text-sm font-medium ' + (isDefective ? 'text-red-600' : 'text-gray-800')
                          }>
                            {label}
                          </span>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {CONDITION_DESCRIPTIONS[value]}
                          </p>
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>

              {/* Stock action — ЩО РОБИТИ З ТОВАРОМ (фільтрується за condition) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {'Що робити з товаром *'}
                </label>
                {globalCondition === 'defective' && (
                  <div className="flex items-center gap-2 mb-2 text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">
                    <Info size={14} />
                    {'Брак не можна повернути на склад. Вибір обмежено.'}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {filteredStockActions.map(([value, label]) => {
                    const isWriteOff = value === 'write_off'
                    return (
                      <label
                        key={value}
                        className={
                          'flex items-center gap-2 px-3 py-2 rounded-xl border cursor-pointer transition-colors text-sm ' +
                          (stockAction === value
                            ? 'bg-yellow-50 border-yellow-400'
                            : 'border-gray-200 hover:border-gray-300')
                        }
                      >
                        <input
                          type="radio"
                          name="stock_action"
                          value={value}
                          checked={stockAction === value}
                          onChange={() => setStockAction(value as StockAction)}
                          className="accent-yellow-500"
                        />
                        <span className={isWriteOff ? 'text-red-600' : ''}>{label}</span>
                      </label>
                    )
                  })}
                </div>
              </div>

              {/* Refund method */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Повернення коштів *</label>
                <div className="grid grid-cols-2 gap-2">
                  {METHODS.map(([value, label]) => (
                    <label
                      key={value}
                      className={
                        'flex items-center gap-2 p-3 rounded-xl border cursor-pointer transition-colors text-sm ' +
                        (method === value
                          ? 'bg-yellow-50 border-yellow-400'
                          : 'border-gray-200 hover:border-gray-300')
                      }
                    >
                      <input
                        type="radio"
                        name="method"
                        value={value}
                        checked={method === value}
                        onChange={() => setMethod(value)}
                        className="accent-yellow-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {/* Підсумок */}
              <div className="bg-gray-50 rounded-xl p-4 text-sm space-y-1">
                <p className="text-gray-600">
                  {'Стан: ' + ITEM_CONDITION_LABELS[globalCondition]}
                </p>
                <p className="text-gray-600">
                  {'Дія: ' + STOCK_ACTION_LABELS[stockAction]}
                </p>
                <p className="text-gray-600">
                  {'Повернення: ' + REFUND_METHOD_LABELS[method]}
                </p>
              </div>

              {/* Submit */}
              <div className="flex items-center justify-between pt-2">
                <Button type="button" variant="ghost" onClick={() => setStep(2)}>
                  Назад до вибору позицій
                </Button>
                <Button type="submit" loading={submitting} icon={<RotateCcw size={16} />} size="lg">
                  {'Оформити повернення на ' + formatMoney(totalRefund)}
                </Button>
              </div>
            </Card>
          </form>
        )}

        {/* Fully returned notice */}
        {found && found.status === 'returned' && (
          <Card padding="sm">
            <div className="flex items-center gap-3 text-red-600">
              <AlertTriangle size={20} />
              <span className="text-sm font-medium">
                Цей чек вже повністю повернуто.
              </span>
            </div>
          </Card>
        )}
      </div>
    </Layout>
  )
}