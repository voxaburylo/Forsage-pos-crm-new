import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, Eye, Play, CheckCircle, AlertCircle, ChevronRight, FileText } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

type Step = 'upload' | 'preview' | 'importing' | 'done'

interface ColMapping { sku?: number; name?: number; category?: number; barcode?: number; retail_price?: number; purchase_price?: number; qty?: number; unit?: number }
interface PreviewRow  { row: number; sku: string; name: string; category?: string; barcode?: string; retail_price: number; purchase_price: number; qty: number; unit: string }
interface Preview     { rows: PreviewRow[]; categories: string[]; detected_mapping: ColMapping; total: number; header: string[] }
interface ImportResult { created: number; updated: number; categories_created: number; errors: Array<{ row: number; sku: string; error: string }> }

const COL_LABELS: Record<keyof ColMapping, string> = {
  sku: 'Артикул', name: 'Назва', category: 'Група/Категорія', barcode: 'Штрихкод',
  retail_price: 'Ціна продажу', purchase_price: 'Ціна закупки', qty: 'Залишок', unit: 'Одиниця',
}

function kopecksToHrn(k: number) { return (k / 100).toFixed(2) }

export default function OnecImportPage() {
  const navigate  = useNavigate()
  const fileRef   = useRef<HTMLInputElement>(null)

  const [step, setStep]       = useState<Step>('upload')
  const [fileText, setFileText] = useState('')
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mapping, setMapping] = useState<ColMapping>({})
  const [mode, setMode]       = useState<'replace' | 'add'>('replace')
  const [updatePrices, setUpdatePrices] = useState(true)
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState<ImportResult | null>(null)

  // ── Крок 1: завантаження файлу ──────────────────────────────────────────────

  async function handleFile(file: File) {
    setFileName(file.name)
    // Перевірка: .xlsx/.xls не читаються через file.text() — це binary zip
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (ext === 'xlsx' || ext === 'xls') {
      toast.error('Формат Excel (.xlsx/.xls) не підтримується. Збережіть файл як CSV: в 1С натисніть "Файл → Зберегти як" і виберіть "CSV (роздільники ;)"')
      setFileText('')
      return
    }
    const text = await file.text()
    setFileText(text)
  }

  async function handlePreview() {
    if (!fileText) { toast.error('Оберіть файл'); return }
    setLoading(true)
    try {
      const res = await api.post<{ data: Preview }>('/api/v1/import/1c/preview', {
        text: fileText, mapping: Object.keys(mapping).length ? mapping : undefined,
      })
      setPreview(res.data)
      setMapping(res.data.detected_mapping)
      setStep('preview')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка аналізу') }
    finally { setLoading(false) }
  }

  // ── Крок 3: імпорт ──────────────────────────────────────────────────────────

  async function handleImport() {
    if (!preview) return
    setStep('importing')
    setLoading(true)
    try {
      const res = await api.post<{ data: ImportResult }>('/api/v1/import/1c/run', {
        rows: preview.rows, mode, updatePrices,
      })
      setResult(res.data)
      setStep('done')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка імпорту')
      setStep('preview')
    } finally { setLoading(false) }
  }

  // ── Рендер ──────────────────────────────────────────────────────────────────

  return (
    <Layout title="Імпорт номенклатури з 1С" onBack={() => navigate('/suppliers')}>
      <div className="max-w-4xl space-y-6">

        {/* Степпер */}
        <div className="flex items-center gap-2 text-sm">
          {(['upload','preview','importing','done'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                step === s ? 'bg-yellow-400 text-black' :
                ['upload','preview','importing','done'].indexOf(step) > i ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
              }`}>{i+1}</span>
              <span className={step === s ? 'font-medium text-gray-900' : 'text-gray-400'}>
                {['Файл','Перегляд','Імпорт','Готово'][i]}
              </span>
              {i < 3 && <ChevronRight size={14} className="text-gray-300" />}
            </div>
          ))}
        </div>

        {/* Крок 1 — Завантаження файлу */}
        {step === 'upload' && (
          <Card className="space-y-5">
            <h2 className="font-semibold text-gray-800">Завантажте файл з 1С</h2>

            {/* Інструкція */}
            <div className="bg-blue-50 rounded-xl p-4 text-sm text-blue-800 space-y-2">
              <p className="font-semibold">Як експортувати з 1С:</p>
              <ol className="list-decimal list-inside space-y-1 text-blue-700">
                <li>Відкрийте <b>Довідники → Номенклатура</b></li>
                <li>Натисніть <b>Ще → Вивести список</b> (або Ctrl+Shift+M)</li>
                <li>Виберіть колонки: Найменування, Артикул, Група, Штрихкод, Ціна продажу, Закупівельна ціна, Залишок</li>
                <li>Зберегти як <b>CSV</b> або <b>Excel → скопіюйте в CSV</b></li>
              </ol>
            </div>

            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition ${
                fileText ? 'border-green-400 bg-green-50' : 'border-gray-200 hover:border-yellow-400 hover:bg-yellow-50'
              }`}
            >
              <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
              {fileText ? (
                <div className="space-y-1">
                  <FileText size={40} className="text-green-500 mx-auto" />
                  <p className="font-semibold text-gray-800">{fileName}</p>
                  <p className="text-xs text-gray-500">{fileText.split('\n').length - 1} рядків</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload size={40} className="text-gray-400 mx-auto" />
                  <p className="text-gray-600 font-medium">Перетягніть CSV файл або натисніть</p>
                  <p className="text-xs text-gray-400">Тільки CSV/TXT (розділювачі: ; або ,). XLSX не підтримується.</p>
                </div>
              )}
            </div>

            {fileText && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Режим кількості</label>
                  <select value={mode} onChange={(e) => setMode(e.target.value as any)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
                    <option value="replace">Замінити (встановити нову кількість)</option>
                    <option value="add">Додати до поточної кількості</option>
                  </select>
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={updatePrices} onChange={(e) => setUpdatePrices(e.target.checked)}
                      className="rounded border-gray-300 text-yellow-500 w-4 h-4" />
                    Оновлювати ціни
                  </label>
                </div>
              </div>
            )}

            <Button onClick={handlePreview} disabled={!fileText || loading} loading={loading}
              icon={<Eye size={16} />}>
              Аналізувати файл
            </Button>
          </Card>
        )}

        {/* Крок 2 — Preview */}
        {step === 'preview' && preview && (
          <div className="space-y-4">

            {/* Статистика */}
            <div className="grid grid-cols-3 gap-4">
              <Card className="text-center py-4">
                <p className="text-3xl font-bold text-gray-900">{preview.total}</p>
                <p className="text-sm text-gray-500 mt-1">Товарів</p>
              </Card>
              <Card className="text-center py-4">
                <p className="text-3xl font-bold text-blue-600">{preview.categories.length}</p>
                <p className="text-sm text-gray-500 mt-1">Категорій/груп</p>
              </Card>
              <Card className="text-center py-4">
                <p className="text-3xl font-bold text-green-600">{Object.values(mapping).filter(v => v !== undefined).length}</p>
                <p className="text-sm text-gray-500 mt-1">Колонок знайдено</p>
              </Card>
            </div>

            {/* Маппінг колонок */}
            <Card className="space-y-3">
              <h3 className="font-semibold text-gray-800 text-sm">Визначені колонки</h3>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(COL_LABELS) as Array<keyof ColMapping>).map((key) => (
                  <div key={key} className="flex items-center gap-2 text-sm">
                    <span className="text-gray-500 w-32">{COL_LABELS[key]}:</span>
                    <select
                      value={mapping[key] !== undefined ? String(mapping[key]) : ''}
                      onChange={(e) => setMapping(m => ({ ...m, [key]: e.target.value !== '' ? parseInt(e.target.value) : undefined }))}
                      className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400"
                    >
                      <option value="">— не вибрано —</option>
                      {preview.header.map((h, i) => (
                        <option key={i} value={String(i)}>{i+1}: {h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              {Object.values(mapping).some(v => v === undefined) || mapping.name === undefined ? null : (
                <Button size="sm" variant="secondary" onClick={handlePreview} loading={loading}>
                  Оновити попередній перегляд
                </Button>
              )}
            </Card>

            {/* Категорії */}
            {preview.categories.length > 0 && (
              <Card className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-800 text-sm">
                    Групи/Категорії ({preview.categories.length})
                  </h3>
                  <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">будуть створені автоматично</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {preview.categories.map((c) => (
                    <span key={c} className="px-2.5 py-1 bg-blue-50 text-blue-700 text-xs rounded-full border border-blue-100 font-medium">{c}</span>
                  ))}
                </div>
                <p className="text-xs text-gray-400">
                  Якщо в 1С категорія має вкладеність (напр. "Запчастини/Фільтри"), вона буде створена як один рівень.
                  Для ієрархічних категорій скористайтесь сторінкою <span className="font-medium">Товари → Імпорт</span>.
                </p>
              </Card>
            )}

            {/* Перші 10 рядків */}
            <Card padding="none">
              <div className="px-4 py-3 border-b border-gray-100">
                <span className="font-semibold text-sm text-gray-800">Перші 10 товарів</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50">
                      <th className="text-left px-3 py-2 text-gray-500">Артикул</th>
                      <th className="text-left px-3 py-2 text-gray-500">Назва</th>
                      <th className="text-left px-3 py-2 text-gray-500">Категорія</th>
                      <th className="text-left px-3 py-2 text-gray-500">Штрихкод</th>
                      <th className="text-right px-3 py-2 text-gray-500">Ціна</th>
                      <th className="text-right px-3 py-2 text-gray-500">Закупка</th>
                      <th className="text-right px-3 py-2 text-gray-500">Залишок</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 10).map((row) => (
                      <tr key={row.row} className="border-t border-gray-50 hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-600 font-mono">{row.sku}</td>
                        <td className="px-3 py-2 text-gray-900 font-medium max-w-[180px] truncate">{row.name}</td>
                        <td className="px-3 py-2 text-blue-600">{row.category || '—'}</td>
                        <td className="px-3 py-2 text-gray-500 font-mono">{row.barcode || '—'}</td>
                        <td className="px-3 py-2 text-right text-green-700">{kopecksToHrn(row.retail_price)} ₴</td>
                        <td className="px-3 py-2 text-right text-gray-500">{kopecksToHrn(row.purchase_price)} ₴</td>
                        <td className="px-3 py-2 text-right text-gray-700">{row.qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.rows.length > 10 && (
                  <p className="px-3 py-2 text-xs text-gray-400">...і ще {preview.rows.length - 10} товарів</p>
                )}
              </div>
            </Card>

            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setStep('upload')}>← Назад</Button>
              <Button onClick={handleImport} icon={<Play size={16} />} loading={loading}>
                Запустити імпорт ({preview.total} товарів)
              </Button>
            </div>
          </div>
        )}

        {/* Крок 3 — Прогрес */}
        {step === 'importing' && (
          <Card className="py-12 text-center space-y-4">
            <div className="w-12 h-12 border-4 border-yellow-400 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-gray-700 font-medium">Імпортуємо товари...</p>
            <p className="text-gray-400 text-sm">Це може зайняти кілька секунд</p>
          </Card>
        )}

        {/* Крок 4 — Результат */}
        {step === 'done' && result && (
          <div className="space-y-4">
            <Card className="space-y-4">
              <div className="flex items-center gap-3">
                <CheckCircle size={32} className="text-green-500" />
                <h2 className="text-lg font-bold text-gray-900">Імпорт завершено</h2>
              </div>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: 'Створено товарів',   value: result.created,            color: 'text-green-600' },
                  { label: 'Оновлено товарів',    value: result.updated,            color: 'text-blue-600' },
                  { label: 'Категорій створено', value: result.categories_created, color: 'text-purple-600' },
                  { label: 'Помилок',            value: result.errors.length,      color: result.errors.length > 0 ? 'text-red-500' : 'text-gray-400' },
                ].map((s) => (
                  <div key={s.label} className="bg-gray-50 rounded-xl p-3 text-center">
                    <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                    <p className="text-xs text-gray-500 mt-1">{s.label}</p>
                  </div>
                ))}
              </div>
            </Card>

            {result.errors.length > 0 && (
              <Card className="space-y-2">
                <div className="flex items-center gap-2 text-red-600">
                  <AlertCircle size={16} />
                  <span className="font-semibold text-sm">Помилки ({result.errors.length})</span>
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {result.errors.map((e, i) => (
                    <div key={i} className="text-xs text-red-600 bg-red-50 px-3 py-1.5 rounded">
                      Рядок {e.row} ({e.sku}): {e.error}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <div className="flex gap-3">
              <Button onClick={() => { setStep('upload'); setFileText(''); setFileName(''); setPreview(null); setResult(null) }}>
                Новий імпорт
              </Button>
              <Button variant="secondary" onClick={() => navigate('/products')}>
                Перейти до товарів
              </Button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}
