import { useEffect, useState } from 'react'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { productApi } from '@/features/products/productApi'
import { initialPicks, photoAiApi, togglePick, type CheckedPhoto, type PhotoAiProduct } from './photoAiApi'

/**
 * Картка товару → «Знайти фото (ШІ)»: до 8 варіантів з інтернету з відміткою ШІ (✅ підходить / ❌ причина).
 * Людина відмічає потрібні (перше відмічене — головне) і тисне «Зберегти»: сервер стискає фото й кладе у сховище
 * програми, головне одразу стає фото картки, решта — галерея для сайту.
 */
export function PhotoAiCardModal({ open, product, hasPhoto, onClose, onSaved }: {
  open: boolean
  product: PhotoAiProduct
  hasPhoto: boolean
  onClose: () => void
  /** Адреса головного фото, яке вже стоїть у картці. */
  onSaved: (url: string) => void
}) {
  const [photos, setPhotos] = useState<CheckedPhoto[] | null>(null)
  const [max, setMax] = useState(3)
  const [calls, setCalls] = useState<{ serper: number; gemini: number } | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setPhotos(null); setError(''); setPicked([]); setCalls(null)
    photoAiApi.search(product)
      .then(data => {
        if (!alive) return
        setPhotos(data.photos); setMax(data.per_product); setCalls(data.calls)
        setPicked(initialPicks(data.photos, data.per_product))
      })
      .catch(reason => { if (alive) setError(reason instanceof Error && reason.message ? reason.message : 'Пошук фото не вдався. Перевірте інтернет і повторіть.') })
    return () => { alive = false }
    // Пошук платний: запускається один раз на відкриття вікна.
  }, [open, product.id])

  async function save() {
    if (!picked.length || saving) return
    setSaving(true)
    try {
      const saved = await photoAiApi.save(product, picked)
      try {
        await productApi.update(product.id, { photo_url: saved.main_url } as never, { silent: true })
        await photoAiApi.applied([product.id], []).catch(() => undefined)
        toast.success(saved.saved < saved.asked ? `Збережено ${saved.saved} з ${saved.asked}: решту сайт-джерело не віддав.` : `Фото збережено: ${saved.saved}`)
        onSaved(saved.main_url)
      } catch {
        // Фото вже у сховищі; у картку без фото його поставить головний ПК, щойно буде на звʼязку.
        toast.error('Фото збережено у сховищі, але картку змінити не вдалося (головний ПК не відповів). Він поставить фото сам, коли буде на звʼязку.')
        onClose()
      }
    } catch (reason) {
      toast.error(reason instanceof Error && reason.message ? reason.message : 'Не вдалося зберегти фото')
    } finally { setSaving(false) }
  }

  const good = photos?.filter(photo => photo.ok).length ?? 0
  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} title="Знайти фото (ШІ)" size="xl">
      <div className="space-y-3" data-photo-ai-card>
        <p className="text-sm font-medium break-words">{product.name}</p>
        {!photos && !error && <p className="text-sm text-gray-600" role="status">Шукаю фото в інтернеті й перевіряю кожне ШІ… до хвилини.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {photos && (
          <>
            <p className="text-xs text-gray-500">
              {photos.length ? `Знайдено варіантів: ${photos.length}, на думку ШІ підходить: ${good}.` : 'Підхожих картинок пошук не дав.'}
              {' '}Відмітьте потрібні — до {max}; перше відмічене стане головним фото.
              {hasPhoto && ' У картці вже є фото — його буде замінено головним із вибраних.'}
              {calls && ` Витрачено запитів: пошук ${calls.serper}, ШІ ${calls.gemini}.`}
            </p>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 max-h-[60vh] overflow-y-auto">
              {photos.map(photo => {
                const order = picked.indexOf(photo.image_url)
                return (
                  <li key={photo.image_url}>
                    <button type="button" disabled={saving} aria-pressed={order >= 0}
                      onClick={() => setPicked(current => togglePick(current, photo.image_url, max))}
                      className={`relative block w-full rounded-lg border-2 bg-white p-1 text-left ${order >= 0 ? 'border-blue-600' : 'border-gray-200'}`}>
                      <img src={photo.thumb_url || photo.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-32 w-full object-contain" />
                      {order >= 0 && <span className="absolute left-1 top-1 rounded bg-blue-600 px-1.5 py-0.5 text-xs font-semibold text-white">{order === 0 ? 'Головне' : order + 1}</span>}
                      <span className={`mt-1 block text-xs ${photo.ok ? 'text-green-700' : 'text-red-700'}`}>{photo.ok ? '✅ підходить' : '❌ ' + photo.reason}</span>
                      <span className="block truncate text-[11px] text-gray-500">{photo.domain} · {photo.width}×{photo.height}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
        <div className="flex gap-2 justify-end pt-2 border-t border-gray-100">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Закрити</Button>
          <Button type="button" onClick={() => void save()} loading={saving} disabled={!picked.length}>Зберегти ({picked.length})</Button>
        </div>
      </div>
    </Modal>
  )
}
