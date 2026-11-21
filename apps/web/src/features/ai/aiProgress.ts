// 21.11.2026: окремо від aiApi, щоб підпис ходу роботи не залежав від мережевого модуля (і його тестових підмін).
/** Хід роботи помічника, поки він думає (21.11.2026). */
export type AiChatProgress = { stage: 'start' } | { stage: 'tools'; tools: string[] } | { stage: 'answer' }

/** Підпис для екрана: що зараз робить помічник. */
export function aiProgressLabel(event: AiChatProgress | null): string {
  if (!event || event.stage === 'start') return 'Думаю…'
  if (event.stage === 'answer') return 'Пишу відповідь…'
  const names = event.tools
  if (names.some(n => /invoice|supply|receiv/i.test(n))) return 'Розбираю накладну…'
  if (names.some(n => /^(create|update|merge|add|delete|set)_/i.test(n))) return 'Готую зміни для підтвердження…'
  if (names.some(n => /customer/i.test(n))) return 'Шукаю клієнтів…'
  if (names.some(n => /sale|report|stat|revenue|analytic/i.test(n))) return 'Рахую продажі…'
  if (names.some(n => /cross|analog/i.test(n))) return 'Шукаю аналоги…'
  return 'Шукаю в каталозі…'
}
