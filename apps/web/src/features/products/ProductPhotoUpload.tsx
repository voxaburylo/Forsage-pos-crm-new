import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { Upload, X, ImagePlus, Clipboard, Camera } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { desktopBridge } from '@/lib/desktopBridge'
import { useScopedAction } from '@/hooks/useScopedAction'

interface Props {
  productId?: string
  currentPhotoUrl?: string | null
  onPhotoUrl: (url: string | null) => void | Promise<void>
  onBusyChange?: (pending: boolean) => void
  disabled?: boolean
  successMessage?: string
}

const BUCKET = 'product-photos'
const MAX_PX = 1200
const JPEG_QUALITY = 0.82

export async function compressToJpeg(source: File | Blob, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  if (source.type && !source.type.startsWith('image/')) throw new Error('Оберіть зображення: JPG, PNG або WebP')
  if (!source.size || source.size > 20 * 1024 * 1024) throw new Error('Фото має бути не порожнім і не більше 20 МБ')
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(source)
    let settled = false
    const finish = (blob?: Blob, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      URL.revokeObjectURL(url)
      img.onload = null
      img.onerror = null
      if (blob?.size) resolve(blob)
      else reject(error ?? new Error('Не вдалося підготувати фото. Спробуйте JPG або PNG.'))
    }
    const onAbort = () => finish(undefined, new DOMException('Обробку фото скасовано', 'AbortError'))
    const timer = setTimeout(() => finish(undefined, new Error('Обробка фото триває надто довго. Спробуйте менший файл.')), 15_000)
    signal?.addEventListener('abort', onAbort, { once: true })
    img.onload = () => {
      try {
        if (!img.width || !img.height) { finish(); return }
        const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.width * scale))
        canvas.height = Math.max(1, Math.round(img.height * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) { finish(); return }
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => finish(blob ?? undefined), 'image/jpeg', JPEG_QUALITY)
      } catch { finish() }
    }
    img.onerror = () => finish()
    try { img.src = url } catch { finish() }
  })
}

/** Bound both clipboard permission/read AND getType(), not just the first promise. */
export function readClipboardImage(signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (blob?: Blob, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (blob) resolve(blob)
      else reject(error ?? new Error('У буфері немає зображення'))
    }
    const onAbort = () => finish(undefined, new DOMException('Читання буфера скасовано', 'AbortError'))
    const timer = setTimeout(() => finish(undefined,
      new Error('Немає відповіді від буфера. Спробуйте Ctrl+V або виберіть файл.')), 3000)
    signal?.addEventListener('abort', onAbort, { once: true })
    void (async () => {
      const items = await navigator.clipboard.read()
      if (settled) return
      for (const item of items) {
        const type = item.types.find((entry) => entry.startsWith('image/'))
        if (type) { finish(await item.getType(type)); return }
      }
      finish()
    })().catch((error: unknown) => finish(undefined, error))
  })
}

