import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, Database, Check } from 'lucide-react'
import { supplierImportsApi } from './supplierImportsApi'
import type { SupplierCatalogItem } from './supplierImportsApi'
import { supplierApi } from './supplierApi'
import { Layout } from '@/components/Layout'
import { Button, Card, SearchInput, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

export default function SupplierPricesPage() {
  const navigate = useNavigate()
  
  const [items, setItems] = useState<SupplierCatalogItem[]>([])
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [supplierId, setSupplierId] = useState<string>('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importedSkus, setImportedSkus] = useState<Set<string>>(new Set())

  // Load suppliers on mount
  useEffect(() => {
    supplierApi.list({ per_page: 200 })
      .then((r) => setSuppliers(r.data || []))
      .catch(() => toast.error('Помилка завантаження постачальників'))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await supplierImportsApi.getCatalog({
        q: search || undefined,
        supplier_id: supplierId || undefined,
        page,
        limit: 25
      })
      setItems(res.data || [])
      setTotal(res.pagination?.total || 0)
    } catch {
      toast.error('Помилка завантаження каталогу прайсів')
    } finally {
      setLoading(false)
    }
  }, [search, supplierId, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search, supplierId])

  const handleImport = async (item: SupplierCatalogItem) => {
    setImportingId(item.id)
    try {
      const res = await supplierImportsApi.importOnDemand({
        sku: item.sku,
        brand: item.brand || '',
        name: item.name,
        supplier_id: item.supplier?.id || null,
        purchase_price: item.price_kopecks
      })
      if (res.data) {
        toast.success(`Товар "${item.name}" успішно імпортовано в каталог!`)
        setImportedSkus(prev => {
          const next = new Set(prev)
          next.add(item.sku)
          return next
        })
      }
    } catch (err: any) {
      toast.error(err.message || 'Помилка імпорту товару')
    } finally {
      setImportingId(null)
    }
  }

  const columns = [
    {
      key: 'sku', header: 'Артикул',
      render: (item: SupplierCatalogItem) => (
        <span className="font-mono text-sm text-gray-800 font-semibold">{item.sku}</span>
      )
    },
    {
      key: 'brand', header: 'Бренд',
      render: (item: SupplierCatalogItem) => (
        <span className="text-gray-600">{item.brand || '—'}</span>
      )
    },
    {
      key: 'name', header: 'Назва',
      render: (item: SupplierCatalogItem) => (
        <span className="text-gray-900 font-medium">{item.name}</span>
      )
    },
    {
      key: 'price', header: 'Ціна (закупка)',
      render: (item: SupplierCatalogItem) => (
        <span className="font-bold text-gray-800">
          {(item.price_kopecks / 100).toFixed(2)} грн
        </span>
      )
    },
    {
      key: 'qty', header: 'Кількість',
      render: (item: SupplierCatalogItem) => (
        <span className="text-sm text-gray-600">{item.qty || '0'}</span>
      )
    },
    {
      key: 'supplier', header: 'Постачальник',
      render: (item: SupplierCatalogItem) => (
        <span className="text-sm text-gray-500 font-semibold">{item.supplier?.name || '—'}</span>
      )
    },
    {
      key: 'warehouse_name', header: 'Склад/Джерело',
      render: (item: SupplierCatalogItem) => (
        <span className="text-sm text-gray-500 font-medium">{item.warehouse_name || '—'}</span>
      )
    },
    {
      key: 'actions', header: '', className: 'w-44 text-right',
      render: (item: SupplierCatalogItem) => {
        const isImported = importedSkus.has(item.sku)
        return (
          <Button
            size="sm"
            variant={isImported ? 'secondary' : 'primary'}
            onClick={() => handleImport(item)}
            disabled={importingId === item.id}
            className="flex items-center gap-1.5 ml-auto"
          >
            {isImported ? (
              <>
                <Check size={14} className="text-green-600" />
                <span>Імпортовано</span>
              </>
            ) : (
              <>
                <Database size={14} />
                <span>В основний каталог</span>
              </>
            )}
          </Button>
        )
      }
    }
  ]

  const pages = Math.ceil(total / 25) || 1

  return (
    <Layout
      title="Номенклатура замовних позицій"
      actions={
        <Button
          onClick={() => navigate('/suppliers/bulk-import')}
          className="flex items-center gap-2"
        >
          <Upload size={18} />
          <span>Імпортувати прайс (CSV)</span>
        </Button>
      }
    >
      <Card className="mb-6 shadow-sm border border-gray-100 bg-white">
        <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="w-full md:w-1/3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Пошук за артикулом або назвою..."
            />
          </div>
          <div className="w-full md:w-1/4">
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 transition"
            >
              <option value="">Усі постачальники</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <Card className="shadow-md border border-gray-100 bg-white">
        {loading && items.length === 0 ? (
          <div className="py-20 text-center text-gray-400">Завантаження позицій...</div>
        ) : items.length === 0 ? (
          <div className="py-20 text-center text-gray-400">
            Прайс-листи постачальників не знайдено. Будь ласка, імпортуйте CSV прайс-лист.
          </div>
        ) : (
          <>
            <Table
              data={items}
              columns={columns}
              keyFn={(item) => item.id}
              loading={loading}
            />
            {pages > 1 && (
              <div className="flex justify-between items-center mt-4 pt-4 border-t border-gray-100">
                <span className="text-sm text-gray-500">
                  Показано {items.length} з {total} позицій
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page === 1}
                    onClick={() => setPage(page - 1)}
                  >
                    Назад
                  </Button>
                  <span className="text-sm text-gray-600 flex items-center px-2">
                    {page} / {pages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page === pages}
                    onClick={() => setPage(page + 1)}
                  >
                    Вперед
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </Layout>
  )
}
