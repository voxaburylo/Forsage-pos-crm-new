import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
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
import { useAuthStore } from '@/stores/authStore'
import { parseFiscalIntentUnknown, type FiscalIntentUnknown } from './fiscalSale'
import { formatMoney } from '@/lib/utils'
import {
  desktopBridge,
  type DesktopUnresolvedFiscalReturnIntent,
} from '@/lib/desktopBridge'
import { usePOSBarcodeScanner } from './usePOSBarcodeScanner'

const REASONS = Object.entries(RETURN_REASON_LABELS) as [ReturnReason, string][]
const METHODS = Object.entries(REFUND_METHOD_LABELS) as [RefundMethod, string][]
const STOCK_ACTIONS_LIST = Object.entries(STOCK_ACTION_LABELS) as [StockAction, string][]
const CONDITIONS = Object.entries(ITEM_CONDITION_LABELS) as [ItemCondition, string][]

function normalizeBarcode(value: string) {
  return value.replace(/\s/g, '').trim()
}

function looksLikeProductBarcode(value: string) {
  const code = normalizeBarcode(value)
  return /^\d{5,}$/.test(code) || (code.length >= 6 && /^[A-Za-z0-9._/-]+$/.test(code) && /\d/.test(code))
}

interface FoundSale {
  id: string
  sale_number: string
  total: number
  status: string
  completed_at?: string
  customer?: { full_name?: string | null; phone?: string } | null
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
  const [candidates, setCandidates] = useState<FoundSale[]>([])
  const [candidateHint, setCandidateHint] = useState('')
  const [saleItems, setSaleItems] = useState<SaleItemForReturn[]>([])
  const [selected, setSelected] = useState<SelectedItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [searching, setSearching] = useState(false)

  const [reason, setReason] = useState<ReturnReason>('defective')
  const [reasonNote, setReasonNote] = useState('')
  const [method, setMethod] = useState<RefundMethod>('cash')

  // Condition — глобальний для всіх позицій (спрощення)
  const returnAttemptRef = useRef<{ fingerprint: string; operationId: string } | null>(null)
  const [fiscalRecovery, setFiscalRecovery] = useState<FiscalIntentUnknown | null>(null)
  const [fiscalRecoveryText, setFiscalRecoveryText] = useState('')
  const [resolvingFiscal, setResolvingFiscal] = useState(false)
  const [unresolvedReturns, setUnresolvedReturns] = useState<DesktopUnresolvedFiscalReturnIntent[]>([])
  const [selectedUnresolvedId, setSelectedUnresolvedId] = useState<string | null>(null)
  const [startupRecoveryText, setStartupRecoveryText] = useState('')
  const [startupRecoveryBusy, setStartupRecoveryBusy] = useState(false)
  const [startupRecoveryLoading, setStartupRecoveryLoading] = useState(false)
  const [globalCondition, setGlobalCondition] = useState<ItemCondition>('good')

  // Stock action — синхронізується з condition
  const [stockAction, setStockAction] = useState<StockAction>('return_to_stock')

  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  // Фіскальний номер оригінального чека (якщо продаж був через ПРРО)
  const session = useAuthStore((state) => state.session)
  const [saleFiscalNumber, setSaleFiscalNumber] = useState<string | null>(null)
  // Фіскальний номер чека повернення (після FiscalizeReturnCheck)
  const [returnFiscalNumber, setReturnFiscalNumber] = useState<string | null>(null)
  const [searchParams] = useSearchParams()

  // Коли змінюється condition — автопідбираємо stock_action
  useEffect(() => {
    const allowed = CONDITION_ALLOWED_ACTIONS[globalCondition] ?? []
    const defaultAction = DEFAULT_STOCK_ACTION_FOR_CONDITION[globalCondition] ?? 'return_to_stock'

    // Якщо поточний stock_action не дозволений для нового condition — міняємо на дефолтний
    if (!allowed.includes(stockAction)) {
      setStockAction(defaultAction)
    }
  }, [globalCondition])

