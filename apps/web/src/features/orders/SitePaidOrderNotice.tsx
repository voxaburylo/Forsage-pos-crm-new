import { SITE_PAID_MARK, STOCK_CONFLICT_MARK } from '@/features/tillCommands/tillOrderModel'

/**
 * Помітне попередження в картці замовлення (27.11.2026, завдання власника): замовлення оплатили онлайн на сайті —
 * при видачі гроші вдруге не брати; якщо товару не вистачило — червона плашка «КОНФЛІКТ» (вирішити: повернути чи привезти).
 */
export function sitePaidState(comment: string | null | undefined): { paid: boolean; conflict: string | null } {
  const text = String(comment ?? '')
  const conflictLine = text.split('\n').find(line => line.startsWith(STOCK_CONFLICT_MARK)) ?? null
  return { paid: text.includes(SITE_PAID_MARK), conflict: conflictLine }
}

export function SitePaidOrderNotice({ comment }: { comment: string | null | undefined }) {
  const state = sitePaidState(comment)
  if (!state.paid && !state.conflict) return null
  return (
    <div className="space-y-2" data-site-paid-notice>
      {state.conflict && <div role="alert" className="rounded-xl border-2 border-red-400 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">⚠️ {state.conflict}</div>}
      {state.paid && <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-900">💳 Оплачено онлайн на сайті — при видачі гроші вдруге не брати. Товар заброньовано під це замовлення.</div>}
    </div>
  )
}