// ─── Завантаження у Supabase Storage ─────────────────────────────────────────
export async function uploadToStorage(blob: Blob, folder: string): Promise<string> {
  const localSave = desktopBridge()?.catalog.savePhoto
  if (localSave) return localSave(folder, await blob.arrayBuffer())

  const { supabase } = await import('@/lib/supabase')
  const ext  = 'jpg'
  const path = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`

  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  })
  if (error) throw new Error(error.message)

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}


// A product currently stores one photo_url. Do not offer a multi-photo gallery
// whose extra images disappear when the card is opened again.
export function ProductPhotoUpload({
  productId, currentPhotoUrl, onPhotoUrl, onBusyChange, disabled = false,
  successMessage = 'Фото збережено',
}: Props) {
  const [dragOver, setDragOver] = useState(false)
  const [tmpFolder] = useState(() => `tmp_${crypto.randomUUID()}`)
  const folder = productId ?? tmpFolder
  const { busy: uploading, begin, isBusy } = useScopedAction(folder)
  const inputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const callbacks = useRef({ onPhotoUrl, onBusyChange })
  const cancelPreparation = useRef<(() => void) | null>(null)
  useLayoutEffect(() => { callbacks.current = { onPhotoUrl, onBusyChange } }, [onPhotoUrl, onBusyChange])
  useLayoutEffect(() => {
    setDragOver(false)
    return () => {
      cancelPreparation.current?.()
      cancelPreparation.current = null
    }
  }, [folder])

  const changePhoto = useCallback(async (prepare: (signal: AbortSignal) => Promise<string | null>) => {
    if (disabled) return
    const attempt = begin()
    if (!attempt) return
    const commit = callbacks.current.onPhotoUrl
    const notify = callbacks.current.onBusyChange
    const controller = new AbortController()
    const cancel = () => { controller.abort(); notify?.(false) }
    cancelPreparation.current = cancel
    try {
      notify?.(true)
      const url = await prepare(controller.signal)
      if (!attempt.isCurrent()) return
      await commit(url)
      if (attempt.isCurrent()) toast.success(url ? successMessage : 'Фото прибрано з картки')
    } catch (error) {
      if (attempt.isCurrent()) toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти фото')
    } finally {
      try {
        if (attempt.isCurrent()) notify?.(false)
      } finally {
        if (cancelPreparation.current === cancel) cancelPreparation.current = null
        attempt.finish()
      }
    }
  }, [disabled, begin, successMessage])

  const processFile = useCallback((file: File | Blob) =>
    changePhoto(async (signal) => {
      const blob = await compressToJpeg(file, signal)
      signal.throwIfAborted()
      return uploadToStorage(blob, folder)
    }), [changePhoto, folder])

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (event.defaultPrevented || disabled || isBusy()) return
      const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith('image/'))
      if (!item) return
      event.preventDefault()
      const file = item.getAsFile()
      if (file) void processFile(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [processFile, disabled, isBusy])

  function onFileInput(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void processFile(file)
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer.files[0]
    if (file) void processFile(file)
  }

  function pasteFromClipboard() {
    if (!navigator.clipboard?.read) {
      toast.warning('Натисніть Ctrl+V щоб вставити зображення з буфера')
      return
    }
    void changePhoto(async (signal) => {
      const image = await readClipboardImage(signal)
      signal.throwIfAborted()
      const blob = await compressToJpeg(image, signal)
      signal.throwIfAborted()
      return uploadToStorage(blob, folder)
    })
  }

  const busy = uploading || disabled
  return (
    <div className="space-y-3" aria-busy={uploading}>
      <div
        onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded-xl p-5 text-center ${dragOver ? 'border-yellow-400 bg-yellow-50' : 'border-gray-200'}`}
      >
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onFileInput} disabled={busy} />
        <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}
          className="w-full flex flex-col items-center gap-2 disabled:opacity-60">
          {uploading ? (
            <>
              <div className="w-8 h-8 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-gray-500">Додаємо та зберігаємо фото...</span>
            </>
          ) : (
            <>
              <span className="flex gap-3"><Upload size={22} /><ImagePlus size={22} /></span>
              <span className="text-sm font-medium text-gray-600">{currentPhotoUrl ? 'Замінити фото' : 'Обрати або перетягнути фото'}</span>
              <span className="text-xs text-gray-400">JPG, PNG, WebP · до 20 МБ · автоматичне стиснення</span>
            </>
          )}
        </button>
      </div>
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment"
        className="hidden" onChange={onFileInput} disabled={busy} />
      <button type="button" onClick={() => cameraInputRef.current?.click()} disabled={busy}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-500 text-white font-semibold disabled:opacity-50">
        <Camera size={20} /> Зробити фото
      </button>
      <button type="button" onClick={pasteFromClipboard} disabled={busy}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gray-100 text-gray-700 border border-gray-200 disabled:opacity-50">
        <Clipboard size={18} /> Вставити з буфера
      </button>
      {currentPhotoUrl && (
        <div className="relative w-40">
          <img src={currentPhotoUrl} alt="Фото товару" className="w-full aspect-square object-cover rounded-xl border" />
          <button type="button" disabled={busy} onClick={() => void changePhoto(async () => null)}
            aria-label="Прибрати фото" title="Прибрати фото"
            className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-7 h-7 flex items-center justify-center hover:bg-red-500 disabled:opacity-50">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
