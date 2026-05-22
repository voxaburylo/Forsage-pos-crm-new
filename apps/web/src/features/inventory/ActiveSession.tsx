import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CheckCircle, Search, Minus, Plus, Camera } from 'lucide-react'
import { api } from '@/lib/api'
import { Layout } from '@/components/Layout'
import { Button, Card, Badge } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { playSuccessBeep, playErrorTone, initAudio } from '@/lib/audioService'
import { CameraScanner } from '@/features/pos/CameraScanner'

interface Item {
  id: string
  product_id: string
  expected_stock: number
  counted_stock: number
  product: { id: string; sku: string; name: string; barcode: string | null; unit: string } | null
}

interface SessionData {
  id: string
  name: string
  status: string
  items: Item[]
}

export default function ActiveSession() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [session, setSession] = useState<SessionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanInput, setScanInput] = useState('')
  const [scanning, setScanning] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const scanRef = useRef<HTMLInputElement>(null)

  async function load() {
    if (!id) return
    try {
      const { data } = await api.get<{ data: SessionData }>(`/api/v1/inventory/${id}`)
      setSession(data)
    } catch { toast.error('Помилка завантаження'); navigate('/inventory') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [id])
  useEffect(() => { scanRef.current?.focus() }, [session?.items])

  async function handleScan(e: React.FormEvent) {
    e.preventDefault()
    if (!scanInput.trim() || !id) return
    setScanning(true)
    initAudio()
    try {
      const { data } = await api.post<{ data: Item[] }>(`/api/v1/inventory/${id}/scan`, { barcode: scanInput.trim() })
      setSession((prev) => prev ? { ...prev, items: data } : prev)
      setScanInput('')
      playSuccessBeep()
    } catch (e) {
      playErrorTone()
      toast.error(e instanceof Error ? e.message : 'Товар не знайдено')
    }
    finally { setScanning(false); scanRef.current?.focus() }
  }

  async function updateCount(itemId: string, counted: number) {
    if (!id) return
    try {
      const { data } = await api.put<{ data: Item }>(`/api/v1/inventory/${id}/items/${itemId}`, { counted_stock: Math.max(0, counted) })
      setSession((prev) => prev ? {
        ...prev,
        items: prev.items.map((i) => i.id === itemId ? { ...i, counted_stock: data.counted_stock } : i),
      } : prev)
    } catch { toast.error('Помилка оновлення') }
  }

  async function completeSession() {
    if (!id || !confirm('Завершити ревізію? Розбіжності будуть застосовані до залишків.')) return
    try {
      const res = await api.post(`/api/v1/inventory/${id}/complete`, {}) as any
      toast.success(`Ревізію завершено. Оновлено ${res.data?.items_updated ?? 0} товарів.`)
      navigate('/inventory')
    } catch { toast.error('Помилка') }
  }

  if (loading) return <Layout title="Ревізія"><div className="text-gray-400 text-sm text-center py-12">Завантаження...</div></Layout>
  if (!session) return null

  const totalDiff = session.items.reduce((s, i) => s + (i.counted_stock - i.expected_stock), 0)
  const diffCount = session.items.filter((i) => i.counted_stock !== i.expected_stock).length
  const isActive = session.status === 'in_progress'

  return (
    <Layout title={`Ревізія: ${session.name}`} onBack={() => navigate('/inventory')}>
      <div className="max-w-4xl space-y-4">
        {/* Сканер */}
        {isActive && (<>
          <Card>
            <form onSubmit={handleScan} className="flex gap-3">
              <div className="relative flex-1">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input ref={scanRef} type="text" value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  placeholder="Скануйте штрих-код або введіть артикул..."
                  className="w-full bg-gray-50 border-2 border-yellow-400 rounded-xl pl-10 pr-4 py-3.5 text-lg font-mono focus:outline-none focus:border-yellow-500"
                  autoFocus />
              </div>
              <button type="button" onClick={() => setCameraOpen(true)}
                className="md:hidden bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl px-3 flex items-center justify-center transition-colors border border-gray-300"
                title="Сканувати камерою">
                <Camera size={22} />
              </button>
              <Button type="submit" loading={scanning} size="sm">Сканувати</Button>
            </form>
          </Card>
          <CameraScanner open={cameraOpen} onClose={() => setCameraOpen(false)}
            onScan={(code) => { setScanInput(code); setCameraOpen(false); setTimeout(() => { const fakeEvent = { preventDefault: () => {} }; handleScan(fakeEvent as any) }, 200) }} />
        </>)}

        {/* Статистика */}
        <div className="flex items-center gap-4 text-sm">
          <Badge color={session.status === 'completed' ? 'green' : 'blue'}>
            {session.status === 'completed' ? 'Завершено' : 'Активна'}
          </Badge>
          <span className="text-gray-500">Товарів: {session.items.length}</span>
          {totalDiff !== 0 && (
            <span className={totalDiff > 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
              {totalDiff > 0 ? '+' : ''}{totalDiff} од.
            </span>
          )}
          {diffCount > 0 && <span className="text-orange-600">{diffCount} розбіжностей</span>}
        </div>

        {/* Таблиця */}
        <Card padding="none">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-2.5">Товар</th>
                <th className="text-right px-3 py-2.5 w-24">Очікувалось</th>
                <th className="text-right px-3 py-2.5 w-24">Фактично</th>
                <th className="text-right px-3 py-2.5 w-20">Різниця</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {session.items.length === 0 ? (
                <tr><td colSpan={4} className="text-center text-gray-400 py-8">Відскануйте перший товар</td></tr>
              ) : session.items.map((item) => {
                const diff = item.counted_stock - item.expected_stock
                return (
                  <tr key={item.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-gray-900">{item.product?.name ?? 'Невідомий'}</p>
                      <p className="text-xs text-gray-400 font-mono">{item.product?.sku ?? ''} · {item.product?.unit ?? 'шт'}</p>
                    </td>
                    <td className="px-3 py-2.5 text-right text-gray-600">{item.expected_stock}</td>
                    <td className="px-3 py-2.5 text-right">
                      {isActive ? (
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => updateCount(item.id, item.counted_stock - 1)}
                            className="w-6 h-6 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 flex items-center justify-center">
                            <Minus size={12} />
                          </button>
                          <span className="w-10 text-center font-semibold">{item.counted_stock}</span>
                          <button onClick={() => updateCount(item.id, item.counted_stock + 1)}
                            className="w-6 h-6 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 flex items-center justify-center">
                            <Plus size={12} />
                          </button>
                        </div>
                      ) : (
                        <span className="font-semibold">{item.counted_stock}</span>
                      )}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${
                      diff === 0 ? 'text-green-600' : diff > 0 ? 'text-blue-600' : 'text-red-600'
                    }`}>
                      {diff === 0 ? '✓' : diff > 0 ? `+${diff}` : diff}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>

        {/* Кнопка завершення */}
        {isActive && (
          <div className="flex justify-end">
            <Button onClick={completeSession} icon={<CheckCircle size={16} />}>
              Завершити та застосувати
            </Button>
          </div>
        )}
      </div>
    </Layout>
  )
}
