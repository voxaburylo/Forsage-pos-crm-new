import { useEffect, useCallback, useState } from 'react'
import { usePOSStore } from '@/stores/posStore'
import { shiftApi } from './shiftApi'
import { saleApi } from './saleApi'
import { toast } from '@/components/ui/Toast'
import { cacheCurrentShift, getCachedCurrentShift } from '@/lib/offlineDB'
import { useAuthStore } from '@/stores/authStore'
import { desktopBridge, desktopCheckoutToSale, type DesktopCheckoutInput } from '@/lib/desktopBridge'
import { buildFiscalSaleItems, parseFiscalIntentUnknown, type FiscalIntentUnknown } from './fiscalSale'

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
  const [fiscalRecovery, setFiscalRecovery] = useState<FiscalIntentUnknown | null>(null)

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

  const resolveFiscalRecovery = useCallback(async (): Promise<boolean> => {
    if (!fiscalRecovery) return false
    const desktop = desktopBridge()
    if (!desktop || !cashierId) {
      toast.error('Відновлення фіскального чека доступне лише в локальній касі')
      return false
    }
    try {
      await desktop.fiscal.resolveUnknownSale(fiscalRecovery.operationId, {
        confirmed_by: cashierId,
        reason: 'Касир перевірив Cashalot і підтвердив, що чек не зареєстровано',
        cashalot_checked: true,
      })
      setFiscalRecovery(null)
      toast.success('Операцію розблоковано. Тепер можна повторити оплату')
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося розблокувати операцію')
      return false
    }
  }, [cashierId, fiscalRecovery])

  // Оформити продаж
  const completeSale = useCallback(async (
    method: PaymentMethod,
    options?: { cashReceived?: number; bonusRedeemed?: number; split?: { cash_amount: number; card_amount: number }; isFiscal?: boolean; terminalAuthCode?: string }
  ) => {
    const { currentShift, items, customer, notes, total, totalDiscount, totalCoreDeposit, managerId, customerOrderId } = store
    const hasTireService = items.some((item) => item.sku === 'POS-TIRE-SERVICE')
    const saleManagerId = currentShift
      ? (hasTireService ? (managerId ?? currentShift.cashier_id ?? null) : currentShift.cashier_id)
      : null
    const bonusRedeemed = Math.min(
      options?.bonusRedeemed ?? 0,
      Math.max(0, total - totalCoreDeposit),
    )
    const toPay = Math.max(0, total - bonusRedeemed)

    if (!currentShift) { toast.error('Відкрийте зміну'); return null }
    if (!items.length)  { toast.error('Чек порожній'); return null }
    if (method === 'debt' && !customer) { toast.error('Вкажіть клієнта для продажу в борг'); return null }
    if (method !== 'mixed' && options?.cashReceived !== undefined && options.cashReceived < toPay) {
      toast.error('Недостатньо готівки'); return null
    }

    const desktop = desktopBridge()
    if (desktop) {
      const requestedFiscal = options?.isFiscal === true
      if (requestedFiscal && (method === 'debt' || (method === 'mixed' && !options?.split))) {
        toast.error('Продаж у борг не фіскалізується — вимкніть фіскальний чек')
        return null
      }

      const operationId = store.getActiveTab()?.idempotencyKey
      if (!operationId) {
        toast.error('Не вдалося визначити номер операції каси. Відкрийте новий чек')
        return null
      }

      const shouldFiscalize = requestedFiscal && toPay > 0
      if (requestedFiscal && !shouldFiscalize) {
        toast.warning('Чек повністю оплачено бонусами, тому ПРРО-чек із нульовою сумою не створюється')
      }

      const splitPayments = method === 'mixed' && options?.split
        ? [
            {
              method: 'cash' as const,
              amount: options.split.cash_amount,
              is_fiscal: shouldFiscalize,
              fiscal_number: null,
            },
            {
              method: 'card' as const,
              amount: options.split.card_amount,
              is_fiscal: shouldFiscalize,
              fiscal_number: null,
              bank_auth_code: options.terminalAuthCode ?? null,
            },
          ].filter((payment) => payment.amount > 0)
        : null
      const payments: DesktopCheckoutInput['payments'] = splitPayments?.length
        ? splitPayments
        : [{
            method: method === 'mixed' ? 'cash' : method,
            amount: toPay,
            is_fiscal: shouldFiscalize,
            fiscal_number: null,
            bank_auth_code: method === 'card' ? options?.terminalAuthCode ?? null : null,
          }]
      const checkoutInput: DesktopCheckoutInput = {
        client_operation_id: operationId,
        shift_id: currentShift.id,
        customer_id: customer?.id ?? null,
        manager_id: saleManagerId,
        cashier_id: currentShift.cashier_id,
        items: items.map((item) => ({
          product_id: item.productId,
          qty: item.qty,
          unit_price: item.unitPrice,
          discount: item.discount,
        })),
        payments,
        notes: notes || null,
        // Знижки позицій вже враховані в sale_items; тут лише додаткове
        // списання бонусів, щоб локальна база не відняла знижку двічі.
        discount: bonusRedeemed,
        bonuses_spent: bonusRedeemed,
        is_fiscal: shouldFiscalize,
        fiscal_number: null,
        fiscal_qr_url: null,
      }

      let fiscalNumber: string | null = null
      try {
        if (shouldFiscalize) {
          const cashAmount = method === 'mixed' && options?.split
            ? options.split.cash_amount
            : method === 'cash' ? toPay : 0
          const cardAmount = method === 'mixed' && options?.split
            ? options.split.card_amount
            : method === 'card' ? toPay : 0
          const bankAmount = method === 'transfer' ? toPay : 0
          const fiscalItems = [
            ...buildFiscalSaleItems(
              items.map((item) => ({
                name: item.name,
                sku: item.sku,
                unit: item.unit,
                qty: item.qty,
                unitPrice: item.unitPrice,
                discount: item.discount,
              })),
              totalDiscount + bonusRedeemed,
            ),
            ...items.flatMap((item) => {
              const deposit = item.requiresCoreReturn ? Number(item.coreDepositAmount ?? 0) : 0
              if (deposit <= 0) return []
              return [{
                name: `Застава (обмін): ${item.name}`,
                vendor_code: `${item.sku || item.productId}-CORE`,
                barcode: null,
                unit: item.unit,
                qty: item.qty,
                unit_price: deposit,
                amount: deposit * item.qty,
                discount: 0,
                is_service: true,
              }]
            }),
          ]
          const intent = await desktop.fiscal.fiscalizeSale({
            operation_id: operationId,
            checkout: checkoutInput,
            items: fiscalItems,
            pay: {
              // Передаємо суму чека, а не отримані купюри: решта не є виручкою.
              cash: cashAmount,
              card: cardAmount,
              bank: bankAmount,
              check_total: toPay,
              auth_code: options?.terminalAuthCode ?? null,
            },
          })
          const fiscalResult = intent.fiscal_result
          if (!fiscalResult) throw new Error('ПРРО не повернув результат фіскалізації')
          fiscalNumber = fiscalResult.ReceiptFiscalNum || fiscalResult.ReceiptLocalNum || null
          checkoutInput.fiscal_number = fiscalNumber
          checkoutInput.fiscal_qr_url =
            fiscalResult.FSKOReceiptLink || fiscalResult.CashalotReceiptLink || null
          checkoutInput.payments = checkoutInput.payments.map((payment) => ({
            ...payment,
            is_fiscal: true,
            fiscal_number: fiscalNumber,
          }))
          if (fiscalResult.OfflineMode) {
            toast.warning('ПРРО в режимі офлайн — чек буде дореєстровано автоматично')
          }
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

        setFiscalRecovery(null)
        store.clearReceipt()
        toast.success(shouldFiscalize
          ? `Продаж #${sale.sale_number} оформлено, фіскальний чек ${fiscalNumber ?? 'зареєстровано'}`
          : 'Локальний продаж #' + sale.sale_number + ' оформлено')
        return sale
      } catch (error) {
        const recovery = parseFiscalIntentUnknown(error)
        if (recovery) {
          setFiscalRecovery(recovery)
          toast.error('Не повторюйте оплату: спочатку перевірте цей чек у Cashalot')
        } else {
          toast.error(error instanceof Error ? error.message : 'Помилка локального продажу')
        }
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
        manager_id:          saleManagerId,
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
      if (sale.fiscal_status === 'failed') {
        toast.warning(`Продаж #${sale.sale_number} збережено, але чек не фіскалізовано: ${sale.fiscal_error ?? 'перевірте ПРРО'}`)
      } else if (sale.post_processing_warning) {
        toast.warning(`Продаж #${sale.sale_number} збережено. Потрібна перевірка: ${sale.post_processing_warning}`)
      } else {
        toast.success('Продаж #' + sale.sale_number + ' оформлено')
      }
      return sale
    } catch (e) {
      // Мережева помилка не означає, що продаж не пройшов: POSPage збереже
      // той самий запит у чергу з тим самим idempotency key.
      if (!(e as any)?.status) throw e
      toast.error(e instanceof Error ? e.message : 'Помилка оформлення продажу')
      return null
    }
  }, [store])

  return {
    store,
    completeSale,
    checkShift,
    fiscalRecovery,
    resolveFiscalRecovery,
    PAYMENT_ATTEMPT_KEY,
  }
}
