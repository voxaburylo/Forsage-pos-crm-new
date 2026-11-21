/**
 * 21.11.2026 (план зручності, п. «закриття зміни»): зміни не закривались з 14–16.11, і через це не
 * робились копії «при закритті зміни». Каса сама підказує: зміна з минулого дня — закрити негайно;
 * після 19:00 за Києвом — нагадування «кінець дня», щоб закрити зміну однією кнопкою з готовим звітом.
 */
export type ShiftEndPrompt = 'stale' | 'evening' | null

export const SHIFT_EVENING_HOUR = 19

function kyivParts(value: Date): { day: string; hour: number } {
  const day = value.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' })
  const hour = Number(value.toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }))
  return { day, hour: hour === 24 ? 0 : hour }
}

export function shiftEndPrompt(openedAt: string | null | undefined, now = new Date()): ShiftEndPrompt {
  if (!openedAt) return null
  const opened = new Date(openedAt)
  if (Number.isNaN(opened.getTime())) return null
  const current = kyivParts(now)
  if (kyivParts(opened).day < current.day) return 'stale'
  return current.hour >= SHIFT_EVENING_HOUR ? 'evening' : null
}
