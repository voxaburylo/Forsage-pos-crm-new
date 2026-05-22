import { useState, useRef, useCallback, useEffect } from 'react'
import { Upload, X, Star, ImagePlus, Clipboard, Camera } from 'lucide-react'
import { toast } from '@/components/ui/Toast'

interface Props {
  productId?: string          // undefined = новий товар (фото збережуться після create)
  currentPhotoUrl?: string | null
  onPhotoUrl: (url: string | null) => void  // повідомляє батьківський компонент про головне фото
}

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL as string
const BUCKET        = 'product-photos'
const MAX_PX        = 1200   // максимальна сторона після стиснення
const JPEG_QUALITY  = 0.82   // 82% — хороший баланс якість/розмір

// ─── Стиснення через Canvas API (без залежностей) ────────────────────────────
async function compressToJpeg(source: File | Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(source)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, MAX_PX / Math.max(img.width, img.height))
      const w = Math.round(img.width  * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('canvas ctx')); return }
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/jpeg', JPEG_QUALITY,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load')) }
    img.src = url
  })
}

// ─── Завантаження у Supabase Storage ─────────────────────────────────────────
async function uploadToStorage(blob: Blob, folder: string): Promise<string> {
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

async function deleteFromStorage(url: string): Promise<void> {
  try {
    const { supabase } = await import('@/lib/supabase')
    const prefix = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`
    if (!url.startsWith(prefix)) return
    const path = url.slice(prefix.length)
    await supabase.storage.from(BUCKET).remove([path])
  } catch { /* best-effort */ }
}

// ─── Компонент ────────────────────────────────────────────────────────────────
export function ProductPhotoUpload({ productId, currentPhotoUrl, onPhotoUrl }: Props) {
  const [photos, setPhotos]     = useState<string[]>(currentPhotoUrl ? [currentPhotoUrl] : [])
  const [mainIdx, setMainIdx]   = useState(0)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const inputRef     = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [tmpFolder] = useState(() => `tmp_${Date.now()}`)
  const folder = productId ?? tmpFolder

  // Синхронізуємо головне фото з батьківським компонентом
  useEffect(() => {
    onPhotoUrl(photos[mainIdx] ?? null)
  }, [photos, mainIdx, onPhotoUrl])

  // ── Обробка файлу ──────────────────────────────────────────────────────────
  const processFile = useCallback(async (file: File | Blob, name = '') => {
    if (!file.type.startsWith('image/') && !(file instanceof Blob)) {
      toast.error('Тільки зображення (JPG, PNG, WebP, BMP, HEIC...)')
      return
    }
    setUploading(true)
    try {
      const sizeBefore = (file.size / 1024).toFixed(0)
      const blob       = await compressToJpeg(file)
      const sizeAfter  = (blob.size  / 1024).toFixed(0)
      const url        = await uploadToStorage(blob, folder)

      setPhotos((prev) => {
        const next = [...prev, url]
        if (prev.length === 0) setMainIdx(0)
        return next
      })
      toast.success(`Фото завантажено (${sizeBefore} KB → ${sizeAfter} KB)`)
      if (name) console.info(`[photo] ${name}: ${sizeBefore} KB → ${sizeAfter} KB`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally {
      setUploading(false)
    }
  }, [folder])

  // ── Вставка з буфера обміну ────────────────────────────────────────────────
  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const items = Array.from(e.clipboardData?.items ?? [])
      const imgItem = items.find((i) => i.type.startsWith('image/'))
      if (!imgItem) return
      e.preventDefault()
      const blob = imgItem.getAsFile()
      if (blob) await processFile(blob, 'clipboard')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [processFile])

  // ── Вибір файлів ───────────────────────────────────────────────────────────
  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    files.forEach((f) => processFile(f, f.name))
    e.target.value = ''
  }

  // ── Drag & Drop ────────────────────────────────────────────────────────────
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    files.forEach((f) => processFile(f, f.name))
  }

  // ── Видалення фото ─────────────────────────────────────────────────────────
  async function removePhoto(idx: number) {
    const url = photos[idx]
    await deleteFromStorage(url)
    setPhotos((prev) => {
      const next = prev.filter((_, i) => i !== idx)
      setMainIdx((m) => Math.min(m, Math.max(0, next.length - 1)))
      return next
    })
  }

  return (
    <div className="space-y-3">

      {/* Зона завантаження */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all ${
          dragOver
            ? 'border-yellow-400 bg-yellow-50 scale-[1.01]'
            : 'border-gray-200 hover:border-yellow-300 hover:bg-yellow-50/40'
        } ${uploading ? 'pointer-events-none opacity-60' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={onFileInput}
        />
        <div className="flex flex-col items-center gap-2">
          {uploading ? (
            <>
              <div className="w-8 h-8 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500">Стискаємо і завантажуємо...</p>
            </>
          ) : (
            <>
              <div className="flex gap-3 justify-center">
                <Upload size={22} className="text-gray-400" />
                <Clipboard size={22} className="text-gray-400" />
                <ImagePlus size={22} className="text-gray-400" />
              </div>
              <p className="text-sm font-medium text-gray-600">
                Натисни або перетягни файли сюди
              </p>
              <p className="text-xs text-gray-400">
                JPG, PNG, WebP · Авто-стиснення до {MAX_PX}px/{Math.round(JPEG_QUALITY * 100)}% JPEG
              </p>
            </>
          )}
        </div>
      </div>

      {/* Кнопка камери (на телефоні відкриває камеру) */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFileInput}
      />
      <button
        type="button"
        onClick={() => cameraInputRef.current?.click()}
        disabled={uploading}
        className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-blue-500 hover:bg-blue-400 text-white font-semibold transition-all disabled:opacity-50 active:scale-[0.98] touch-target"
      >
        <Camera size={20} />
        Зробити фото
      </button>

      {/* Галерея */}
      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((url, idx) => (
            <div key={url} className="relative group rounded-xl overflow-hidden border-2 border-transparent"
              style={{ borderColor: idx === mainIdx ? '#facc15' : undefined }}>

              <img src={url} alt={`Фото ${idx + 1}`}
                className="w-full aspect-square object-cover cursor-pointer"
                onClick={() => setMainIdx(idx)}
              />

              {/* Головне фото */}
              {idx === mainIdx && (
                <div className="absolute top-1 left-1 bg-yellow-400 text-black text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-0.5">
                  <Star size={9} fill="black" /> Головне
                </div>
              )}
              {idx !== mainIdx && (
                <button
                  onClick={() => setMainIdx(idx)}
                  className="absolute top-1 left-1 hidden group-hover:flex bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded items-center gap-0.5 hover:bg-yellow-500 hover:text-black transition-colors"
                >
                  <Star size={9} /> Головне
                </button>
              )}

              {/* Видалити */}
              <button
                onClick={() => removePhoto(idx)}
                className="absolute top-1 right-1 hidden group-hover:flex bg-black/60 text-white rounded-full w-6 h-6 items-center justify-center hover:bg-red-500 transition-colors"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {photos.length > 1 && (
        <p className="text-xs text-gray-400">
          Натисни на фото щоб зробити його головним. Головне фото відображається у списку товарів.
        </p>
      )}
    </div>
  )
}
