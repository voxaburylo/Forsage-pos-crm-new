/**
 * Клітинка з фото товару в рядку накладної: показ, завантаження, заміна.
 *
 * Винесено з `InvoiceFormPage.tsx` — це самостійний шматок інтерфейсу зі
 * своїм станом, який більше нічого у формі не стосується.
 */
import { toast } from '@/components/ui/Toast'
import { compressToJpeg, uploadToStorage } from '@/features/products/ProductPhotoUpload'
import { Camera, Clipboard, ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
export interface RowPhotoCellProps {
  photoUrl: string | null
  productId: string
  onPhotoUpdated: (url: string | null) => void
}

export function RowPhotoCell({ photoUrl, productId, onPhotoUpdated }: RowPhotoCellProps) {
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    await uploadPhoto(file)
  }

  // Фото в накладній — ТИМЧАСОВЕ: висить у позиції, а в товар записується лише при
  // збереженні/проведенні накладної. Закрив без проведення → нічого не змінилось/створилось.
  const uploadPhoto = async (file: File | Blob) => {
    setUploading(true)
    try {
      const blob = await compressToJpeg(file)
      const url = await uploadToStorage(blob, productId)
      onPhotoUpdated(url)   // лише в позицію; у товар — при проведенні накладної
      toast.success('Фото додано')
    } catch {
      toast.error('Не вдалося завантажити фото')
    } finally {
      setUploading(false)
    }
  }

  const handlePaste = async () => {
    try {
      const items = await Promise.race([
        navigator.clipboard.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('CLIPBOARD_TIMEOUT')), 3000)),
      ])
      for (const item of items) {
        const imageType = item.types.find(type => type.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          await uploadPhoto(blob)
          return
        }
      }
      toast.error('У буфері обміну немає зображення')
    } catch {
      toast.error('Будь ласка, натисніть Ctrl+V при фокусі на кнопці або надайте доступ')
    }
  }

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault()
      await handlePaste()
    }
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Видалити фото?')) return
    setUploading(true)
    try {
      onPhotoUpdated(null)   // прибираємо лише з позиції; товар не чіпаємо до проведення
      toast.success('Фото видалено')
    } catch {
      toast.error('Помилка видалення')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="relative w-10 h-10 group bg-gray-50 rounded-lg overflow-hidden flex items-center justify-center border border-gray-200 shrink-0">
      {uploading ? (
        <Loader2 size={16} className="animate-spin text-gray-400" />
      ) : photoUrl ? (
        <>
          <img src={photoUrl} alt="Product" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-1 text-white hover:text-yellow-400"
              title="Змінити фото"
            >
              <Camera size={12} />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="p-1 text-red-400 hover:text-red-500"
              title="Видалити"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center w-full h-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={handleKeyDown}
            className="w-full h-full flex flex-col items-center justify-center"
            title="Завантажити або вставити (Ctrl+V)"
          >
            <ImagePlus size={16} />
            <span className="text-[7px] mt-0.5 font-bold uppercase tracking-wider">Додати</span>
          </button>
          <button
            type="button"
            onClick={handlePaste}
            className="absolute bottom-0.5 right-0.5 p-0.5 bg-white/80 rounded border border-gray-200 hover:bg-white text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Вставити з буфера"
          >
            <Clipboard size={8} />
          </button>
        </div>
      )}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        capture="environment"
        className="hidden"
      />
    </div>
  )
}

