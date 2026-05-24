import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Phone, MessageSquare, FilePen, DollarSign, Printer } from 'lucide-react'
import { api } from '@/lib/api'
import { orderApi, type CustomerOrder, type CustomerOrderStatus, type ItemStatus } from './orderApi'
import { printOrderReceipt } from './OrderReceiptPrint'
import { printPickingList } from './PickingListPrint'
import { shiftApi } from '@/features/pos/shiftApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Badge, Input } from '@/components/ui'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate } from '@/lib/utils'
import { adminApi } from '@/features/admin/adminApi'
import { productApi } from '@/features/products/productApi'
import { DEFAULT_LABEL } from '@/features/labels/LabelDesigner'

interface Payment {
  id: string
  amount: number
  method: string
  is_fiscal: boolean
  notes: string | null
  created_at: string
}

interface ActivityEntry {
  id: string
  action: string
  details: any
  created_at: string
  user_id: string | null
}

const ACTION_LABELS: Record<string, string> = {
  created: 'Створено',
  'item_status:pending': 'Додано позицію',
  'item_status:ordered': 'Замовлено у постачальника',
  'item_status:arrived': 'Прийнято на склад',
  'item_status:handed': 'Видано клієнту',
  'item_status:canceled': 'Скасовано позицію',
  status_changed: 'Змінено статус',
  payment_added: 'Додано платіж',
  completed: 'Завершено',
  canceled: 'Скасовано',
  bulk_arrival: 'Масове приймання',
  kp_sent_telegram: 'КП відправлено в Telegram',
  telegram_sent: 'Сповіщення в Telegram',
  deadline_reminder_sent: 'Нагадування про дедлайн',
  deadline_critical: 'Прострочено!',
}

type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'

const STATUS_CONFIG: Record<CustomerOrderStatus, { label: string; color: BadgeColor }> = {
  lead:       { label: 'Лід',        color: 'blue'   },
  new:        { label: 'Нове',       color: 'gray'   },
  ordered:    { label: 'Замовлено',  color: 'yellow' },
  arrived:    { label: 'Прибуло',    color: 'green'  },
  called:     { label: 'Повідомл.',  color: 'blue'   },
  no_answer:  { label: 'Не відповів', color: 'orange' },
  ready:      { label: 'До видачі',  color: 'green'  },
  completed:  { label: 'Видано',     color: 'green'  },
  canceled:   { label: 'Скасовано',  color: 'red'    },
}

const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  pending:  'Очікує',
  ordered:  'Замовлено',
  arrived:  'Прийшло',
  handed:   'Видано',
  canceled: 'Скасовано',
}

const ITEM_STATUS_COLOR: Record<ItemStatus, BadgeColor> = {
  pending:  'gray',
  ordered:  'yellow',
  arrived:  'green',
  handed:   'green',
  canceled: 'red',
}

const ITEM_STATUS_ACTIONS: Record<string, Array<{ status: ItemStatus; label: string; icon: string }>> = {
  pending:  [{ status: 'ordered', label: 'Замовлено', icon: '📥' }, { status: 'canceled', label: 'Скасувати', icon: '❌' }],
  ordered:  [{ status: 'arrived', label: 'Приїхало', icon: '📦' }, { status: 'canceled', label: 'Скасувати', icon: '❌' }],
  arrived:  [{ status: 'handed',  label: 'Видано',   icon: '✅' }],
}

