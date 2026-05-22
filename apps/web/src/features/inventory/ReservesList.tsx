import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search, Trash2, Calendar, ShieldAlert, User, ShoppingBag, Box } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Button, Card, Table, Badge, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatDate } from '@/lib/utils'
import { productApi } from '@/features/products/productApi'
import { customerApi } from '@/features/customers/customerApi'
import type { Product } from '@/types/product'
import type { Customer } from '@/types/customer'

interface Reserve {
  id: string
  tenant_id: string
  product_id: string
  order_id: string | null
  customer_id: string | null
  qty: number
  reserved_by: string
  expires_at: string | null
  released_at: string | null
  created_at: string
  product?: {
    id: string
    name: string
    sku: string
  } | null
  customer?: {
    id: string
    full_name: string
    phone: string
  } | null
  order?: {
    id: string
    number: string
    status: string
  } | null
  user?: {
    id: string
    full_name: string
  } | null
}

export default function ReservesList() {
  const [reserves, setReserves] = useState<Reserve[]>([])
  const [loading, setLoading] = useState(true)
  
  // Search and filter
  const [searchQuery, setSearchQuery] = useState('')

  // Create Reserve Modal State
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  
  // Create Reserve Form Fields
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [productSearch, setProductSearch] = useState('')
  const [productResults, setProductResults] = useState<Product[]>([])
  
  const [qty, setQty] = useState('1')
  
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerResults, setCustomerResults] = useState<Customer[]>([])
  
  const [orderId, setOrderId] = useState('')
  const [expiresAt, setExpiresAt] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 3)
    return d.toISOString().substring(0, 16) // Format as YYYY-MM-DDTHH:MM
  })

  // Load active reserves
  async function loadReserves() {
    setLoading(true)
    try {
      const { data } = await api.get<{ data: Reserve[] }>('/api/v1/reserves')
      setReserves(data)
    } catch {
      toast.error('Помилка завантаження списку резервів')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadReserves()
  }, [])

  // Product autocomplete search
  const handleProductSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setProductResults([])
      return
    }
    try {
      const res = await productApi.list({ search: q, per_page: 5 })
      setProductResults(res.data)
    } catch {
      setProductResults([])
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => handleProductSearch(productSearch), 300)
    return () => clearTimeout(t)
  }, [productSearch, handleProductSearch])

  // Customer autocomplete search
  const handleCustomerSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setCustomerResults([])
      return
    }
    try {
      const res = await customerApi.list({ search: q, per_page: 5 })
      setCustomerResults(res.data)
    } catch {
      setCustomerResults([])
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => handleCustomerSearch(customerSearch), 300)
    return () => clearTimeout(t)
  }, [customerSearch, handleCustomerSearch])

  // Cancel/Release Reserve
  async function handleCancelReserve(id: string) {
    if (!confirm('Ви впевнені, що хочете зняти цей резерв?')) return
    try {
      await api.delete(`/api/v1/reserves/${id}`)
      toast.success('Резерв успішно знято')
      loadReserves()
    } catch (err: any) {
      toast.error(err.response?.data?.error?.message || 'Помилка при знятті резерву')
    }
  }

  // Submit manual reserve
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedProduct) {
      toast.error('Будь ласка, виберіть товар')
      return
    }

    const numQty = parseFloat(qty)
    if (isNaN(numQty) || numQty <= 0) {
      toast.error('Вкажіть коректну кількість')
      return
    }

    setCreating(true)
    try {
      await api.post('/api/v1/reserves', {
        product_id: selectedProduct.id,
        qty: numQty,
        customer_id: selectedCustomer?.id || null,
        order_id: orderId.trim() || null,
        expires_at: new Date(expiresAt).toISOString()
      })

      toast.success('Резерв успішно створено')
      setCreateModalOpen(false)
      // Reset form
      setSelectedProduct(null)
      setProductSearch('')
      setQty('1')
      setSelectedCustomer(null)
      setCustomerSearch('')
      setOrderId('')
      loadReserves()
    } catch (err: any) {
      toast.error(err.response?.data?.error?.message || 'Помилка при створенні резерву')
    } finally {
      setCreating(false)
    }
  }

  // Filter reserves client-side
  const filteredReserves = reserves.filter(r => {
    const query = searchQuery.toLowerCase().trim()
    if (!query) return true
    
    const productName = r.product?.name?.toLowerCase() || ''
    const productSku = r.product?.sku?.toLowerCase() || ''
    const customerName = r.customer?.full_name?.toLowerCase() || ''
    const orderNumber = r.order?.number?.toLowerCase() || ''
    
    return productName.includes(query) || 
           productSku.includes(query) || 
           customerName.includes(query) || 
           orderNumber.includes(query)
  })

  // Columns definition
  const columns = [
    {
      key: 'product',
      header: 'Товар',
      render: (r: Reserve) => (
        <div>
          {r.product ? (
            <Link to={`/products/${r.product.id}`} className="font-medium text-gray-900 hover:text-yellow-700 transition-colors">
              {r.product.name}
            </Link>
          ) : (
            <span className="text-gray-400">Невідомий товар</span>
          )}
          <div className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
            <Box size={12} />
            <span>SKU: {r.product?.sku || 'N/A'}</span>
          </div>
        </div>
      )
    },
    {
      key: 'qty',
      header: 'Кількість',
      className: 'w-24 text-right font-semibold text-gray-900',
      render: (r: Reserve) => `${r.qty} шт`
    },
    {
      key: 'customer_order',
      header: 'Клієнт / Замовлення',
      render: (r: Reserve) => (
        <div className="space-y-1">
          {r.customer && (
            <div className="text-sm font-medium text-gray-900 flex items-center gap-1">
              <User size={13} className="text-gray-400" />
              <span>{r.customer.full_name}</span>
            </div>
          )}
          {r.order ? (
            <Link to={`/customer-orders/${r.order.id}`} className="inline-flex items-center gap-1 text-xs text-amber-600 hover:text-amber-800 font-medium bg-amber-50 px-1.5 py-0.5 rounded">
              <ShoppingBag size={11} />
              Замовлення #{r.order.number}
            </Link>
          ) : (
            !r.customer && <span className="text-gray-400 text-xs">—</span>
          )}
        </div>
      )
    },
    {
      key: 'expires_at',
      header: 'Термін дії',
      render: (r: Reserve) => {
        if (!r.expires_at) return <Badge color="gray">Безстроково</Badge>
        const date = new Date(r.expires_at)
        const isExpired = date.getTime() <= Date.now()
        const isExpiringSoon = !isExpired && (date.getTime() - Date.now() < 24 * 3600 * 1000)
        
        return (
          <div>
            <div className="flex items-center gap-1.5">
              <Calendar size={13} className={isExpired ? 'text-red-400' : 'text-gray-400'} />
              <span className={`text-sm ${isExpired ? 'text-red-600 font-medium' : 'text-gray-700'}`}>
                {formatDate(r.expires_at)}
              </span>
            </div>
            {isExpired && <span className="text-[10px] text-red-500 font-semibold uppercase block mt-0.5">Прострочено</span>}
            {isExpiringSoon && <span className="text-[10px] text-amber-500 font-semibold uppercase block mt-0.5">Скоро закінчиться</span>}
          </div>
        )
      }
    },
    {
      key: 'reserved_by',
      header: 'Хто зарезервував',
      render: (r: Reserve) => (
        <div>
          <span className="text-sm text-gray-700 font-medium">{r.user?.full_name || 'Менеджер'}</span>
          <div className="text-[11px] text-gray-400 mt-0.5">Створено: {formatDate(r.created_at)}</div>
        </div>
      )
    },
    {
      key: 'actions',
      header: '',
      className: 'w-20 text-right',
      render: (r: Reserve) => (
        <button
          onClick={() => handleCancelReserve(r.id)}
          className="text-gray-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50 transition-all"
          title="Скасувати бронь"
        >
          <Trash2 size={16} />
        </button>
      )
    }
  ]

  return (
    <Layout title="Резерви товарів">
      <div className="space-y-4">
        {/* Top Control Bar */}
        <div className="flex flex-col sm:flex-row gap-3 justify-between items-stretch sm:items-center">
          <div className="relative flex-1 max-w-md">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
              <Search size={16} />
            </span>
            <input
              type="text"
              placeholder="Пошук за товаром, SKU, клієнтом чи замовленням..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500 transition-all bg-white"
            />
          </div>
          <Button
            icon={<Plus size={16} />}
            onClick={() => setCreateModalOpen(true)}
            className="shadow-sm bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-medium border-0 transition-all"
          >
            Створити резерв
          </Button>
        </div>

        {/* Reserves Table */}
        <Card padding="none" className="overflow-hidden border border-gray-100 shadow-sm rounded-xl">
          <Table
            columns={columns}
            data={filteredReserves}
            keyFn={(r) => r.id}
            loading={loading}
            empty={
              <div className="text-center py-16 space-y-3">
                <div className="inline-flex p-3 bg-amber-50 text-amber-500 rounded-full">
                  <ShieldAlert size={24} />
                </div>
                <h3 className="text-sm font-semibold text-gray-900">Немає активних резервів</h3>
                <p className="text-xs text-gray-400 max-w-xs mx-auto">
                  Усі зарезервовані товари будуть відображатися тут до моменту їх списання чи закінчення терміну дії.
                </p>
              </div>
            }
          />
        </Card>
      </div>

      {/* Create Reserve Modal */}
      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Створення ручного резерву"
        size="md"
      >
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          {/* Product Search */}
          <div className="space-y-1 relative">
            <label className="block text-sm font-semibold text-gray-700">Товар *</label>
            {selectedProduct ? (
              <div className="flex items-center justify-between p-3 bg-amber-50/50 border border-amber-200 rounded-lg">
                <div>
                  <div className="text-sm font-medium text-gray-900">{selectedProduct.name}</div>
                  <div className="text-xs text-gray-500">SKU: {selectedProduct.sku} | Доступно: {selectedProduct.qty_on_hand} {selectedProduct.unit}</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => setSelectedProduct(null)}>Змінити</Button>
              </div>
            ) : (
              <div>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                    <Search size={14} />
                  </span>
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder="Введіть назву або SKU товару..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
                {productResults.length > 0 && (
                  <div className="absolute z-50 left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
                    {productResults.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setSelectedProduct(p)
                          setProductResults([])
                          setProductSearch('')
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm hover:bg-amber-50 flex items-center justify-between border-b border-gray-50 last:border-0"
                      >
                        <div>
                          <div className="font-medium text-gray-900">{p.name}</div>
                          <div className="text-xs text-gray-400">SKU: {p.sku}</div>
                        </div>
                        <span className="text-xs font-semibold text-gray-500">Залишок: {p.qty_on_hand} {p.unit}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Quantity */}
            <Input
              label="Кількість *"
              type="number"
              step="0.001"
              min="0.001"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="1"
              required
            />

            {/* Expiration Date */}
            <div className="space-y-1">
              <label className="block text-sm font-semibold text-gray-700">Термін дії *</label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                required
              />
            </div>
          </div>

          {/* Customer Search */}
          <div className="space-y-1 relative">
            <label className="block text-sm font-semibold text-gray-700">Клієнт (необов'язково)</label>
            {selectedCustomer ? (
              <div className="flex items-center justify-between p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <div>
                  <div className="text-sm font-medium text-gray-900">{selectedCustomer.full_name}</div>
                  <div className="text-xs text-gray-500">{selectedCustomer.phone}</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => setSelectedCustomer(null)}>Змінити</Button>
              </div>
            ) : (
              <div>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                    <Search size={14} />
                  </span>
                  <input
                    type="text"
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    placeholder="Введіть ім'я або телефон клієнта..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
                {customerResults.length > 0 && (
                  <div className="absolute z-50 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
                    {customerResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSelectedCustomer(c)
                          setCustomerResults([])
                          setCustomerSearch('')
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm hover:bg-amber-50 flex items-center justify-between border-b border-gray-50 last:border-0"
                      >
                        <div>
                          <div className="font-medium text-gray-900">{c.full_name}</div>
                          <div className="text-xs text-gray-400">{c.phone}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Order ID */}
          <Input
            label="ID Замовлення (необов'язково)"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder="Введіть UUID замовлення якщо є"
          />

          <div className="flex gap-3 pt-3 border-t border-gray-100">
            <Button
              type="submit"
              loading={creating}
              disabled={!selectedProduct}
              className="flex-1 bg-amber-500 hover:bg-amber-600 border-0"
            >
              Створити резерв
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setCreateModalOpen(false)
                setSelectedProduct(null)
                setSelectedCustomer(null)
              }}
            >
              Скасувати
            </Button>
          </div>
        </form>
      </Modal>
    </Layout>
  )
}
