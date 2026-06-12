import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ClipboardList, Printer, CheckCircle, Clock, CheckSquare, Barcode, Search } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Badge, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatDate } from '@/lib/utils'
import { pickingApi, type EnrichedCustomerOrder, type EnrichedOrderItem } from './pickingApi'
import { printPickingList } from '@/features/orders/PickingListPrint'
import { playSuccessBeep, playWarning, playErrorTone } from '@/lib/audioService'

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
      
      // Перевіряємо, чи всі товари складу зібрані
      const allPicked = updatedItems
        .filter(i => i.source_type === 'warehouse')
        .every(i => i.item_status === 'arrived')

      setCurrentOrder({ ...currentOrder, items: updatedItems })

      if (allPicked && isPicked) {
        // Якщо це був останній складський товар, відкриваємо модалку для ячейки
        setCellModalOpen(true)
      }
    } catch (err: any) {
      playErrorTone()
      toast.error(err?.message || 'Помилка оновлення статусу збірки')
    }
  }

  // Зібрати всі товари складу в один клік
  async function handlePickAll() {
    if (!currentOrder) return
    const pendingItems = currentOrder.items.filter(i => i.source_type === 'warehouse' && i.item_status === 'pending')
    if (pendingItems.length === 0) return

    setLoadingDetail(true)
    try {
      for (const item of pendingItems) {
        await pickingApi.pickItem(item.id, 'arrived')
      }
      playSuccessBeep()
      toast.success('Всі позиції зі складу відмічено як зібрані!')
      
      await loadOrderDetail(currentOrder.id)
      setCellModalOpen(true)
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
    const allArrived = supplierItems.every(i => i.item_status === 'arrived' || i.item_status === 'handed')
    return allArrived ? 'ready' : 'pending_supplier'
  }

  // Зберегти ячейку видачі
  async function handleSaveCell(e: React.FormEvent) {
    e.preventDefault()
    if (!currentOrder || !pickupCell.trim()) {
      toast.error('Вкажіть ячейку видачі')
      return
    }
    setSavingCell(true)
    try {
      await pickingApi.updatePickupCell(currentOrder.id, pickupCell.trim())
      toast.success('Ячейку видачі збережено, замовлення готове до видачі!')
      setCellModalOpen(false)
      // Повертаємось до списку збірки
      setSearchParams({})
    } catch (err: any) {
      toast.error(err?.message || 'Не вдалося зберегти ячейку')
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
    
    const pickedCount = warehouseItems.filter(i => i.item_status === 'arrived').length
    const totalCount = warehouseItems.length
    const isFinished = pickedCount === totalCount && totalCount > 0

    return (
      <Layout 
        title={`Збірка замовлення #${currentOrder.id.slice(0, 8)}`}
        onBack={() => setSearchParams({})}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" icon={<Printer size={15} />} onClick={handlePrintSlip}>
              Друк листа
            </Button>
            {isFinished && (
              <Button onClick={() => setCellModalOpen(true)} className="bg-green-600 hover:bg-green-700 text-white font-medium">
                Вказати комірку
              </Button>
            )}
          </div>
        }
      >
        <div className="max-w-3xl space-y-6">
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
                <span className="text-xs text-gray-400 block mb-1">Прогрес збірки</span>
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
                  variant="primary"
                  onClick={handlePickAll}
                  className="bg-green-600 hover:bg-green-700 text-white font-semibold text-xs py-1.5 px-3 rounded-lg flex items-center gap-1"
                >
                  ⚡ Зібрати всі товари
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
                            <CheckCircle size={14} /> Зібрано
                          </Button>
                        ) : (
                          <Button 
                            onClick={() => handlePickItem(item, true)}
                            className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold px-4 py-2 text-xs flex items-center gap-1"
                          >
                            <CheckSquare size={14} /> Зібрати
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
              <div className="space-y-2 opacity-75">
                {supplierItems.map(item => (
                  <div key={item.id} className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm">
                    <div>
                      <div className="font-medium text-gray-800">{item.name}</div>
                      <div className="flex gap-4 mt-1.5 text-xs text-gray-400">
                        {item.sku && <span>Арт: <strong className="font-mono">{item.sku}</strong></span>}
                        <span>Кількість: <strong>{item.qty} шт</strong></span>
                        <span>Статус: <Badge color={item.item_status === 'arrived' ? 'green' : 'yellow'}>{item.item_status}</Badge></span>
                      </div>
                    </div>
                    <div className="text-xs text-gray-400 italic">
                      Не потребує збірки зі складу
                    </div>
                  </div>
                ))}
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
              Всі позиції зі складу зібрано! Вкажіть комірку, в яку ви поклали це замовлення, щоб менеджер міг швидко знайти його при видачі.
            </p>
            <Input 
              label="Комірка видачі *" 
              value={pickupCell} 
              onChange={(e) => setPickupCell(e.target.value)} 
              placeholder="Наприклад: А-5, Полиця 2, Стіл"
              required 
              autoFocus 
            />
            <div className="flex gap-3">
              <Button type="submit" loading={savingCell} className="flex-1 bg-green-600 hover:bg-green-700">
                Завершити збірку
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
    <Layout title="Збірка замовлень (WMS)">
      <div className="max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Тут відображаються замовлення, які містять складські товари та потребують комплектації.
          </p>
          <Button size="sm" variant="secondary" onClick={loadOrders} loading={loadingOrders}>
            Оновити
          </Button>
        </div>

        {/* Пояснення логіки збірки */}
        <div className="bg-blue-50/60 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-900/80 leading-relaxed">
          <span className="font-semibold">Як це працює:</span> комірник відкриває замовлення →
          сканує або відмічає кожну позицію зі складу як «зібрано» (можна друкувати лист збірки з комірками) →
          вкінці вводить № комірки видачі, куди поклав зібране. Після цього замовлення готове до видачі на касі.
          «Очікують деталі» — позиції, які ще їдуть від постачальника.
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
                Готові ({orders.filter(o => getOrderReadyStatus(o) === 'ready').length})
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
                Очікують деталі ({orders.filter(o => getOrderReadyStatus(o) === 'pending_supplier').length})
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
                const pendingWarehouseItems = warehouseItems.filter(i => i.item_status === 'pending')
                const pickedCount = warehouseItems.length - pendingWarehouseItems.length
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
                            Готово до комплектації
                          </Badge>
                        ) : (
                          <Badge color="yellow">
                            Очікує деталей
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
                        Складати
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
