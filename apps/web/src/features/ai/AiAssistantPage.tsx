import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import {
  Sparkles, Send, Paperclip, X, Check, Loader2, AlertTriangle, Settings as SettingsIcon, Eye, Trash2,
} from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { aiApi } from './aiApi'
import type { AiStatus, AiPendingAction, AiChatMessage, AiActionChange, AiChatImage } from './aiApi'
import { OrderConfirmModal } from './OrderConfirmModal'
import { useAuthStore } from '@/stores/authStore'

// ── Таблиця «було → стане» для одиничної дії ─────────────────────────────────
function ChangesTable({ changes }: { changes: AiActionChange[] }) {
  return (
    <div className="rounded-lg border border-gray-100 overflow-hidden bg-white">
      <table className="w-full text-xs">
        <tbody className="divide-y divide-gray-50">
          {changes.map((c, ci) => (
            <tr key={ci}>
              <td className="px-2.5 py-1.5 font-medium text-gray-500 w-28 align-top">{c.label}</td>
              <td className="px-2.5 py-1.5 text-gray-400 line-through align-top">{c.old ?? '—'}</td>
              <td className="px-2.5 py-1.5 text-gray-900 font-medium align-top">{c.next}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Таблиця-прев'ю масової дії (з обмеженням рядків для компактного вигляду) ──
function BulkPreviewTable({ action, maxRows }: { action: AiPendingAction; maxRows?: number }) {
  const all = action.items ?? []
  const cols = action.columns ?? []
  const rows = maxRows ? all.slice(0, maxRows) : all
  return (
    <div className="rounded-lg border border-gray-100 overflow-hidden bg-white">
      <div className={maxRows ? 'overflow-x-auto' : 'max-h-[60vh] overflow-auto'}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-50 text-gray-400">
            <tr>
              <th className="px-2 py-1.5 text-left font-semibold w-8">#</th>
              {cols.map((col) => (
                <th key={col} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((row, ri) => (
              <tr key={ri}>
                <td className="px-2 py-1.5 text-gray-300">{ri + 1}</td>
                {cols.map((col) => (
                  <td key={col} className="px-2 py-1.5 text-gray-800 align-top whitespace-nowrap">{row[col] ?? '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {maxRows && all.length > maxRows && (
        <div className="text-[11px] text-gray-400 px-2 py-1 bg-gray-50 text-center">
          …та ще {all.length - maxRows}. Натисніть «Переглянути та підтвердити», щоб побачити всі.
        </div>
      )}
    </div>
  )
}

interface ChatEntry {
  role: 'user' | 'model'
  text: string
  actions?: AiPendingAction[]
  cost?: number
}

// Переписка зберігається локально, щоб не зникати при переході на іншу вкладку
const CHAT_STORAGE_KEY = 'forsage_ai_chat_v1'

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGES = 4
const ALLOWED_ATTACHMENT_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.txt']
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']

function isImageFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext))
}

// ── Читання прикріпленого файлу у текст (Excel/CSV/текст) ──────────────────────
async function fileToText(file: File): Promise<string> {
  const name = file.name.toLowerCase()
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    throw new Error('Підтримуються Excel, CSV, TXT та фото (JPG/PNG/WebP)')
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Файл завеликий — максимум 5 МБ')
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const parts: string[] = []
    for (const sheetName of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName])
      parts.push(`# Лист: ${sheetName}\n${csv}`)
    }
    return parts.join('\n\n')
  }
  // csv / txt / інше — як текст
  return await file.text()
}

// ── Стиснення фото для відправки в Gemini (довша сторона ≤1800px, JPEG) ────────
// Рукописний текст має лишатися читабельним, тому не тиснемо занадто сильно.
async function fileToCompressedImage(file: File): Promise<{ name: string; dataUrl: string }> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Фото завелике — максимум 20 МБ')
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Не вдалося прочитати фото (спробуйте JPG або PNG)'))
      el.src = objectUrl
    })
    const maxSide = 1800
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas недоступний')
    ctx.drawImage(img, 0, 0, w, h)
    return { name: file.name, dataUrl: canvas.toDataURL('image/jpeg', 0.88) }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function dataUrlToChatImage(dataUrl: string): AiChatImage {
  const [, base64] = dataUrl.split(',', 2)
  return { mime_type: 'image/jpeg', data_base64: base64 ?? '' }
}

export default function AiAssistantPage() {
  const navigate = useNavigate()
  const role = useAuthStore((state) => state.session?.user.user_metadata?.role as string | undefined)
  const canConfigure = role === 'owner' || role === 'admin'
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)

  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [attachment, setAttachment] = useState<{ name: string; text: string } | null>(null)
  const [imageAttachments, setImageAttachments] = useState<Array<{ name: string; dataUrl: string }>>([])
  const [orderModalAction, setOrderModalAction] = useState<AiPendingAction | null>(null)
  const [applied, setApplied] = useState<Record<string, 'ok' | 'rejected'>>({})
  const [applyMsg, setApplyMsg] = useState<Record<string, string>>({})
  const [applyErrors, setApplyErrors] = useState<Record<string, Array<{ item: string; error: string }>>>({})
  const [applyStatus, setApplyStatus] = useState<Record<string, 'ok' | 'warn'>>({})
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [modalAction, setModalAction] = useState<AiPendingAction | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    aiApi.status()
      .then(({ data }) => setStatus(data))
      .catch(() => {})
      .finally(() => setLoadingStatus(false))
  }, [])

  // ── Збереження переписки (localStorage, тримається місяцями — не лише тиждень) ──
  const hydratedRef = useRef(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAT_STORAGE_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (Array.isArray(p.entries)) setEntries(p.entries)
        if (p.applied) setApplied(p.applied)
        if (p.applyMsg) setApplyMsg(p.applyMsg)
        if (p.applyStatus) setApplyStatus(p.applyStatus)
        if (p.applyErrors) setApplyErrors(p.applyErrors)
      }
    } catch { /* ignore */ }
    hydratedRef.current = true
  }, [])

  useEffect(() => {
    // не перезаписуємо сховище порожнім до завершення завантаження
    if (!hydratedRef.current) return
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
        entries: entries.slice(-80), applied, applyMsg, applyStatus, applyErrors,
        savedAt: Date.now(),
      }))
    } catch { /* quota/JSON — ігноруємо */ }
  }, [entries, applied, applyMsg, applyStatus, applyErrors])

  function clearChat() {
    setEntries([]); setApplied({}); setApplyMsg({}); setApplyStatus({}); setApplyErrors({}); setModalAction(null)
    try { localStorage.removeItem(CHAT_STORAGE_KEY) } catch { /* ignore */ }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [entries, sending])

  async function handleAttach(file: File | undefined) {
    if (!file) return
    try {
      if (isImageFile(file)) {
        if (imageAttachments.length >= MAX_IMAGES) {
          toast.error(`Максимум ${MAX_IMAGES} фото за раз`)
          return
        }
        const img = await fileToCompressedImage(file)
        setImageAttachments((prev) => [...prev, img])
        toast.success(`Фото «${file.name}» прикріплено`)
        return
      }
      const text = await fileToText(file)
      setAttachment({ name: file.name, text })
      toast.success(`Файл «${file.name}» прикріплено`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося прочитати файл')
    }
  }

  async function send() {
    const message = input.trim()
    if (!message && !attachment && imageAttachments.length === 0) return
    if (sending) return

    const history: AiChatMessage[] = entries.map((e) => ({ role: e.role, text: e.text }))
    const attachmentNote = [
      attachment ? `📎 ${attachment.name}` : null,
      ...imageAttachments.map((img) => `🖼️ ${img.name}`),
    ].filter(Boolean).join('\n')
    const userEntry: ChatEntry = {
      role: 'user',
      text: message + (attachmentNote ? `\n\n${attachmentNote}` : ''),
    }
    setEntries((prev) => [...prev, userEntry])
    const fileText = attachment?.text
    const images = imageAttachments.length > 0 ? imageAttachments.map((img) => dataUrlToChatImage(img.dataUrl)) : undefined
    const fallbackPrompt = images ? 'Ось фото замовлення з зошита — додай замовлення в програму.' : 'Ось файл, розбери його.'
    setInput('')
    setAttachment(null)
    setImageAttachments([])
    setSending(true)

    try {
      const { data } = await aiApi.chat({ message: message || fallbackPrompt, history, file_text: fileText, images })
      setEntries((prev) => [...prev, { role: 'model', text: data.reply, actions: data.actions, cost: data.usage.cost_usd }])
      // оновимо лічильник у шапці
      setStatus((s) => s ? { ...s, usage: { ...s.usage, cost_usd: Number((s.usage.cost_usd + data.usage.cost_usd).toFixed(4)), requests: s.usage.requests + 1 } } : s)
    } catch (e) {
      setEntries((prev) => [...prev, { role: 'model', text: '⚠️ ' + (e instanceof Error ? e.message : 'Помилка запиту') }])
    } finally {
      setSending(false)
    }
  }

  async function applyAction(action: AiPendingAction, payloadOverride?: Record<string, any>) {
    setApplyingId(action.id)
    try {
      const { data } = await aiApi.applyAction({ tool: action.tool, payload: payloadOverride ?? action.payload })
      const r = data.result

      if (action.tool === 'create_order') {
        const num = r?.order_number != null ? `#${r.order_number}` : ''
        const where = r?.status === 'completed' ? 'в архіві (Виконані)' : 'у розділі «Замовлення»'
        const msg = `Замовлення ${num} створено — ${where}` + (r?.customer_created ? ', клієнта заведено' : '')
        setApplyMsg((prev) => ({ ...prev, [action.id]: msg }))
        setApplyStatus((prev) => ({ ...prev, [action.id]: 'ok' }))
        setApplied((prev) => ({ ...prev, [action.id]: 'ok' }))
        toast.success(msg)
        return
      }

      const errors = Array.isArray(r?.errors) ? r.errors : []

      if (r && typeof r.created === 'number') {
        // Масова дія: created / failed
        const created = r.created
        const failed = r.failed ?? 0
        setApplyErrors((prev) => ({ ...prev, [action.id]: errors }))
        if (created === 0) {
          const msg = `Не створено жодного (пропущено ${failed})`
          setApplyMsg((prev) => ({ ...prev, [action.id]: msg }))
          setApplyStatus((prev) => ({ ...prev, [action.id]: 'warn' }))
          setApplied((prev) => ({ ...prev, [action.id]: 'ok' }))
          toast.error(msg)
        } else {
          const msg = `Створено ${created}` + (failed ? `, пропущено ${failed}` : '')
          setApplyMsg((prev) => ({ ...prev, [action.id]: msg }))
          setApplyStatus((prev) => ({ ...prev, [action.id]: failed ? 'warn' : 'ok' }))
          setApplied((prev) => ({ ...prev, [action.id]: 'ok' }))
          if (failed) toast.warning(msg); else toast.success(msg + ' — дивіться в розділі «Клієнти/Товари»')
        }
      } else {
        // Одинична дія
        setApplyMsg((prev) => ({ ...prev, [action.id]: 'Збережено' }))
        setApplyStatus((prev) => ({ ...prev, [action.id]: 'ok' }))
        setApplied((prev) => ({ ...prev, [action.id]: 'ok' }))
        toast.success('Збережено')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не вдалося застосувати')
    } finally {
      setApplyingId(null)
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // ── Drag & drop файлу у вікно чату ──────────────────────────────
  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
    if (notConfigured) return
    if (!dragOver) setDragOver(true)
  }
  function onDragLeave(e: React.DragEvent) {
    // ігноруємо переходи між дочірніми елементами — гасимо лише при виході з контейнера
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (notConfigured) return
    const files = Array.from(e.dataTransfer.files ?? []).slice(0, MAX_IMAGES)
    for (const file of files) handleAttach(file)
  }

  const notConfigured = !loadingStatus && status && (!status.has_key || !status.enabled)

  return (
    <Layout title="Допомога АІ">
      <div
        className="max-w-3xl mx-auto flex flex-col relative"
        style={{ height: 'calc(100vh - 140px)' }}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Оверлей при перетягуванні файлу */}
        {dragOver && (
          <div className="absolute inset-0 z-30 rounded-2xl border-2 border-dashed border-purple-400 bg-purple-50/85 backdrop-blur-sm flex flex-col items-center justify-center gap-2 pointer-events-none">
            <Paperclip size={28} className="text-purple-500" />
            <p className="text-sm font-semibold text-purple-700">Відпустіть файл, щоб прикріпити</p>
            <p className="text-xs text-purple-400">Фото замовлення (JPG/PNG), Excel, CSV або текст</p>
          </div>
        )}

        {/* Шапка з лічильником */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
              <Sparkles size={18} className="text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-gray-800">Директор (Gemini)</p>
              <p className="text-[11px] text-gray-400">{status?.model ?? 'gemini-2.5-flash'}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {status && (
              <div className="text-right">
                <p className="text-[11px] text-gray-400">Витрати за місяць</p>
                <p className="text-sm font-bold text-gray-700">≈ ${status.usage.cost_usd.toFixed(4)}</p>
              </div>
            )}
            {entries.length > 0 && (
              <button
                type="button"
                onClick={clearChat}
                title="Очистити переписку"
                className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </div>

        {notConfigured && (
          <Card className="mb-3 border-amber-200 bg-amber-50/60">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-800">
                  {!status?.has_key ? 'Ключ Gemini не додано' : 'Помічник вимкнено'}
                </p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Додайте API-ключ Gemini та увімкніть помічника в Налаштуваннях, щоб почати діалог.
                </p>
              </div>
              {canConfigure ? (
                <Button type="button" variant="secondary" onClick={() => navigate('/settings')} className="text-xs shrink-0">
                  <SettingsIcon size={14} className="mr-1" /> Налаштування
                </Button>
              ) : (
                <span className="text-xs text-amber-700">Зверніться до адміністратора</span>
              )}
            </div>
          </Card>
        )}

        {/* Стрічка діалогу */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pr-1">
          {entries.length === 0 && !sending && (
            <div className="h-full flex flex-col items-center justify-center text-center text-gray-400 gap-2 px-6">
              <Sparkles size={32} className="text-gray-300" />
              <p className="text-sm font-medium text-gray-500">Напишіть завдання директору</p>
              <p className="text-xs max-w-sm">
                Наприклад: сфотографуйте рукописне замовлення з зошита й напишіть «додай замовлення
                в програму» — клієнт, авто і запчастини заведуться самі. Або: «розбери цей прайс»
                (перетягніть Excel/фото сюди чи натисніть 📎), «знайди дублі в назвах фільтрів».
              </p>
            </div>
          )}

          {entries.map((entry, i) => (
            <div key={i} className={entry.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[85%] ${entry.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-2`}>
                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                    entry.role === 'user'
                      ? 'bg-gray-800 text-white rounded-br-sm'
                      : 'bg-white border border-gray-100 text-gray-800 rounded-bl-sm'
                  }`}
                >
                  {entry.text}
                </div>

                {/* Картки пропозицій змін */}
                {entry.actions?.map((action) => {
                  const state = applied[action.id]
                  const isOrder = action.tool === 'create_order'
                  const isBulk = !isOrder && !!(action.items && action.columns)
                  return (
                    <Card key={action.id} className="w-full border-blue-100 bg-blue-50/40 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-gray-800">{action.title}</p>
                        {isBulk && <span className="text-[11px] text-gray-400 shrink-0 whitespace-nowrap">{action.count} записів</span>}
                      </div>

                      {isOrder ? (
                        <>
                          <ChangesTable changes={action.changes} />
                          <BulkPreviewTable action={action} maxRows={6} />
                          {(action.uncertain?.length ?? 0) > 0 && state !== 'ok' && (
                            <p className="text-[11px] font-medium text-amber-600 flex items-center gap-1">
                              <AlertTriangle size={12} /> Деякі поля розпізнано невпевнено — перевірте їх у вікні підтвердження
                            </p>
                          )}
                        </>
                      ) : isBulk
                        ? <BulkPreviewTable action={action} maxRows={4} />
                        : <ChangesTable changes={action.changes} />}

                      {state === 'ok' ? (
                        <div className="space-y-1">
                          {applyStatus[action.id] === 'warn' ? (
                            <p className="text-xs font-semibold text-amber-600 flex items-center gap-1">
                              <AlertTriangle size={14} /> {applyMsg[action.id] ?? 'Застосовано з попередженнями'}
                            </p>
                          ) : (
                            <p className="text-xs font-semibold text-green-600 flex items-center gap-1">
                              <Check size={14} /> {applyMsg[action.id] ?? 'Застосовано'}
                            </p>
                          )}
                          {(applyErrors[action.id]?.length ?? 0) > 0 && (
                            <ul className="text-[11px] text-gray-500 bg-white rounded-md border border-gray-100 px-2 py-1 space-y-0.5 max-h-24 overflow-y-auto">
                              {applyErrors[action.id].slice(0, 8).map((er, ei) => (
                                <li key={ei}><span className="text-gray-700 font-medium">{er.item}</span>: {er.error}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : state === 'rejected' ? (
                        <p className="text-xs font-medium text-gray-400 flex items-center gap-1">
                          <X size={14} /> Відхилено
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-600 bg-amber-50 rounded-md px-2 py-1">
                            <AlertTriangle size={12} /> Ще не збережено — потрібне ваше підтвердження
                          </div>
                          <div className="flex gap-2">
                            {isOrder ? (
                              <Button type="button" onClick={() => setOrderModalAction(action)} className="text-xs">
                                <Eye size={14} className="mr-1" /> Перевірити та створити замовлення
                              </Button>
                            ) : isBulk ? (
                              <Button type="button" onClick={() => setModalAction(action)} className="text-xs">
                                <Eye size={14} className="mr-1" /> Переглянути та підтвердити{action.count ? ` (${action.count})` : ''}
                              </Button>
                            ) : (
                              <Button type="button" onClick={() => applyAction(action)} loading={applyingId === action.id} className="text-xs">
                                <Check size={14} className="mr-1" /> Застосувати
                              </Button>
                            )}
                            <Button type="button" variant="secondary" onClick={() => setApplied((p) => ({ ...p, [action.id]: 'rejected' }))} className="text-xs">
                              Відхилити
                            </Button>
                          </div>
                        </div>
                      )}
                    </Card>
                  )
                })}

                {entry.role === 'model' && entry.cost !== undefined && entry.cost > 0 && (
                  <span className="text-[10px] text-gray-300 px-1">≈ ${entry.cost.toFixed(5)}</span>
                )}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-sm px-4 py-2.5">
                <Loader2 size={16} className="text-gray-400 animate-spin" />
              </div>
            </div>
          )}
        </div>

        {/* Поле вводу */}
        <div className="mt-3 border border-gray-200 rounded-2xl bg-white p-2 shadow-sm">
          {attachment && (
            <div className="flex items-center gap-2 mb-2 px-2 py-1.5 bg-gray-50 rounded-lg text-xs">
              <Paperclip size={13} className="text-gray-400" />
              <span className="flex-1 truncate text-gray-600">{attachment.name}</span>
              <button
                type="button"
                onClick={() => setAttachment(null)}
                className="text-gray-400 hover:text-red-500"
                aria-label={`Видалити вкладення ${attachment.name}`}
                title="Видалити вкладення"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {imageAttachments.length > 0 && (
            <div className="flex gap-2 mb-2 px-1 flex-wrap">
              {imageAttachments.map((img, i) => (
                <div key={i} className="relative group">
                  <img src={img.dataUrl} alt={img.name} className="h-16 w-16 object-cover rounded-lg border border-gray-200" />
                  <button
                    type="button"
                    onClick={() => setImageAttachments((prev) => prev.filter((_, x) => x !== i))}
                    className="absolute -top-1.5 -right-1.5 bg-white border border-gray-200 rounded-full p-0.5 text-gray-400 hover:text-red-500 shadow-sm"
                    aria-label={`Видалити фото ${img.name}`}
                    title="Видалити фото"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.txt,.jpg,.jpeg,.png,.webp,image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                for (const f of Array.from(e.target.files ?? []).slice(0, MAX_IMAGES)) handleAttach(f)
                if (fileRef.current) fileRef.current.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={!!notConfigured}
              className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-40 shrink-0"
              title="Прикріпити фото замовлення / Excel / CSV / текст"
              aria-label="Прикріпити фото замовлення, Excel, CSV або текстовий файл"
            >
              <Paperclip size={18} />
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={!!notConfigured}
              rows={1}
              placeholder={notConfigured ? 'Спочатку налаштуйте ключ Gemini…' : 'Напишіть завдання… (Enter — надіслати, Shift+Enter — новий рядок)'}
              className="flex-1 resize-none max-h-40 py-2 px-1 text-sm focus:outline-none disabled:bg-transparent"
            />
            <Button
              type="button"
              onClick={send}
              disabled={sending || !!notConfigured || (!input.trim() && !attachment && imageAttachments.length === 0)}
              className="shrink-0"
              aria-label="Надіслати повідомлення"
              title="Надіслати повідомлення"
            >
              <Send size={16} />
            </Button>
          </div>
        </div>
      </div>

      {/* Вікно попереднього перегляду масової дії з підтвердженням унизу */}
      <Modal
        open={!!modalAction}
        onClose={() => setModalAction(null)}
        title={modalAction?.title ?? 'Попередній перегляд'}
        size="xl"
      >
        {modalAction && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              Директор підготував <b>{modalAction.count}</b> {(modalAction.count ?? 0) === 1 ? 'запис' : 'записів'}.
              Перевірте список — нічого не збережеться, доки ви не натиснете «Підтвердити».
            </p>

            {modalAction.items
              ? <BulkPreviewTable action={modalAction} />
              : <ChangesTable changes={modalAction.changes} />}

            <div className="flex gap-2 pt-3 border-t border-gray-100">
              <Button
                type="button"
                className="flex-1"
                loading={applyingId === modalAction.id}
                onClick={async () => { await applyAction(modalAction); setModalAction(null) }}
              >
                <Check size={16} className="mr-1" /> Підтвердити та зберегти{modalAction.count ? ` (${modalAction.count})` : ''}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setModalAction(null)}>
                Скасувати
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Редаговане підтвердження замовлення з фото (сумнівні поля підсвічено) */}
      {orderModalAction && (
        <OrderConfirmModal
          action={orderModalAction}
          applying={applyingId === orderModalAction.id}
          onClose={() => setOrderModalAction(null)}
          onConfirm={async (editedPayload) => {
            await applyAction(orderModalAction, editedPayload)
            setOrderModalAction(null)
          }}
        />
      )}
    </Layout>
  )
}
