import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Phone, MessageSquare, FilePen, ChevronDown, Pencil, Copy } from 'lucide-react'
import { orderApi, type CustomerOrder, type CustomerOrderStatus, type ItemStatus } from './orderApi'
import { formatOrderNo, startRepeatOrder } from './orderActions'
import { printOrderReceipt } from './OrderReceiptPrint'
import { printPickingList } from './PickingListPrint'
import { Layout } from '@/components/Layout'
import { Button, Card, Badge } from '@/components/ui'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/components/ui/Toast'
import { formatMoney, formatDate } from '@/lib/utils'
import { productApi } from '@/features/products/productApi'
import { QuickCustomerEditModal } from '@/features/customers/QuickCustomerEditModal'
import { customerApi } from '@/features/customers/customerApi'
import type { Customer } from '@/types/customer'
import type { Product } from '@/types/product'
import { loadProductLabelSettings, printLabels } from '@/features/labels/LabelDesigner'
import { printInvoice, printDeliveryNote, orderMessengerText, loadSellerRequisites, hasSellerRequisites } from './orderDocuments'
import { isTerminalOrderStatus } from './orderStatus'

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
  user_name?: string
  user_phone?: string
}

const ACTION_LABELS: Record<string, string> = {
  created: 'Створено',
  'item_status:pending': 'Додано позицію',
  'item_status:ordered': 'Замовлено у постачальника',
  'item_status:arrived': 'Прийнято на склад',
  'item_status:handed': 'Видано клієнту',
  'item_status:canceled': 'Скасовано позицію',
  'item_status:returned': 'Повернуто позицію',
  items_returned: 'Повернуто товар за чеком',
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

const ORDER_DETAIL_READ_TIMEOUT_MS = 10_000

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'

const STATUS_CONFIG: Record<CustomerOrderStatus, { label: string; color: BadgeColor }> = {
  lead:       { label: 'Лід',        color: 'blue'   },
  quoted:     { label: 'Чернетка',   color: 'gray'   },
  new:        { label: 'Нове',       color: 'gray'   },
  in_progress:{ label: 'В роботі',   color: 'yellow' },
  ordered:    { label: 'Замовлено',  color: 'yellow' },
  arrived:    { label: 'Прибуло',    color: 'green'  },
  called:     { label: 'Повідомл.',  color: 'blue'   },
  no_answer:  { label: 'Не відповів', color: 'orange' },
  ready:      { label: 'До видачі',  color: 'green'  },
  completed:  { label: 'Видано',     color: 'green'  },
  canceled:   { label: 'Скасовано',  color: 'red'    },
  archived:   { label: 'Архів',      color: 'gray'   },
}

const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  pending:  'Очікує',
  ordered:  'Замовлено',
  arrived:  'Прийшло',
  handed:   'Видано',
  canceled: 'Скасовано',
  returned: 'Повернуто',
}

const ITEM_STATUS_COLOR: Record<ItemStatus, BadgeColor> = {
  pending:  'gray',
  ordered:  'yellow',
  arrived:  'green',
  handed:   'green',
  canceled: 'red',
  returned: 'red',
}

function itemStatusLabel(item: CustomerOrder['items'][number]): string {
  if (item.item_status === 'pending' && item.source_type === 'supplier') return 'Під замовлення'
  if (item.item_status === 'pending' && item.source_type === 'warehouse') return 'Зарезервовано'
  return ITEM_STATUS_LABEL[item.item_status]
}

const ITEM_STATUS_ACTIONS: Record<string, Array<{ status: ItemStatus; label: string; icon: string }>> = {
  pending:  [{ status: 'ordered', label: 'Замовити постачальнику', icon: '📥' }, { status: 'canceled', label: 'Скасувати', icon: '❌' }],
  ordered:  [{ status: 'arrived', label: 'Приїхало', icon: '📦' }, { status: 'canceled', label: 'Скасувати', icon: '❌' }],
  // Issuing stock is intentionally absent here: it must create a receipt in POS.
}

