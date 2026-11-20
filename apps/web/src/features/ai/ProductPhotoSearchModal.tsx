import { useEffect, useState } from 'react'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { compressToJpeg, uploadToStorage } from '@/features/products/ProductPhotoUpload'
import { productApi } from '@/features/products/productApi'
import {
  base64ToBlob, findProductPhotos, initialPhotoSelection, pickPhotoSearchProducts,
  type PhotoSearchProduct, type PhotoSearchResult,
} from './productPhotoSearch'

/**
 * «Знайти фото (ШІ)» для вибраних товарів: ШІ шукає сторінку саме цього товару, сервер перевіряє
 * точний артикул на сторінці й бере головне фото. Нічого не зберігається без вибору власника.
 */
export function ProductPhotoSearchModal({ open, products, onClose, onSaved }: {
  open: boolean
  products: PhotoSearchProduct[]
  onClose: () => void
  onSaved: () => void
}) {
  const [results, setResults] = useState<PhotoSearchResult[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [cost, setCost] = useState<number | null>(null)
  const { search, skippedNoSku, skippedOverLimit } = pickPhotoSearchProducts(products)

  useEffect(() => {
    if (!open) return
    let alive = true
    setResults(null); setError(''); setSelected(new Set()); setCost(null)
    if (!search.length) { setError('У вибраних товарів немає артикулу — без нього фото з точним збігом не підібрати.'); return }
    findProductPhotos(search)
      .then(({ data }) => {
        if (!alive) return
        setResults(data.results)
        setSelected(initialPhotoSelection(data.results, search))
        setCost(data.usage.cost_usd_estimate)
      })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Пошук фото не вдався') })
    return () => { alive = false }
    // Пошук запускається один раз на відкриття вікна.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = (id: string) => setSelected(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  async function save() {
    if (!results || saving) return
    setSaving(true)
    let saved = 0
    const failed: string[] = []
    for (const result of results) {
      if (!selected.has(result.product_id) || !result.image_base64 || !result.mime_type) continue
      const product = search.find(item => item.id === result.product_id)
      try {
        const blob = await compressToJpeg(base64ToBlob(result.image_base64, result.mime_type))
        const url = await uploadToStorage(blob, result.product_id)
        await productApi.update(result.product_id, { photo_url: url })
        saved++
      } catch (reason) {
        failed.push(`${product?.name ?? result.product_id}: ${reason instanceof Error ? reason.message : 'помилка'}`)
      }
    }
    setSaving(false)
    if (saved) toast.success(`Фото збережено: ${saved}`)
    if (failed.length) toast.error('Не збережено: ' + failed.join('; '))
    if (saved) onSaved()
  }

  const found = results?.filter(result => result.status === 'found').length ?? 0
  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} title="Фото з інтернету (ШІ)" size="xl">
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          Фото пропонується лише тоді, коли на сторінці магазину чи виробника є точно такий самий артикул. Перевірте кожне фото перед збереженням.
          {skippedNoSku > 0 && ` Без артикулу пропущено: ${skippedNoSku}.`}
          {skippedOverLimit > 0 && ` За раз — до 8 товарів, решту (${skippedOverLimit}) виберіть наступним разом.`}
        </p>
        {!results && !error && <p className="text-sm text-gray-600">Шукаю фото для {search.length} товарів… це може зайняти 1–3 хвилини.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {results && (
          <>
            <p className="text-sm text-gray-700">Знайдено фото: {found} з {results.length}{cost !== null ? ` · ≈ $${cost.toFixed(3)}` : ''}</p>
            <ul className="divide-y divide-gray-100 max-h-[60vh] overflow-y-auto">
              {results.map(result => {
                const product = search.find(item => item.id === result.product_id)
                const image = result.image_base64 && result.mime_type ? `data:${result.mime_type};base64,${result.image_base64}` : null
                return (
                  <li key={result.product_id} className="flex gap-3 py-2 items-start">
                    {image ? (
                      <label className="flex gap-2 items-start cursor-pointer">
                        <input type="checkbox" className="mt-1" aria-label={`Зберегти фото для ${product?.name ?? ''}`}
                          checked={selected.has(result.product_id)} onChange={() => toggle(result.product_id)} disabled={saving} />
                        <img src={image} alt="" className="w-24 h-24 object-contain border border-gray-200 rounded bg-white" />
                      </label>
                    ) : <div className="w-24 h-24 shrink-0 rounded bg-gray-50 border border-dashed border-gray-200 ml-6" />}
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="font-medium break-words">{product?.name}</p>
                      <p className="text-xs text-gray-500">Артикул {product?.sku}{product?.photo_url ? ' · вже має фото — буде замінено, якщо відмітити' : ''}</p>
                      <p className={`text-xs ${result.status === 'found' ? 'text-green-700' : 'text-gray-500'}`}>{result.reason}</p>
                      {result.page_url && (
                        <a href={result.page_url} target="_blank" rel="noreferrer noopener" className="text-xs text-blue-600 underline break-all">{result.page_url}</a>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
        <div className="flex gap-2 justify-end pt-2 border-t border-gray-100">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Закрити</Button>
          <Button type="button" onClick={() => void save()} loading={saving} disabled={!results || selected.size === 0}>
            Зберегти вибрані ({selected.size})
          </Button>
        </div>
      </div>
    </Modal>
  )
}
