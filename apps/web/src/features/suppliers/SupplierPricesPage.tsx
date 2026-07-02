import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, Check, Plus, Pencil, Trash2 } from 'lucide-react'
import { supplierImportsApi } from './supplierImportsApi'
import type { SupplierCatalogItem } from './supplierImportsApi'
import { supplierApi } from './supplierApi'
import { Layout } from '@/components/Layout'
import { Button, Card, SearchInput, Table, Modal, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

export default function SupplierPricesPage() {
  const navigate = useNavigate()
  
  const [items, setItems] = useState<SupplierCatalogItem[]>([])
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [supplierId, setSupplierId] = useState<string>('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  
  const [loading, setLoading] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importedSkus, setImportedSkus] = useState<Set<string>>(new Set())

  // Modal State for Create/Edit
  const [modalOpen, setModalOpen] = useState(false)
  const [editItem, setEditItem] = useState<SupplierCatalogItem | null>(null)
  
  const [formSku, setFormSku] = useState('')
  const [formBrand, setFormBrand] = useState('')
  const [formName, setFormName] = useState('')
  const [formPrice, setFormPrice] = useState('')
  const [formQty, setFormQty] = useState('0')
  const [formWarehouse, setFormWarehouse] = useState('')
  const [formSupplierId, setFormSupplierId] = useState('')
  const [saving, setSaving] = useState(false)

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
      // setTotal(res.pagination?.total || 0)
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

  const openCreateModal = () => {
    setEditItem(null)
    setFormSku('')
    setFormBrand('')
    setFormName('')
    setFormPrice('')
    setFormQty('0')
    setFormWarehouse('')
    setFormSupplierId('')
    setModalOpen(true)
  }

  const openEditModal = (item: SupplierCatalogItem) => {
    setEditItem(item)
    setFormSku(item.sku)
    setFormBrand(item.brand || '')
    setFormName(item.name)
    setFormPrice((item.price_kopecks / 100).toString())
    setFormQty(item.qty || '0')
    setFormWarehouse(item.warehouse_name || '')
    setFormSupplierId(item.supplier?.id || '')
    setModalOpen(true)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Ви впевнені, що хочете видалити цей чорновий товар?')) return
    try {
      await supplierImportsApi.deleteCatalogItem(id)
      toast.success('Позицію видалено')
      load()
    } catch {
      toast.error('Помилка видалення позиції')
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formSku.trim() || !formName.trim()) {
      toast.error('Артикул та назва обов’язкові')
      return
    }
    const priceKopecks = Math.round(parseFloat(formPrice || '0') * 100)
    
    setSaving(true)
    try {
      const payload = {
        sku: formSku.trim(),
        brand: formBrand.trim() || undefined,
        name: formName.trim(),
        price_kopecks: priceKopecks,
        qty: formQty.trim(),
        warehouse_name: formWarehouse.trim() || undefined,
        supplier_id: formSupplierId || null
      }
      
      if (editItem) {
        await supplierImportsApi.updateCatalogItem(editItem.id, payload)
        toast.success('Товар оновлено')
      } else {
        await supplierImportsApi.createCatalogItem(payload)
        toast.success('Товар додано')
      }
      setModalOpen(false)
      load()
    } catch (err: any) {
      toast.error(err.message || 'Помилка збереження товару')
    } finally {
      setSaving(false)
    }
  }

  const columns: any[] = [
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
      key: 'qty', header: 'Кіл-сть',
      render: (item: SupplierCatalogItem) => (
        <span className="text-gray-600 font-mono text-xs">{item.qty || '0'}</span>
      )
    },
    {
      key: 'supplier', header: 'Постачальник',
      render: (item: SupplierCatalogItem) => (
        <span className="text-gray-500 text-xs font-medium">{item.supplier?.name || '—'}</span>
      )
    },
    {
      key: 'actions', header: '',
      render: (item: SupplierCatalogItem) => {
        const isImported = importedSkus.has(item.sku)
        return (
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => openEditModal(item)}
              className="p-1 text-gray-400 hover:text-gray-600 transition"
              title="Редагувати"
              type="button"
            >
              <Pencil size={15} />
            </button>
            <button
              onClick={() => handleDelete(item.id)}
              className="p-1 text-gray-400 hover:text-red-600 transition"
              title="Видалити"
              type="button"
            >
              <Trash2 size={15} />
            </button>
            <Button
              size="sm"
              variant={isImported ? 'secondary' : 'primary'}
              loading={importingId === item.id}
              disabled={isImported}
              onClick={() => handleImport(item)}
              className="text-xs py-1 px-2.5"
            >
              {isImported ? (
                <span className="flex items-center gap-1"><Check size={12} /> Імпортовано</span>
              ) : 'Створити товар у каталозі'}
            </Button>
          </div>
        )
      }
    }
  ]

  return (
    <Layout title="Чернова номенклатура">
      <div className="space-y-4">
        {/* Header toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
          <div className="flex-1 flex flex-col sm:flex-row gap-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Пошук за артикулом або назвою..."
              className="w-full sm:max-w-xs"
            />
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 transition"
            >
              <option value="">— Всі постачальники —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              icon={<Upload size={16} />}
              onClick={() => navigate('/settings/draft-nomenclature/import')}
            >
              Імпорт з Excel
            </Button>
            <Button
              variant="primary"
              icon={<Plus size={16} />}
              onClick={openCreateModal}
            >
              Додати вручну
            </Button>
          </div>
        </div>

        {/* Catalog Table */}
        <Card className="p-0 overflow-hidden border border-gray-100">
          <Table data={items} columns={columns} loading={loading} keyFn={(item) => item.id} />
        </Card>
      </div>

      {/* Create / Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editItem ? 'Редагувати чорнову позицію' : 'Створити чорнову позицію'}
        size="md"
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Артикул *"
              value={formSku}
              onChange={(e) => setFormSku(e.target.value)}
              placeholder="12345"
              required
            />
            <Input
              label="Бренд"
              value={formBrand}
              onChange={(e) => setFormBrand(e.target.value)}
              placeholder="Bosch"
            />
          </div>
          
          <Input
            label="Назва товару *"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Фільтр масляний"
            required
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Ціна закупівлі (грн)"
              type="number"
              step="0.01"
              value={formPrice}
              onChange={(e) => setFormPrice(e.target.value)}
              placeholder="0.00"
            />
            <Input
              label="Кількість (строка)"
              value={formQty}
              onChange={(e) => setFormQty(e.target.value)}
              placeholder=">10"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Назва складу / опис"
              value={formWarehouse}
              onChange={(e) => setFormWarehouse(e.target.value)}
              placeholder="Склад Одеса"
            />
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Постачальник</label>
              <select
                value={formSupplierId}
                onChange={(e) => setFormSupplierId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white"
              >
                <option value="">— Без постачальника —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-3 pt-3 border-t border-gray-100">
            <Button
              type="submit"
              loading={saving}
              className="flex-1"
            >
              Зберегти
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setModalOpen(false)}
            >
              Скасувати
            </Button>
          </div>
        </form>
      </Modal>
    </Layout>
  )
}
