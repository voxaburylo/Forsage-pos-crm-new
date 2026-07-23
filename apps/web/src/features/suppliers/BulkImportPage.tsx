import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, History, Loader2, Settings, Upload, XCircle } from 'lucide-react'
import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import { supplierImportsApi, type SupplierImportPreviewMatch, type SupplierPriceImport } from './supplierImportsApi'
import {
  buildSupplierImportRows,
  cleanSupplierImportCell,
  EMPTY_SUPPLIER_IMPORT_MAPPING,
  guessSupplierImportMapping,
  SUPPLIER_IMPORT_FIELDS,
  type SupplierImportField,
  type SupplierImportMapping,
} from './supplierImportLocal'
import { supplierApi } from './supplierApi'
import { Layout } from '@/components/Layout'
import { Badge, Button, Card, Input, Modal, toast } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'

async function readImportFile(file: File): Promise<unknown[][]> {
  if (/\.csv$/i.test(file.name)) {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: false,
        skipEmptyLines: false,
        complete: (result) => resolve(result.data as unknown[][]),
        error: reject,
      })
    })
  }
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellText: true, cellNF: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('У файлі немає аркушів')
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as unknown[][]
}

function statusBadge(status: SupplierPriceImport['status']) {
  if (status === 'completed') return <Badge color="green">Успішно</Badge>
  if (status === 'failed') return <Badge color="red">Помилка</Badge>
  if (status === 'processing') return <Badge color="blue">Обробка</Badge>
  return <Badge color="gray">У черзі</Badge>
}

