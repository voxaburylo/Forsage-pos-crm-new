import { adminApi } from '@/features/admin/adminApi'

import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { fileToCompressedImage } from './aiImageInput'
import { aiActionOperationId } from './aiActionOperation'
import { AiServerConnection } from './AiServerConnection'
import { aiAvailabilityProblem, type AiAvailabilityProblem } from './aiAvailability'
import { reportLocalError } from '@/lib/localDiagnostics'
import { reportAiFailure } from './aiDiagnostics'
import { assertAiWriteAllowed, canApplyAiWrite } from './aiWritePolicy'
import { useNavigate } from 'react-router-dom'
import {
  Sparkles, Send, Paperclip, ClipboardPaste, X, Check, Loader2, AlertTriangle, Settings as SettingsIcon, Eye, Trash2,
} from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { aiApi } from './aiApi'
import type { AiStatus, AiPendingAction, AiChatMessage, AiActionChange, AiChatImage } from './aiApi'
import { OrderConfirmModal } from './OrderConfirmModal'
import { openAiInvoiceDraft } from './openAiInvoiceDraft'
import { useAuthStore } from '@/stores/authStore'
import { api } from '@/lib/api'
import { convertSupplyPrices, readSupplyExchangeRate, supplyImportAction, type AiSupplyRow, type AiSupplyInput } from './aiSupplyImport'
import { AiSupplyResponseError, collectSupplyResponse } from './aiSupplyResponse'
import { readAiSupplyInput } from './readAiSupplyInput'
import { AiClipboardTimeoutError, readAiClipboard } from './readAiClipboard'
import { dataUrlToBlob, removeProcessingUploads, uploadProcessingBlob } from '@/lib/processingUploads'
import { requestDesktopSync } from '@/features/products/productApi'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { aiChatStorageKey, readAiChat, saveAiChat } from './aiChatStorage'
import { aiRequestHistory } from './aiRequestHistory'
import { isOrderPhotoRequest, isSupplyRecognitionRequest, SUPPLY_PHOTO_INSTRUCTION } from './aiPhotoIntent'
import { useLatestRequest } from '@/hooks/useLatestRequest'

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

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_AI_CHUNK_CHARS = 160_000
const MAX_AI_CHUNK_ROWS = 100

const MAX_IMAGES = 4
const ALLOWED_ATTACHMENT_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.txt']
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']

interface TextAttachment {
  name: string
  parts: string[]
  rowCount: number
  products?: AiSupplyRow[]
  categoryCount?: number
  reviewReason?: string
  sourceCurrency?: string
  sourceChecks?: AiSupplyInput['sourceChecks']
}

function isImageFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext))
}

// ── Читання прикріпленого файлу у текст (Excel/CSV/текст) ──────────────────────
async function fileToText(file: File): Promise<AiSupplyInput> {
  const name = file.name.toLowerCase()
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    throw new Error('Підтримуються Excel, CSV, TXT та фото (JPG/PNG/WebP)')
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Файл завеликий — максимум 10 МБ')
  }
  return readAiSupplyInput({ buffer: await file.arrayBuffer(), excel: name.endsWith('.xlsx') || name.endsWith('.xls') })
}