export default function OrderDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  const [order, setOrder]     = useState<CustomerOrder | null>(null)
  const [loading, setLoading] = useState(true)
  const [now]                 = useState(() => new Date())

  const [itemLabelModal, setItemLabelModal] = useState(false)
  const [selectedOrderItem, setSelectedOrderItem] = useState<any | null>(null)
  const [itemLabelCopies, setItemLabelCopies] = useState(1)
  const [printingLabel, setPrintingLabel] = useState(false)

  const [cancelModal, setCancelModal] = useState(false)
  const [canceling, setCanceling]     = useState(false)

  const [payments, setPayments] = useState<Payment[]>([])
  const [actionsOpen, setActionsOpen] = useState(false)

  const [quickCustomer, setQuickCustomer] = useState<Customer | null>(null)
  const [customerEditorOpen, setCustomerEditorOpen] = useState(false)

  useEffect(() => {
    if (!actionsOpen) return
    const handleClick = () => setActionsOpen(false)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [actionsOpen])

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const result = await orderApi.get(id, { silent: true })
      setOrder((result as { data: CustomerOrder }).data)
    } catch (error) {
      toast.error(getErrorMessage(error, 'Замовлення не знайдено'))
      navigate('/orders')
    } finally {
      setLoading(false)
    }
  }, [id, navigate])

  useEffect(() => { load() }, [load])

  async function openCustomerEditor() {
    if (!order?.customer) return
    try {
      const result = await customerApi.get(order.customer.id)
      setQuickCustomer(result.data)
      setCustomerEditorOpen(true)
    } catch {
      toast.error('Не вдалося завантажити клієнта')
    }
  }

  useEffect(() => {
    if (!id) return
    orderApi.listPayments(id, { silent: true, timeoutMs: ORDER_DETAIL_READ_TIMEOUT_MS })
      .then((r) => setPayments((r.data ?? []) as Payment[]))
      .catch(() => {})
  }, [id])

  async function handleItemStatus(itemId: string, status: ItemStatus) {
    if (!id) return
    try {
      await orderApi.updateItemStatus(id, itemId, status, { silent: true })
      toast.success('Статус позиції оновлено')
      load()
    } catch (error) { toast.error(getErrorMessage(error, 'Не вдалося оновити статус позиції')) }
  }

  async function handleOrderStatus(status: CustomerOrderStatus) {
    if (!id || !order) return
    const previousOrder = order
    setOrder({ ...order, status })
    try {
      await orderApi.updateStatus(id, status, undefined, { silent: true })
      toast.success('Статус замовлення оновлено')
      await load()
    } catch (error) {
      setOrder(previousOrder)
      toast.error(getErrorMessage(error, 'Не вдалося змінити статус'))
    }
  }

  function openOrderPaymentInPos() {
    if (!order) return
    const search = order.order_number ? String(order.order_number) : order.id
    navigate(`/pos?order=${encodeURIComponent(search)}`)
  }

  async function handleCancel(refund: boolean) {
    if (!id || !order) return
    setCanceling(true)
    try {
      await orderApi.cancel(id, refund, undefined, undefined, { silent: true })
      toast.success(refund ? 'Скасовано, передоплату повернено' : 'Замовлення скасовано')
      setCancelModal(false)
      load()
    } catch (error) { toast.error(getErrorMessage(error, 'Не вдалося скасувати замовлення')) } finally { setCanceling(false) }
  }

  async function handleCancelAsCredit() {
    if (!id || !order) return
    setCanceling(true)
    try {
      await orderApi.cancel(id, false, null, true, { silent: true })
      toast.success('Скасовано, передоплата залишена як кредит клієнту')
      setCancelModal(false)
      load()
    } catch (error) { toast.error(getErrorMessage(error, 'Не вдалося скасувати замовлення')) } finally { setCanceling(false) }
  }

  async function handlePrintItemLabelConfirm() {
    if (!selectedOrderItem || printingLabel) return

    setPrintingLabel(true)
    try {
      let catalogProduct: Product | null = null
      if (selectedOrderItem.product_id) {
        try {
          catalogProduct = (await productApi.get(selectedOrderItem.product_id)).data
        } catch {
          // Позицію замовлення все одно можна надрукувати без картки каталогу.
        }
      }

      const now = new Date().toISOString()
      const labelProduct: Product = {
        id: catalogProduct?.id ?? selectedOrderItem.product_id ?? selectedOrderItem.id,
        sku: selectedOrderItem.sku || catalogProduct?.sku || '',
        name: selectedOrderItem.name || catalogProduct?.name || 'Товар',
        barcode: catalogProduct?.barcode || selectedOrderItem.sku || null,
        additional_barcodes: catalogProduct?.additional_barcodes ?? null,
        brand_id: catalogProduct?.brand_id ?? null,
        category_id: catalogProduct?.category_id ?? null,
        unit: catalogProduct?.unit ?? 'шт',
        purchase_price: selectedOrderItem.buy_price,
        retail_price: selectedOrderItem.sell_price,
        qty_on_hand: catalogProduct?.qty_on_hand ?? 0,
        reorder_point: catalogProduct?.reorder_point ?? 0,
        notes: catalogProduct?.notes ?? null,
        is_active: catalogProduct?.is_active ?? true,
        is_service: selectedOrderItem.item_type === 'service',
        storage_bin: catalogProduct?.storage_bin ?? null,
        is_favorite: catalogProduct?.is_favorite ?? false,
        photo_url: catalogProduct?.photo_url ?? null,
        specs: catalogProduct?.specs ?? null,
        created_at: catalogProduct?.created_at ?? now,
        updated_at: catalogProduct?.updated_at ?? now,
      }

      const settings = await loadProductLabelSettings()
      const copies = Math.max(1, Math.min(999, Math.floor(Number(itemLabelCopies) || 1)))
      await printLabels(
        settings,
        Array.from({ length: copies }, () => labelProduct),
        false,
      )
      setItemLabelModal(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося надрукувати етикетку')
    } finally {
      setPrintingLabel(false)
    }
  }

  if (loading) return <Layout title="Замовлення"><div className="text-center py-20 text-gray-400">Завантаження...</div></Layout>
  if (!order) return null

  const conf = STATUS_CONFIG[order.status] ?? { label: order.status, color: 'gray' as const }
  const totalPaid = order.total_paid ?? order.prepayment
  // Скасоване замовлення не має «залишку до сплати» — обов'язань немає
  const remaining = order.status === 'canceled' ? 0 : order.total_amount - totalPaid
  const allArrived = order.items.every((i) => ['arrived', 'handed', 'canceled', 'returned'].includes(i.item_status))
  const allHanded  = order.items.every((i) => ['handed', 'canceled', 'returned'].includes(i.item_status))
  const terminal    = isTerminalOrderStatus(order.status)
  const canComplete = allArrived && !allHanded && !terminal
  const canCancel   = !terminal
  const isDraft     = order.status === 'quoted' || (order.status === 'lead' && (order.source === 'mobile_draft' || order.items.some((item) => (item as { is_draft_note?: boolean }).is_draft_note)))
  // Звичайне (не чернетка, не завершене/скасоване) замовлення можна редагувати
  // напряму — раніше кнопки редагування тут не було взагалі
  const canEdit     = !isDraft && !terminal
  const hasPendingWarehouseItems = order.items.some((i) => i.source_type === 'warehouse' && i.item_status === 'pending')

  return (
    <Layout
      title={`Замовлення ${formatOrderNo(order)} від ${formatDate(order.created_at)}`}
      onBack={() => navigate('/orders')}
      actions={
        <div className="flex gap-1.5 md:gap-2 items-center">
          {isDraft && (
            <Button icon={<FilePen size={15} />} onClick={() => navigate('/quotes/' + id)}>
              <span className="hidden sm:inline">Редагувати КП</span>
            </Button>
          )}
          {canEdit && (
            <Button variant="secondary" icon={<Pencil size={15} />} onClick={() => navigate(`/orders/${id}/edit`)}>
              <span className="hidden sm:inline">Редагувати</span>
            </Button>
          )}
          {order.status === 'completed' && order.sale_id && (
            <>
              <Button variant="secondary" onClick={() => navigate(`/returns?saleId=${order.sale_id}&orderId=${id}`)}>
                ↩️ <span className="hidden sm:inline">Повернути</span>
              </Button>
              <Button variant="secondary" onClick={() => navigate(`/returns?saleId=${order.sale_id}&exchangeOrderId=${id}`)}>
                🔁 <span className="hidden sm:inline">Обміняти</span>
              </Button>
            </>
          )}
          {canComplete && (
            <Button onClick={openOrderPaymentInPos} className="bg-green-600 hover:bg-green-700 text-white">
              {remaining > 0 ? <>💰<span className="hidden sm:inline">&nbsp;Оплата / видача в касі</span></> : <>📦<span className="hidden sm:inline">&nbsp;Видати товар</span></>}
            </Button>
          )}
          {hasPendingWarehouseItems && !terminal && (
            <Button className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold" onClick={() => navigate(`/inventory/picking?orderId=${id}`)}>
              📦<span className="hidden sm:inline">&nbsp;Зібрати</span>
            </Button>
          )}

          {/* Випадаюче меню для другорядних дій */}
          <div className="relative">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setActionsOpen(!actionsOpen); }}
              className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl hover:bg-gray-100 transition-colors text-sm font-semibold flex items-center gap-1 text-gray-700 shadow-sm"
            >
              Дії <ChevronDown size={14} className={`transition-transform duration-200 ${actionsOpen ? 'rotate-180' : ''}`} />
            </button>

            {actionsOpen && (
              <div className="absolute right-0 mt-1.5 w-52 bg-white border border-gray-150 rounded-xl shadow-lg py-1.5 z-30 focus:outline-none animate-in fade-in slide-in-from-top-1 duration-100">
                <button
                  onClick={() => startRepeatOrder(order, navigate)}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 font-medium"
                >
                  🔄 Повторити замовлення
                </button>
                <button
                  onClick={() => {
                    try {
                      printPickingList(order as any)
                    } catch (err) {
                      console.error(err)
                      toast.error('Не вдалося надрукувати збірочний лист. Перевірте, чи не заблоковані спливаючі вікна.')
                    }
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 font-medium"
                >
                  📋 Збірочний лист
                </button>
                <button
                  onClick={() => {
                    try {
                      printOrderReceipt(order)
                    } catch (err) {
                      console.error(err)
                      toast.error('Не вдалося надрукувати квитанцію. Перевірте, чи не заблоковані спливаючі вікна.')
                    }
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 font-medium"
                >
                  🖨 Квитанція
                </button>
                <button
                  onClick={() => {
                    const seller = loadSellerRequisites()
                    if (!hasSellerRequisites(seller)) toast.warning('Реквізити продавця не заповнені (Налаштування → Реквізити продавця)')
                    try {
                      printInvoice(order, seller)
                    } catch (err) {
                      console.error(err)
                      toast.error('Не вдалося сформувати рахунок. Перевірте, чи не заблоковані спливаючі вікна.')
                    }
                    setActionsOpen(false)
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 font-medium"
                >
                  🧾 Рахунок-фактура
                </button>
                <button
                  onClick={() => {
                    const seller = loadSellerRequisites()
                    if (!hasSellerRequisites(seller)) toast.warning('Реквізити продавця не заповнені (Налаштування → Реквізити продавця)')
                    try {
                      printDeliveryNote(order, seller)
                    } catch (err) {
                      console.error(err)
                      toast.error('Не вдалося сформувати накладну. Перевірте, чи не заблоковані спливаючі вікна.')
                    }
                    setActionsOpen(false)
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 font-medium"
                >
                  📄 Видаткова накладна
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(orderMessengerText(order))
                      .then(() => toast.success('Скопійовано для месенджера'))
                      .catch(() => toast.error('Не вдалося скопіювати'))
                    setActionsOpen(false)
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 font-medium"
                >
                  💬 Копіювати для месенджера
                </button>
                <button
                  onClick={() => {
                    const text = [
                      `Замовлення ${formatOrderNo(order)}`,
                      order.customer ? `Клієнт: ${order.customer.full_name ?? order.customer.phone}` : '',
                      ...order.items.map((i) => `• ${i.name}${i.sku ? ` (${i.sku})` : ''} — ${i.qty} × ${formatMoney(i.sell_price)}`),
                      `Разом: ${formatMoney(order.total_amount)}`,
                      remaining > 0 ? `До сплати: ${formatMoney(remaining)}` : '',
                    ].filter(Boolean).join('\n')
                    navigator.clipboard.writeText(text)
                      .then(() => toast.success('Реквізити скопійовано'))
                      .catch(() => toast.error('Не вдалося скопіювати'))
                    setActionsOpen(false)
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 font-medium"
                >
                  📋 Копіювати реквізити
                </button>
                {order.chat_id && (
                  <button
                    onClick={() => navigate(`/orders?tab=bots&chat_id=${order.chat_id}`)}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 font-medium"
                  >
                    💬 Чат
                  </button>
                )}
                {canCancel && (
                  <div className="border-t border-gray-100 my-1" />
                )}
                {canCancel && (
                  <button
                    onClick={() => setCancelModal(true)}
                    className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 font-semibold"
                  >
                    ❌ Скасувати замовлення
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      }
    >
      <div className="mx-auto max-w-[1400px] space-y-5">

        {/* Шапка */}
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                {canCancel && !isDraft ? (
                  <select
                    value={order.status}
                    onChange={(e) => handleOrderStatus(e.target.value as CustomerOrderStatus)}
                    className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-800 outline-none focus:ring-2 focus:ring-yellow-400"
                    aria-label="Загальний статус замовлення"
                  >
                    {(['lead', 'new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready'] as CustomerOrderStatus[]).map((status) => (
                      <option key={status} value={status}>{STATUS_CONFIG[status]?.label ?? status}</option>
                    ))}
                  </select>
                ) : <Badge color={conf.color}>{conf.label}</Badge>}
                {order.source === 'messenger' && <MessageSquare size={14} className="text-blue-400" />}
                {order.source === 'phone' && <Phone size={14} className="text-green-400" />}
                <span className="text-xs text-gray-400">{formatDate(order.created_at)}</span>
              </div>

              <div className="text-sm text-gray-600 space-y-1">
                {order.customer ? (
                  <div className="flex flex-wrap items-center gap-x-2">
                    <button onClick={openCustomerEditor}
                      className="font-medium text-blue-600 hover:underline" title="Швидко змінити ім’я або телефон">
                      {order.customer.full_name ?? order.customer.phone}
                    </button>
                    {order.customer.full_name && order.customer.phone && (
                      <span className="inline-flex items-center gap-1">
                        <a href={`tel:${order.customer.phone}`} className="inline-flex items-center gap-1 font-mono text-gray-600 hover:text-gray-900">
                          <Phone size={13} /> {order.customer.phone}
                        </a>
                        <button type="button" onClick={() => {
                          navigator.clipboard.writeText(order.customer?.phone ?? '')
                          toast.success('Телефон скопійовано')
                        }} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Скопіювати телефон">
                          <Copy size={12} />
                        </button>
                        <button type="button" onClick={openCustomerEditor} className="text-xs font-medium text-blue-600 hover:underline">
                          змінити
                        </button>
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-gray-400">Клієнт не вказаний</div>
                )}

                {/* Автомобіль замовлення */}
                {order.vehicle_info && (
                  <div className="space-y-1">
                    <div>🚗 {[order.vehicle_info.make, order.vehicle_info.model, order.vehicle_info.year].filter(Boolean).join(' ') || 'Автомобіль'}</div>
                    {order.vehicle_info.vin && (
                      <button type="button" onClick={() => {
                        navigator.clipboard.writeText(order.vehicle_info?.vin ?? '')
                        toast.success('VIN скопійовано')
                      }} className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-2.5 py-1.5 font-mono text-sm font-bold tracking-wider text-gray-900 hover:bg-gray-200">
                        VIN {order.vehicle_info.vin} <Copy size={13} />
                      </button>
                    )}
                  </div>
                )}

                {order.comment ? (
                  <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 italic text-amber-900">📝 {order.comment}</div>
                ) : null}
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
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-800">Позиції замовлення</h3>
          </div>

          {order.items.length === 0 ? (
            <p className="text-sm text-gray-400">Позиції відсутні</p>
          ) : (
            <div className="space-y-2.5">
              {order.items.map((item) => {
                const actions = ITEM_STATUS_ACTIONS[item.item_status]
                return (
                  <div key={item.id} className="flex flex-col md:flex-row md:items-center justify-between bg-gray-50 rounded-xl p-4 text-sm gap-3 shadow-sm border border-gray-100/50">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2 flex-wrap">
                        <span className="font-semibold text-gray-900 leading-snug">{item.name}</span>
                        {item.sku && <span className="text-gray-400 text-xs font-mono bg-white px-1.5 py-0.5 rounded border border-gray-100">{item.sku}</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <Badge color={ITEM_STATUS_COLOR[item.item_status]}>{itemStatusLabel(item)}</Badge>
                        {item.expected_date && (
                          <span className={`text-xs ${new Date(item.expected_date) < new Date() ? 'text-red-500 font-medium' : 'text-gray-400'}`}>
                            ⏳ Очікується: {formatDate(item.expected_date)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between md:justify-end gap-3 shrink-0 pt-3 md:pt-0 border-t md:border-t-0 border-gray-200/60">
                      <span className="text-gray-950 text-sm font-semibold">{item.qty} × {formatMoney(item.sell_price)}</span>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button onClick={() => { setSelectedOrderItem(item); setItemLabelCopies(Math.ceil(item.qty)); setItemLabelModal(true); }}
                          className="text-xs px-2.5 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 active:bg-gray-100 transition-colors flex items-center gap-1 text-gray-700 font-medium shadow-sm"
                          title="Друк етикетки замовлення">
                          🏷️ <span className="md:hidden lg:inline">Етикетка</span>
                        </button>
                        {actions?.map((action) => (
                          <button key={action.status} onClick={() => handleItemStatus(item.id, action.status)}
                            className="text-xs px-2.5 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 active:bg-gray-100 transition-colors font-medium shadow-sm">
                            {action.icon} {action.label}
                          </button>
                        ))}
                      </div>
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
            {!terminal && (
              <Button size="sm" variant="secondary" onClick={openOrderPaymentInPos}>
                {canComplete && remaining <= 0 ? 'Видати товар через касу' : 'Оплата / видача через касу'}
              </Button>
            )}
          </div>
          {!terminal && (
            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Гроші за замовлення приймаються тільки в касі, а видача товару закривається там же: так оплата потрапляє у зміну, ПРРО, журнал і зарплатні нарахування менеджера.
            </div>
          )}

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
            {order.prepayment > 0 && order.prepayment_method && (
              <div className="flex justify-between text-gray-500">
                <span>Тип передоплати:</span>
                <span className="font-medium">
                  {order.prepayment_method === 'cash' ? 'Готівка' : order.prepayment_method === 'card' ? 'Картка' : 'Переказ'}
                </span>
              </div>
            )}
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
                          {e.user_name && (
                            <span className="text-gray-500 text-xs font-semibold" title={e.user_phone}>
                              ({e.user_name})
                            </span>
                          )}
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

      {/* Модал скасування */}
      <Modal open={cancelModal} onClose={() => setCancelModal(false)} title="Скасувати замовлення" size="sm">
        {order && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {totalPaid > 0
                ? `Оплачено: ${formatMoney(totalPaid)}. Що робити з грошима?`
                : 'Ви впевнені, що хочете скасувати це замовлення?'}
            </p>
            {totalPaid > 0 ? (
              <div className="space-y-2">
                <Button onClick={() => handleCancel(true)} loading={canceling} className="w-full bg-red-600 hover:bg-red-700 text-white">
                  💰 Повернути {formatMoney(totalPaid)}
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

      <QuickCustomerEditModal
        customer={quickCustomer}
        open={customerEditorOpen}
        onClose={() => setCustomerEditorOpen(false)}
        onSaved={(customer) => {
          setQuickCustomer(customer)
          setOrder((current) => current ? {
            ...current,
            customer: current.customer ? {
              ...current.customer,
              phone: customer.phone,
              full_name: customer.full_name,
            } : current.customer,
          } : current)
        }}
      />
    </Layout>
  )
}