export default function BulkImportPage() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { session } = useAuthStore()
  const userRole = (session?.user?.app_metadata?.role as string | undefined) ?? 'cashier'
  const isAllowed = userRole === 'owner' || userRole === 'admin'
  const localMode = supplierImportsApi.isLocal()

  const [supplierId, setSupplierId] = useState('')
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [supplierModal, setSupplierModal] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [newSupplierPhone, setNewSupplierPhone] = useState('')
  const [creatingSupplier, setCreatingSupplier] = useState(false)
  const [mode, setMode] = useState<'replace' | 'add'>('replace')
  const [warehouseName, setWarehouseName] = useState('')

  const [file, setFile] = useState<File | null>(null)
  const [rawRows, setRawRows] = useState<unknown[][]>([])
  const [mapping, setMapping] = useState<SupplierImportMapping>({ ...EMPTY_SUPPLIER_IMPORT_MAPPING })
  const [startRow, setStartRow] = useState(0)
  const [headerRow, setHeaderRow] = useState<number | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [previewMatches, setPreviewMatches] = useState<SupplierImportPreviewMatch[]>([])
  const [matching, setMatching] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [uploading, setUploading] = useState(false)

  const [activeImportId, setActiveImportId] = useState<string | null>(null)
  const [activeImport, setActiveImport] = useState<SupplierPriceImport | null>(null)
  const [history, setHistory] = useState<SupplierPriceImport[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)

  const preview = useMemo(
    () => buildSupplierImportRows(rawRows, mapping, startRow),
    [rawRows, mapping, startRow],
  )
  const columnCount = useMemo(
    () => Math.max(0, ...rawRows.slice(0, 30).map((row) => row.length)),
    [rawRows],
  )
  const matchByRow = useMemo(
    () => new Map(previewMatches.map((item) => [item.row.source_row, item.match])),
    [previewMatches],
  )

  async function fetchHistory() {
    setLoadingHistory(true)
    try {
      setHistory((await supplierImportsApi.list()).data || [])
    } catch {
      toast.error('Не вдалося завантажити історію імпортів')
    } finally {
      setLoadingHistory(false)
    }
  }

  useEffect(() => {
    if (!isAllowed) return
    supplierApi.list({ per_page: 200 }).then((result) => setSuppliers(result.data || [])).catch(() => {})
    fetchHistory()
  }, [isAllowed])

  useEffect(() => {
    if (!activeImportId || !isAllowed) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const data = (await supplierImportsApi.getStatus(activeImportId)).data
        if (cancelled) return
        setActiveImport(data)
        if (data.status === 'completed' || data.status === 'failed') {
          fetchHistory()
          return
        }
        timer = window.setTimeout(poll, 2000)
      } catch {
        if (!cancelled) toast.error('Не вдалося отримати статус імпорту')
      }
    }
    poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [activeImportId, isAllowed])

  useEffect(() => {
    if (!showPreview || preview.rows.length === 0) {
      setPreviewMatches([])
      return
    }
    let cancelled = false
    setMatching(true)
    supplierImportsApi.previewRows(preview.rows.slice(0, 30))
      .then((matches) => { if (!cancelled) setPreviewMatches(matches) })
      .catch(() => { if (!cancelled) setPreviewMatches([]) })
      .finally(() => { if (!cancelled) setMatching(false) })
    return () => { cancelled = true }
  }, [showPreview, preview.rows])

  async function handleCreateSupplier() {
    if (!newSupplierName.trim()) { toast.error('Назва постачальника обов’язкова'); return }
    setCreatingSupplier(true)
    try {
      const data = (await supplierApi.create({
        name: newSupplierName.trim(),
        phone: newSupplierPhone.trim() || null,
      })).data
      setSuppliers((current) => [...current, data])
      setSupplierId(data.id)
      setSupplierModal(false)
      setNewSupplierName('')
      setNewSupplierPhone('')
      toast.success('Постачальника створено')
    } catch {
      toast.error('Помилка створення постачальника')
    } finally {
      setCreatingSupplier(false)
    }
  }

  async function acceptFile(nextFile: File) {
    if (!/\.(xlsx?|csv)$/i.test(nextFile.name)) {
      toast.error('Підтримуються файли .xlsx, .xls або .csv')
      return
    }
    try {
      const rows = (await readImportFile(nextFile))
        .map((row) => Array.isArray(row) ? row : [])
        .filter((row) => row.some((cell) => cleanSupplierImportCell(cell)))
      if (rows.length === 0) throw new Error('Файл порожній')
      const guessed = guessSupplierImportMapping(rows)
      setFile(nextFile)
      setRawRows(rows)
      setMapping(guessed.mapping)
      setStartRow(guessed.startRow)
      setHeaderRow(guessed.headerRow)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося прочитати файл')
    }
  }

  function clearFile() {
    setFile(null)
    setRawRows([])
    setMapping({ ...EMPTY_SUPPLIER_IMPORT_MAPPING })
    setStartRow(0)
    setHeaderRow(null)
    setPreviewMatches([])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function openPreview() {
    if (!file || rawRows.length === 0) { toast.error('Оберіть Excel або CSV файл'); return }
    setShowPreview(true)
  }

  async function handleUpload() {
    if (!file) return
    if (mapping.name == null) { toast.error('Вкажіть колонку з назвою товару'); return }
    if (mapping.price == null) { toast.error('Вкажіть колонку закупівельної ціни'); return }
    if (preview.rows.length === 0) { toast.error('Не знайдено товарних рядків. Перевірте старт і колонки.'); return }
    setUploading(true)
    try {
      const selectedSupplier = suppliers.find((item) => item.id === supplierId)
      const result = await supplierImportsApi.uploadRows(file.name, preview.rows, {
        supplierId: supplierId || null,
        supplierName: selectedSupplier?.name,
        mode,
        warehouseName: warehouseName.trim() || undefined,
        parseErrors: preview.errors,
      })
      setShowPreview(false)
      clearFile()
      setActiveImportId(result.importId)
      toast.success(localMode ? 'Прайс збережено локально' : 'Файл передано на обробку')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Помилка імпорту файлу')
    } finally {
      setUploading(false)
    }
  }

  if (!isAllowed) {
    return (
      <Layout title="Пакетний імпорт прайс-листів" onBack={() => navigate('/suppliers')}>
        <Card className="max-w-md mx-auto mt-12 text-center p-6 border-red-200 bg-red-50/50">
          <XCircle className="mx-auto text-red-500 mb-4" size={48} />
          <h2 className="text-lg font-bold text-red-800 mb-2">Доступ заборонено</h2>
          <p className="text-sm text-red-700 mb-4">Лише власники та адміністратори мають доступ до цієї сторінки.</p>
          <Button onClick={() => navigate('/dashboard')} variant="outline">Повернутися на головну</Button>
        </Card>
      </Layout>
    )
  }

  const progressPercent = activeImport?.total_rows
    ? Math.min(100, Math.round(activeImport.processed_rows / activeImport.total_rows * 100))
    : 0

  return (
    <Layout title="Пакетний імпорт прайс-листів" onBack={() => navigate('/settings/draft-nomenclature')}>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <Card className="shadow-md border border-gray-100 bg-white">
            <h3 className="text-base font-bold text-gray-800 mb-4 flex items-center gap-2"><Settings size={18} className="text-yellow-500" />Параметри імпорту</h3>
            {localMode && <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">Desktop: прайс і товари не записуються напряму на сервер. Нові картки створюються у локальній базі та синхронізуються штатною чергою.</div>}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Постачальник</label>
                <div className="flex gap-2">
                  <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)} className="flex-1 min-w-0 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50">
                    <option value="">— Без постачальника —</option>
                    {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                  </select>
                  <Button type="button" onClick={() => setSupplierModal(true)}>+</Button>
                </div>
              </div>
              <Input label="Склад / джерело" value={warehouseName} onChange={(event) => setWarehouseName(event.target.value)} placeholder="Основний склад" />
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Режим кількості</label>
                <select value={mode} onChange={(event) => setMode(event.target.value as 'replace' | 'add')} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50">
                  <option value="replace">Замінити прайс цього складу</option>
                  <option value="add">Додати до наявної кількості</option>
                </select>
              </div>
            </div>
          </Card>

          <Card className="shadow-md border border-gray-100 bg-white">
            <div
              onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => { event.preventDefault(); setIsDragging(false); if (event.dataTransfer.files[0]) acceptFile(event.dataTransfer.files[0]) }}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer min-h-[180px] flex flex-col items-center justify-center ${isDragging ? 'border-yellow-400 bg-yellow-50' : file ? 'border-green-400 bg-green-50/20' : 'border-gray-200 bg-gray-50/50'}`}
            >
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(event) => { const selected = event.target.files?.[0]; if (selected) acceptFile(selected) }} />
              {file ? <><FileText className="text-green-500 mb-3" size={42} /><p className="text-sm font-semibold break-all">{file.name}</p><p className="text-xs text-gray-400 mt-1">{rawRows.length} непорожніх рядків</p></> : <><Upload className="text-gray-400 mb-3" size={42} /><p className="text-sm font-semibold text-gray-700">Перетягніть Excel або CSV сюди</p><p className="text-xs text-gray-400 mt-1">або натисніть для вибору</p></>}
            </div>
            {file && <div className="mt-4 flex gap-2"><Button onClick={openPreview} className="flex-1">Перевірити колонки →</Button><Button variant="outline" onClick={clearFile}>Скасувати</Button></div>}
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-6">
          {activeImport ? (
            <Card className="shadow-md border border-gray-100 bg-white">
              <div className="flex justify-between gap-4 border-b border-gray-100 pb-3 mb-4"><div><div className="text-xs text-gray-400">Останній імпорт</div><div className="font-bold break-all">{activeImport.filename}</div></div>{statusBadge(activeImport.status)}</div>
              <div className="flex justify-between text-xs text-gray-500 mb-1"><span>Оброблено {activeImport.processed_rows} з {activeImport.total_rows}</span><span>{progressPercent}%</span></div>
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden"><div className="h-full bg-green-500" style={{ width: `${progressPercent}%` }} /></div>
              {activeImport.errors_log.length > 0 && <div className="mt-4 max-h-64 overflow-auto rounded-lg border border-red-100"><table className="w-full text-xs"><tbody>{activeImport.errors_log.map((error, index) => <tr key={`${error.row}-${index}`} className="border-b border-red-50"><td className="px-3 py-2 w-20 text-red-700">Рядок {error.row || '—'}</td><td className="px-3 py-2 text-gray-700">{error.error}</td></tr>)}</tbody></table></div>}
            </Card>
          ) : <Card className="py-12 text-center text-gray-400"><Upload className="mx-auto mb-3 text-gray-300" size={36} /><p className="text-sm">Оберіть файл і перевірте сопоставлення колонок.</p></Card>}
        </div>
      </div>

      <div className="mt-8">
        <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-4"><History size={20} />Історія імпортів</h3>
        <Card padding="none" className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="text-left px-4 py-3">Дата</th><th className="text-left px-4 py-3">Файл</th><th className="text-left px-4 py-3">Постачальник</th><th className="text-left px-4 py-3">Статус</th><th className="text-right px-4 py-3">Рядки</th><th className="text-right px-4 py-3">Помилки</th><th className="px-4 py-3" /></tr></thead><tbody className="divide-y divide-gray-100">
          {loadingHistory && history.length === 0 ? <tr><td colSpan={7} className="py-8 text-center text-gray-400"><Loader2 className="animate-spin mx-auto" /></td></tr> : history.length === 0 ? <tr><td colSpan={7} className="py-8 text-center text-gray-400">Історія порожня</td></tr> : history.map((item) => <tr key={item.id}><td className="px-4 py-3 text-xs text-gray-500">{new Date(item.created_at).toLocaleString()}</td><td className="px-4 py-3 font-medium">{item.filename}</td><td className="px-4 py-3 text-gray-600">{item.suppliers?.name || '—'}</td><td className="px-4 py-3">{statusBadge(item.status)}</td><td className="px-4 py-3 text-right">{item.processed_rows}/{item.total_rows}</td><td className="px-4 py-3 text-right">{item.errors_log.length}</td><td className="px-4 py-3 text-right"><Button size="sm" variant="outline" onClick={() => setActiveImportId(item.id)}>Деталі</Button></td></tr>)}
        </tbody></table></div></Card>
      </div>

      <Modal open={showPreview} onClose={() => setShowPreview(false)} title="Перевірка Excel перед імпортом" size="xl">
        <div className="space-y-4 max-h-[80vh] overflow-y-auto pr-1">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Виберіть тип над кожним стовпчиком і рядок, з якого починаються товари. У desktop точні збіги не створять дубль.</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm"><div className="rounded-lg bg-gray-50 px-3 py-2">Товарів: <b>{preview.rows.length}</b></div><div className="rounded-lg bg-gray-50 px-3 py-2">Пропущено: <b>{preview.skipped}</b></div><div className="rounded-lg bg-gray-50 px-3 py-2">Помилки: <b className={preview.errors.length ? 'text-red-600' : ''}>{preview.errors.length}</b></div></div>
          <div className="flex items-end gap-3"><div><label className="block text-xs font-semibold text-gray-500 mb-1">Почати з рядка</label><input type="number" min={1} max={Math.max(1, rawRows.length)} value={startRow + 1} onChange={(event) => setStartRow(Math.max(0, (Number.parseInt(event.target.value) || 1) - 1))} className="w-32 border border-gray-200 rounded-lg px-3 py-2" /></div>{headerRow != null && <span className="text-xs text-gray-400 pb-2">Заголовок схожий на рядок {headerRow + 1}</span>}{matching && <span className="text-xs text-gray-500 pb-2 flex items-center gap-1"><Loader2 size={13} className="animate-spin" />Зіставляю з локальним каталогом…</span>}</div>
          <div className="border border-gray-200 rounded-xl overflow-hidden"><div className="overflow-auto max-h-[440px]"><table className="min-w-full text-xs"><thead className="sticky top-0 z-10 bg-white shadow-sm"><tr><th className="sticky left-0 z-20 bg-white px-2 py-2 min-w-[74px] text-left">Рядок</th>{Array.from({ length: columnCount }).map((_, column) => {
            const selectedField = SUPPLIER_IMPORT_FIELDS.find(({ field }) => mapping[field] === column)?.field ?? ''
            return <th key={column} className={`px-2 py-2 min-w-[150px] text-left ${selectedField ? 'bg-yellow-100' : ''}`}><div className="text-[10px] text-gray-400 mb-1">Колонка {column + 1}</div><select value={selectedField} onChange={(event) => { const field = event.target.value as SupplierImportField | ''; setMapping((current) => { const next = { ...current }; (Object.keys(next) as SupplierImportField[]).forEach((key) => { if (next[key] === column) next[key] = null }); if (field) next[field] = column; return next }) }} className="w-full border border-gray-200 rounded px-2 py-1.5"><option value="">Не імпорт.</option>{SUPPLIER_IMPORT_FIELDS.map((option) => <option key={option.field} value={option.field}>{option.label}{option.required ? ' *' : ''}</option>)}</select></th>
          })}<th className="sticky right-0 bg-white px-2 py-2 min-w-[190px] text-left">Зіставлення</th></tr></thead><tbody>{rawRows.slice(0, 30).map((row, rowIndex) => {
            const sourceRow = rowIndex + 1
            const match = matchByRow.get(sourceRow)
            return <tr key={rowIndex} className={rowIndex < startRow ? 'bg-gray-50 text-gray-400' : 'bg-white'}><td className="sticky left-0 bg-inherit px-2 py-1"><button type="button" onClick={() => setStartRow(rowIndex)} className={`w-full rounded px-2 py-1 text-left ${rowIndex === startRow ? 'bg-yellow-400 text-black font-bold' : ''}`}>{sourceRow}{rowIndex === startRow ? ' старт' : ''}</button></td>{Array.from({ length: columnCount }).map((_, column) => <td key={column} className={`px-2 py-1 max-w-[240px] truncate ${SUPPLIER_IMPORT_FIELDS.some(({ field }) => mapping[field] === column) ? 'bg-yellow-50 text-gray-900' : ''}`} title={cleanSupplierImportCell(row[column])}>{cleanSupplierImportCell(row[column])}</td>)}<td className="sticky right-0 bg-inherit px-2 py-1">{rowIndex < startRow ? 'Не імпортується' : match?.error ? <span className="text-red-600" title={match.error}>Конфлікт — перевірте рядок</span> : match?.product ? <span className="text-green-700" title={match.product.name}>Є в каталозі ({match.kind})</span> : localMode ? <span className="text-gray-500">Нова картка</span> : <span className="text-gray-400">Перевіриться при створенні</span>}</td></tr>
          })}</tbody></table></div></div>
          {preview.errors.length > 0 && <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{preview.errors.slice(0, 5).map((error) => <div key={`${error.row}-${error.error}`}>Рядок {error.row}: {error.error}</div>)}</div>}
          <div className="flex justify-end gap-2 border-t pt-3"><Button variant="secondary" onClick={() => setShowPreview(false)}>Скасувати</Button><Button onClick={handleUpload} loading={uploading} disabled={preview.rows.length === 0 || matching}>Підтвердити імпорт</Button></div>
        </div>
      </Modal>

      <Modal open={supplierModal} onClose={() => setSupplierModal(false)} title="Швидке створення постачальника" size="sm"><div className="space-y-4"><Input label="Назва постачальника *" value={newSupplierName} onChange={(event) => setNewSupplierName(event.target.value)} /><Input label="Телефон" value={newSupplierPhone} onChange={(event) => setNewSupplierPhone(event.target.value)} /><div className="flex gap-3"><Button loading={creatingSupplier} onClick={handleCreateSupplier} className="flex-1">Створити</Button><Button variant="secondary" onClick={() => setSupplierModal(false)}>Скасувати</Button></div></div></Modal>
    </Layout>
  )
}
