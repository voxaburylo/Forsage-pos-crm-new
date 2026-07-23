import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { supplierImportsApi, type SupplierCatalogItem } from './supplierImportsApi'
import { normalizeSupplierBarcode } from './supplierImportLocal'
import { supplierApi } from './supplierApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Input, Modal, SearchInput, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

const PAGE_SIZE = 50

export default function SupplierPricesPage() {
  const navigate = useNavigate()
  const localMode = supplierImportsApi.isLocal()
  const [items, setItems] = useState<SupplierCatalogItem[]>([])
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [supplierId, setSupplierId] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [editItem, setEditItem] = useState<SupplierCatalogItem | null>(null)
  const [formSku, setFormSku] = useState('')
  const [formBarcode, setFormBarcode] = useState('')
  const [formBrand, setFormBrand] = useState('')
  const [formName, setFormName] = useState('')
  const [formPrice, setFormPrice] = useState('')
  const [formQty, setFormQty] = useState('0')
  const [formWarehouse, setFormWarehouse] = useState('')
  const [formSupplierId, setFormSupplierId] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supplierApi.list({ per_page: 200 })
      .then((result) => setSuppliers(result.data || []))
      .catch(() => toast.error('Помилка завантаження постачальників'))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await supplierImportsApi.getCatalog({
        q: search || undefined,
        supplier_id: supplierId || undefined,
        page,
        limit: PAGE_SIZE,
      })
      setItems(result.data || [])
      setTotal(result.pagination?.total || 0)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка завантаження каталогу прайсів')
    } finally {
      setLoading(false)
    }
  }, [page, search, supplierId])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search, supplierId])

  function supplierName(item: SupplierCatalogItem): string {
    return item.supplier?.name
      || suppliers.find((supplier) => supplier.id === item.supplier_id)?.name
      || '—'
  }

  async function handleImport(item: SupplierCatalogItem) {
    if (item.match_error) {
      toast.error(item.match_error)
      openEditModal(item)
      return
    }
    setImportingId(item.id)
    try {
      const result = await supplierImportsApi.importOnDemand({
        sku: item.sku,
        barcode: item.barcode,
        brand: item.brand || '',
        name: item.name,
        supplier_id: item.supplier_id ?? item.supplier?.id ?? null,
        purchase_price: item.price_kopecks,
      })
      setItems((current) => current.map((candidate) => candidate.id === item.id
        ? { ...candidate, matched_product_id: result.data.id, match_error: null }
        : candidate))
      const reused = 'reused' in result && result.reused === true
      toast.success(reused ? `Використано наявний товар «${result.data.name}»` : `Товар «${result.data.name}» створено в каталозі`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка імпорту товару')
    } finally {
      setImportingId(null)
    }
  }

  function resetForm() {
    setFormSku('')
    setFormBarcode('')
    setFormBrand('')
    setFormName('')
    setFormPrice('')
    setFormQty('0')
    setFormWarehouse('')
    setFormSupplierId('')
  }

  function openCreateModal() {
    setEditItem(null)
    resetForm()
    setModalOpen(true)
  }

  function openEditModal(item: SupplierCatalogItem) {
    setEditItem(item)
    setFormSku(item.sku)
    setFormBarcode(item.barcode || '')
    setFormBrand(item.brand || '')
    setFormName(item.name)
    setFormPrice((item.price_kopecks / 100).toString())
    setFormQty(item.qty || '0')
    setFormWarehouse(item.warehouse_name || '')
    setFormSupplierId(item.supplier_id ?? item.supplier?.id ?? '')
    setModalOpen(true)
  }

  async function handleDelete(id: string) {
    if (!confirm('Видалити цю чернову позицію?')) return
    try {
      await supplierImportsApi.deleteCatalogItem(id)
      toast.success('Позицію видалено')
      load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка видалення позиції')
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (!formName.trim()) { toast.error('Назва товару обов’язкова'); return }
    const parsedPrice = Number.parseFloat(formPrice.replace(',', '.'))
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) { toast.error('Перевірте закупівельну ціну'); return }
    const sku = formSku.trim() || `AUTO-${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`
    setSaving(true)
    try {
      const payload = {
        sku,
        barcode: normalizeSupplierBarcode(formBarcode) || null,
        brand: formBrand.trim() || undefined,
        name: formName.trim(),
        price_kopecks: Math.round(parsedPrice * 100),
        qty: formQty.trim() || '0',
        warehouse_name: formWarehouse.trim() || undefined,
        supplier_id: formSupplierId || null,
      }
      if (editItem) await supplierImportsApi.updateCatalogItem(editItem.id, payload)
      else await supplierImportsApi.createCatalogItem(payload)
      toast.success(editItem ? 'Позицію оновлено і повторно зіставлено' : 'Позицію додано')
      setModalOpen(false)
      load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка збереження товару')
    } finally {
      setSaving(false)
    }
  }

  const columns: any[] = [
    { key: 'sku', header: 'Артикул', render: (item: SupplierCatalogItem) => <span className="font-mono text-xs font-semibold">{item.sku || '—'}</span> },
    { key: 'barcode', header: 'Штрихкод', render: (item: SupplierCatalogItem) => <span className="font-mono text-xs text-gray-600">{item.barcode || '—'}</span> },
    { key: 'name', header: 'Назва', render: (item: SupplierCatalogItem) => <div><div className="font-medium text-gray-900">{item.name}</div>{item.brand && <div className="text-xs text-gray-400">{item.brand}</div>}</div> },
    { key: 'price', header: 'Закупка', render: (item: SupplierCatalogItem) => <span className="font-bold">{(item.price_kopecks / 100).toFixed(2)} грн</span> },
    { key: 'qty', header: 'К-сть', render: (item: SupplierCatalogItem) => <span>{item.qty || '0'}</span> },
    { key: 'supplier', header: 'Постачальник', render: (item: SupplierCatalogItem) => <span className="text-xs text-gray-500">{supplierName(item)}</span> },
    {
      key: 'match', header: 'Локальний каталог', render: (item: SupplierCatalogItem) => item.match_error
        ? <button type="button" onClick={() => openEditModal(item)} className="text-left text-xs font-semibold text-red-600" title={item.match_error}>Конфлікт — виправити</button>
        : item.matched_product_id
          ? <span className="text-xs font-semibold text-green-700">Знайдено ({item.match_kind || 'точно'})</span>
          : <span className="text-xs text-gray-400">Нова картка</span>,
    },
    {
      key: 'actions', header: '', render: (item: SupplierCatalogItem) => (
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => openEditModal(item)} className="p-1 text-gray-400 hover:text-gray-700" title="Редагувати"><Pencil size={15} /></button>
          <button type="button" onClick={() => handleDelete(item.id)} className="p-1 text-gray-400 hover:text-red-600" title="Видалити"><Trash2 size={15} /></button>
          <Button
            size="sm"
            variant={item.matched_product_id ? 'secondary' : 'primary'}
            loading={importingId === item.id}
            disabled={Boolean(item.matched_product_id)}
            onClick={() => handleImport(item)}
            className="text-xs"
          >
            {item.matched_product_id ? <span className="flex items-center gap-1"><Check size={12} /> Уже в каталозі</span> : 'Створити товар'}
          </Button>
        </div>
      ),
    },
  ]

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Layout title="Чернова номенклатура">
      <div className="space-y-4">
        {localMode && <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">Черновий прайс зберігається в локальній SQLite-базі та синхронізується у фоні. Кнопка «Створити товар» спочатку перевіряє точний штрихкод, артикул і повну назву.</div>}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
          <div className="flex-1 flex flex-col sm:flex-row gap-3"><SearchInput value={search} onChange={setSearch} placeholder="Назва, артикул або штрихкод..." className="w-full sm:max-w-sm" /><select value={supplierId} onChange={(event) => setSupplierId(event.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50"><option value="">— Всі постачальники —</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></div>
          <div className="flex gap-2"><Button variant="outline" icon={<Upload size={16} />} onClick={() => navigate('/settings/draft-nomenclature/import')}>Імпорт Excel</Button><Button icon={<Plus size={16} />} onClick={openCreateModal}>Додати вручну</Button></div>
        </div>
        <Card className="p-0 overflow-hidden border border-gray-100"><Table data={items} columns={columns} loading={loading} keyFn={(item) => item.id} /></Card>
        {totalPages > 1 && <div className="flex items-center justify-center gap-3"><Button variant="outline" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>← Назад</Button><span className="text-sm text-gray-500">{page} / {totalPages}</span><Button variant="outline" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>Далі →</Button></div>}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editItem ? 'Редагувати чернову позицію' : 'Створити чернову позицію'} size="md">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Input label="Артикул" value={formSku} onChange={(event) => setFormSku(event.target.value)} placeholder="Якщо порожньо — створиться AUTO" /><Input label="Штрихкод" value={formBarcode} onChange={(event) => setFormBarcode(event.target.value)} /></div>
          <Input label="Назва товару *" value={formName} onChange={(event) => setFormName(event.target.value)} required />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Input label="Бренд" value={formBrand} onChange={(event) => setFormBrand(event.target.value)} /><Input label="Закупка, грн *" type="number" min="0" step="0.01" value={formPrice} onChange={(event) => setFormPrice(event.target.value)} required /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Input label="Кількість" type="number" min="0" step="0.001" value={formQty} onChange={(event) => setFormQty(event.target.value)} /><Input label="Склад / джерело" value={formWarehouse} onChange={(event) => setFormWarehouse(event.target.value)} /></div>
          <div><label className="block text-xs font-semibold text-gray-500 mb-1">Постачальник</label><select value={formSupplierId} onChange={(event) => setFormSupplierId(event.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm"><option value="">— Без постачальника —</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></div>
          {editItem?.match_error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{editItem.match_error}</div>}
          <div className="flex gap-3 pt-3 border-t"><Button type="submit" loading={saving} className="flex-1">Зберегти</Button><Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Скасувати</Button></div>
        </form>
      </Modal>
    </Layout>
  )
}
