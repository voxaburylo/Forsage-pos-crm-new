import { desktopBridge, isDesktopRuntime } from '@/lib/desktopBridge'
import { productApi } from '@/features/products/productApi'
import { applyApprovedPhotos, collectBatch, photoAiApi, type PhotoAiProduct } from './photoAiApi'

/**
 * «Фото ШІ» на ПК з базою каси. Лише каса знає, у яких карток уже є своє фото (фото каси — файли на її диску, у хмарі
 * їх не видно), тому зібрати партію «товари без фото» і поставити готові фото в картки можна тільки тут.
 */
export function hasTillCatalog(): boolean {
  const catalog = desktopBridge()?.catalog
  return isDesktopRuntime() && Boolean(catalog?.listProducts && catalog.findById && catalog.saveProduct)
}

/** Ставить готові фото в картки без фото. null — це не ПК з базою каси. */
export async function runApplyApproved(): Promise<{ applied: number; skipped: number; failed: number } | null> {
  const catalog = desktopBridge()?.catalog
  if (!hasTillCatalog() || !catalog?.findById) return null
  return applyApprovedPhotos({
    list: () => photoAiApi.unapplied(),
    findCard: id => catalog.findById!(id),
    setCardPhoto: (id, url) => productApi.update(id, { photo_url: url } as never, { silent: true }),
    report: (applied, skipped) => photoAiApi.applied(applied, skipped),
  })
}

/** Партія для масового пошуку: товари каси без фото, спершу ті, що є на складі. */
export function collectTillBatch(want: number): Promise<PhotoAiProduct[]> {
  if (!hasTillCatalog()) return Promise.resolve([])
  return collectBatch(want, {
    listPage: page => productApi.list({ page, per_page: 200, sort_field: 'qty_on_hand', sort_dir: 'desc' })
      .then(result => ({ data: result.data, total_pages: result.pagination.total_pages })),
    eligible: ids => photoAiApi.eligible(ids),
  })
}
