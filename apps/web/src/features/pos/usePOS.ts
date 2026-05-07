import { useEffect, useCallback } from 'react'
import { usePOSStore } from '@/stores/posStore'
import { shiftApi } from './shiftApi'
import { saleApi } from './saleApi'
import { toast } from '@/components/ui/Toast'

export function usePOS() {
  const store = usePOSStore()

  // Завантажуємо поточну зміну при старті
  useEffect(() => {
    shiftApi.current().then(({ data }) => {
      store.setCurrentShift(data)
    }).catch(() => {
      store.setCurrentShift(null)
    })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // Оформити продаж
  const completeSale = useCallback(async (
    method: 'cash' | 'card' | 'debt',
    options?: { cashReceived?: number }
  ) => {
    const { currentShift, items, customer, notes, total } = store

    if (!currentShift) { toast.error('Відкрийте зміну'); return null }
    if (!items.length)  { toast.error('Чек порожній'); return null }
    if (method === 'debt' && !customer) { toast.error('Вкажіть клієнта для продажу в борг'); return null }
    if (options?.cashReceived !== undefined && options.cashReceived < total) {
      toast.error('Недостатньо готівки'); return null
    }

    try {
      const { data: sale } = await saleApi.create({
        shift_id:       currentShift.id,
        customer_id:    customer?.id ?? null,
        items:          items.map((i) => ({
          product_id: i.productId,
          qty:        i.qty,
          unit_price: i.unitPrice,
          discount:   i.discount,
        })),
        payment_method: method,
        notes:          notes || undefined,
      })
      store.clearReceipt()
      toast.success(`Продаж #${sale.sale_number} оформлено`)
      return sale
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка оформлення продажу')
      return null
    }
  }, [store])

  // Гарячі клавіші
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'F8') { e.preventDefault(); document.getElementById('pos-pay-btn')?.click() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  return { store, completeSale }
}