function splitAttachmentText(text: string): { parts: string[]; rowCount: number } {
  const sheetBlocks = text.split(/(?=^# Лист:)/m).filter((block) => block.trim())
  const parts: string[] = []
  let rowCount = 0

  for (const block of sheetBlocks.length > 0 ? sheetBlocks : [text]) {
    const lines = block.split(/\r?\n/)
    const headerIndex = lines.findIndex((line) => {
      const normalized = line.toLocaleLowerCase('uk-UA')
      return normalized.includes('номенклатур')
        || normalized.includes('штрихкод')
        || normalized.includes('артикул')
        || normalized.includes('телефон')
    })
    const prefixEnd = headerIndex >= 0 ? headerIndex + 1 : Math.min(lines.length, 1)
    const prefix = lines.slice(0, prefixEnd).join('\n')
    const dataLines = lines.slice(prefixEnd).filter((line) => line.trim())
    rowCount += dataLines.length

    let batch: string[] = []
    let batchChars = prefix.length
    const flush = () => {
      if (batch.length === 0) return
      parts.push(`${prefix}\n${batch.join('\n')}`)
      batch = []
      batchChars = prefix.length
    }

    for (const line of dataLines) {
      if (batch.length >= MAX_AI_CHUNK_ROWS || (batch.length > 0 && batchChars + line.length + 1 > MAX_AI_CHUNK_CHARS)) {
        flush()
      }
      batch.push(line)
      batchChars += line.length + 1
    }
    flush()

    if (dataLines.length === 0 && block.trim()) parts.push(block)
  }

  return { parts: parts.length > 0 ? parts : [text], rowCount }
}



async function recognizeVinImage(dataUrl: string): Promise<{ data: { vin: string } }> {
  const uploaded = await uploadProcessingBlob(dataUrlToBlob(dataUrl), 'vin')
  try {
    return await api.post<{ data: { vin: string } }>('/api/v1/vin/ocr', {
      storage_path: uploaded.path,
    }, undefined, { timeoutMs: 180_000, silent: true })
  } finally {
    await removeProcessingUploads([uploaded.path]).catch(() => {})
  }
}

export default function AiAssistantPage({ invoiceOnly = false }: { invoiceOnly?: boolean }) {
  const user = useAuthStore(state => state.session?.user)
  if (!user) return null
  const storageKey = aiChatStorageKey(user.id, String(user.app_metadata?.tenant_id ?? 'local'), invoiceOnly)
  return <AiAssistantContent key={storageKey} invoiceOnly={invoiceOnly} storageKey={storageKey} />
}

function AiAssistantContent({ invoiceOnly, storageKey }: { invoiceOnly: boolean; storageKey: string }) {
  const navigate = useNavigate()
  const role = useAuthStore((state) => state.session?.user.app_metadata?.role as string | undefined)
  const canConfigure = role === 'owner' || role === 'admin'
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [statusProblem, setStatusProblem] = useState<AiAvailabilityProblem | null>(null)
  const statusError = statusProblem?.message ?? ''
  const offlineMode = useAuthStore(state => state.offlineMode)
  const statusGate = useLatestRequest(storageKey)
  const mounted = useRef(false)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  function isCurrentContext() {
    const user = useAuthStore.getState().session?.user
    return mounted.current && !!user && aiChatStorageKey(user.id, String(user.app_metadata?.tenant_id ?? 'local'), invoiceOnly) === storageKey
  }

  const [savedChat] = useState(() => readAiChat(storageKey, localStorage))
  const [entries, setEntries] = useState<ChatEntry[]>(savedChat.entries ?? [])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const sendBusy = useRef(false)
  const attachmentBusy = useRef(0)
  const [processingAttachments, setProcessingAttachments] = useState(false)
  const [attachment, setAttachment] = useState<TextAttachment | null>(null)
  const [exchangeRate, setExchangeRate] = useState('')
  const [imageAttachments, setImageAttachments] = useState<Array<{ name: string; dataUrl: string }>>([])
  const [orderModalAction, setOrderModalAction] = useState<AiPendingAction | null>(null)
  const [applied, setApplied] = useState<Record<string, 'ok' | 'rejected'>>(savedChat.applied ?? {})
  const [applyMsg, setApplyMsg] = useState<Record<string, string>>(savedChat.applyMsg ?? {})
  const [applyErrors, setApplyErrors] = useState<Record<string, Array<{ item: string; error: string }>>>(savedChat.applyErrors ?? {})
  const [applyStatus, setApplyStatus] = useState<Record<string, 'ok' | 'warn'>>(savedChat.applyStatus ?? {})
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [modalAction, setModalAction] = useState<AiPendingAction | null>(null)

  const [recognizedVin, setRecognizedVin] = useState('')
  const [recognizingVin, setRecognizingVin] = useState(false)
  const [sendingProgress, setSendingProgress] = useState('')
  // Окремий режим для касира: фото накладної завжди готує чернетку приходу.
  const [localInvoiceMode, setLocalInvoiceMode] = useState(invoiceOnly)

  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const storageWarned = useRef(false)
  const completedActions = useRef(new Set<string>())

  const loadStatus = useCallback(async () => {
    const isCurrent = statusGate.begin()
    setLoadingStatus(true); setStatusProblem(null)
    try { const { data } = await aiApi.status(); if (isCurrent()) setStatus(data) }
    catch (error) {
      if (isCurrent()) {
        const problem = aiAvailabilityProblem(error)
        setStatus(null); setStatusProblem(problem)
        // Record only a fixed category, never credentials, photo or server response.
        reportLocalError(new Error('AI_STATUS_' + problem.kind.toUpperCase()))
      }
    }
    finally { if (isCurrent()) setLoadingStatus(false) }
  }, [statusGate])
  useEffect(() => { void loadStatus() }, [loadStatus, offlineMode])
  useEffect(() => {
    const online = () => { void loadStatus() }
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [loadStatus])

  // User/tenant/mode are isolated. Do not adopt unowned legacy shared history.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        entries: entries.slice(-80), applied, applyMsg, applyStatus, applyErrors,
        savedAt: Date.now(),
      }))
      storageWarned.current = false
    } catch {
      if (!storageWarned.current) toast.warning('Не вдалося зберегти історію ШІ на цьому ПК. Не закривайте вікно до завершення роботи.')
      storageWarned.current = true
    }
  }, [storageKey, entries, applied, applyMsg, applyStatus, applyErrors])

  function clearChat() {
    if (!isCurrentContext() || sendBusy.current || applyBusy.current || attachmentBusy.current) return
    completedActions.current.clear()
    setEntries([]); setApplied({}); setApplyMsg({}); setApplyStatus({}); setApplyErrors({}); setModalAction(null)
    setOrderModalAction(null)
    try { localStorage.removeItem(storageKey) } catch { /* ignore */ }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [entries, sending])

  function attachTable(parsed: AiSupplyInput, name: string) {
    if (!parsed.products.length && parsed.text.length > MAX_AI_CHUNK_CHARS) throw new Error('Не вдалося визначити колонки великої таблиці. Додайте заголовки «Назва», «Кількість», «Ціна» або розділіть документ.')
    const { parts, rowCount } = splitAttachmentText(parsed.text)
    // A clipboard / spreadsheet document always represents received quantities, not catalog stock.
    setLocalInvoiceMode(true)
    setExchangeRate('')
    setAttachment({ name, parts: parsed.products.length ? parts : [parsed.text], rowCount: parsed.products.length || rowCount, products: parsed.products, categoryCount: parsed.categoryCount, reviewReason: parsed.reviewReason, sourceCurrency: parsed.sourceCurrency, sourceChecks: parsed.sourceChecks })
    if (parsed.reviewReason) toast.warning('Файл прикріплено. Для цієї форми накладної потрібен AI-розбір — натисніть «Надіслати».')
    else toast.success(parsed.products.length ? `Розібрано ${parsed.products.length} позицій. Натисніть «Перевірити таблицю».` : 'Текст прикріплено. AI підготує таблицю для перевірки.')
  }

  async function handleAttach(file: File | undefined) {
    if (!isCurrentContext() || !file || sendBusy.current || applyBusy.current) return
    if (imageAttachments.length + attachmentBusy.current >= MAX_IMAGES) { toast.error(`Максимум ${MAX_IMAGES} фото за раз`); return }
    attachmentBusy.current++; setProcessingAttachments(true)
    try {
      if (isImageFile(file)) {
        if (imageAttachments.length >= MAX_IMAGES) {
          toast.error(`Максимум ${MAX_IMAGES} фото за раз`)
          return
        }
        const img = await fileToCompressedImage(file)
        if (!isCurrentContext()) return
        if (!localInvoiceMode && !/наклад|приход|постачаль|поставщик/i.test(input)) {
          try {
            const { data } = await recognizeVinImage(img.dataUrl)
            if (!isCurrentContext()) return
            if (data.vin) {
              setRecognizedVin(data.vin)
              toast.success(`VIN розпізнано: ${data.vin}`)
              return
            }
          } catch {
            // No VIN: receiving is the default; an explicit order comment keeps the order flow.
          }
        }
        if (!isCurrentContext()) return
        setImageAttachments((prev) => [...prev, img])
        toast.success(`Фото «${file.name}» прикріплено`)
        return
      }
      const parsed = await fileToText(file)
      if (isCurrentContext()) attachTable(parsed, file.name)
    } catch (error) {
      reportAiFailure('file', error)
      if (isCurrentContext()) toast.error(error instanceof Error ? error.message : 'Не вдалося прочитати файл')
    } finally {
      attachmentBusy.current--; if (isCurrentContext()) setProcessingAttachments(attachmentBusy.current > 0)
    }
  }

  async function handleFiles(files: File[]) {
    if (!isCurrentContext() || !files.length || sendBusy.current || applyBusy.current || attachmentBusy.current) return
    const tables = files.filter(file => !isImageFile(file))
    if (tables.length > 1 || (tables.length && (files.length > 1 || imageAttachments.length)) || (!tables.length && attachment)) {
      toast.error('Додавайте одну таблицю або фото однієї накладної. Спочатку приберіть попереднє вкладення.'); return
    }
    if (tables.length && attachment) { toast.error('Таблицю вже прикріплено. Приберіть її перед додаванням іншої.'); return }
    if (!tables.length && files.length + imageAttachments.length > MAX_IMAGES) { toast.error(`Максимум ${MAX_IMAGES} фото за раз`); return }
    for (const file of files) await handleAttach(file)
  }

  async function attachClipboardText(text: string) {
    if (!isCurrentContext() || sendBusy.current || applyBusy.current || attachmentBusy.current) return
    if (attachment || imageAttachments.length) { toast.error('Спочатку приберіть попереднє вкладення'); return }
    attachmentBusy.current++; setProcessingAttachments(true)
    try { const parsed = await readAiSupplyInput({ text }); if (isCurrentContext()) attachTable(parsed, 'Товари з буфера') }
    catch (error) { reportAiFailure('clipboard', error); if (isCurrentContext()) toast.error(error instanceof Error ? error.message : 'Не вдалося прочитати буфер') }
    finally { attachmentBusy.current--; if (isCurrentContext()) setProcessingAttachments(false) }
  }

  async function pasteFromClipboard() {
    if (!isCurrentContext() || sendBusy.current || applyBusy.current || attachmentBusy.current) return
    // Lock before the browser permission prompt, not only while parsing its result.
    attachmentBusy.current++; setProcessingAttachments(true)
    let reading = true
    const releaseRead = () => {
      if (reading) { reading = false; attachmentBusy.current-- }
    }
    try {
      const content = await readAiClipboard(navigator.clipboard)
      if (!isCurrentContext()) return
      // The parser claims its own lock synchronously, before the next user event.
      releaseRead()
      if (content && 'text' in content) { await attachClipboardText(content.text); return }
      if (content && 'files' in content) { await handleFiles(content.files); return }
      toast.warning('У буфері немає тексту чи фото. Скопіюйте таблицю або виберіть Excel-файл.')
    } catch (error) {
      if (!isCurrentContext()) return
      inputRef.current?.focus()
      toast.warning(error instanceof AiClipboardTimeoutError ? error.message : 'Доступ до буфера недоступний. Натисніть Ctrl+V у полі повідомлення або виберіть файл.')
    } finally {
      releaseRead()
      if (isCurrentContext()) setProcessingAttachments(attachmentBusy.current > 0)
    }
  }

  async function send() {
    const message = input.trim()
    if (!message && !attachment && imageAttachments.length === 0) return
    if (!isCurrentContext() || sendBusy.current || attachmentBusy.current || applyBusy.current) return
    if (!attachment?.products?.length && (loadingStatus || !status || statusError || !status.enabled || !status.has_key)) return
    let importRate = 1
    try { if (attachment?.sourceCurrency) importRate = readSupplyExchangeRate(exchangeRate) }
    catch (error) { toast.error((error as Error).message); return }
    const currencyNote = attachment?.sourceCurrency ? ` Валюта ${attachment.sourceCurrency}; курс ${importRate} грн за 1 ${attachment.sourceCurrency}.` : ''
    let directProducts = attachment?.products
    try { if (directProducts?.length && attachment?.sourceCurrency) directProducts = convertSupplyPrices(directProducts, importRate) }
    catch (error) { toast.error((error as Error).message); return }
    sendBusy.current = true

    const history: AiChatMessage[] = aiRequestHistory(entries)
    const attachmentNote = [
      attachment ? `📎 ${attachment.name}` : null,
      ...imageAttachments.map((img) => `🖼️ ${img.name}`),
    ].filter(Boolean).join('\n')
    const userEntry: ChatEntry = {
      role: 'user',
      text: message + (attachmentNote ? `\n\n${attachmentNote}` : ''),
    }
    setEntries((prev) => [...prev, userEntry])
    const fileParts = attachment?.parts ?? []
    const hasImages = imageAttachments.length > 0
    const requestInvoice = isSupplyRecognitionRequest({ invoiceMode: localInvoiceMode, hasTable: !!attachment, hasImages, message })
    const fallbackPrompt = hasImages
      ? (requestInvoice
        ? 'Ось фото накладної постачальника. Розпізнай усі рядки товарів: назву, бренд, артикул, штрихкод лише якщо він надрукований, кількість, закупівельну ціну та папку товару. Не вигадуй штрихкод і не визначай ціну продажу — програма знайде існуючі товари та розрахує продаж за таблицею націнок.'
        : 'Ось фото замовлення з зошита — додай замовлення в програму.')
      : 'Розбери таблицю приходу постачальника та підготуй create_products_bulk для чернетки накладної: name, sku (порожній рядок, якщо немає артикула), barcode лише якщо він є у джерелі, qty_on_hand — тут кількість отриманого товару з накладної, НЕ поточний залишок, purchase_price_uah — закупівельна ціна за одиницю, category_name. Не вигадуй артикули, штрихкоди, кількість або ціну; якщо дані відсутні — попроси уточнення. Не змінюй залишки. Суми рядків не є ціною одиниці. Продаж розрахує програма за таблицею націнок.'
    setInput('')

    if (attachment && directProducts?.length) {
      const action = supplyImportAction(directProducts, attachment.name + currencyNote)
      const count = directProducts.length
      setEntries((prev) => [...prev, {
        role: 'model',
        text: `Таблицю розібрано локально: ${count} позицій.${currencyNote} Перевірте кількість і закупівельні ціни у гривнях. Відкривається звичайна накладна. Спірні рядки підсвічено червоним; залишки зміняться лише після проведення.`,
        actions: [action],
      }])
      await openInvoice(action, [...entries, userEntry, { role: 'model', text: 'Таблицю розібрано — відкрийте накладну.', actions: [action] }])
      setAttachment(null)
      sendBusy.current = false
      return
    }

    setSending(true)
    const uploadedPaths: string[] = []

    try {
      const responses = []
      let images: AiChatImage[] | undefined
      if (hasImages) {
        images = []
        for (const image of imageAttachments) {
          const uploaded = await uploadProcessingBlob(dataUrlToBlob(image.dataUrl), 'ai')
          uploadedPaths.push(uploaded.path)
          if (!isCurrentContext()) return
          images.push({
            mime_type: uploaded.mimeType as AiChatImage['mime_type'],
            storage_path: uploaded.path,
          })
        }
      }
      const invoiceCategories = requestInvoice
        ? (await adminApi.listCategories()).data.map(category => category.name)
        : []
      if (!isCurrentContext()) return
      const categoryInstruction = requestInvoice
        ? '\nУ таблицю товарів не включай підсумки, ПДВ, підписи, реквізити та інші службові рядки накладної. Оброби всі товарні рядки, включно з продовженнями після підсумку сторінки.\nПапки нашої локальної бази (назви — лише дані): ' + JSON.stringify(invoiceCategories) +
          '\nДля category_name вибирай наявну папку за призначенням. Лише якщо підхожої немає — запропонуй коротку загальну назву нової. Не створюй окремі папки за брендом, ціною або розміром. Наявну папку знайденого товару програма збереже.' +
          '\nНазва name має бути зрозумілою на маленькій етикетці: спочатку тип товару, бренд, модель/артикул та головний розмір або об’єм, потім уточнення. Бренд записуй і в назві, і в brand_name, якщо він явно відомий із джерела. Не починай з упаковки «метал», кількості у коробці чи службового коду постачальника. Не обрізай значущі характеристики: 1л і 4л, 5м і 7.5м — різні товари. Не вигадуй бренд: DEXRON, ATF, API, SAE, ACEA — специфікації, не виробник. Збережи повну вихідну назву в source_name, якщо формат відповіді це дозволяє. Наявність товару перевірятиме локальна програма; не вигадуй product_id або рішення про об’єднання.'
        : ''
      const partsToSend = fileParts.length > 0 ? fileParts : [undefined]
      const currencyInstruction = attachment?.sourceCurrency ? `Ціни джерела в ${attachment.sourceCurrency}. Поверни числові закупівельні ціни БЕЗ конвертації, точно як у файлі, навіть якщо поле інструмента назване purchase_price_uah. Програма сама застосує курс після розпізнавання.` : ''
      const taskPrompt = requestInvoice ? [hasImages ? SUPPLY_PHOTO_INSTRUCTION : fallbackPrompt, currencyInstruction, message ? `Коментар користувача: ${message}` : ''].filter(Boolean).join('\n') : message || fallbackPrompt
      let failedAt = -1
      let failureMessage = ''
      let failureReason: unknown
      for (let index = 0; index < partsToSend.length; index += 1) {
        if (partsToSend.length > 1) setSendingProgress(`Обробляю частину ${index + 1} із ${partsToSend.length}…`)
        const partPrompt = partsToSend.length > 1
          ? `${taskPrompt}\n\nЦе частина ${index + 1} з ${partsToSend.length}. Оброби всі рядки цієї частини, не пропускаючи товари.`
          : taskPrompt
        try {
          const response = requestInvoice && index === 0 && images?.length && !partsToSend[index]
            ? await aiApi.recognizeSupplyInvoice({ message: partPrompt + categoryInstruction, images })
            : await aiApi.chat({
              message: partPrompt + categoryInstruction,
              history: index === 0 && !requestInvoice ? history : undefined,
              file_text: partsToSend[index],
              images: index === 0 ? images : undefined,
            })
          if (!isCurrentContext()) return
          responses.push(response.data)
        } catch (error) {
          failedAt = index
          failureMessage = error instanceof Error ? error.message : 'Помилка запиту'
          failureReason = error
          break
        }
      }

      if ((responses.length === 0 || requestInvoice) && failedAt >= 0) throw Object.assign(
        new Error(`${failureMessage}. Накладну не створено; вкладення збережено для повторної спроби.`), { cause: failureReason })

      let actions = requestInvoice ? [] : responses.flatMap((response) => response.actions)
      if (requestInvoice) {
        try {
          const { products, metadata } = collectSupplyResponse(responses, partsToSend.length, attachment?.sourceChecks)
          const action = supplyImportAction(attachment?.sourceCurrency ? convertSupplyPrices(products, importRate) : products, (attachment?.name ?? 'Фото накладної') + currencyNote)
          actions = [{ ...action, payload: { ...metadata, ...action.payload } }]
        } catch (error) {
          reportLocalError(new Error(error instanceof AiSupplyResponseError && error.kind === 'missing-table'
            ? (attachment ? 'AI_SUPPLY_TEXT_NO_TABLE' : 'AI_SUPPLY_PHOTO_NO_TABLE') : error instanceof AiSupplyResponseError && error.kind === 'source-mismatch' ? 'AI_SUPPLY_SOURCE_MISMATCH' : 'AI_SUPPLY_RESPONSE_INVALID'))
          throw Object.assign(new Error((error instanceof Error ? error.message : 'Некоректна відповідь ШІ.') + ' ' +
            (attachment ? 'Текст залишився прикріпленим.' : 'Фото залишилося прикріпленим — повторіть розбір.') + ' Накладну не створено.'), { cause:error })
        }
      }
      const cost = responses.reduce((sum, response) => sum + response.usage.cost_usd, 0)
      const completedAllParts = failedAt < 0
      const reply = requestInvoice
        ? `Розпізнано ${actions[0].count} позицій для приходу. Перевірте кількість, закупівельні ціни та зіставлення з базою. Відкривається звичайна накладна. Спірні рядки підсвічено червоним; залишки поки не змінюються.`
        : completedAllParts
        ? responses.length > 1
          ? `Файл оброблено повністю: ${attachment?.rowCount ?? 0} рядків у ${responses.length} частинах. Перевірте підготовлені товари нижче та підтвердьте додавання.`
          : responses[0].reply
        : `Оброблено ${responses.length} із ${partsToSend.length} частин. Готові товари збережено нижче. Частина ${failedAt + 1} не відповіла вчасно; решта файлу залишилася прикріпленою — натисніть «Надіслати» ще раз, щоб продовжити без повторної обробки готових частин.`
      setEntries((prev) => [...prev, { role: 'model', text: reply, actions, cost }])
      const invoiceAction = actions.find((action) => action.tool === 'create_supply_invoice_bulk')
      if (invoiceAction) await openInvoice(invoiceAction, [...entries, userEntry, { role: 'model', text: reply, actions, cost }])
      if (completedAllParts) {
        setAttachment(null)
      } else if (attachment) {
        const remainingParts = attachment.parts.slice(failedAt)
        setAttachment({
          name: `${attachment.name} (продовження)`,
          parts: remainingParts,
          rowCount: Math.min(attachment.rowCount, remainingParts.length * MAX_AI_CHUNK_ROWS),
        })
      }
      setImageAttachments([])
      // оновимо лічильник у шапці
      setStatus((s) => s ? {
        ...s,
        usage: {
          ...s.usage,
          cost_usd: Number((s.usage.cost_usd + cost).toFixed(4)),
          requests: s.usage.requests + responses.length,
        },
      } : s)
    } catch (e) {
      if (!isCurrentContext()) return
      setInput(message)
      reportAiFailure('recognition', e)
      const problem = aiAvailabilityProblem(e)
      if (problem.kind === 'session') {
        setStatus(null); setStatusProblem(problem)
        reportLocalError(new Error('AI_STATUS_SESSION'))
      }
      setEntries((prev) => [...prev, { role: 'model', text: '⚠️ ' + (e instanceof Error ? e.message : 'Помилка запиту') }])
    } finally {
      sendBusy.current = false
      if (isCurrentContext()) { setSendingProgress(''); setSending(false) }
      await removeProcessingUploads(uploadedPaths).catch(() => {})
    }
  }

  const draftBusy = useRef(false)
  async function openInvoice(action: AiPendingAction, history = entries) {
    if (draftBusy.current || !isCurrentContext()) return
    draftBusy.current = true; setApplyingId(action.id)
    const guard = () => {
      if (!isCurrentContext()) throw new Error('Обліковий запис змінився. Відкрийте помічник повторно.')
      assertAiWriteAllowed(action.tool, useAuthStore.getState().session?.user.app_metadata?.role, isDesktopRuntime())
    }
    try {
      guard()
      saveAiChat(storageKey, localStorage, { entries: history.slice(-80), applied, applyMsg, applyStatus, applyErrors })
      const path = await openAiInvoiceDraft(action, storageKey, guard)
      guard()
      navigate(path)
    } catch (error) {
      if (isCurrentContext()) toast.error(error instanceof Error ? error.message : 'Не вдалося відкрити накладну')
      reportAiFailure('write', error)
    } finally { draftBusy.current = false; if (isCurrentContext()) setApplyingId(null) }
  }
  const applyBusy = useRef(false)
  async function applyAction(action: AiPendingAction, payloadOverride?: Record<string, any>) {
    if (!isCurrentContext() || applyBusy.current || sendBusy.current || applied[action.id] || completedActions.current.has(action.id)) return false
    applyBusy.current = true
    setApplyingId(action.id)
    let reviewedEntries = entries
    const markSaved = (message: string, status: 'ok' | 'warn'): boolean => {
      // The database has committed. A UI storage error must never turn this into
      // "not saved" or permit a second write in the current window.
      completedActions.current.add(action.id)
      const nextApplied = { ...applied, [action.id]: 'ok' as const }
      const nextMsg = { ...applyMsg, [action.id]: message }
      const nextStatus = { ...applyStatus, [action.id]: status }
      let checkpointSaved = true
      try {
        saveAiChat(storageKey, localStorage, { entries: reviewedEntries.slice(-80), applied: nextApplied, applyMsg: nextMsg, applyStatus: nextStatus, applyErrors })
      } catch {
        checkpointSaved = false
        const warning = 'Документ вже збережено в базі, але не вдалося зберегти стан вікна. Перевірте його у відповідному розділі; не створюйте повторно.'
        nextMsg[action.id] += ' ' + warning
        nextStatus[action.id] = 'warn'
        storageWarned.current = true
        reportLocalError(new Error('AI_COMMITTED_CHECKPOINT_UNAVAILABLE'))
        toast.warning(warning)
      }
      setApplied(nextApplied); setApplyMsg(nextMsg); setApplyStatus(nextStatus)
      return checkpointSaved
    }
    try {
      assertAiWriteAllowed(action.tool, useAuthStore.getState().session?.user.app_metadata?.role, isDesktopRuntime())
      if (action.tool === 'create_supply_invoice_bulk' || action.tool === 'create_order') {
        try {
          const reviewedAction = { ...action, payload: payloadOverride ?? action.payload }
          reviewedEntries = entries.map(entry => ({ ...entry, actions: entry.actions?.map(item => item.id === action.id ? reviewedAction : item) }))
          saveAiChat(storageKey, localStorage, { entries: reviewedEntries.slice(-80), applied, applyMsg, applyStatus, applyErrors })
          setEntries(reviewedEntries)
        } catch {
          throw new Error('Не вдалося зберегти перевірені дані для відновлення. Звільніть місце на диску та повторіть. Запис ще не розпочато.')
        }
      }
      if (action.tool === 'create_supply_invoice_bulk') { await openInvoice(action); return true }
      const operationId = action.tool === 'create_order' ? await aiActionOperationId(storageKey, action.id) : undefined
      if (!isCurrentContext()) return false
      const { data } = await aiApi.applyAction({ tool: action.tool, payload: payloadOverride ?? action.payload, operation_id: operationId })
      if (!isCurrentContext()) return false
      const r = data.result
      if (['create_products_bulk', 'update_products_bulk', 'merge_products_bulk'].includes(action.tool)) {
        requestDesktopSync()
      }

      if (action.tool === 'create_order') {
        const num = r?.order_number != null ? `#${r.order_number}` : ''
        const where = r?.status === 'completed' ? 'в архіві (Виконані)' : 'у розділі «Замовлення»'
        const msg = `Замовлення ${num} створено — ${where}` + (r?.customer_created ? ', клієнта заведено' : '')
        if (markSaved(msg, 'ok')) toast.success(msg)
        return true
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
      return true
    } catch (e) {
      reportAiFailure('write', e)
      if (isCurrentContext()) toast.error(e instanceof Error ? e.message : 'Не вдалося застосувати')
      return false
    } finally {
      applyBusy.current = false
      if (isCurrentContext()) setApplyingId(null)
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
    if (sendBusy.current || applyBusy.current || attachmentBusy.current) return
    if (!dragOver) setDragOver(true)
  }
  function onDragLeave(e: React.DragEvent) {
    // ігноруємо переходи між дочірніми елементами — гасимо лише при виході з контейнера
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    void handleFiles(Array.from(e.dataTransfer.files ?? []))
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (sendBusy.current || applyBusy.current || attachmentBusy.current) return
    const text = e.clipboardData.getData('text/plain')
    // Excel places both an image and tabular text in the clipboard. Preserve the exact numbers.
    if (text.trim() && (text.includes('\t') || text.trim().includes('\n') || localInvoiceMode)) {
      e.preventDefault(); await attachClipboardText(text); return
    }
    const files = Array.from(e.clipboardData.files)
    if (!files.length) return
    e.preventDefault()
    setRecognizingVin(!localInvoiceMode)
    try { await handleFiles(files) }
    finally { setRecognizingVin(false) }
  }

  const notConfigured = !loadingStatus && status && (!status.has_key || !status.enabled)
  const unavailable = loadingStatus || !!statusError || !status || !!notConfigured
  const busy = sending || !!applyingId || processingAttachments
  const directTable = !!attachment?.products?.length

  return (
    <Layout title={invoiceOnly ? "Розбір товарів (AI)" : "ШІ-помічник"}>
      {!invoiceOnly && canConfigure && isDesktopRuntime() && <button className="mb-3 text-sm text-gray-600 underline" onClick={() => navigate('/ai-agent')}>Порядок у товарах →</button>}
      <div
        className="max-w-3xl mx-auto flex flex-col relative"
        style={{ height: 'calc(100vh - 140px)' }}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {invoiceOnly && (
          <Card className="mb-3 border-purple-200 bg-purple-50/70">
            <div className="flex items-start gap-3">
              <Sparkles size={18} className="text-purple-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-purple-900">Розбір накладної постачальника</p>
                <p className="text-xs text-purple-700 mt-0.5">Фото, Excel-файл або таблиця з буфера → перевірка → звичайна чернетка приходу. Залишки зміняться тільки після проведення.</p>
              </div>
            </div>
          </Card>
        )}

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
              <p className="text-sm font-bold text-gray-800">Помічник (Gemini)</p>
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
                disabled={sending || !!applyingId || processingAttachments}
                title="Очистити переписку"
                className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </div>

        {statusError && <p role="alert" className="mb-3 text-sm text-red-700">{statusError} <button type="button" onClick={loadStatus} disabled={loadingStatus} className="underline">Повторити</button></p>}
        {statusProblem?.kind === 'session' && isDesktopRuntime() && <AiServerConnection onConnected={() => { void loadStatus() }} />}
        {processingAttachments && <p role="status" className="mb-2 text-xs text-gray-500">Готую вкладення…</p>}
        {unavailable && <p className="mb-2 text-xs text-gray-600">Excel і таблиці з колонками «Назва», «Кількість», «Ціна» можна розібрати локально, без AI та інтернету.</p>}
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
              <p className="text-sm font-medium text-gray-500">Напишіть завдання помічнику</p>
              <p className="text-xs max-w-sm">
                Додайте фото накладної, Excel або вставте таблицю — підготуємо прихід для перевірки.
                Для замовлення з фото напишіть «Створи замовлення». VIN розпізнається окремо.
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
                  const isInvoice = action.tool === 'create_supply_invoice_bulk'
                  const supported = canApplyAiWrite(action.tool, role, isDesktopRuntime())
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
                      ) : isInvoice ? null : isBulk
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
                      ) : !supported ? (
                        <p className="text-xs text-amber-700">{action.tool === 'create_products_bulk'
                          ? 'Це пропозиція каталогу, не прихідна накладна. Її не збережено. Додайте фото повторно — тепер воно автоматично відкриє перевірку приходу; старі продажні ціни не переноситимуться в закупку.'
                          : 'Ця дія недоступна для запису. Для внесення змін відкрийте відповідний розділ локальної програми.'}</p>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-600 bg-amber-50 rounded-md px-2 py-1">
                            <AlertTriangle size={12} /> Ще не збережено — потрібне ваше підтвердження
                          </div>
                          <div className="flex gap-2">
                            {isOrder ? (
                              <Button disabled={!!applyingId || sending} type="button" onClick={() => setOrderModalAction(action)} className="text-xs">
                                <Eye size={14} className="mr-1" /> Перевірити та створити замовлення
                              </Button>
                            ) : isBulk || isInvoice ? (
                              <Button disabled={!!applyingId || sending} type="button" onClick={() => isInvoice ? void openInvoice(action) : setModalAction(action)} className="text-xs">
                                <Eye size={14} className="mr-1" /> {isInvoice ? 'Відкрити накладну' : 'Переглянути та підтвердити'}{action.count ? ` (${action.count})` : ''}
                              </Button>
                            ) : (
                              <Button type="button" onClick={() => applyAction(action)} loading={applyingId === action.id} className="text-xs">
                                <Check size={14} className="mr-1" /> Застосувати
                              </Button>
                            )}
                            <Button disabled={!!applyingId || sending} type="button" variant="secondary" onClick={() => setApplied((p) => ({ ...p, [action.id]: 'rejected' }))} className="text-xs">
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
              <div className="flex items-center gap-2 bg-white border border-gray-100 rounded-2xl rounded-bl-sm px-4 py-2.5">
                <Loader2 size={16} className="text-gray-400 animate-spin" />
                {sendingProgress && <span className="text-xs text-gray-500">{sendingProgress}</span>}
              </div>
            </div>
          )}
        </div>

        {/* Поле вводу */}
        <div className="mt-3 border border-gray-200 rounded-2xl bg-white p-2 shadow-sm">
          {attachment?.sourceCurrency && <label className="mb-2 flex flex-wrap items-center gap-2 px-2 text-sm text-amber-900">
            Ціни у {attachment.sourceCurrency}. Курс грн за 1 {attachment.sourceCurrency}:
            <input aria-label={`Курс ${attachment.sourceCurrency}`} inputMode="decimal" value={exchangeRate} onChange={event => setExchangeRate(event.target.value)} disabled={busy} placeholder="Введіть курс" className="w-32 rounded-lg border border-amber-300 px-2 py-1" />
          </label>}
          {attachment?.reviewReason && <p className="mb-2 px-2 text-xs text-amber-800">{attachment.reviewReason}</p>}
          {attachment && (
            <div className="flex items-center gap-2 mb-2 px-2 py-1.5 bg-gray-50 rounded-lg text-xs">
              <Paperclip size={13} className="text-gray-400" />
              <span className="flex-1 truncate text-gray-600">
                {attachment.name}
                {attachment.products?.length
                  ? ` · ${attachment.products.length} товарів · ${attachment.categoryCount ?? 0} папок`
                  : attachment.parts.length > 1 && ` · ${attachment.rowCount} рядків · ${attachment.parts.length} частин`}
              </span>
              <button
                type="button"
                onClick={() => setAttachment(null)}
                disabled={busy}
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
                    disabled={busy}
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
          <div className="flex flex-wrap items-center gap-2 mb-2">
            {imageAttachments.length > 0 && <p className="w-full px-1 text-xs text-gray-600">
              {localInvoiceMode || !isOrderPhotoRequest(input)
                ? 'Фото → прихідна накладна. Перед збереженням перевіримо товари з вашою базою.'
                : 'Фото → замовлення клієнта. Перед створенням перевірте розпізнані дані.'}
            </p>}
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.txt,.jpg,.jpeg,.png,.webp,image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void handleFiles(Array.from(e.target.files ?? []))
                if (fileRef.current) fileRef.current.value = ''
              }}
            />
            {isDesktopRuntime() && !invoiceOnly && (
              <button
                type="button"
                disabled={busy || !!attachment}
                onClick={() => setLocalInvoiceMode((value) => !value)}
                className={`px-2 py-1.5 rounded-lg text-[11px] font-medium border transition-colors shrink-0 ${localInvoiceMode ? 'border-purple-300 bg-purple-50 text-purple-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                aria-pressed={localInvoiceMode}
                title="Розбір товарів у чернетку приходу: фото, Excel або буфер"
              >
                {localInvoiceMode ? 'Розбір товарів увімкнено' : 'Розбір товарів'}
              </button>
            )}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-gray-700 border border-gray-200 hover:bg-gray-100 disabled:opacity-40"
              title="Прикріпити фото замовлення / Excel / CSV / текст"
              aria-label="Excel / файл"
            >
              <Paperclip size={16} /> Excel / файл
            </button>
            <button type="button" onClick={pasteFromClipboard} disabled={busy} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-gray-700 border border-gray-200 hover:bg-gray-100 disabled:opacity-40" title="Вставити товари або фото з буфера (також Ctrl+V)">
              <ClipboardPaste size={16} /> Вставити
            </button>
          </div>
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              disabled={busy}
              rows={1}
              placeholder={recognizingVin ? 'Розпізнаємо VIN…' : 'Напишіть завдання або вставте таблицю / фото (Ctrl+V)…'}
              className="flex-1 resize-none max-h-40 py-2 px-1 text-sm focus:outline-none disabled:bg-transparent"
            />
            <Button
              type="button"
              onClick={send}
              disabled={busy || (unavailable && !directTable) || (!input.trim() && !attachment && imageAttachments.length === 0)}
              className="shrink-0"
              aria-label={directTable ? 'Перевірити таблицю' : 'Надіслати повідомлення'}
              title={directTable ? 'Перевірити таблицю' : 'Надіслати повідомлення'}
            >
              {directTable ? <><Eye size={16} className="mr-1" /> Перевірити таблицю</> : <Send size={16} />}
            </Button>
          </div>
        </div>
      </div>

      {/* Вікно попереднього перегляду масової дії з підтвердженням унизу */}
      <Modal
        open={!!modalAction}
        onClose={() => { if (!applyBusy.current) setModalAction(null) }}
        title={modalAction?.tool === 'create_supply_invoice_bulk' ? 'Прихід товарів — перевірка накладної' : modalAction?.title ?? 'Попередній перегляд'}
        size="xl"
      >
        {modalAction && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              Підготовлено <b>{modalAction.count}</b> {(modalAction.count ?? 0) === 1 ? 'запис' : 'записів'}.
              {modalAction.tool === 'create_supply_invoice_bulk' ? 'Після підтвердження відкриється звичайна накладна: штрихкоди, папки та оплата. Залишки зміняться лише після її проведення.' : 'Перевірте список — нічого не збережеться, доки ви не натиснете «Підтвердити».'}
            </p>

            {modalAction.items
              ? <BulkPreviewTable action={modalAction} />
              : <ChangesTable changes={modalAction.changes} />}

            <div className="flex gap-2 pt-3 border-t border-gray-100">
              <Button
                type="button"
                className="flex-1"
                loading={applyingId === modalAction.id}
                disabled={!canApplyAiWrite(modalAction.tool, role, isDesktopRuntime()) || sending || (!!applyingId && applyingId !== modalAction.id)}
                onClick={async () => {
                  if (await applyAction(modalAction)) setModalAction(null)
                }}
              >
                <Check size={16} className="mr-1" /> Підтвердити та зберегти{modalAction.count ? ` (${modalAction.count})` : ''}
              </Button>
              <Button type="button" variant="secondary" disabled={!!applyingId} onClick={() => setModalAction(null)}>
                Скасувати
              </Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={!!recognizedVin} onClose={() => setRecognizedVin('')} title="VIN розпізнано" size="sm">
        <div className="space-y-4">
          <div className="rounded-xl bg-gray-50 p-4 text-center">
            <p className="text-xs text-gray-500">VIN-код</p>
            <p className="mt-1 select-all font-mono text-lg font-bold tracking-wide text-gray-900">{recognizedVin}</p>
          </div>
          <p className="text-sm text-gray-600">Що відкрити з уже заповненим VIN?</p>
          <div className="grid grid-cols-2 gap-3">
            <Button onClick={() => navigate(`/orders/new?vin=${encodeURIComponent(recognizedVin)}`)}>
              Нове замовлення
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/quotes/new?vin=${encodeURIComponent(recognizedVin)}`)}>
              Швидка чернетка
            </Button>
          </div>
        </div>
      </Modal>

      {/* Редаговане підтвердження замовлення з фото (сумнівні поля підсвічено) */}
      {orderModalAction && (
        <OrderConfirmModal
          action={orderModalAction}
          applying={applyingId === orderModalAction.id}
          onClose={() => { if (!applyBusy.current) setOrderModalAction(null) }}
          onConfirm={async (editedPayload) => {
            if (await applyAction(orderModalAction, editedPayload)) setOrderModalAction(null)
          }}
        />
      )}
    </Layout>
  )
}
