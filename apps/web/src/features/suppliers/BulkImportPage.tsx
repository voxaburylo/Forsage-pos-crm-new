import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { 
  Upload, 
  XCircle, 
  Loader2, 
  History, 
  FileText, 
  Settings, 
  RefreshCw 
} from 'lucide-react'
import { supplierImportsApi } from './supplierImportsApi'
import type { SupplierPriceImport } from './supplierImportsApi'
import { supplierApi } from './supplierApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Badge, toast } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'

export default function BulkImportPage() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  // Auth roles check
  const { session } = useAuthStore()
  const userRole = session?.user?.user_metadata?.role as string ?? 'cashier'
  const isAllowed = userRole === 'owner' || userRole === 'admin'

  // Form State
  const [supplierId, setSupplierId] = useState<string>('')
  const [updateRetail, setUpdateRetail] = useState<boolean>(true)
  const [mode, setMode] = useState<'replace' | 'add'>('replace')

  // File State
  const [file, setFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [uploading, setUploading] = useState<boolean>(false)

  // Preview wizard
  const [previewRows, setPreviewRows] = useState<string[][]>([])
  const [showPreview, setShowPreview] = useState(false)

  // Active / History imports state
  const [activeImportId, setActiveImportId] = useState<string | null>(null)
  const [activeImport, setActiveImport] = useState<SupplierPriceImport | null>(null)
  const [history, setHistory] = useState<SupplierPriceImport[]>([])
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false)

  // Load suppliers and history on mount
  useEffect(() => {
    if (!isAllowed) return

    supplierApi.list({ per_page: 200 })
      .then((r) => setSuppliers(r.data))
      .catch(() => {})
    
    fetchHistory()
  }, [isAllowed])

  // Poll active import status
  useEffect(() => {
    if (!activeImportId || !isAllowed) return

    // Immediately fetch once
    fetchActiveStatus(activeImportId)

    const interval = setInterval(() => {
      fetchActiveStatus(activeImportId)
    }, 2000)

    return () => clearInterval(interval)
  }, [activeImportId, isAllowed])

  const fetchHistory = async () => {
    setLoadingHistory(true)
    try {
      const res = await supplierImportsApi.list()
      setHistory(res.data || [])
    } catch (err: any) {
      toast.error('Не вдалося завантажити історію імпортів')
    } finally {
      setLoadingHistory(false)
    }
  }

  const fetchActiveStatus = async (id: string) => {
    try {
      const res = await supplierImportsApi.getStatus(id)
      const data = res.data
      setActiveImport(data)
      
      // If finished (completed/failed), stop active monitoring (optionally update history)
      if (data.status === 'completed' || data.status === 'failed') {
        fetchHistory()
      }
    } catch (err: any) {
      toast.error('Не вдалося отримати статус імпорту')
    }
  }

  // Handle Drag & Drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const droppedFiles = e.dataTransfer.files
    if (droppedFiles && droppedFiles.length > 0) {
      const selectedFile = droppedFiles[0]
      if (selectedFile.name.endsWith('.csv')) {
        setFile(selectedFile)
      } else {
        toast.error('Будь ласка, завантажуйте файли тільки у форматі CSV (.csv)')
      }
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files
    if (selectedFiles && selectedFiles.length > 0) {
      setFile(selectedFiles[0])
    }
  }

  // Парсимо перші N рядків CSV і показуємо preview
  const handleShowPreview = () => {
    if (!file) { toast.error('Оберіть CSV файл'); return }
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = (e.target?.result as string) ?? ''
      const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim())
      const sep = lines[0]?.includes(';') ? ';' : lines[0]?.includes('\t') ? '\t' : ','
      const rows = lines.slice(0, 8).map((l) => l.split(sep).map((c) => c.replace(/^["']|["']$/g, '').trim()))
      setPreviewRows(rows)
      setShowPreview(true)
    }
    reader.readAsText(file, 'UTF-8')
  }

  // Submit Upload
  const handleUpload = async () => {
    if (!file) {
      toast.error('Будь ласка, оберіть CSV-файл для імпорту')
      return
    }

    setUploading(true)
    try {
      const res = await supplierImportsApi.upload(
        file, 
        supplierId ? supplierId : null, 
        updateRetail, 
        mode
      )
      
      if (res.success) {
        toast.success('Файл успішно завантажено. Почалась обробка!')
        setFile(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
        setActiveImportId(res.importId)
      }
    } catch (err: any) {
      toast.error(err.message || 'Помилка завантаження файлу')
    } finally {
      setUploading(false)
    }
  }

  // Access check redirect/error block
  if (!isAllowed) {
    return (
      <Layout title="Пакетний імпорт прайс-листів" onBack={() => navigate('/suppliers')}>
        <div className="max-w-md mx-auto mt-12">
          <Card className="text-center p-6 border-red-200 bg-red-50/50">
            <XCircle className="mx-auto text-red-500 mb-4" size={48} />
            <h2 className="text-lg font-bold text-red-800 mb-2">Доступ заборонено</h2>
            <p className="text-sm text-red-700 mb-4">
              Лише власники та адміністратори мають доступ до цієї сторінки.
            </p>
            <Button onClick={() => navigate('/dashboard')} variant="outline">
              Повернутися на Головну
            </Button>
          </Card>
        </div>
      </Layout>
    )
  }

  // Calculate Progress Percent
  const progressPercent = activeImport?.total_rows && activeImport.total_rows > 0
    ? Math.min(Math.round((activeImport.processed_rows / activeImport.total_rows) * 100), 100)
    : 0

  return (
    <Layout
      title="Пакетний імпорт прайс-листів (CSV)"
      onBack={() => navigate('/suppliers/import')}
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Column: Form & Upload */}
        <div className="lg:col-span-1 space-y-6">
          <Card className="shadow-md border border-gray-100 bg-white">
            <h3 className="text-base font-bold text-gray-800 mb-4 flex items-center gap-2">
              <Settings size={18} className="text-yellow-500" />
              Параметри імпорту
            </h3>

            <div className="space-y-4">
              {/* Supplier selection */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wider">
                  Постачальник
                </label>
                <select 
                  value={supplierId} 
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 transition"
                >
                  <option value="">— Без прив'язки до постачальника —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              {/* Mode Selection */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase tracking-wider">
                  Режим оновлення кількості
                </label>
                <select 
                  value={mode} 
                  onChange={(e) => setMode(e.target.value as 'replace' | 'add')}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 transition"
                >
                  <option value="replace">Заміна (встановити вказану кількість)</option>
                  <option value="add">Додавання (плюсувати до поточної кількості)</option>
                </select>
              </div>

              {/* Toggle Retail price update */}
              <div className="pt-2">
                <label className="flex items-center gap-3 text-sm text-gray-700 cursor-pointer select-none">
                  <input 
                    type="checkbox" 
                    checked={updateRetail}
                    onChange={(e) => setUpdateRetail(e.target.checked)}
                    className="rounded border-gray-300 text-yellow-500 focus:ring-yellow-400 w-4 h-4 cursor-pointer" 
                  />
                  <div>
                    <span className="font-medium text-gray-800">Оновлювати роздрібну ціну</span>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Роздрібні ціни будуть перераховані на основі націнок магазину
                    </p>
                  </div>
                </label>
              </div>
            </div>
          </Card>

          {/* Drag & Drop File Upload */}
          <Card className="shadow-md border border-gray-100 bg-white">
            <div 
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition duration-300 flex flex-col items-center justify-center min-h-[180px]
                ${isDragging 
                  ? 'border-yellow-400 bg-yellow-50/40 text-yellow-700' 
                  : file 
                    ? 'border-green-400 bg-green-50/20 text-green-700' 
                    : 'border-gray-200 bg-gray-50/50 hover:bg-gray-50 hover:border-gray-300'
                }`}
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                accept=".csv" 
                className="hidden" 
              />
              
              {file ? (
                <>
                  <FileText className="text-green-500 mb-3 animate-bounce" size={42} />
                  <p className="text-sm font-semibold text-gray-800 break-all px-2">{file.name}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {(file.size / 1024).toFixed(1)} KB • Натисніть, щоб змінити файл
                  </p>
                </>
              ) : (
                <>
                  <Upload className={`mb-3 ${isDragging ? 'text-yellow-500' : 'text-gray-400'}`} size={42} />
                  <p className="text-sm font-semibold text-gray-700">Перетягніть CSV файл сюди</p>
                  <p className="text-xs text-gray-400 mt-1">або натисніть для вибору на комп'ютері</p>
                  <div className="mt-3 px-3 py-1 bg-yellow-100/60 rounded text-[11px] font-medium text-yellow-800">
                    Максимум 50,000+ рядків
                  </div>
                </>
              )}
            </div>

            {file && (
              <div className="mt-4 flex gap-2">
                <Button
                  onClick={handleShowPreview}
                  disabled={uploading}
                  className="flex-1 bg-yellow-400 hover:bg-yellow-500 text-gray-900 border-none font-semibold shadow"
                >
                  Переглянути перед імпортом →
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setFile(null)}
                  disabled={uploading}
                >
                  Скасувати
                </Button>
              </div>
            )}

            {/* Preview Modal */}
            {showPreview && previewRows.length > 0 && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-gray-800">Попередній перегляд CSV (перші {previewRows.length} рядків)</h3>
                    <button onClick={() => setShowPreview(false)} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-gray-100">
                    <table className="w-full text-xs">
                      <tbody>
                        {previewRows.map((row, ri) => (
                          <tr key={ri} className={ri === 0 ? 'bg-yellow-50 font-semibold' : ri % 2 === 0 ? 'bg-gray-50' : 'bg-white'}>
                            <td className="px-2 py-1 text-gray-400 border-r border-gray-100 w-6">{ri + 1}</td>
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-3 py-1.5 border-r border-gray-100 text-gray-700 truncate max-w-[140px]" title={cell}>
                                {cell || <span className="text-gray-300">—</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-gray-400">
                    Файл: <strong>{file?.name}</strong> · Режим: <strong>{mode === 'replace' ? 'заміна' : 'додавання'}</strong> · Оновлювати роздрібну: <strong>{updateRetail ? 'так' : 'ні'}</strong>
                  </p>
                  <div className="flex gap-3 pt-1">
                    <Button
                      onClick={() => { setShowPreview(false); handleUpload() }}
                      disabled={uploading}
                      className="flex-1 bg-yellow-400 hover:bg-yellow-500 text-gray-900 font-semibold"
                    >
                      {uploading ? <><Loader2 size={16} className="animate-spin mr-2" />Завантаження...</> : 'Підтвердити і запустити імпорт'}
                    </Button>
                    <Button variant="outline" onClick={() => setShowPreview(false)}>Скасувати</Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Right Column: Active Import Details & Error Log */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Active Import Card */}
          {activeImport ? (
            <Card className="shadow-md border border-gray-100 bg-white">
              <div className="flex items-center justify-between border-b border-gray-50 pb-4 mb-4">
                <div>
                  <span className="text-xs text-gray-400 uppercase tracking-wider block font-semibold">
                    Поточна задача імпорту
                  </span>
                  <h4 className="text-base font-bold text-gray-800 truncate max-w-sm mt-0.5">
                    {activeImport.filename}
                  </h4>
                </div>
                
                {/* Status Badges */}
                <div>
                  {activeImport.status === 'pending' && (
                    <Badge color="gray">
                      У черзі
                    </Badge>
                  )}
                  {activeImport.status === 'processing' && (
                    <Badge color="blue" className="flex items-center gap-1 animate-pulse">
                      <Loader2 size={12} className="animate-spin" />
                      Обробка
                    </Badge>
                  )}
                  {activeImport.status === 'completed' && (
                    <Badge color="green">
                      Успішно завершено
                    </Badge>
                  )}
                  {activeImport.status === 'failed' && (
                    <Badge color="red">
                      Помилка виконання
                    </Badge>
                  )}
                </div>
              </div>

              {/* Progress Bar (Visible during processing/completed) */}
              {(activeImport.status === 'processing' || activeImport.status === 'completed' || activeImport.status === 'failed') && (
                <div className="space-y-2 mb-4">
                  <div className="flex justify-between text-xs font-semibold text-gray-600">
                    <span>Прогрес завантаження</span>
                    <span>{progressPercent}%</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${
                        activeImport.status === 'failed' 
                          ? 'bg-red-500' 
                          : activeImport.status === 'completed' 
                            ? 'bg-green-500' 
                            : 'bg-yellow-400'
                      }`}
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Оброблено рядків: {activeImport.processed_rows}</span>
                    <span>Всього у файлі: {activeImport.total_rows}</span>
                  </div>
                </div>
              )}

              {/* Summary Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-3 bg-gray-50 rounded-lg text-center mb-4">
                <div>
                  <div className="text-xs text-gray-400">Постачальник</div>
                  <div className="text-sm font-semibold text-gray-800 truncate">
                    {activeImport.suppliers?.name || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400">Помилок/Зауважень</div>
                  <div className={`text-sm font-semibold ${activeImport.errors_log.length > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {activeImport.errors_log.length}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400">Створено/Оновлено</div>
                  <div className="text-sm font-semibold text-gray-800">
                    {activeImport.processed_rows - activeImport.errors_log.filter(e => e.row > 0).length}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400">Початок імпорту</div>
                  <div className="text-sm font-semibold text-gray-800">
                    {new Date(activeImport.created_at).toLocaleTimeString()}
                  </div>
                </div>
              </div>

              {/* Errors logs list */}
              {activeImport.errors_log.length > 0 && (
                <div className="mt-4">
                  <div className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">
                    Лог помилок та зауважень
                  </div>
                  <div className="border border-red-100 rounded-lg overflow-hidden bg-red-50/20 max-h-[250px] overflow-y-auto">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-red-50 text-red-800 font-semibold border-b border-red-100 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 w-16">Рядок</th>
                          <th className="px-3 py-2">Помилка</th>
                          <th className="px-3 py-2 hidden md:table-cell">Рядок з файлу</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-red-100/50">
                        {activeImport.errors_log.map((err, idx) => (
                          <tr key={idx} className="hover:bg-red-100/20">
                            <td className="px-3 py-2 font-semibold text-red-700">
                              {err.row > 0 ? err.row : 'Критична'}
                            </td>
                            <td className="px-3 py-2 text-gray-700 font-medium">
                              {err.error}
                            </td>
                            <td className="px-3 py-2 font-mono text-[10px] text-gray-400 truncate max-w-xs hidden md:table-cell">
                              {err.raw || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>
          ) : (
            <Card className="shadow-md border border-gray-100 bg-white py-12 text-center text-gray-400">
              <Upload className="mx-auto mb-3 text-gray-300" size={36} />
              <p className="text-sm">Завантажте файл зліва або оберіть імпорт з історії нижче,</p>
              <p className="text-xs mt-1">щоб побачити деталі виконання та список помилок.</p>
            </Card>
          )}
        </div>
      </div>

      {/* History of imports */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <History size={20} className="text-gray-500" />
            Історія останніх імпортів
          </h3>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={fetchHistory} 
            disabled={loadingHistory}
            className="flex items-center gap-1.5"
          >
            <RefreshCw size={14} className={loadingHistory ? 'animate-spin' : ''} />
            Оновити
          </Button>
        </div>

        <Card padding="none" className="shadow-md border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="bg-gray-50/75 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Дата / Час</th>
                  <th className="px-4 py-3">Файл</th>
                  <th className="px-4 py-3">Постачальник</th>
                  <th className="px-4 py-3">Статус</th>
                  <th className="px-4 py-3 text-right">Рядків (Оброблено / Всього)</th>
                  <th className="px-4 py-3 text-right">Помилки</th>
                  <th className="px-4 py-3 w-28">Дії</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loadingHistory && history.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-gray-400 text-xs">
                      <Loader2 className="animate-spin mx-auto mb-2 text-gray-300" size={24} />
                      Завантаження історії...
                    </td>
                  </tr>
                ) : history.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-gray-400 text-xs">
                      Історія імпортів порожня
                    </td>
                  </tr>
                ) : (
                  history.map((imp) => {
                    const rowErrors = imp.errors_log.length
                    return (
                      <tr 
                        key={imp.id} 
                        className={`hover:bg-gray-50/50 transition ${activeImportId === imp.id ? 'bg-yellow-50/30' : ''}`}
                      >
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
                          {new Date(imp.created_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-800 max-w-[200px] truncate">
                          {imp.filename}
                        </td>
                        <td className="px-4 py-3 text-gray-600 truncate max-w-[150px]">
                          {imp.suppliers?.name || '—'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {imp.status === 'pending' && (
                            <Badge color="gray">
                              В черзі
                            </Badge>
                          )}
                          {imp.status === 'processing' && (
                            <Badge color="blue">
                              Обробка
                            </Badge>
                          )}
                          {imp.status === 'completed' && (
                            <Badge color="green">
                              Успішно
                            </Badge>
                          )}
                          {imp.status === 'failed' && (
                            <Badge color="red">
                              Помилка
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-gray-600 whitespace-nowrap">
                          {imp.processed_rows} / {imp.total_rows}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {rowErrors > 0 ? (
                            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">
                              {rowErrors}
                            </span>
                          ) : (
                            <span className="text-green-600 text-xs font-semibold">0</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Button 
                            variant="outline" 
                            size="sm"
                            onClick={() => {
                              setActiveImportId(imp.id)
                              // Scroll up to view detailed card
                              window.scrollTo({ top: 0, behavior: 'smooth' })
                            }}
                          >
                            Деталі
                          </Button>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Layout>
  )
}