export default function OrderDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  const [order, setOrder]     = useState<CustomerOrder | null>(null)
  const [loading, setLoading] = useState(true)
  const [now]                 = useState(() => new Date())

  const [payModal, setPayModal]   = useState(false)
  const [payMethod, setPayMethod] = useState<'cash' | 'card' | 'mixed'>('cash')
  const [isFiscal, setIsFiscal]   = useState(false)
  const [paying, setPaying]       = useState(false)

  const [itemLabelModal, setItemLabelModal] = useState(false)
  const [selectedOrderItem, setSelectedOrderItem] = useState<any | null>(null)
  const [itemLabelCopies, setItemLabelCopies] = useState(1)
  const [printingLabel, setPrintingLabel] = useState(false)

  const [cancelModal, setCancelModal] = useState(false)
  const [canceling, setCanceling]     = useState(false)

  const [payments, setPayments] = useState<Payment[]>([])
  const [addPayModal, setAddPayModal] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payMethodField, setPayMethodField] = useState<'cash' | 'card' | 'transfer'>('cash')
  const [payFiscal, setPayFiscal] = useState(false)
  const [paySaving, setPaySaving] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const result = await orderApi.get(id)
      setOrder((result as { data: CustomerOrder }).data)
    } catch {
      toast.error('Замовлення не знайдено')
      navigate('/orders')
    } finally {
      setLoading(false)
    }
  }, [id, navigate])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!id) return
    api.get<{ data: Payment[] }>(`/api/v1/customer-orders/${id}/payments`)
      .then((r) => setPayments(r.data ?? []))
      .catch(() => {})
  }, [id])

  async function handleItemStatus(itemId: string, status: ItemStatus) {
    if (!id) return
    try {
      await orderApi.updateItemStatus(id, itemId, status)
      toast.success('Статус позиції оновлено')
      load()
    } catch { toast.error('Помилка') }
  }

  async function handleComplete() {
    if (!id || !order) return
    setPaying(true)
    try {
      const shiftRes = await shiftApi.current().catch(() => ({ data: null }))
      const shiftId = shiftRes.data?.id ?? null
      await orderApi.complete(id, { payment_method: payMethod, is_fiscal: isFiscal, shift_id: shiftId })
      toast.success('Замовлення завершено')
      setPayModal(false)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка')
    } finally { setPaying(false) }
  }

  async function handleAddPayment() {
    if (!id || !order) return
    const amount = Math.round(parseFloat(payAmount || '0') * 100)
    if (amount <= 0) { toast.error('Вкажіть суму'); return }
    const rem = order.total_amount - (order.total_paid ?? order.prepayment)
    if (amount > rem) { toast.error('Сума перевищує залишок'); return }

    setPaySaving(true)
    try {
      const shiftRes = await shiftApi.current().catch(() => ({ data: null }))
      await api.post(`/api/v1/customer-orders/${id}/payments`, {
        amount, method: payMethodField, is_fiscal: payFiscal,
        shift_id: shiftRes.data?.id ?? null,
      })
      toast.success('Оплату додано')
      setAddPayModal(false); setPayAmount('')
      load()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { setPaySaving(false) }
  }

  async function handleCancel(refund: boolean) {
    if (!id || !order) return
    setCanceling(true)
    try {
      await orderApi.cancel(id, refund)
      toast.success(refund ? 'Скасовано, передоплату повернено' : 'Замовлення скасовано')
      setCancelModal(false)
      load()
    } catch { toast.error('Помилка') } finally { setCanceling(false) }
  }

  async function handleCancelAsCredit() {
    if (!id || !order) return
    setCanceling(true)
    try {
      await orderApi.cancel(id, false, null, true)
      toast.success('Скасовано, передоплата залишена як кредит клієнту')
      setCancelModal(false)
      load()
    } catch { toast.error('Помилка') } finally { setCanceling(false) }
  }

  async function handlePrintItemLabelConfirm() {
    if (!order || !selectedOrderItem) return
    setPrintingLabel(true)
    try {
      let barcodeValue = selectedOrderItem.sku || ''
      if (selectedOrderItem.product_id) {
        try {
          const res = await productApi.get(selectedOrderItem.product_id)
          if (res.data.barcode) {
            barcodeValue = res.data.barcode
          }
        } catch { /* fallback: лишаємо barcodeValue = sku, друк не блокуємо */ }
      }

      const settingsRes = await adminApi.getSettings()
      const settings = settingsRes.data.label_settings || DEFAULT_LABEL

      const w = settings.width_mm
      const h = settings.height_mm
      const padding = settings.padding_mm
      const fontSize = settings.font_size

      const clientName = order.customer?.full_name || order.customer?.phone || '—'
      const carInfo = order.vehicle_info
        ? [order.vehicle_info.make, order.vehicle_info.model].filter(Boolean).join(' ')
        : ''
      const orderNum = order.kp_number || order.id.slice(0, 8)
      const cellInfo = order.pickup_cell ? `Комірка: ${order.pickup_cell}` : ''
      const today = new Date().toLocaleDateString('uk-UA')

      const labelsHtml = Array(itemLabelCopies).fill(0).map((_, index) => {
        return `
          <div class="label">
            <div style="font-size:${fontSize}px; font-weight:bold; border-bottom:0.2mm solid #ddd; padding-bottom:0.5mm; display:flex; justify-content:between; width:100%;">
              <span>ЗАМОВЛЕННЯ №${orderNum}</span>
              ${cellInfo ? `<span style="color:#b45309; font-weight:bold; margin-left:auto;">${cellInfo}</span>` : ''}
            </div>
            <div style="font-size:${fontSize + 1}px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:0.5mm; width:100%;">
              ${selectedOrderItem.name}
            </div>
            <div style="font-size:${fontSize}px; font-weight:bold; color:#1e3a8a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">
              Клієнт: ${clientName}
            </div>
            ${carInfo ? `<div style="font-size:${fontSize - 1}px; color:#4b5563; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">Авто: ${carInfo}</div>` : ''}
            
            <div style="text-align:center; margin:0.5mm 0; width:100%;">
              <svg id="bc-${index}"></svg>
            </div>
            
            <div style="display:flex; justify-content:space-between; align-items:baseline; font-size:${fontSize - 1}px; color:#6b7280; width:100%;">
              <div>Арт: ${selectedOrderItem.sku || '—'}</div>
              <div>${today}</div>
            </div>
          </div>
        `
      }).join('')

      const html = `<!DOCTYPE html>
    <html><head><style>
      @page { margin: 0; size: ${w}mm ${h}mm; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        width: ${w}mm; min-height: ${h}mm;
        padding: ${padding}mm;
        font-family: 'Courier New', monospace;
        font-size: ${fontSize}px;
        line-height: 1.2;
        overflow: hidden;
      }
      .label {
        width: ${w - padding * 2}mm;
        height: ${h - padding * 2}mm;
        display: flex; flex-direction: column;
        justify-content: space-between;
        page-break-inside: avoid;
        page-break-after: always;
      }
      .label svg { max-width: ${w - padding * 2}mm; max-height: ${settings.barcode_height * 0.8}px; }
    </style></head><body>
      ${labelsHtml}
      <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3/dist/JsBarcode.all.min.js"></script>
      <script>
        try {
          ${Array(itemLabelCopies).fill(0).map((_, idx) => `
            JsBarcode('#bc-${idx}', '${barcodeValue}', { width: 1.2, height: ${settings.barcode_height}, fontSize: ${fontSize}, margin: 0, displayValue: ${barcodeValue ? 'true' : 'false'} });
          `).join('\n')}
        } catch(e) {}
        window.onload = function() { setTimeout(function() { window.print(); window.close(); }, 500); };
      </script>
    </body></html>`

      const iframe = document.createElement('iframe')
      iframe.style.position = 'fixed'
      iframe.style.top = '-9999px'
      iframe.style.width = '0'
      iframe.style.height = '0'
      document.body.appendChild(iframe)
      iframe.contentDocument?.open()
      iframe.contentDocument?.write(html)
      iframe.contentDocument?.close()
      setTimeout(() => { if (document.body.contains(iframe)) document.body.removeChild(iframe) }, 30000)

      setItemLabelModal(false)
    } catch {
      toast.error('Не вдалося надрукувати етикетку')
    } finally {
      setPrintingLabel(false)
    }
  }

  if (loading) return <Layout title="Замовлення"><div className="text-center py-20 text-gray-400">Завантаження...</div></Layout>
  if (!order) return null

  const conf = STATUS_CONFIG[order.status] ?? { label: order.status, color: 'gray' as const }
  const totalPaid = order.total_paid ?? order.prepayment
  const remaining = order.total_amount - totalPaid
  const allArrived = order.items.every((i) => ['arrived', 'handed', 'canceled'].includes(i.item_status))
  const allHanded  = order.items.every((i) => ['handed', 'canceled'].includes(i.item_status))
  const canComplete = allArrived && !allHanded && !['completed', 'canceled'].includes(order.status)
  const canCancel   = !['completed', 'canceled'].includes(order.status)
  const isDraft     = order.status === 'lead' && ['walk_in', 'mobile_draft'].includes(order.source)
  const hasPendingWarehouseItems = order.items.some((i) => i.source_type === 'warehouse' && i.item_status === 'pending')

  return (
    <Layout
      title={`Замовлення від ${formatDate(order.created_at)}`}
      onBack={() => navigate('/orders')}
      actions={
        <div className="flex gap-2">
          {isDraft && (
            <Button icon={<FilePen size={15} />} onClick={() => navigate('/quotes/' + id)}>
              Редагувати КП
            </Button>
          )}
          {canComplete && (
            <Button onClick={() => setPayModal(true)} className="bg-green-600 hover:bg-green-700 text-white">
              💰 Видати
            </Button>
          )}
          {hasPendingWarehouseItems && !['completed', 'canceled'].includes(order.status) && (
            <Button className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold" onClick={() => navigate(`/inventory/picking?orderId=${id}`)}>
              📦 Зібрати
            </Button>
          )}
          <Button variant="secondary" icon={<Printer size={15} />} onClick={() => printPickingList(order as any)}>
            📋 Збірочний лист
          </Button>
          <Button variant="secondary" icon={<Printer size={15} />} onClick={() => printOrderReceipt(order)}>
            🖨 Квитанція
          </Button>
          {order.chat_id && (
            <Button variant="secondary" size="sm" icon={<MessageSquare size={14} />} onClick={() => navigate(`/chats?chat_id=${order.chat_id}`)}>
              💬 Чат
            </Button>
          )}
          {canCancel && (
            <Button variant="secondary" onClick={() => setCancelModal(true)}>
              ❌ Скасувати
            </Button>
          )}
        </div>
      }
    >
      <div className="max-w-3xl space-y-5">

        {/* Шапка */}
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge color={conf.color}>{conf.label}</Badge>
                {order.source === 'messenger' && <MessageSquare size={14} className="text-blue-400" />}
                {order.source === 'phone' && <Phone size={14} className="text-green-400" />}
                <span className="text-xs text-gray-400">{formatDate(order.created_at)}</span>
              </div>

              <div className="text-sm text-gray-600 space-y-1">
                {order.customer ? (
                  <div>
                    Клієнт:{' '}
                    <button onClick={() => navigate('/customers/' + order.customer!.id)}
                      className="text-blue-600 hover:underline font-medium">
                      {order.customer.full_name ?? order.customer.phone}
                    </button>
                  </div>
                ) : (
                  <div className="text-gray-400">Клієнт не вказаний</div>
                )}

                {order.vehicle_info && (
                  <div>🚗 {[order.vehicle_info.make, order.vehicle_info.model, order.vehicle_info.year].filter(Boolean).join(' ')}
                    {order.vehicle_info.vin && <span className="ml-1 font-mono text-xs text-gray-400">({order.vehicle_info.vin})</span>}
                  </div>
                )}

                {order.comment && <div className="italic text-gray-500">{order.comment}</div>}
                {order.pickup_deadline_at && (
                  <div className={`text-xs mt-2 ${new Date(order.pickup_deadline_at) < now ? 'text-red-600 font-bold' : 'text-gray-500'}`}>
                    📅 Дедлайн видачі: {formatDate(order.pickup_deadline_at)}
                    {new Date(order.pickup_deadline_at) < now && ` (прострочено на ${Math.floor((now.getTime() - new Date(order.pickup_deadline_at).getTime()) / 86400000)} дн.)`}
                  </div>
                )}
                {order.pickup_cell && (
                  <div className="text-xs mt-2 text-green-700 font-bold">
                    📦 Комірка зберігання: {order.pickup_cell}
                  </div>
                )}
              </div>
            </div>

            <div className="text-right space-y-1 shrink-0">
              <div>
                <span className="text-xs text-gray-400">Сума замовлення</span>
                <div className="text-2xl font-bold text-gray-900">{formatMoney(order.total_amount)}</div>
              </div>
              {totalPaid > 0 && (
                <div className="text-sm text-green-600">Сплачено: {formatMoney(totalPaid)}</div>
              )}
              {remaining > 0 && !allHanded && (
                <div className="text-sm text-orange-600 font-medium">Залишок: {formatMoney(remaining)}</div>
              )}
            </div>
          </div>
        </Card>

        {/* Позиції */}
        <Card>
          <h3 className="font-semibold text-gray-800 mb-3">Позиції замовлення</h3>
          {order.items.length === 0 ? (
            <p className="text-sm text-gray-400">Позиції відсутні</p>
          ) : (
            <div className="space-y-2">
              {order.items.map((item) => {
                const actions = ITEM_STATUS_ACTIONS[item.item_status]
                return (
                  <div key={item.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2.5 text-sm">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-gray-800">{item.name}</span>
                      {item.sku && <span className="text-gray-400 text-xs ml-1.5 font-mono">{item.sku}</span>}
                      <span className="ml-2">
                        <Badge color={ITEM_STATUS_COLOR[item.item_status]}>{ITEM_STATUS_LABEL[item.item_status]}</Badge>
                      </span>
                      {item.expected_date && (
                        <span className={`text-xs ml-1 ${new Date(item.expected_date) < new Date() ? 'text-red-500' : 'text-gray-400'}`}>
                          ⏳ {formatDate(item.expected_date)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <span className="text-gray-600 text-xs">{item.qty} × {formatMoney(item.sell_price)}</span>
                      <button onClick={() => { setSelectedOrderItem(item); setItemLabelCopies(Math.ceil(item.qty)); setItemLabelModal(true); }}
                        className="text-[11px] px-2 py-0.5 rounded bg-white border border-gray-200 hover:bg-gray-100 transition-colors flex items-center gap-0.5 text-gray-700"
                        title="Друк етикетки замовлення">
                        🏷️ Етикетка
                      </button>
                      {actions?.map((action) => (
                        <button key={action.status} onClick={() => handleItemStatus(item.id, action.status)}
                          className="text-[11px] px-2 py-0.5 rounded bg-white border border-gray-200 hover:bg-gray-100 transition-colors">
                          {action.icon} {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* Платежі */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-800">Оплати</h3>
            {!['completed', 'canceled'].includes(order.status) && (
              <Button size="sm" variant="secondary" icon={<DollarSign size={14} />} onClick={() => setAddPayModal(true)}>
                + Додати оплату
              </Button>
            )}
          </div>

          {payments.length === 0 ? (
            <p className="text-sm text-gray-400">Ще не було оплат</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                  <th className="text-left px-2 py-1.5">Дата</th>
                  <th className="text-right px-2 py-1.5">Сума</th>
                  <th className="text-center px-2 py-1.5">Метод</th>
                  <th className="text-center px-2 py-1.5">ПРРО</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-gray-50">
                    <td className="px-2 py-1.5 text-gray-500">{new Date(p.created_at).toLocaleDateString('uk-UA')}</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{formatMoney(p.amount)}</td>
                    <td className="px-2 py-1.5 text-center">
                      <Badge color={p.method === 'cash' ? 'green' : p.method === 'card' ? 'blue' : 'yellow'}>
                        {p.method === 'cash' ? 'Готівка' : p.method === 'card' ? 'Картка' : 'Переказ'}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5 text-center">{p.is_fiscal ? '✅' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="mt-3 pt-3 border-t border-gray-100 space-y-1 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>Загальна сума:</span>
              <span className="font-semibold">{formatMoney(order.total_amount)}</span>
            </div>
            <div className="flex justify-between text-green-600">
              <span>Сплачено:</span>
              <span className="font-semibold">{formatMoney(totalPaid)}</span>
            </div>
            {remaining > 0 && (
              <div className="flex justify-between text-orange-600 font-bold">
                <span>Залишок:</span>
                <span>{formatMoney(remaining)}</span>
              </div>
            )}
          </div>
        </Card>

        {/* Журнал активності */}
        {order.activity && order.activity.length > 0 && (
          <Card>
            <h3 className="font-semibold text-gray-800 mb-3">Журнал дій</h3>
            <div className="space-y-2">
              {[...order.activity]
                .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                .map((entry) => {
                  const e = entry as ActivityEntry
                  return (
                    <div key={e.id} className="flex gap-3 items-start text-sm">
                      <div className="w-2 h-2 rounded-full bg-yellow-400 mt-1.5 shrink-0" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-700 font-medium">
                            {ACTION_LABELS[e.action] ?? e.action}
                          </span>
                          <span className="text-gray-400 text-xs">{formatDate(e.created_at)}</span>
                        </div>
                        {e.action === 'payment_added' && e.details?.amount && (
                          <div className="text-xs text-green-600">
                            💰 {formatMoney(e.details.amount)} ({e.details.method})
                          </div>
                        )}
                        {e.action === 'status_changed' && e.details?.new_status && (
                          <div className="text-xs text-gray-500">
                            Новий статус: {STATUS_CONFIG[e.details.new_status as CustomerOrderStatus]?.label ?? e.details.new_status}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
            </div>
          </Card>
        )}
      </div>

      {/* Модал видачі */}
      <Modal open={payModal} onClose={() => setPayModal(false)} title="Фінальний розрахунок" size="sm">
        {order && (
          <div className="space-y-4">
            <div className="bg-green-50 rounded-xl p-4 space-y-1 text-sm">
              <div className="flex justify-between"><span>Загальна сума:</span><span className="font-bold">{formatMoney(order.total_amount)}</span></div>
              {order.prepayment > 0 && (
                <div className="flex justify-between text-blue-600"><span>Передоплата:</span><span>{formatMoney(order.prepayment)}</span></div>
              )}
              <div className="border-t border-green-200 pt-1 flex justify-between text-lg font-bold">
                <span>До сплати:</span>
                <span className="text-green-700">{formatMoney(Math.max(0, remaining))}</span>
              </div>
            </div>
            {remaining > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Метод оплати</label>
                <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as any)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                  <option value="cash">Готівка</option>
                  <option value="card">Картка</option>
                  <option value="mixed">Змішана</option>
                </select>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={isFiscal} onChange={(e) => setIsFiscal(e.target.checked)} className="w-4 h-4 accent-yellow-400" />
              🧾 Фіскальний чек (ПРРО)
            </label>
            <div className="flex gap-3">
              <Button onClick={handleComplete} loading={paying} className="flex-1 bg-green-600 hover:bg-green-700">
                ✅ Підтвердити видачу
              </Button>
              <Button variant="secondary" onClick={() => setPayModal(false)}>Скасувати</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Модал додавання оплати */}
      <Modal open={addPayModal} onClose={() => setAddPayModal(false)} title="+ Додати оплату" size="sm">
        {order && (
          <div className="space-y-4">
            <div className="bg-blue-50 rounded-xl p-3 text-sm space-y-1">
              <div className="flex justify-between"><span>Загальна сума:</span><span className="font-bold">{formatMoney(order.total_amount)}</span></div>
              <div className="flex justify-between"><span>Вже сплачено:</span><span className="font-semibold text-green-600">{formatMoney(totalPaid)}</span></div>
              <div className="flex justify-between font-bold"><span>Залишок:</span><span className="text-orange-600">{formatMoney(remaining)}</span></div>
            </div>
            <Input label="Сума (грн)" type="number" min="0.01" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Метод оплати</label>
              <select value={payMethodField} onChange={(e) => setPayMethodField(e.target.value as any)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
                <option value="cash">Готівка</option>
                <option value="card">Картка</option>
                <option value="transfer">Переказ</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={payFiscal} onChange={(e) => setPayFiscal(e.target.checked)}
                className="w-4 h-4 accent-yellow-400" />
              🧾 Фіскальний чек (ПРРО)
            </label>
            <div className="flex gap-3">
              <Button onClick={handleAddPayment} loading={paySaving} className="flex-1">💳 Додати оплату</Button>
              <Button variant="secondary" onClick={() => setAddPayModal(false)}>Скасувати</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Модал скасування */}
      <Modal open={cancelModal} onClose={() => setCancelModal(false)} title="Скасувати замовлення" size="sm">
        {order && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {order.prepayment > 0
                ? `Передоплата: ${formatMoney(order.prepayment)}. Що робити з грошима?`
                : 'Ви впевнені, що хочете скасувати це замовлення?'}
            </p>
            {order.prepayment > 0 ? (
              <div className="space-y-2">
                <Button onClick={() => handleCancel(true)} loading={canceling} className="w-full bg-red-600 hover:bg-red-700 text-white">
                  💰 Повернути {formatMoney(order.prepayment)}
                </Button>
                <Button variant="secondary" onClick={() => handleCancel(false)} loading={canceling} className="w-full">
                  Залишити в магазині
                </Button>
                <Button variant="secondary" onClick={() => handleCancelAsCredit()} loading={canceling}
                  className="w-full border-blue-300 text-blue-700">
                  📋 Залишити як кредит клієнту
                </Button>
              </div>
            ) : (
              <div className="flex gap-3">
                <Button onClick={() => handleCancel(false)} loading={canceling} className="flex-1 bg-red-600 hover:bg-red-700 text-white">
                  Скасувати
                </Button>
                <Button variant="secondary" onClick={() => setCancelModal(false)}>Назад</Button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Модалка друку етикетки заказної позиції */}
      {itemLabelModal && selectedOrderItem && (
        <Modal
          open={itemLabelModal}
          onClose={() => setItemLabelModal(false)}
          title="Друк етикетки замовлення"
          size="sm"
        >
          <div className="space-y-4">
            <div>
              <p className="font-semibold text-gray-900">{selectedOrderItem.name}</p>
              <p className="text-xs text-gray-400">Артикул: {selectedOrderItem.sku || '—'}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Кількість копій
              </label>
              <input
                type="number"
                min={1}
                max={999}
                value={itemLabelCopies}
                onChange={(e) => setItemLabelCopies(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
              <Button variant="secondary" onClick={() => setItemLabelModal(false)}>
                Скасувати
              </Button>
              <Button
                onClick={handlePrintItemLabelConfirm}
                loading={printingLabel}
              >
                Друкувати
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Layout>
  )
}
