import { lazy, Suspense, useState } from 'react'
import { Button } from '@/components/ui'
import type { PhotoAiProduct } from './photoAiApi'

const PhotoAiCardModal = lazy(() => import('./PhotoAiCardModal').then(module => ({ default: module.PhotoAiCardModal })))

/** Кнопка «Знайти фото (ШІ)» під фото в картці товару. Вікно пошуку завантажується лише після натискання. */
export function PhotoAiCardButton({ product, hasPhoto, disabled, onSaved }: {
  product: PhotoAiProduct; hasPhoto: boolean; disabled?: boolean; onSaved: (url: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2">
      <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => setOpen(true)} data-photo-ai-button>🖼️ Знайти фото (ШІ)</Button>
      {open && (
        <Suspense fallback={null}>
          <PhotoAiCardModal open product={product} hasPhoto={hasPhoto} onClose={() => setOpen(false)} onSaved={(url) => { setOpen(false); onSaved(url) }} />
        </Suspense>
      )}
    </div>
  )
}

const PhotoAiBulkModal = lazy(() => import('./PhotoAiBulkModal').then(module => ({ default: module.PhotoAiBulkModal })))

/** Кнопка «Фото ШІ» на сторінці товарів: масовий пошук для товарів без фото. */
export function PhotoAiBulkButton({ onChanged }: { onChanged?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)} title="Знайти фото в інтернеті для товарів без фото" data-photo-ai-bulk-button>🖼️ Фото ШІ</Button>
      {open && (
        <Suspense fallback={null}>
          <PhotoAiBulkModal open onClose={() => setOpen(false)} onChanged={onChanged} />
        </Suspense>
      )}
    </>
  )
}
