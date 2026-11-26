import { useEffect, useState } from 'react'
import { productApi } from '@/features/products/productApi'
import type { Product } from '@/types/product'
import { normalizeExactInvoiceProductName } from './invoiceFormModel'

/**
 * Червона плашка рядка накладної, який каса не провела. Винесено з InvoiceFormPage.tsx 26.11.2026.
 *
 * Слово власника 26.11.2026: «третій день не можу нормально розбирати товар». У журналі каси — 61 відмова «Кілька карток
 * мають точно таку саму назву»: програма казала «виберіть картку вручну», а вибрати не було з чого — доводилось шукати
 * картку пошуком або питати помічника. Тепер у самій плашці — картки з такою назвою (артикул, залишок, ціна) і кнопка
 * «Вибрати»: один натиск, і рядок привʼязано.
 */
export function isSameNameProblem(message: string): boolean {
  return /кілька товарів із точною назвою|збігається з кількома товарами|кілька карток мають точно таку саму назву/i.test(message)
}

/** Картки з точно такою назвою; спершу ті, що є на складі, далі — заповненіші. */
export function sameNameCards(products: readonly Product[], name: string): Product[] {
  const wanted = normalizeExactInvoiceProductName(name)
  const unique = [...new Map(products.filter(product => normalizeExactInvoiceProductName(product.name) === wanted).map(product => [product.id, product])).values()]
  return unique.sort((a, b) => (Number(b.qty_on_hand) || 0) - (Number(a.qty_on_hand) || 0) || (Number(b.retail_price) || 0) - (Number(a.retail_price) || 0) || a.id.localeCompare(b.id))
}

export function cardLabel(product: Product): string {
  const sku = product.sku && !/^AUTO-/i.test(product.sku) ? 'арт. ' + product.sku : 'без артикула'
  return `${sku} · залишок ${Number(product.qty_on_hand) || 0} · ${((Number(product.retail_price) || 0) / 100).toFixed(2)} грн`
}

export function InvoiceLineProblem({ name, message, onChoose, onAsk }: {
  name: string; message: string; onChoose: (product: Product) => void; onAsk: () => void
}) {
  const sameName = isSameNameProblem(message)
  const [cards, setCards] = useState<Product[] | null>(null)
  useEffect(() => {
    if (!sameName || name.trim().length < 2) { setCards(null); return }
    let alive = true
    productApi.search(name.trim(), 200).then(result => { if (alive) setCards(sameNameCards(result.data ?? [], name)) }, () => { if (alive) setCards([]) })
    return () => { alive = false }
  }, [sameName, name])
  return (
    <div className="mt-1 rounded-lg border border-red-200 bg-red-100 px-2 py-1 text-[11px] font-semibold text-red-700" data-invoice-line-problem>
      {sameName && cards?.length
        ? <>У базі вже є {cards.length} {cards.length === 1 ? 'картка' : 'картки'} з такою назвою. Виберіть, у яку прийняти товар:</>
        : <>{message || 'Проблемний рядок.'} Виправте рядок або виберіть товар через пошук.</>}
      {sameName && cards?.length ? (
        <ul className="mt-1 space-y-1" data-invoice-same-name>
          {cards.slice(0, 6).map(product => (
            <li key={product.id} className="flex flex-wrap items-center gap-2 rounded-md bg-white px-2 py-1 font-medium text-gray-800">
              <span className="min-w-0 flex-1">{cardLabel(product)}</span>
              <button type="button" onClick={() => onChoose(product)} className="rounded-md bg-yellow-400 px-2.5 py-1 text-[11px] font-semibold text-gray-900 hover:bg-yellow-500">Вибрати</button>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" onClick={onAsk}
        className={(sameName && cards?.length ? 'mt-1 ' : 'ml-2 ') + 'rounded-md bg-white px-2 py-0.5 text-[11px] font-semibold text-purple-700 ring-1 ring-purple-200 hover:bg-purple-50'}>
        Спитати помічника
      </button>
    </div>
  )
}
