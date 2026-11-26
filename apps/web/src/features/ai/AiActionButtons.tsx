import { Check, Eye } from 'lucide-react'
import { Button } from '@/components/ui'

/**
 * Кнопки під пропозицією помічника. Винесено з AiAssistantPage.tsx 26.11.2026.
 * Слово власника: «без купи зайвих нагромаджень, підтверджень і незрозумілих кнопок». Було: жовта плашка «Ще не збережено —
 * потрібне ваше підтвердження» + «Переглянути та підтвердити» → вікно → «Підтвердити та зберегти». Тепер масова пропозиція
 * підтверджується однією кнопкою тут же (перші рядки видно в картці), а повний список — за бажанням, посиланням.
 * Замовлення із зошита й накладна лишаються з переглядом: там власник править поля перед записом.
 */
export type AiActionKind = 'order' | 'invoice' | 'bulk' | 'single'

export function aiActionKind(flags: { isOrder: boolean; isInvoice: boolean; isBulk: boolean }): AiActionKind {
  return flags.isOrder ? 'order' : flags.isInvoice ? 'invoice' : flags.isBulk ? 'bulk' : 'single'
}

export function aiPrimaryLabel(kind: AiActionKind, count?: number): string {
  if (kind === 'order') return 'Перевірити та створити замовлення'
  if (kind === 'invoice') return 'Відкрити накладну' + (count ? ` (${count})` : '')
  return 'Підтвердити' + (kind === 'bulk' && count ? ` (${count})` : '')
}

export function AiActionButtons({ kind, count, loading, disabled, onPrimary, onViewAll, onReject }: {
  kind: AiActionKind; count?: number; loading: boolean; disabled: boolean
  onPrimary: () => void; onViewAll?: () => void; onReject: () => void
}) {
  const opens = kind === 'order' || kind === 'invoice'
  return (
    <div className="flex flex-wrap items-center gap-2" data-ai-action-buttons={kind}>
      <Button type="button" onClick={onPrimary} loading={loading} disabled={disabled && !loading} className="text-xs" data-ai-action-primary>
        {opens ? <Eye size={14} className="mr-1" /> : <Check size={14} className="mr-1" />} {aiPrimaryLabel(kind, count)}
      </Button>
      <Button disabled={disabled || loading} type="button" variant="secondary" onClick={onReject} className="text-xs">Відхилити</Button>
      {kind === 'bulk' && onViewAll && (
        <button type="button" onClick={onViewAll} disabled={disabled || loading} className="text-xs text-blue-700 underline disabled:text-gray-400" data-ai-action-view-all>
          усі рядки
        </button>
      )}
    </div>
  )
}
