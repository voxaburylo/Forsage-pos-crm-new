import { useEffect, useCallback } from 'react'
import { usePOSStore } from '@/stores/posStore'
import { shiftApi } from './shiftApi'
import { saleApi } from './saleApi'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'

const PAYMENT_ATTEMPT_KEY = 'forsage_last_payment_attempt'

export function usePOS() {
  const store = usePOSStore()

  // Завантажуємо поточну зміну при старті
  useEffect(() => {
    shiftApi.current().then(({ data }) => {
      store.setCurrentShift(data)
    }).catch(() => {
      store.setCurrentShift(null)
    })
  }, [])

  // Оформити продаж
  const completeSale = useCallback(async (
    method: 'cash' | 'card' | 'debt' | 'mixed' | 'transfer',
    options?: { cashReceived?: number; bonusRedeemed?: number; split?: { cash_amount: number; card_amount: number }; isFiscal?: boolean; terminalAuthCode?: string }
  ) => {
    const { currentShift, items, customer, notes, total, managerId } = store
    const bonusRedeemed = options?.bonusRedeemed ?? 0
    const toPay = Math.max(0, total - bonusRedeemed)

    if (!currentShift) { toast.error('Відкрийте зміну'); return null }
    if (!items.length)  { toast.error('Чек порожній'); return null }
    if (method === 'debt' && !customer) { toast.error('Вкажіть клієнта для продажу в борг'); return null }
    if (method !== 'mixed' && options?.cashReceived !== undefined && options.cashReceived < toPay) {
      toast.error('Недостатньо готівки'); return null
    }

    try {
      // Зберігаємо момент спроби — для crash recovery перевірки
      const attemptAt = new Date().toISOString()
      localStorage.setItem(PAYMENT_ATTEMPT_KEY, JSON.stringify({
        shift_id: currentShift.id,
        attempt_at: attemptAt,
      }))

      const salePayload: any = {
        shift_id:       currentShift.id,
        customer_id:    customer?.id ?? null,
        manager_id:     managerId,
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
      }
      if (method === 'mixed' && options?.split) {
        salePayload.cash_amount = options.split.cash_amount
        salePayload.card_amount = options.split.card_amount
      }
      const idempotencyKey = store.getActiveTab()?.idempotencyKey
      const { data: sale } = await saleApi.create(salePayload, idempotencyKey)
      if (!sale?.id) throw new Error('Сервер не повернув ID продажу')

      // Списуємо бонуси якщо були використані
      if (bonusRedeemed > 0 && customer) {
        try {
          await api.post('/api/v1/loyalty/customer/' + customer.id + '/redeem', {
            amount: bonusRedeemed,
            sale_id: sale.id,
          })
        } catch {
          toast.warning('Продаж оформлено, але бонуси не списались — зверніться до адміна')
        }
      }

      localStorage.removeItem(PAYMENT_ATTEMPT_KEY)
      store.clearReceipt()
      toast.success('Продаж #' + sale.sale_number + ' оформлено')
      return sale
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка оформлення продажу')
      return null
    }
  }, [store])

  return { store, completeSale, PAYMENT_ATTEMPT_KEY }
}
