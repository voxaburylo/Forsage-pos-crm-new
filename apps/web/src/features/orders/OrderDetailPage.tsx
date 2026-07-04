import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Phone, MessageSquare, FilePen, DollarSign, ChevronDown, Pencil, Copy } from 'lucide-react'
import { api } from '@/lib/api'
import { orderApi, type CustomerOrder, type CustomerOrderStatus, type ItemStatus } from './orderApi'
import { formatOrderNo, startRepeatOrder } from './orderActions'
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
import { QuickCustomerEditModal } from '@/features/customers/QuickCustomerEditModal'
import { customerApi } from '@/features/customers/customerApi'
import type { Customer } from '@/types/customer'

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

// Редагована копія позиції для inline-редагування прямо на картці
interface DraftEditItem {
  id?: string
  name: string
  sku: string
  qty: string
  sell_price: string
  supplier_id: string | null
  product_id: string | null
  item_type: 'product' | 'service'
  buy_price: string
  expected_date: string | null
  item_status: ItemStatus
}

type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'

const STATUS_CONFIG: Record<CustomerOrderStatus, { label: string; color: BadgeColor }> = {
  lead:       { label: 'Лід',        color: 'blue'   },
  new:        { label: 'Нове',       color: 'gray'   },
  in_progress:{ label: 'В роботі',   color: 'yellow' },
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

const ITEM_STATUS_ACTIONS: Record<string, Array<{ status: ItemStatus; label: string; icon: string }>> = {
  pending:  [{ status: 'ordered', label: 'Замовити постачальнику', icon: '📥' }, { status: 'canceled', label: 'Скасувати', icon: '❌' }],
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
  const [inlineAmount, setInlineAmount] = useState('')
  const [inlinePayMethod, setInlinePayMethod] = useState<'cash' | 'card' | 'transfer'>('cash')

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
  const [actionsOpen, setActionsOpen] = useState(false)

  // Inline-редагування позицій та авто прямо на картці (без переходу на форму)
  const [editItems, setEditItems] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftEditItem[]>([])
  const [draftVehicle, setDraftVehicle] = useState({ make: '', model: '', year: '', vin: '' })
  const [draftComment, setDraftComment] = useState('')
  const [savingItems, setSavingItems] = useState(false)
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [quickCustomer, setQuickCustomer] = useState<Customer | null>(null)
  const [customerEditorOpen, setCustomerEditorOpen] = useState(false)

  function startEdit() {
    if (!order) return
    setDraftItems(order.items.map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku ?? '',
      qty: String(i.qty),
      sell_price: (i.sell_price / 100).toFixed(2),
      supplier_id: i.supplier_id,
      product_id: i.product_id,
      item_type: i.item_type,
      buy_price: (i.buy_price / 100).toFixed(2),
      expected_date: i.expected_date,
      item_status: i.item_status,
    })))
    const v = order.vehicle_info
    setDraftVehicle({ make: v?.make ?? '', model: v?.model ?? '', year: v?.year ? String(v.year) : '', vin: v?.vin ?? '' })
    setDraftComment(order.comment ?? '')
    setEditItems(true)
  }

  function updateDraftItem(idx: number, patch: Partial<DraftEditItem>) {
    setDraftItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }
  function addDraftItem() {
    setDraftItems((prev) => [...prev, { name: '', sku: '', qty: '1', sell_price: '0', supplier_id: null, product_id: null, item_type: 'product', buy_price: '0', expected_date: null, item_status: 'pending' }])
  }
  function removeDraftItem(idx: number) {
    setDraftItems((prev) => prev.filter((_, i) => i !== idx))
  }

  async function saveEdit() {
    if (!id) return
    const valid = draftItems.filter((i) => i.name.trim())
    if (valid.length === 0) { toast.error('Додайте хоча б одну позицію з назвою'); return }
    setSavingItems(true)
    try {
      const vehicle_info = (draftVehicle.make || draftVehicle.model || draftVehicle.vin)
        ? {
            make: draftVehicle.make || undefined,
            model: draftVehicle.model || undefined,
            year: draftVehicle.year ? parseInt(draftVehicle.year) : undefined,
            vin: draftVehicle.vin || undefined,
          }
        : null
      await orderApi.update(id, {
        comment: draftComment.trim() || null,
        vehicle_info,
        items: valid.map((i) => ({
          id: i.id,
          name: i.name.trim(),
          sku: i.sku.trim() || null,
          product_id: i.product_id,
          supplier_id: i.supplier_id,
          source_type: i.supplier_id ? 'supplier' : 'warehouse',
          item_type: i.item_type,
          buy_price: Math.round(parseFloat(i.buy_price || '0') * 100),
          sell_price: Math.round(parseFloat(i.sell_price || '0') * 100),
          qty: parseFloat(i.qty) || 1,
          expected_date: i.expected_date,
          item_status: i.item_status,
        })),
      })
      toast.success('Замовлення оновлено')
      setEditItems(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка збереження')
    } finally {
      setSavingItems(false)
    }
  }

  const draftTotal = draftItems.reduce((s, i) => s + (parseFloat(i.sell_price || '0') * (parseFloat(i.qty) || 0)), 0)

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
    api.get<{ data: Array<{ id: string; name: string }> }>('/api/v1/suppliers?per_page=200', { silent: true })
      .then((result) => {
        const seen = new Set<string>()
        setSuppliers((result.data ?? []).filter((supplier) => {
          const key = supplier.name.trim().toLocaleLowerCase('uk-UA')
          if (!key || seen.has(key)) return false
          seen.add(key)
          return true
        }))
      })
      .catch(() => {})
  }, [])

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

  async function handleOrderStatus(status: CustomerOrderStatus) {
    if (!id) return
    try {
      await orderApi.updateStatus(id, status)
      toast.success('Статус замовлення оновлено')
      load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося змінити статус')
    }
  }

  async function handleComplete() {
    if (!id || !order) return
    setPaying(true)
    try {
      const shiftRes = await shiftApi.current().catch(() => ({ data: null }))
      const shiftId = shiftRes.data?.id ?? null

      const inlineCents = Math.round(parseFloat(inlineAmount || '0') * 100)
      if (inlineCents > 0) {
        await api.post(`/api/v1/customer-orders/${id}/payments`, {
          amount: inlineCents,
          method: inlinePayMethod,
          is_fiscal: isFiscal,
          shift_id: shiftId
        })
      }

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
    const rem = order.total_amount - (order.discount_amount ?? 0) - (order.total_paid ?? order.prepayment)
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
      const orderNum = order.order_number != null ? String(order.order_number) : (order.kp_number || order.id.slice(0, 8))
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
  const discount = order.discount_amount ?? 0
  const totalPaid = order.total_paid ?? order.prepayment
  // Скасоване замовлення не має «залишку до сплати» — обов'язань немає
  const remaining = order.status === 'canceled' ? 0 : order.total_amount - discount - totalPaid
  const allArrived = order.items.every((i) => ['arrived', 'handed', 'canceled', 'returned'].includes(i.item_status))
  const allHanded  = order.items.every((i) => ['handed', 'canceled', 'returned'].includes(i.item_status))
  const canComplete = allArrived && !allHanded && !['completed', 'canceled'].includes(order.status)
  const canCancel   = !['completed', 'canceled'].includes(order.status)
  const isDraft     = order.status === 'lead' && ['walk_in', 'mobile_draft'].includes(order.source)
  // Звичайне (не чернетка, не завершене/скасоване) замовлення можна редагувати
  // напряму — раніше кнопки редагування тут не було взагалі
  const canEdit     = !isDraft && !['completed', 'canceled'].includes(order.status)
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
          {canEdit && !editItems && (
            <Button variant="secondary" icon={<Pencil size={15} />} onClick={startEdit}>
              <span className="hidden sm:inline">Редагувати</span>
            </Button>
          )}
          {editItems && (
            <>
              <Button variant="secondary" onClick={() => setEditItems(false)}>Скасувати</Button>
              <Button className="!bg-green-600 hover:!bg-green-700 text-white" loading={savingItems} onClick={saveEdit}>
                Зберегти
              </Button>
            </>
          )}
          {canComplete && !editItems && (
            <Button onClick={() => {
              setPayModal(true);
              setInlineAmount((remaining / 100).toString());
              setInlinePayMethod('cash');
              setPayMethod('cash');
            }} className="bg-green-600 hover:bg-green-700 text-white">
              💰<span className="hidden sm:inline">&nbsp;Видати</span>
            </Button>
          )}
          {hasPendingWarehouseItems && !editItems && !['completed', 'canceled'].includes(order.status) && (
            <Button className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold" onClick={() => navigate(`/inventory/picking?orderId=${id}`)}>
              📦<span className="hidden sm:inline">&nbsp;Зібрати</span>
            </Button>
          )}

          {/* Випадаюче меню для другорядних дій */}
          <div className={`relative ${editItems ? 'hidden' : ''}`}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setActionsOpen(!actionsOpen); }}
              className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl hover:bg-gray-100 transition-colors text-sm font-semibold flex items-center gap-1 text-gray-700 shadow-sm"
            >
              Дії <ChevronDown size={14} className={`transition-transform duration-200 ${actionsOpen ? 'rotate-180' : ''}`} />
            </button>

            {actionsOpen && (
              <div className="absolute right-0 mt-1.5 w-52 bg-white border border-gray-150 rounded-xl shadow-lg py-1.5 z-30 focus:outline-none animate-in fade-in slide-in-from-top-1 duration-100">
                {canEdit && (
                  <button
                    onClick={() => navigate(`/orders/${id}/edit`)}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 font-medium"
                  >
                    📝 Повна форма (клієнт, оплата)
                  </button>
                )}
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
      <div className="mx-auto max-w-6xl space-y-5">

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
                    {(['new', 'in_progress', 'ordered', 'arrived', 'called', 'no_answer', 'ready'] as CustomerOrderStatus[]).map((status) => (
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

                {/* Авто: у режимі редагування — поля, інакше рядок */}
                {editItems ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1 max-w-xl">
                    <input value={draftVehicle.make} onChange={(e) => setDraftVehicle((v) => ({ ...v, make: e.target.value }))} placeholder="Марка"
                      className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-transparent" />
                    <input value={draftVehicle.model} onChange={(e) => setDraftVehicle((v) => ({ ...v, model: e.target.value }))} placeholder="Модель"
                      className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-transparent" />
                    <input value={draftVehicle.year} onChange={(e) => setDraftVehicle((v) => ({ ...v, year: e.target.value }))} placeholder="Рік" inputMode="numeric"
                      className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-transparent" />
                    <input value={draftVehicle.vin} onChange={(e) => setDraftVehicle((v) => ({ ...v, vin: e.target.value.toUpperCase() }))} placeholder="VIN"
                      className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-transparent" />
                  </div>
                ) : order.vehicle_info && (
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

                {editItems ? (
                  <textarea value={draftComment} onChange={(e) => setDraftComment(e.target.value)} rows={2}
                    placeholder="Нотатка до замовлення"
                    className="mt-2 w-full max-w-2xl rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
                ) : order.comment ? (
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
            {editItems && (
              <button onClick={addDraftItem} className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1">
                <span className="text-lg leading-none">+</span> Додати позицію
              </button>
            )}
          </div>

          {editItems ? (
            <div className="overflow-x-auto">
              <div className="min-w-[920px] space-y-2">
                <div className="grid grid-cols-[32px_minmax(180px,1fr)_110px_60px_85px_85px_140px_120px_32px] gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  <span>№</span><span>Назва</span><span>Артикул</span><span>К-сть</span>
                  <span>Закупка</span><span>Продаж</span><span>Постачальник</span><span>Статус</span><span></span>
                </div>
                {draftItems.map((it, idx) => (
                  <div key={it.id ?? `new-${idx}`} className="grid grid-cols-[32px_minmax(180px,1fr)_110px_60px_85px_85px_140px_120px_32px] items-center gap-2 rounded-xl border border-gray-100 bg-gray-50 p-2">
                    <span className="text-center text-sm font-bold text-gray-400">{idx + 1}</span>
                    <input value={it.name} onChange={(e) => updateDraftItem(idx, { name: e.target.value })} placeholder="Назва запчастини"
                      className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
                    <input value={it.sku} onChange={(e) => updateDraftItem(idx, { sku: e.target.value })} placeholder="Артикул"
                      className="rounded-lg border border-gray-200 bg-white px-2.5 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
                    <input type="number" min="0.001" step="any" value={it.qty} onChange={(e) => updateDraftItem(idx, { qty: e.target.value })}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-center text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
                    <input type="number" min="0" step="0.01" value={it.buy_price} onChange={(e) => updateDraftItem(idx, { buy_price: e.target.value })}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-right text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
                    <input type="number" min="0" step="0.01" value={it.sell_price} onChange={(e) => updateDraftItem(idx, { sell_price: e.target.value })}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-right text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
                    <select value={it.supplier_id ?? ''} onChange={(e) => updateDraftItem(idx, { supplier_id: e.target.value || null })}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-400">
                      <option value="">Власний склад</option>
                      {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                    </select>
                    <select value={it.item_status} onChange={(e) => updateDraftItem(idx, { item_status: e.target.value as ItemStatus })}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-400">
                      {Object.entries(ITEM_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <button onClick={() => removeDraftItem(idx)} title="Видалити позицію" className="rounded p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-500">🗑</button>
                  </div>
                ))}
              </div>
              <div className="flex justify-end pt-2 border-t border-gray-100 text-sm">
                <span className="text-gray-500 mr-2">Разом:</span>
                <span className="font-bold text-gray-900">{draftTotal.toFixed(2)} ₴</span>
              </div>
            </div>
          ) : order.items.length === 0 ? (
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
                        <Badge color={ITEM_STATUS_COLOR[item.item_status]}>{ITEM_STATUS_LABEL[item.item_status]}</Badge>
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
            {discount > 0 && (
              <div className="flex justify-between text-red-600 font-semibold">
                <span>Знижка:</span>
                <span>-{formatMoney(discount)}</span>
              </div>
            )}
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

      {/* Модал видачі */}
      <Modal open={payModal} onClose={() => setPayModal(false)} title="Фінальний розрахунок" size="sm">
        {order && (
          <div className="space-y-4">
            <div className="bg-green-50 rounded-xl p-4 space-y-1 text-sm">
              <div className="flex justify-between"><span>Загальна сума:</span><span className="font-bold">{formatMoney(order.total_amount)}</span></div>
              {discount > 0 && (
                <div className="flex justify-between text-red-600 font-semibold"><span>Знижка:</span><span>-{formatMoney(discount)}</span></div>
              )}
              {order.prepayment > 0 && (
                <div className="flex justify-between text-blue-600"><span>Передоплата:</span><span>{formatMoney(order.prepayment)}</span></div>
              )}
              <div className="border-t border-green-200 pt-1 flex justify-between text-lg font-bold">
                <span>До сплати:</span>
                <span className="text-green-700">{formatMoney(Math.max(0, remaining))}</span>
              </div>
            </div>
            {remaining > 0 && (
              <div className="space-y-3">
                <Input
                  label="Внести оплату при видачі (грн)"
                  type="number"
                  min="0"
                  step="0.01"
                  value={inlineAmount}
                  onChange={(e) => setInlineAmount(e.target.value)}
                />
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Метод оплати</label>
                  <select
                    value={inlinePayMethod}
                    onChange={(e) => {
                      const m = e.target.value as 'cash' | 'card' | 'transfer';
                      setInlinePayMethod(m);
                      setPayMethod(m === 'transfer' ? 'cash' : m);
                    }}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    <option value="cash">Готівка</option>
                    <option value="card">Картка</option>
                    <option value="transfer">Переказ</option>
                  </select>
                </div>
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
              {discount > 0 && (
                <div className="flex justify-between text-red-600 font-semibold"><span>Знижка:</span><span>-{formatMoney(discount)}</span></div>
              )}
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
