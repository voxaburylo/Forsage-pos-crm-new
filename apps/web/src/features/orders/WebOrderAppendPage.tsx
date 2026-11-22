import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { Card } from '@/components/ui'
import { api } from '@/lib/api'
import WebOrderFormPage from './WebOrderFormPage'

type OrderHead = { id: string; order_number: number | null; status: string; sale_id: string | null }
const CLOSED = new Set(['completed', 'canceled', 'archived'])

/**
 * Дозамовлення з телефона (етап 8, 22.11.2026): до відкритого замовлення додаються позиції — додає каса.
 * Тут лише читаємо «шапку» замовлення з копії на сервері, щоб не пропонувати дозамовлення до закритого.
 */
export default function WebOrderAppendPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<{ id: string; order: OrderHead | null; error: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    api.get<{ data: OrderHead }>('/api/v1/customer-orders/' + id, { silent: true, timeoutMs: 10_000 })
      .then(found => { if (!cancelled) setState({ id, order: found.data, error: '' }) })
      .catch(() => { if (!cancelled) setState({ id, order: null, error: 'Замовлення не знайдено або немає зв’язку з сервером.' }) })
    return () => { cancelled = true }
  }, [id])
  const current = state?.id === id ? state : null
  const order = current?.order
  if (order && !CLOSED.has(order.status) && !order.sale_id) {
    return <WebOrderFormPage appendTo={{ id: order.id, title: order.order_number ? '№ ' + order.order_number : '' }} />
  }
  return (
    <Layout title="Додати до замовлення" onBack={() => navigate('/orders/' + id)}>
      <Card className="text-sm text-gray-600">
        {!current ? 'Завантаження…' : current.error || 'Замовлення вже закрите (видане, скасоване або в архіві). Оформіть нове замовлення.'}
      </Card>
    </Layout>
  )
}
