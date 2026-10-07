import type { LineItem } from './invoiceFormModel'
import { invoiceMatchProblems, type InvoiceCandidate } from './aiInvoiceMatching'

/** Only disputed rows need an extra control, directly inside the ordinary invoice. */
export function AiInvoiceLineMatch({ item, choose, disabled }: { item: LineItem; choose: (product: InvoiceCandidate | null) => void; disabled: boolean }) {
  if (!item.ai_review) return null
  const review = item.ai_review.result, problems = invoiceMatchProblems(item)
  const note = String(item.ai_review.source.purchase_price_note ?? '')
  if (!problems.length) return note ? <p role="note" className="mt-1 text-xs text-amber-800">{note}</p> : null
  return <div className="mt-1 space-y-1 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800" data-ai-issue={item.client_key}>
    {problems.map(message => <p role="alert" key={message}>{message}</p>)}
    {!!review?.candidates.length && <select aria-label={'Заміна товару: ' + item.product_name} disabled={disabled}
      className="w-full min-w-0 rounded border border-red-300 bg-white px-2 py-1 text-gray-900" value={item.product_id || item.ai_review.choice || ''}
      onChange={event => choose(review.candidates.find(product => product.id === event.target.value) ?? null)}>
      <option value="" disabled>Виберіть товар або відскануйте його штрихкод</option>
      {review.candidates.map(product => <option key={product.id} value={product.id}>{product.name} · {product.sku} · {product.barcode || 'без штрихкоду'}</option>)}
      <option value="new">Це інший товар — залишити новим</option>
    </select>}
  </div>
}
