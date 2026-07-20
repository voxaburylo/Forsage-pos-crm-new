import { useEffect, useCallback } from 'react'
import { usePOSStore } from '@/stores/posStore'
import { shiftApi } from './shiftApi'
import { saleApi } from './saleApi'
import { toast } from '@/components/ui/Toast'
import { cacheCurrentShift, getCachedCurrentShift } from '@/lib/offlineDB'
import { useAuthStore } from '@/stores/authStore'
import { desktopBridge, desktopCheckoutToSale } from '@/lib/desktopBridge'

const PAYMENT_ATTEMPT_KEY = 'forsage_last_payment_attempt'
type PaymentMethod = 'cash' | 'card' | 'debt' | 'mixed' | 'transfer'

export function usePOS() {
  const store = usePOSStore()

  // Беремо actions через селектори — Zustand гарантує стабільні ссилки.
  // НЕ використовувати `store.setX` в deps useCallback/useEffect, інакше нескінченний
  // re-render цикл (store-об'єкт міняється на кожне оновлення state).
  const setInitializing = usePOSStore((s) => s.setInitializing)
  const setInitError    = usePOSStore((s) => s.setInitError)
  const setCurrentShift = usePOSStore((s) => s.setCurrentShift)
  const scopeKey = useAuthStore((s) => s.session?.user?.id ?? '')
  const cashierId = useAuthStore((s) => s.session?.user?.id ?? '')

  const checkShift = useCallback(() => {
    setInitializing(true)
    setInitError(null)

    const desktop = desktopBridge()
    if (desktop && cashierId) {
      desktop.pos.getOpenShift(cashierId)
        .then((shift) => {
          setCurrentShift(shift)
          setInitError(null)
        })
        .catch((err) => {
          setInitError(err instanceof Error ? err.message : 'Помилка локальної бази')
        })
        .finally(() => setInitializing(false))
      return
    }

    shiftApi.current({ silent: true })
      .then(({ data }) => {
        setCurrentShift(data)
        setInitError(null)
        if (scopeKey) cacheCurrentShift(data, scopeKey).catch(() => {})
      })
      .catch(async (err) => {
        const cachedShift = scopeKey ? await getCachedCurrentShift(scopeKey).catch(() => null) : null
        if (cachedShift) {
          setCurrentShift(cachedShift)
          setInitError(null)
          return
        }
        const status = err?.status
        if (status === 404 || err?.message?.includes('NO_SHIFT') || err?.message?.includes('not found')) {
          setCurrentShift(null)
        } else {
          setInitError(err?.message ?? 'Помилка зв\'язку з сервером')
        }
      })
      .finally(() => {
        setInitializing(false)
      })
  }, [setInitializing, setInitError, setCurrentShift, scopeKey, cashierId])

  // Завантажуємо поточну зміну при старті
  useEffect(() => {
    checkShift()
  }, [checkShift])

  // Оформити продаж
  const completeSale = useCallback(async (
    method: PaymentMethod,
    options?: { cashReceived?: number; bonusRedeemed?: number; split?: { cash_amount: number; card_amount: number }; isFiscal?: boolean; terminalAuthCode?: string }
  ) => {
    const { currentShift, items, customer, notes, total, totalDiscount, managerId, customerOrderId } = store
    const bonusRedeemed = options?.bonusRedeemed ?? 0
    const toPay = Math.max(0, total - bonusRedeemed)

    if (!currentShift) { toast.error('Відкрийте зміну'); return null }
    if (!items.length)  { toast.error('Чек порожній'); return null }
    if (method === 'debt' && !customer) { toast.error('Вкажіть клієнта для продажу в борг'); return null }
    if (method !== 'mixed' && options?.cashReceived !== undefined && options.cashReceived < toPay) {
      toast.error('Недостатньо готівки'); return null
    }

    const desktop = desktopBridge()
    if (desktop) {
      if (options?.isFiscal && (method === 'debt' || (method === 'mixed' && !options?.split))) {
        toast.error('Продаж у борг не фіскалізується — вимкніть фіскальний чек')
        return null
      }

      // Фіскалізація через ПРРО Кашалот — ДО запису в локальну базу:
      // якщо ФСКО відхилить чек, продаж не проводиться взагалі.
      let fiscalNumber: string | null = null
      let fiscalQrUrl: string | null = null
      if (options?.isFiscal) {
        try {
          const cashAmount = method === 'mixed' && options?.split
            ? options.split.cash_amount
            : method === 'cash' ? toPay : 0
          const cardAmount = method === 'mixed' && options?.split
            ? options.split.card_amount
            : method === 'card' ? toPay : 0
          const bankAmount = method === 'transfer' ? toPay : 0

          // Розкидаємо загальну знижку чека по позиціях пропорційно,
          // щоб сума позицій зійшлася з сумою чека до копійки.
          const lineAmounts = items.map((item) => item.unitPrice * item.qty - item.discount)
          const linesTotal = lineAmounts.reduce((sum, amount) => sum + amount, 0)
          let discountLeft = Math.min(totalDiscount, linesTotal)
          const fiscalItems = items.map((item, index) => {
            const lineAmount = lineAmounts[index]
            const isLast = index === items.length - 1
            const share = isLast
              ? discountLeft
              : Math.min(discountLeft, Math.round(totalDiscount * lineAmount / (linesTotal || 1)))
            discountLeft -= share
            const gross = item.unitPrice * item.qty
            const finalAmount = Math.max(0, lineAmount - share)
            return {
              name: item.name,
              vendor_code: item.sku || item.name,
              unit: item.unit,
              qty: item.qty,
              unit_price: item.unitPrice,
              amount: finalAmount,
              discount: Math.max(0, gross - finalAmount),
            }
          })

          const fiscalResult = await desktop.fiscal.registerCheck(fiscalItems, {
            // У ПРРО передаємо суму самого чека, а не отримані від клієнта
            // купюри: решта не є виручкою й не повинна потрапляти в Z-звіт.
            cash: cashAmount,
            card: cardAmount,
            bank: bankAmount,
            check_total: toPay,
            auth_code: options?.terminalAuthCode ?? null,
          })
          fiscalNumber = fiscalResult.ReceiptFiscalNum || null
          fiscalQrUrl = fiscalResult.FSKOReceiptLink || fiscalResult.CashalotReceiptLink || null
          if (fiscalResult.OfflineMode) {
            toast.warning('ПРРО в режимі офлайн — чек буде дореєстровано автоматично')
          }
        } catch (error) {
          toast.error('Фіскалізація не пройшла: '
            + (error instanceof Error ? error.message : 'невідома помилка')
            + '. Продаж НЕ проведено.')
          return null
        }
      }

      try {
        const payments = method === 'mixed' && options?.split
          ? [
              { method: 'cash' as const, amount: options.split.cash_amount, is_fiscal: !!fiscalNumber, fiscal_number: fiscalNumber },
              { method: 'card' as const, amount: options.split.card_amount, is_fiscal: !!fiscalNumber, fiscal_number: fiscalNumber, bank_auth_code: options.terminalAuthCode ?? null },
            ].filter((payment) => payment.amount > 0)
          : [{
              method: method === 'mixed' ? 'cash' as const : method,
              amount: toPay,
              is_fiscal: !!fiscalNumber,
              fiscal_number: fiscalNumber,
              bank_auth_code: method === 'card' ? options?.terminalAuthCode ?? null : null,
            }]

        const checkoutInput = {
          shift_id: currentShift.id,
          customer_id: customer?.id ?? null,
          manager_id: managerId,
          cashier_id: currentShift.cashier_id,
          items: items.map((item) => ({
            product_id: item.productId,
            qty: item.qty,
            unit_price: item.unitPrice,
            discount: item.discount,
          })),
          payments,
          notes: notes || null,
          discount: totalDiscount + bonusRedeemed,
          bonuses_spent: bonusRedeemed,
          is_fiscal: !!fiscalNumber,
          fiscal_number: fiscalNumber,
          fiscal_qr_url: fiscalQrUrl,
        }
        const result = await desktop.pos.checkout(checkoutInput)
        window.dispatchEvent(new Event('forsage:desktop-sync-requested'))
        const sale = desktopCheckoutToSale(result, checkoutInput, items.map((item) => ({
          id: `${result.sale_id}-${item.productId}`,
          product_id: item.productId,
          qty: item.qty,
          unit_price: item.unitPrice,
          discount: item.discount,
          total: item.unitPrice * item.qty - item.discount,
          product: { id: item.productId, sku: item.sku, name: item.name, unit: item.unit },
        })))

        store.clearReceipt()
        toast.success(fiscalNumber
          ? `Продаж #${sale.sale_number} оформлено, фіскальний чек ${fiscalNumber}`
          : 'Локальний продаж #' + sale.sale_number + ' оформлено')
        return sale
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Помилка локального продажу')
        return null
      }
    }

    try {
      // Зберігаємо момент спроби — для crash recovery перевірки
      const attemptAt = new Date().toISOString()
      localStorage.setItem(PAYMENT_ATTEMPT_KEY, JSON.stringify({
        shift_id: currentShift.id,
        attempt_at: attemptAt,
      }))

      const salePayload: any = {
        shift_id:            currentShift.id,
        customer_id:         customer?.id ?? null,
        customer_order_id:   customerOrderId || null,
        manager_id:          managerId,
        items:          items.map((i) => ({
          product_id: i.productId,
          qty:        i.qty,
          unit_price: i.unitPrice,
          discount:   i.discount,
        })),
        payment_method: method,
        notes:          notes || undefined,
        is_fiscal:           options?.isFiscal ?? false,
        terminal_auth_code:  options?.terminalAuthCode ?? null,
        discount:            totalDiscount + bonusRedeemed,
        bonuses_spent:       bonusRedeemed,
      }
      if (method === 'mixed' && options?.split) {
        salePayload.cash_amount = options.split.cash_amount
        salePayload.card_amount = options.split.card_amount
      }
      const idempotencyKey = store.getActiveTab()?.idempotencyKey
      const { data: sale } = await saleApi.create(salePayload, idempotencyKey)
      if (!sale?.id) throw new Error('Сервер не повернув ID продажу')

      localStorage.removeItem(PAYMENT_ATTEMPT_KEY)
      store.clearReceipt()
      toast.success('Продаж #' + sale.sale_number + ' оформлено')
      return sale
    } catch (e) {
      // Мережева помилка не означає, що продаж не пройшов: POSPage збереже
      // той самий запит у чергу з тим самим idempotency key.
      if (!(e as any)?.status) throw e
      toast.error(e instanceof Error ? e.message : 'Помилка оформлення продажу')
      return null
    }
  }, [store])

  return { store, completeSale, checkShift, PAYMENT_ATTEMPT_KEY }
}
