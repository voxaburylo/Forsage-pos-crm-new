/**
 * 25.11.2026, слово власника: «кружечок навпроти складу — заповнюється зеленим у міру завантаження, і скільки
 * лишилось у днях, годинах чи хвилинах; ненавʼязливо, щоб не заважало; кружечок з анімацією».
 */
export type LoadProgress = { fraction: number | null; eta_ms: number | null; loading: boolean; next_at: string | null; note?: string }

/** «≈ 2 дн 5 год», «≈ 1 год 20 хв», «≈ 15 хв», «< 1 хв». */
export function leftText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '< 1 хв'
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60
  if (days > 0) return `≈ ${days} дн${hours ? ` ${hours} год` : ''}`
  if (hours > 0) return `≈ ${hours} год${rest ? ` ${rest} хв` : ''}`
  return `≈ ${rest} хв`
}

/** Короткий підпис біля кружечка. */
export function progressText(progress: LoadProgress | null | undefined): string {
  if (!progress) return ''
  if (progress.loading) {
    const percent = progress.fraction == null ? '' : `${Math.floor(progress.fraction * 100)} %`
    const left = leftText(progress.eta_ms)
    return [percent, left && `лишилось ${left}`, progress.note].filter(Boolean).join(' · ') || 'завантажується'
  }
  // 26.11.2026: пояснення від сервера («вимкнено», «на паузі, поки вантажаться кроси»).
  if (progress.note) return [progress.fraction == null ? '' : `${Math.floor(progress.fraction * 100)} %`, progress.note].filter(Boolean).join(' · ')
  if (progress.fraction === 1) return 'завантажено'
  return progress.fraction == null ? '' : 'ще не завантажувалось'
}

export function LoadRing({ progress, label, showText = true, textClassName = '' }: { progress: LoadProgress | null | undefined; label: string; showText?: boolean; textClassName?: string }) {
  if (!progress) return null
  const size = 16, stroke = 2.5, radius = (size - stroke) / 2, length = 2 * Math.PI * radius
  const fraction = progress.fraction ?? 0
  const text = progressText(progress)
  const next = !progress.loading && progress.next_at ? `; наступне оновлення ${new Date(progress.next_at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}` : ''
  return (
    <span className="inline-flex shrink-0 items-center gap-1 align-middle text-[11px] leading-none text-gray-400" role="img"
      aria-label={`${label}: ${text}${next}`} title={`${label}: ${text}${next}`} data-load-ring={progress.loading ? 'loading' : fraction >= 1 ? 'done' : 'idle'}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={progress.loading && progress.fraction == null ? 'animate-spin' : ''} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#16a34a" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={length} strokeDashoffset={progress.fraction == null ? length * 0.7 : length * (1 - fraction)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dashoffset 0.8s ease' }}
          className={progress.loading && progress.fraction != null ? 'animate-pulse' : ''} />
      </svg>
      {showText && text && <span className={textClassName}>{text}</span>}
    </span>
  )
}
