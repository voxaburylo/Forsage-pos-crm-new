import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ClipboardList, Printer, CheckCircle, Clock, CheckSquare, Barcode, Search } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Badge, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatDate } from '@/lib/utils'
import { pickingApi, type EnrichedCustomerOrder, type EnrichedOrderItem } from './pickingApi'
import { printPickingList } from '@/features/orders/PickingListPrint'
import { DEFAULT_BIN_LABEL, loadProductLabelSettings, printLabels } from '@/features/labels/LabelDesigner'
import { playSuccessBeep, playWarning, playErrorTone } from '@/lib/audioService'

function PickingSteps({ active }: { active: 1 | 2 | 3 }) {
  const steps = [
    ['1', 'Оберіть замовлення', 'Відкрийте замовлення, яке можна збирати'],
    ['2', 'Зберіть товари', 'Йдіть за комірками та підтверджуйте позиції'],
    ['3', 'Покладіть у комірку видачі', 'Вкажіть, де касир знайде готове замовлення'],
  ] as const

  return (
    <div className="grid gap-2 md:grid-cols-3">
      {steps.map(([number, title, description], index) => {
        const step = (index + 1) as 1 | 2 | 3
        const done = step < active
        const current = step === active
        return (
          <div key={number} className={`rounded-xl border px-3 py-3 ${
            current ? 'border-yellow-300 bg-yellow-50' : done ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'
          }`}>
            <div className="flex items-start gap-2.5">
              <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                current ? 'bg-yellow-400 text-gray-900' : done ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-600'
              }`}>{done ? '✓' : number}</span>
              <div>
                <p className="text-sm font-semibold text-gray-800">{title}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-gray-500">{description}</p>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function WarehousePicking() {
  const [searchParams, setSearchParams] = useSearchParams()
  const orderId = searchParams.get('orderId')

  const [orders, setOrders] = useState<EnrichedCustomerOrder[]>([])
  const [loadingOrders, setLoadingOrders] = useState(false)

  const [currentOrder, setCurrentOrder] = useState<EnrichedCustomerOrder | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  // Поля для завершення збірки (введення ячейки)
  const [cellModalOpen, setCellModalOpen] = useState(false)
  const [pickupCell, setPickupCell] = useState('')
  const [savingCell, setSavingCell] = useState(false)

  // Пошук, фільтрація та сканування штрих-кодів
  const [filterTab, setFilterTab] = useState<'all' | 'ready' | 'pending_supplier'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [barcodeInput, setBarcodeInput] = useState('')

  // Завантажити список замовлень на збірку
  async function loadOrders() {
    setLoadingOrders(true)
    try {
      const res = await pickingApi.listOrders()
      setOrders(res.data ?? [])
    } catch {
      toast.error('Помилка завантаження списку збірки')
    } finally {
      setLoadingOrders(false)
    }
  }

  // Завантажити деталі вибраного замовлення
  async function loadOrderDetail(id: string) {
    setLoadingDetail(true)
    try {
      const res = await pickingApi.getOrderDetails(id)
      setCurrentOrder(res.data)
      setPickupCell(res.data.pickup_cell || '')
    } catch {
      toast.error('Помилка завантаження деталей замовлення')
      setSearchParams({})
    } finally {
      setLoadingDetail(false)
    }
  }

  useEffect(() => {
    if (orderId) {
      loadOrderDetail(orderId)
    } else {
      setCurrentOrder(null)
      loadOrders()
    }
  }, [orderId])

  // Позначити позицію як зібрану / не зібрану
  async function handlePickItem(item: EnrichedOrderItem, isPicked: boolean) {
    if (!currentOrder) return
    const newStatus: EnrichedOrderItem['item_status'] = isPicked ? 'arrived' : 'pending'
    try {
      await pickingApi.pickItem(item.id, newStatus)
      if (isPicked) {
        playSuccessBeep()
        toast.success('Товар зібрано')
      } else {
        playWarning()
        toast.success('Статус товару скинуто')
      }
      
      // Локально оновлюємо статус, щоб користувач бачив миттєвий результат
      const updatedItems = currentOrder.items.map(i => 
        i.id === item.id ? { ...i, item_status: newStatus } : i
      )
      
      // Завершувати збірку можна лише коли зібрано склад і вже надійшли
      // всі позиції постачальників.
      const allWarehousePicked = updatedItems
        .filter(i => i.source_type === 'warehouse')
        .every(i => i.item_status === 'arrived' || i.item_status === 'handed')
      const allSupplierItemsReady = updatedItems
        .filter(i => i.source_type === 'supplier')
        .every(i => i.item_status === 'arrived' || i.item_status === 'handed' || i.item_status === 'canceled')

      setCurrentOrder({ ...currentOrder, items: updatedItems })

      if (allWarehousePicked && isPicked) {
        if (allSupplierItemsReady) {
          setCellModalOpen(true)
        } else {
          playWarning()
          toast.warning('Складські товари зібрані. Завершити замовлення можна після надходження позицій постачальника.')
        }
      }
    } catch (err: any) {
      playErrorTone()
      toast.error(err?.message || 'Помилка оновлення статусу збірки')
    }
  }

  // Позначити позицію постачальника («під замовлення») як таку, що надійшла / ні.
  // Раніше ці позиції були лише для перегляду — комплектацію не можна було завершити.
  async function handleSupplierArrival(item: EnrichedOrderItem, arrived: boolean) {
    if (!currentOrder) return
    const newStatus: EnrichedOrderItem['item_status'] = arrived ? 'arrived' : 'pending'
    try {
      await pickingApi.pickItem(item.id, newStatus)
      if (arrived) { playSuccessBeep(); toast.success('Позицію позначено як «Надійшло»') }
      else { playWarning(); toast.success('Статус позиції скинуто') }

      const updatedItems = currentOrder.items.map((i) => i.id === item.id ? { ...i, item_status: newStatus } : i)
      setCurrentOrder({ ...currentOrder, items: updatedItems })

      const allWarehousePicked = updatedItems
        .filter((i) => i.source_type === 'warehouse')
        .every((i) => i.item_status === 'arrived' || i.item_status === 'handed')
      const allSupplierReady = updatedItems
        .filter((i) => i.source_type === 'supplier')
        .every((i) => i.item_status === 'arrived' || i.item_status === 'handed' || i.item_status === 'canceled')
      if (arrived && allWarehousePicked && allSupplierReady) setCellModalOpen(true)
    } catch (err: any) {
      playErrorTone()
      toast.error(err?.message || 'Помилка оновлення статусу позиції')
    }
  }

  // Зібрати всі товари складу в один клік
  async function handlePickAll() {
    if (!currentOrder) return
    const pendingItems = currentOrder.items.filter(i => i.source_type === 'warehouse' && i.item_status === 'pending')
    if (pendingItems.length === 0) return
    if (!window.confirm(`Позначити як зібрані всі складські позиції (${pendingItems.length})?`)) return

    setLoadingDetail(true)
    try {
      for (const item of pendingItems) {
        await pickingApi.pickItem(item.id, 'arrived')
      }
      playSuccessBeep()
      toast.success('Усі складські позиції позначено як зібрані')
      
      await loadOrderDetail(currentOrder.id)
      const supplierReady = currentOrder.items
        .filter(i => i.source_type === 'supplier')
        .every(i => i.item_status === 'arrived' || i.item_status === 'handed' || i.item_status === 'canceled')
      if (supplierReady) {
        setCellModalOpen(true)
      } else {
        playWarning()
        toast.warning('Очікуємо позиції постачальника. Комірку видачі можна буде вказати після їх надходження.')
      }
    } catch (err: any) {
      playErrorTone()
      toast.error(err?.message || 'Не вдалося зібрати всі позиції')
      await loadOrderDetail(currentOrder.id)
    } finally {
      setLoadingDetail(false)
    }
  }

  // Обробка сканування штрих-коду
  async function handleBarcodeScan(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const code = barcodeInput.trim().toUpperCase()
      if (!code || !currentOrder) return

      const target = currentOrder.items.find(i => 
        i.source_type === 'warehouse' && 
        i.item_status === 'pending' && 
        (i.sku?.toUpperCase() === code || i.sku?.toUpperCase().replace(/\W/g, '') === code.replace(/\W/g, ''))
      )

      if (target) {
        await handlePickItem(target, true)
        setBarcodeInput('')
      } else {
        playErrorTone()
        toast.error(`Товар з артикулом "${code}" не знайдено серед незібраних позицій складу`)
      }
    }
  }

  // Розрахунок статусу готовності деталей постачальника
  function getOrderReadyStatus(order: EnrichedCustomerOrder) {
    const supplierItems = order.items.filter(i => i.source_type === 'supplier')
    if (supplierItems.length === 0) return 'ready'
    const allArrived = supplierItems.every(i =>
      i.item_status === 'arrived' || i.item_status === 'handed' || i.item_status === 'canceled'
    )
    return allArrived ? 'ready' : 'pending_supplier'
  }

  function getItemStatusLabel(status: EnrichedOrderItem['item_status']) {
    return {
      pending: 'Очікує',
      ordered: 'Замовлено',
      arrived: 'Надійшло',
      handed: 'Видано',
      canceled: 'Скасовано',
    }[status]
  }

  // Зберегти ячейку видачі
  async function printPickupCellLabel(cell: string) {
    const cleanCell = cell.trim()
    if (!cleanCell) return
    try {
      const settings = await loadProductLabelSettings()
      const binSettings = settings.bin_settings || DEFAULT_BIN_LABEL
      await printLabels(binSettings as any, [{ label: cleanCell }], true)
      toast.success('Етикетку комірки відправлено на друк')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося надрукувати етикетку комірки')
    }
  }
  async function handleSaveCell(e: React.FormEvent, printAfterSave = false) {
    e.preventDefault()
    if (!currentOrder || !pickupCell.trim()) {
      toast.error('Вкажіть комірку видачі')
      return
    }
    const allReady = currentOrder.items.every(i =>
      i.item_status === 'arrived' || i.item_status === 'handed' || i.item_status === 'canceled'
    )
    if (!allReady) {
      toast.error('Не всі позиції готові. Спочатку зберіть складські товари та дочекайтеся постачальника.')
      return
    }
    setSavingCell(true)
    try {
      const cell = pickupCell.trim()
      await pickingApi.updatePickupCell(currentOrder.id, cell)
      if (printAfterSave) await printPickupCellLabel(cell)
      toast.success('Комірку видачі збережено, замовлення готове до видачі!')
      setCellModalOpen(false)
      // Повертаємось до списку збірки
      setSearchParams({})
    } catch (err: any) {
      toast.error(err?.message || 'Не вдалося зберегти комірку')
    } finally {
      setSavingCell(false)
    }
  }

  // Друк сліпу збірки
  function handlePrintSlip() {
    if (currentOrder) {
      printPickingList(currentOrder)
    }
  }

  if (orderId) {
    // ЕКРАН ЗБІРКИ КОНКРЕТНОГО ЗАМОВЛЕННЯ
    if (loadingDetail) {
      return (
        <Layout title="Збірка замовлення">
          <div className="text-center py-20 text-gray-400">Завантаження деталей замовлення...</div>
        </Layout>
      )
    }

    if (!currentOrder) {
      return (
        <Layout title="Збірка замовлення">
          <div className="text-center py-20 text-gray-400">Замовлення не знайдено</div>
        </Layout>
      )
    }

    const warehouseItems = currentOrder.items
      .filter(i => i.source_type === 'warehouse')
      .sort((a, b) => {
        if (!a.storage_bin && !b.storage_bin) return 0
        if (!a.storage_bin) return 1
        if (!b.storage_bin) return -1
        return a.storage_bin.localeCompare(b.storage_bin, undefined, { numeric: true, sensitivity: 'base' })
      })
    const supplierItems = currentOrder.items.filter(i => i.source_type === 'supplier')
    
    const pickedCount = warehouseItems.filter(i => i.item_status === 'arrived' || i.item_status === 'handed').length
    const totalCount = warehouseItems.length
    // Замовлення може складатися лише з позицій «під замовлення» (без складу) —
    // тоді складська частина вважається готовою автоматично.
    const warehouseFinished = totalCount === 0 ? true : pickedCount === totalCount
    const suppliersReady = supplierItems.every(i =>
      i.item_status === 'arrived' || i.item_status === 'handed' || i.item_status === 'canceled'
    )
    const isFinished = warehouseFinished && suppliersReady

    return (
      <Layout 
        title={`Комплектація #${currentOrder.id.slice(0, 8)}`}
        onBack={() => setSearchParams({})}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" icon={<Printer size={15} />} onClick={handlePrintSlip}>
              Друк листа
            </Button>
            {currentOrder.pickup_cell && (
              <Button variant="secondary" icon={<Printer size={15} />} onClick={() => printPickupCellLabel(currentOrder.pickup_cell!)}>
                Друк комірки
              </Button>
            )}
            {isFinished && (
              <Button onClick={() => setCellModalOpen(true)} className="bg-green-600 hover:bg-green-700 text-white font-medium">
                Вказати комірку
              </Button>
            )}
          </div>
        }
      >
        <div className="max-w-4xl space-y-6">
          <PickingSteps active={isFinished ? 3 : 2} />

          {/* Картка замовлення */}
          <Card>
            <div className="flex justify-between items-start flex-wrap gap-4">
              <div>
                <h3 className="font-bold text-lg text-gray-900">
                  #{currentOrder.id.slice(0, 8)}
                  {currentOrder.kp_number && <span className="text-gray-400 font-normal ml-2">({currentOrder.kp_number})</span>}
                </h3>
                <p className="text-sm text-gray-500 mt-1">
                  Створено: {formatDate(currentOrder.created_at)}
                </p>
                {currentOrder.customer && (
                  <p className="text-sm text-gray-700 mt-2 font-medium">
                    Клієнт: {currentOrder.customer.full_name || 'Невідомо'} ({currentOrder.customer.phone})
                  </p>
                )}
                {currentOrder.pickup_cell && (
                  <div className="mt-3">
                    <Badge color="green">Комірка: {currentOrder.pickup_cell}</Badge>
                  </div>
                )}
              </div>
              <div className="text-right shrink-0">
                <span className="text-xs text-gray-400 block mb-1">Взято зі складу</span>
                <div className="text-2xl font-bold text-gray-900">
                  {pickedCount} / {totalCount}
                </div>
                <div className="w-32 bg-gray-200 h-2 rounded-full overflow-hidden mt-2 ml-auto">
                  <div 
                    className="bg-green-500 h-full transition-all duration-300"
                    style={{ width: `${totalCount > 0 ? (pickedCount / totalCount) * 100 : 0}%` }}
                  />
                </div>
              </div>
            </div>
            {currentOrder.comment && (
              <div className="mt-4 italic text-sm text-gray-500 border-t border-gray-100 pt-3">
                Коментар: {currentOrder.comment}
              </div>
            )}
          </Card>

          {/* Панель сканування штрих-кодів */}
          <Card className="shadow-sm border border-gray-100 bg-[#1A1A1A] p-4 flex flex-col sm:flex-row gap-3 items-center">
            <div className="flex items-center gap-2 text-yellow-400 shrink-0">
              <Barcode size={22} />
              <span className="text-xs font-bold text-gray-300 uppercase tracking-wider">Штрих-код / Артикул:</span>
            </div>
            <div className="relative flex-1 w-full">
              <input
                type="text"
                placeholder="Введіть або відскануйте артикул (натисніть Enter)..."
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                onKeyDown={handleBarcodeScan}
                className="w-full bg-[#242424] border border-gray-800 focus:border-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-400 text-white rounded-lg px-3 py-2 text-sm font-semibold transition"
                autoFocus
              />
            </div>
            {barcodeInput && (
              <Button size="sm" variant="secondary" onClick={() => setBarcodeInput('')} className="shrink-0">
                Очистити
              </Button>
            )}
          </Card>

          {/* Список товарів для збірки */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-gray-800 text-sm uppercase tracking-wider flex items-center gap-2">
                <ClipboardList size={16} /> Позиції зі складу
              </h4>
              {warehouseItems.filter(i => i.item_status === 'pending').length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handlePickAll}
                  className="font-semibold text-xs py-1.5 px-3 rounded-lg flex items-center gap-1"
                >
                  Позначити всі як зібрані
                </Button>
              )}
            </div>

            {warehouseItems.length === 0 ? (
              <Card>
                <p className="text-gray-400 text-center py-6 text-sm">У цьому замовленні немає товарів зі складу</p>
              </Card>
            ) : (
              <div className="space-y-2">
                {warehouseItems.map(item => {
                  const isPicked = item.item_status === 'arrived' || item.item_status === 'handed'
                  return (
                    <div 
                      key={item.id} 
                      className={`flex items-center justify-between border rounded-xl p-4 transition-all ${
                        isPicked 
                          ? 'bg-green-50/50 border-green-200' 
                          : 'bg-white border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex-1 min-w-0 pr-4">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-gray-900 text-sm md:text-base leading-snug">
                            {item.name}
                          </span>
                          {item.storage_bin ? (
                            <span className="px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 font-bold text-xs">
                              Комірка: {item.storage_bin}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded bg-red-50 text-red-700 text-xs italic">
                              Комірка не вказана
                            </span>
                          )}
                        </div>
                        <div className="flex gap-4 mt-1.5 text-xs text-gray-500">
                          {item.sku && (
                            <span>Артикул: <strong className="font-mono text-gray-700">{item.sku}</strong></span>
                          )}
                          <span>Кількість: <strong className="text-gray-700 text-sm">{item.qty} шт</strong></span>
                        </div>
                      </div>
                      <div className="shrink-0">
                        {isPicked ? (
                          <Button 
                            variant="secondary" 
                            className="bg-green-100 hover:bg-green-200 text-green-800 border-none flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold"
                            onClick={() => handlePickItem(item, false)}
                          >
                            <CheckCircle size={14} /> Зібрано · скасувати
                          </Button>
                        ) : (
                          <Button 
                            onClick={() => handlePickItem(item, true)}
                            className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold px-4 py-2 text-xs flex items-center gap-1"
                          >
                            <CheckSquare size={14} /> Взято зі складу
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Товари під замовлення (Supplier) */}
          {supplierItems.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-semibold text-gray-500 text-sm uppercase tracking-wider flex items-center gap-2">
                <Clock size={16} /> Позиції під замовлення від постачальників
              </h4>
              <div className="space-y-2">
                {supplierItems.map(item => {
                  const arrived = item.item_status === 'arrived' || item.item_status === 'handed'
                  const canceled = item.item_status === 'canceled'
                  return (
                    <div key={item.id} className={`flex items-center justify-between border rounded-xl p-4 text-sm transition-all ${arrived ? 'bg-green-50/50 border-green-200' : 'bg-gray-50 border-gray-200'}`}>
                      <div className="min-w-0 pr-4">
                        <div className="font-medium text-gray-800">{item.name}</div>
                        <div className="flex gap-4 mt-1.5 text-xs text-gray-400 flex-wrap">
                          {item.sku && <span>Арт: <strong className="font-mono">{item.sku}</strong></span>}
                          <span>Кількість: <strong>{item.qty} шт</strong></span>
                          {item.expected_date && <span>Очікуємо: <strong>{formatDate(item.expected_date)}</strong></span>}
                          <span>Статус: <Badge color={arrived ? 'green' : canceled ? 'gray' : 'yellow'}>{getItemStatusLabel(item.item_status)}</Badge></span>
                        </div>
                      </div>
                      {!canceled && (
                        <div className="shrink-0">
                          {arrived ? (
                            <Button
                              variant="secondary"
                              className="bg-green-100 hover:bg-green-200 text-green-800 border-none flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold"
                              onClick={() => handleSupplierArrival(item, false)}
                            >
                              <CheckCircle size={14} /> Надійшло · скасувати
                            </Button>
                          ) : (
                            <Button
                              onClick={() => handleSupplierArrival(item, true)}
                              className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold px-4 py-2 text-xs flex items-center gap-1"
                            >
                              <CheckSquare size={14} /> Надійшло
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Модалка для введення ячейки видачі */}
        <Modal 
          open={cellModalOpen} 
          onClose={() => setCellModalOpen(false)} 
          title="Вкажіть комірку тимчасового зберігання"
          size="sm"
        >
          <form onSubmit={handleSaveCell} className="space-y-4">
            <p className="text-sm text-gray-600">
              Усі позиції готові. Покладіть замовлення в окрему комірку або на полицю видачі та вкажіть її номер — касир побачить це місце під час видачі.
            </p>
            <Input 
              label="Комірка видачі *" 
              value={pickupCell} 
              onChange={(e) => setPickupCell(e.target.value)} 
              placeholder="Наприклад: А-5, Полиця 2, Стіл"
              required 
              autoFocus 
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" loading={savingCell} className="flex-1 bg-green-600 hover:bg-green-700">
                Зберегти
              </Button>
              <Button type="button" loading={savingCell} variant="secondary" onClick={(event) => handleSaveCell(event, true)} icon={<Printer size={15} />}>
                Зберегти і друк
              </Button>
              <Button type="button" variant="secondary" onClick={() => setCellModalOpen(false)}>
                Закрити
              </Button>
            </div>
          </form>
        </Modal>
      </Layout>
    )
  }

  // Фільтрація та пошук замовлень
  const filteredOrders = orders.filter(order => {
    const q = searchQuery.toLowerCase().trim()
    if (q) {
      const orderIdMatch = order.id.toLowerCase().includes(q)
      const custNameMatch = order.customer?.full_name?.toLowerCase().includes(q)
      const custPhoneMatch = order.customer?.phone?.includes(q)
      const commentMatch = order.comment?.toLowerCase().includes(q)
      if (!orderIdMatch && !custNameMatch && !custPhoneMatch && !commentMatch) {
        return false
      }
    }

    const status = getOrderReadyStatus(order)
    if (filterTab === 'ready') return status === 'ready'
    if (filterTab === 'pending_supplier') return status === 'pending_supplier'
    return true
  })

  // ЕКРАН СПИСКУ ЗАМОВЛЕНЬ НА ЗБІРКУ
  return (
    <Layout title="Збірка замовлень">
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Черга для комірника: взяти товари зі складу, скласти одне замовлення разом і передати його в зону видачі.
          </p>
        </div>

        <PickingSteps active={1} />

        <div className="rounded-xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-xs leading-relaxed text-blue-900">
          <strong>Важливо:</strong> товари постачальника тут не потрібно шукати на складі.
          Якщо замовлення «очікує постачальника», складську частину можна підготувати, але завершити комплектацію —
          лише після надходження всіх позицій.
        </div>

        <Card className="shadow-sm border border-gray-100 bg-white">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            {/* Пошук по замовленнях */}
            <div className="w-full md:w-1/2 relative">
              <input
                type="text"
                placeholder="Пошук за № замовлення, коментарем або ім'ям/телефоном клієнта..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full border border-gray-200 focus:border-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-400 rounded-lg pl-9 pr-3 py-2 text-sm bg-gray-50 focus:bg-white transition"
              />
              <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
            </div>

            {/* Вкладки фільтрів */}
            <div className="flex bg-gray-100 p-1 rounded-lg w-full md:w-auto self-stretch md:self-auto gap-1">
              <button
                type="button"
                onClick={() => setFilterTab('all')}
                className={`flex-1 md:flex-initial px-3.5 py-1.5 text-xs font-semibold rounded-md transition-all ${
                  filterTab === 'all'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Всі ({orders.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('ready')}
                className={`flex-1 md:flex-initial px-3.5 py-1.5 text-xs font-semibold rounded-md transition-all ${
                  filterTab === 'ready'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Можна збирати ({orders.filter(o => getOrderReadyStatus(o) === 'ready').length})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab('pending_supplier')}
                className={`flex-1 md:flex-initial px-3.5 py-1.5 text-xs font-semibold rounded-md transition-all ${
                  filterTab === 'pending_supplier'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Очікують постачальника ({orders.filter(o => getOrderReadyStatus(o) === 'pending_supplier').length})
              </button>
            </div>
          </div>
        </Card>

        <Card padding="none">
          {loadingOrders ? (
            <div className="text-center py-20 text-gray-400 text-sm">Завантаження списку...</div>
          ) : filteredOrders.length === 0 ? (
            <div className="text-center py-20 text-gray-400 text-sm">
              <CheckCircle size={32} className="mx-auto text-green-500 mb-2 opacity-50" />
              Нічого не знайдено за поточними критеріями
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredOrders.map(order => {
                const warehouseItems = order.items.filter(i => i.source_type === 'warehouse')
                const pickedCount = warehouseItems.filter(i =>
                  i.item_status === 'arrived' || i.item_status === 'handed'
                ).length
                const isReady = getOrderReadyStatus(order) === 'ready'

                return (
                  <div key={order.id} className="p-4 flex items-center justify-between hover:bg-gray-50/50 transition-colors flex-wrap gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button 
                          onClick={() => setSearchParams({ orderId: order.id })}
                          className="font-bold text-gray-950 hover:text-yellow-600 text-sm md:text-base text-left"
                        >
                          Замовлення #{order.id.slice(0, 8)}
                        </button>
                        <Badge color={order.status === 'ordered' ? 'yellow' : 'gray'}>
                          {order.status === 'ordered' ? 'Замовлено' : 'Нове'}
                        </Badge>
                        {isReady ? (
                          <Badge color="green">
                            Можна збирати
                          </Badge>
                        ) : (
                          <Badge color="yellow">
                            Очікує постачальника
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 flex gap-3 flex-wrap">
                        <span>Створено: {formatDate(order.created_at)}</span>
                        {order.customer && (
                          <span className="text-gray-600 font-medium">
                            Клієнт: {order.customer.full_name || 'Невідомо'} ({order.customer.phone})
                          </span>
                        )}
                      </div>
                      {order.comment && (
                        <p className="text-xs italic text-gray-400 max-w-md truncate">Коментар: {order.comment}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right shrink-0">
                        <span className="text-[11px] text-gray-400 block">Товари складу</span>
                        <span className="font-semibold text-sm text-gray-800">
                          Зібрано {pickedCount} з {warehouseItems.length}
                        </span>
                      </div>
                      <Button 
                        size="sm" 
                        onClick={() => setSearchParams({ orderId: order.id })}
                        className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold text-xs"
                      >
                        {pickedCount > 0 ? 'Продовжити збірку' : 'Почати збірку'}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>
    </Layout>
  )
}