  useEffect(() => {
    const desktop = desktopBridge()
    const cashierId = session?.user?.id
    if (!desktop || !cashierId) return
    let cancelled = false
    setStartupRecoveryLoading(true)
    desktop.fiscal.listUnresolvedReturns({ cashier_id: cashierId })
      .then((items) => {
        if (cancelled) return
        setUnresolvedReturns(items)
        setSelectedUnresolvedId((current) => (
          current && items.some((item) => item.operation_id === current)
            ? current
            : items[0]?.operation_id ?? null
        ))
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(error instanceof Error
            ? error.message
            : 'Не вдалося перевірити незавершені фіскальні повернення')
        }
      })
      .finally(() => {
        if (!cancelled) setStartupRecoveryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [session?.user?.id])

  const activeItems = selected.filter((i) => i.qty > 0)
  const totalRefund = activeItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const hasSelection = activeItems.length > 0
  const selectedUnresolvedReturn = unresolvedReturns.find(
    (item) => item.operation_id === selectedUnresolvedId,
  ) ?? unresolvedReturns[0] ?? null

  // Дозволені stock_action для поточного condition
  const allowedStockActions = CONDITION_ALLOWED_ACTIONS[globalCondition] ?? []
  const filteredStockActions = STOCK_ACTIONS_LIST.filter(
    ([val]) => allowedStockActions.includes(val),
  )

  // Step 1: search sale
  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    searchSale(saleNumber)
  }

  async function searchSale(num: string, options: { preferProductBarcode?: boolean } = {}) {
    const q = num.trim()
    if (!q) return

    setSearching(true)
    setFound(null)
    setSaleItems([])
    setSelected([])
    setCandidates([])
    setCandidateHint('')
    setSaleFiscalNumber(null)
    setStep(1)

    try {
      const barcode = normalizeBarcode(q)
      const barcodeFirst = options.preferProductBarcode || looksLikeProductBarcode(q)
      const requests: Array<{ params: Record<string, string | number>; hint: string }> = barcodeFirst
        ? [
            { params: { product_barcode: barcode, status: 'completed', per_page: 12 }, hint: 'Знайдено останні чеки з цим товаром — оберіть потрібний:' },
            { params: { search: q, per_page: 12 }, hint: 'Знайдено чеків — оберіть потрібний:' },
          ]
        : [
            { params: { search: q, per_page: 12 }, hint: 'Знайдено чеків — оберіть потрібний:' },
            { params: { product_barcode: barcode, status: 'completed', per_page: 12 }, hint: 'Знайдено останні чеки з цим товаром — оберіть потрібний:' },
          ]

      let sales: FoundSale[] = []
      let hint = ''
      for (const req of requests) {
        if (!req.params.product_barcode && !req.params.search) continue
        const result = await saleApi.list(req.params, { silent: true })
        sales = (result as unknown as { data: FoundSale[] }).data ?? []
        hint = req.hint
        if (sales.length > 0) break
      }

      if (sales.length === 0) {
        toast.error('Нічого не знайдено (чек / телефон / ім\'я / штрихкод товару)')
        return
      }
      if (sales.length > 1) {
        setCandidateHint(hint)
        setCandidates(sales)   // кілька чеків — даємо обрати
        return
      }
      await selectSale(sales[0])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка пошуку чека')
    } finally {
      setSearching(false)
    }
  }

  usePOSBarcodeScanner({
    onScan: (code) => {
      setSaleNumber(code)
      searchSale(code, { preferProductBarcode: true })
    },
  })

  async function selectSale(sale: FoundSale) {
    setFound(sale)
    setCandidates([])
    try {
      setLoadingItems(true)
      const itemsResult = await returnApi.getSaleItems(sale.id)
      const data = itemsResult.data
      setSaleItems(data.items)
      setSaleFiscalNumber(data.sale.fiscal_number ?? null)
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
      toast.error(err instanceof Error ? err.message : 'Помилка завантаження чека')
    } finally {
      setLoadingItems(false)
    }
  }

  // Авто-пошук, якщо прийшли з картки продажу (/returns?sale=НОМЕР)
  useEffect(() => {
    const presale = searchParams.get('sale')
    if (presale) {
      setSaleNumber(presale)
      searchSale(presale)
    }
  }, [])

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

    const returnBody = {
      sale_id: found.id,
      reason,
      reason_note: reasonNote || null,
      refund_method: method,
      stock_action: stockAction,
      fiscal_number: null,
      items: activeItems.map((item) => ({
        sale_item_id: item.id,
        product_id: item.product_id,
        quantity: item.qty,
        condition: globalCondition,
      })),
    }
    const fingerprint = JSON.stringify({
      ...returnBody,
      fiscal_number: undefined,
    })
    if (returnAttemptRef.current?.fingerprint !== fingerprint) {
      returnAttemptRef.current = {
        fingerprint,
        operationId: crypto.randomUUID(),
      }
    }
    const operationId = returnAttemptRef.current.operationId

    setSubmitting(true)
    try {
      let fiscalReturnNum: string | null = null
      const desktop = desktopBridge()
      const requiresFiscalReturn = Boolean(
        desktop && saleFiscalNumber && (method === 'cash' || method === 'terminal'),
      )

      if (requiresFiscalReturn && desktop && saleFiscalNumber) {
        const config = await desktop.fiscal.getConfig().catch(() => null)
        if (!config?.enabled) {
          toast.error('Оригінальний чек фіскальний. Увімкніть і налаштуйте Cashalot для повернення')
          return
        }
        const approvedBy = session?.user?.id ?? 'local'
        const shift = await desktop.pos.getOpenShift(approvedBy)
        const fiscalItems = activeItems.map((item) => ({
          name: item.product_name,
          vendor_code: item.sku || item.product_name,
          unit: item.unit,
          qty: item.qty,
          unit_price: item.unit_price,
          amount: item.qty * item.unit_price,
        }))
        const response = await desktop.fiscal.fiscalizeReturn({
          operation_id: operationId,
          return_input: {
            ...returnBody,
            approved_by: approvedBy,
            shift_id: shift?.id ?? null,
            client_operation_id: operationId,
            is_fiscal: true,
          },
          items: fiscalItems,
          pay: {
            cash: method === 'cash' ? totalRefund : 0,
            card: method === 'terminal' ? totalRefund : 0,
            check_total: totalRefund,
          },
          original_fiscal_number: saleFiscalNumber,
        })
        const fiscalResult = response.intent.fiscal_result
        fiscalReturnNum = fiscalResult?.ReceiptFiscalNum
          || fiscalResult?.ReceiptLocalNum
          || response.data?.fiscal_number
          || null
        if (fiscalResult?.OfflineMode) {
          toast.warning('ПРРО в режимі офлайн — чек повернення буде дореєстровано автоматично')
        }
        window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      } else {
        const result = await returnApi.create(returnBody, operationId)
        fiscalReturnNum = result.data?.fiscal_number ?? null
      }

      returnAttemptRef.current = null
      setFiscalRecovery(null)
      setReturnFiscalNumber(fiscalReturnNum)
      toast.success('Повернення оформлено')
      setDone(true)
    } catch (err) {
      const recovery = parseFiscalIntentUnknown(err)
      if (recovery) {
        setFiscalRecovery(recovery)
        toast.error('Не повторюйте повернення: спочатку перевірте чек у Cashalot')
      } else {
        toast.error(err instanceof Error ? err.message : 'Помилка оформлення повернення')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function refreshUnresolvedReturns(preferredOperationId?: string) {
    const desktop = desktopBridge()
    const cashierId = session?.user?.id
    if (!desktop || !cashierId) return
    const items = await desktop.fiscal.listUnresolvedReturns({ cashier_id: cashierId })
    setUnresolvedReturns(items)
    setSelectedUnresolvedId((current) => {
      const preferred = preferredOperationId ?? current
      return preferred && items.some((item) => item.operation_id === preferred)
        ? preferred
        : items[0]?.operation_id ?? null
    })
  }

  async function resumeUnresolvedReturn(intent: DesktopUnresolvedFiscalReturnIntent) {
    const desktop = desktopBridge()
    const cashierId = session?.user?.id
    if (!desktop || !cashierId) {
      toast.error('Відновлення доступне лише авторизованому касиру в локальній програмі')
      return
    }
    setStartupRecoveryBusy(true)
    try {
      const result = await desktop.fiscal.resumeReturn(intent.operation_id, {
        cashier_id: cashierId,
      })
      if (result.intent.state !== 'completed') {
        throw new Error('Повернення ще не завершено')
      }
      window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
      toast.success(
        intent.state === 'fiscalized'
          ? 'Фіскальне повернення безпечно збережено у локальній базі'
          : 'Повернення продовжено та завершено',
      )
      setStartupRecoveryText('')
      await refreshUnresolvedReturns()
    } catch (error) {
      const recovery = parseFiscalIntentUnknown(error)
      toast.error(recovery
        ? 'Не повторюйте повернення. Перевірте його результат у Cashalot'
        : error instanceof Error
          ? error.message
          : 'Не вдалося продовжити повернення')
      await refreshUnresolvedReturns(intent.operation_id).catch(() => undefined)
    } finally {
      setStartupRecoveryBusy(false)
    }
  }

  async function resolveStartupUnknownReturn(intent: DesktopUnresolvedFiscalReturnIntent) {
    const desktop = desktopBridge()
    const cashierId = session?.user?.id
    if (!desktop || !cashierId) {
      toast.error('Розблокування доступне лише авторизованому касиру')
      return
    }
    setStartupRecoveryBusy(true)
    try {
      await desktop.fiscal.resolveUnknownReturn(intent.operation_id, {
        cashier_id: cashierId,
        cashalot_checked: true,
        confirmed_by: cashierId,
        reason: 'Касир перевірив Cashalot і підтвердив, що чек повернення не зареєстровано',
      })
      setStartupRecoveryText('')
      toast.success('Результат перевірено. Тепер повернення можна безпечно продовжити')
      await refreshUnresolvedReturns(intent.operation_id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося розблокувати повернення')
    } finally {
      setStartupRecoveryBusy(false)
    }
  }

  async function cancelPreparedReturn(intent: DesktopUnresolvedFiscalReturnIntent) {
    const desktop = desktopBridge()
    const cashierId = session?.user?.id
    if (!desktop || !cashierId || intent.state !== 'prepared') return
    const confirmed = window.confirm(
      'Скасувати підготовлене повернення? Воно ще не передавалося у Cashalot. Ця дія не змінить гроші та залишки.',
    )
    if (!confirmed) return
    setStartupRecoveryBusy(true)
    try {
      await desktop.fiscal.cancelPreparedReturn(intent.operation_id, {
        cashier_id: cashierId,
        confirmed_by: cashierId,
        reason: 'Касир скасував підготовлене повернення до передачі у Cashalot',
      })
      setStartupRecoveryText('')
      toast.success('Підготовлене повернення скасовано. Гроші та залишки не змінювалися')
      await refreshUnresolvedReturns()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося скасувати повернення')
      await refreshUnresolvedReturns(intent.operation_id).catch(() => undefined)
    } finally {
      setStartupRecoveryBusy(false)
    }
  }

  async function resolveFiscalReturnRecovery() {
    if (!fiscalRecovery) return
    const desktop = desktopBridge()
    const confirmedBy = session?.user?.id
    if (!desktop || !confirmedBy) {
      toast.error('Розблокування доступне лише авторизованому касиру в локальній програмі')
      return
    }
    setResolvingFiscal(true)
    try {
      await desktop.fiscal.resolveUnknownReturn(fiscalRecovery.operationId, {
        cashier_id: confirmedBy,
        cashalot_checked: true,
        confirmed_by: confirmedBy,
        reason: 'Касир перевірив Cashalot і підтвердив, що чек повернення не зареєстровано',
      })
      setFiscalRecovery(null)
      setFiscalRecoveryText('')
      toast.success('Повернення розблоковано. Тепер можна повторити його оформлення')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося розблокувати повернення')
    } finally {
      setResolvingFiscal(false)
    }
  }

  function reset() {
    setDone(false)
    returnAttemptRef.current = null
    setFiscalRecovery(null)
    setFiscalRecoveryText('')
    setFound(null)
    setSaleItems([])
    setSelected([])
    setSaleNumber('')
    setReason('defective')
    setReasonNote('')
    setMethod('cash')
    setGlobalCondition('good')
    setStockAction('return_to_stock')
    setSaleFiscalNumber(null)
    setReturnFiscalNumber(null)
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
          <p className="text-gray-500 text-sm mb-2">
            {REFUND_METHOD_LABELS[method]}
          </p>
          {returnFiscalNumber && (
            <p className="text-gray-500 text-sm mb-2">
              {'Фіскальний чек повернення: ' + returnFiscalNumber}
            </p>
          )}
          <div className="mb-4" />
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
              placeholder="Номер чека, телефон, ім'я або штрихкод товару"
              className="flex-1"
              autoFocus
            />
            <Button type="submit" loading={searching} variant="secondary">
              <Search size={16} />
              Знайти
            </Button>
          </form>

          {candidates.length > 0 && (
            <div className="mt-3 border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">
              <p className="px-4 py-2 text-xs text-gray-500 bg-gray-50">{candidateHint || ('Знайдено ' + candidates.length + ' чеків — оберіть потрібний:')}</p>
              {candidates.map((c) => (
                <button key={c.id} type="button" onClick={() => selectSale(c)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-yellow-50 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-mono font-semibold text-yellow-700">#{c.sale_number}</span>
                    {c.customer?.full_name ? ` · ${c.customer.full_name}` : c.customer?.phone ? ` · ${c.customer.phone}` : ''}
                    {c.completed_at ? ` · ${new Date(c.completed_at).toLocaleDateString('uk-UA')}` : ''}
                  </span>
                  <span className="font-semibold text-gray-700 shrink-0">{formatMoney(c.total)}</span>
                </button>
              ))}
            </div>
          )}

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
      {startupRecoveryLoading && unresolvedReturns.length === 0 && (
        <div className="fixed bottom-5 right-5 z-[110] rounded-xl bg-gray-900 px-4 py-3 text-sm text-white shadow-xl">
          Перевіряємо незавершені повернення…
        </div>
      )}
      {selectedUnresolvedReturn && (
        <div
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/80 p-3 sm:p-5"
          role="dialog"
          aria-modal="true"
          aria-labelledby="unresolved-return-title"
        >
          <div className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-amber-300 bg-white p-4 shadow-2xl sm:p-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 shrink-0 text-amber-600" size={24} />
              <div>
                <h2 id="unresolved-return-title" className="text-xl font-bold text-gray-900">
                  Є незавершене фіскальне повернення
                </h2>
                <p className="mt-1 text-sm leading-6 text-gray-600">
                  Програма відновила операцію після перезапуску. Виберіть її та завершіть
                  безпечну дію — повторного списання грошей або зміни залишків не буде.
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.4fr)]">
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl bg-gray-50 p-2">
                {unresolvedReturns.map((intent) => {
                  const selectedIntent = intent.operation_id === selectedUnresolvedReturn.operation_id
                  const stateLabel = intent.state === 'prepared'
                    ? 'Підготовлено'
                    : intent.state === 'fiscalized'
                      ? 'Чек уже зареєстровано'
                      : 'Результат невідомий'
                  return (
                    <button
                      key={intent.operation_id}
                      type="button"
                      onClick={() => {
                        setSelectedUnresolvedId(intent.operation_id)
                        setStartupRecoveryText('')
                      }}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        selectedIntent
                          ? 'border-amber-500 bg-amber-50'
                          : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <span className="block font-semibold text-gray-900">
                        {intent.sale_number ? `Чек ${intent.sale_number}` : 'Повернення'}
                      </span>
                      <span className="mt-1 block text-xs font-medium text-amber-700">
                        {stateLabel}
                      </span>
                      <span className="mt-1 block text-sm text-gray-600">
                        {formatMoney(intent.refund_kopecks)} · {intent.item_count} поз.
                      </span>
                    </button>
                  )
                })}
              </div>

              <div className="rounded-xl border border-gray-200 p-4">
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <p>
                    <span className="text-gray-500">Продаж:</span>{' '}
                    <strong>{selectedUnresolvedReturn.sale_number ?? 'номер недоступний'}</strong>
                  </p>
                  <p>
                    <span className="text-gray-500">Сума:</span>{' '}
                    <strong>{formatMoney(selectedUnresolvedReturn.refund_kopecks)}</strong>
                  </p>
                  <p>
                    <span className="text-gray-500">Спосіб:</span>{' '}
                    <strong>
                      {REFUND_METHOD_LABELS[selectedUnresolvedReturn.refund_method as RefundMethod]
                        ?? selectedUnresolvedReturn.refund_method}
                    </strong>
                  </p>
                  <p>
                    <span className="text-gray-500">Створено:</span>{' '}
                    <strong>{new Date(selectedUnresolvedReturn.created_at).toLocaleString('uk-UA')}</strong>
                  </p>
                </div>
                <p className="mt-3 break-all rounded-lg bg-gray-50 p-2 text-xs text-gray-500">
                  Операція: {selectedUnresolvedReturn.operation_id}
                </p>

                {selectedUnresolvedReturn.state === 'prepared' && (
                  <div className="mt-5 space-y-3">
                    <p className="rounded-xl bg-blue-50 p-3 text-sm leading-6 text-blue-800">
                      Повернення ще не надсилалося у Cashalot. Його можна продовжити або
                      скасувати без зміни грошей і складських залишків.
                    </p>
                    <button
                      type="button"
                      disabled={startupRecoveryBusy}
                      onClick={() => resumeUnresolvedReturn(selectedUnresolvedReturn)}
                      className="w-full rounded-xl bg-yellow-400 px-4 py-3 font-bold text-black disabled:opacity-40"
                    >
                      {startupRecoveryBusy ? 'Зачекайте…' : 'Продовжити повернення'}
                    </button>
                    <button
                      type="button"
                      disabled={startupRecoveryBusy || !selectedUnresolvedReturn.can_cancel}
                      onClick={() => cancelPreparedReturn(selectedUnresolvedReturn)}
                      className="w-full rounded-xl border border-red-300 px-4 py-3 font-semibold text-red-700 disabled:opacity-40"
                    >
                      Скасувати підготовлене повернення
                    </button>
                  </div>
                )}

                {selectedUnresolvedReturn.state === 'fiscalized' && (
                  <div className="mt-5 space-y-3">
                    <p className="rounded-xl bg-green-50 p-3 text-sm leading-6 text-green-800">
                      Чек повернення вже зареєстровано у Cashalot. Програма тільки дозапише
                      його у локальну базу — повторного звернення до ПРРО не буде.
                    </p>
                    <button
                      type="button"
                      disabled={startupRecoveryBusy}
                      onClick={() => resumeUnresolvedReturn(selectedUnresolvedReturn)}
                      className="w-full rounded-xl bg-green-600 px-4 py-3 font-bold text-white disabled:opacity-40"
                    >
                      {startupRecoveryBusy ? 'Завершуємо…' : 'Завершити локальне збереження'}
                    </button>
                  </div>
                )}

                {(selectedUnresolvedReturn.state === 'unknown'
                  || selectedUnresolvedReturn.state === 'fiscalizing') && (
                  <div className="mt-5">
                    <p className="rounded-xl bg-red-50 p-3 text-sm leading-6 text-red-800">
                      Не повторюйте і не скасовуйте повернення. Спочатку відкрийте Cashalot
                      та перевірте, чи існує чек повернення.
                      {selectedUnresolvedReturn.last_error
                        ? ` Причина зупинки: ${selectedUnresolvedReturn.last_error}`
                        : ''}
                    </p>
                    <p className="mt-4 text-sm font-semibold text-gray-900">
                      Якщо чека в Cashalot немає, введіть «ЧЕКА НЕМАЄ»
                    </p>
                    <input
                      autoFocus
                      value={startupRecoveryText}
                      onChange={(event) => setStartupRecoveryText(event.target.value)}
                      placeholder="ЧЕКА НЕМАЄ"
                      className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-yellow-500"
                    />
                    <button
                      type="button"
                      disabled={startupRecoveryBusy
                        || startupRecoveryText.trim().toUpperCase() !== 'ЧЕКА НЕМАЄ'}
                      onClick={() => resolveStartupUnknownReturn(selectedUnresolvedReturn)}
                      className="mt-3 w-full rounded-xl bg-yellow-400 px-4 py-3 font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {startupRecoveryBusy
                        ? 'Зберігаємо перевірку…'
                        : 'Я перевірив: чека немає'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {fiscalRecovery && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-2xl border border-red-400 bg-white p-6 shadow-2xl">
            <h2 className="text-xl font-bold text-red-700">Не повторюйте повернення</h2>
            <p className="mt-3 text-sm leading-6 text-gray-700">
              Перевірте в Cashalot, чи був створений чек повернення. Автоматичний повтор
              заблоковано, щоб клієнт не отримав гроші двічі.
            </p>
            <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
              {fiscalRecovery.message}
            </p>
            <p className="mt-2 break-all text-xs text-gray-500">
              Операція: {fiscalRecovery.operationId}
            </p>
            <p className="mt-5 text-sm font-semibold text-gray-900">
              Якщо чека повернення в Cashalot немає, введіть «ЧЕКА НЕМАЄ»
            </p>
            <input
              autoFocus
              value={fiscalRecoveryText}
              onChange={(event) => setFiscalRecoveryText(event.target.value)}
              placeholder="ЧЕКА НЕМАЄ"
              className="mt-3 w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:border-yellow-500"
            />
            <button
              type="button"
              disabled={resolvingFiscal || fiscalRecoveryText.trim().toUpperCase() !== 'ЧЕКА НЕМАЄ'}
              onClick={resolveFiscalReturnRecovery}
              className="mt-3 w-full rounded-xl bg-yellow-400 px-4 py-3 font-bold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              {resolvingFiscal ? 'Перевіряємо...' : 'Я перевірив: чека немає, розблокувати'}
            </button>
          </div>
        </div>
      )}
    </Layout>
  )
}
