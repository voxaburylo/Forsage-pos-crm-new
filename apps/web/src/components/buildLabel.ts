/**
 * Підпис збірки вгорі екрана (22.11.2026, прохання власника: «на другому ПК не видно, яка версія й чи оновилась»).
 * Каса: дата й час збірки програми (так само її видно в «Налаштування → Про програму»), у вебі — дата публікації.
 * Дата за Києвом, коротко: «зб. 22.11 18:25».
 */
export function formatBuildStamp(iso: string | null | undefined): string | null {
  const date = new Date(String(iso ?? ''))
  if (!Number.isFinite(date.getTime())) return null
  const parts = Object.fromEntries(new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.day}.${parts.month} ${parts.hour}:${parts.minute}`
}

export interface BuildLabel {
  /** «Каса · зб. 22.11 18:25» / «Веб · зб. 22.11 18:25». */
  text: string
  /** Повна назва збірки для підказки при наведенні. */
  title: string
  /** ПК менеджера вже завантажив новішу збірку: встановиться при закритті програми. */
  updateWaiting: boolean
}

export function buildLabel(input: {
  desktop: boolean
  build?: { releaseId?: string | null; builtAt?: string | null } | null
  stagedUpdateReleaseId?: string | null
  managerPc?: boolean
  webBuiltAt?: string | null
  webCommit?: string | null
}): BuildLabel | null {
  if (input.desktop) {
    const stamp = formatBuildStamp(input.build?.builtAt)
    if (!stamp) return null
    const where = input.managerPc ? 'ПК менеджера' : 'Каса'
    return { text: `${where} · зб. ${stamp}`, title: `Збірка програми: ${input.build?.releaseId ?? 'невідомо'}`, updateWaiting: Boolean(input.stagedUpdateReleaseId) }
  }
  const stamp = formatBuildStamp(input.webBuiltAt)
  if (!stamp) return null
  return { text: `Веб · зб. ${stamp}`, title: `Збірка вебу${input.webCommit ? ': ' + input.webCommit : ''}`, updateWaiting: false }
}
