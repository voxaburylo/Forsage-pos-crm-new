import type { LanUpdateReport } from '@/lib/desktopBridge'

/**
 * 25.11.2026 (власник: «на втором ПК программа не обновляется — подумай почему»): стан автооновлення ПК менеджера
 * простими словами. Причину видно на екрані — власник надсилає фото, а не шукає журнал.
 */
export function lanUpdateLines(report: LanUpdateReport): Array<{ tone: 'ok' | 'warn' | 'bad'; text: string }> {
  const lines: Array<{ tone: 'ok' | 'warn' | 'bad'; text: string }> = []
  const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString('uk-UA') : ''
  if (!report.portable) lines.push({ tone: 'bad', text: 'Програму запущено не з файлу Forsage.exe з архіву — автооновлення не працює. Запускайте Forsage.exe з теки «Forsage-Manager».' })
  const state = report.outcome?.state
  if (state === 'installed') lines.push({ tone: 'ok', text: `Остання установка оновлення пройшла${report.outcome?.finishedAt ? ' ' + when(report.outcome.finishedAt) : ''}.` })
  if (state === 'failed' || state === 'rolled-back') lines.push({ tone: 'bad', text: `Остання установка оновлення не вдалася${report.outcome?.message ? ': ' + report.outcome.message : ''}. Програма повторить при наступному закритті.` })
  if (state === 'waiting') lines.push({ tone: 'warn', text: 'Оновлення встановлюється (після закриття програми). Зачекайте кілька хвилин і відкрийте програму знову.' })
  if (state === 'unknown') lines.push({ tone: 'bad', text: `Попередня установка оновлення перервалась${report.outcome?.message ? ' (' + report.outcome.message + ')' : ''} — нові оновлення заблоковано до перевірки. Оновіть програму флешкою з архіву «Форсаж — ПК менеджера».` })
  if (report.staged) lines.push({ tone: 'ok', text: 'Нову версію завантажено — встановиться, коли ви повністю закриєте програму.' })
  else if (report.error) lines.push({ tone: 'warn', text: `Нову версію не вдалося завантажити з головного ПК${report.checkedAt ? ' (' + when(report.checkedAt) + ')' : ''}: ${report.error}` })
  else if (report.checkedAt) lines.push({ tone: 'ok', text: `Перевірено ${when(report.checkedAt)}: на головному ПК немає новішої версії.` })
  else lines.push({ tone: 'warn', text: 'Оновлення ще не перевірялось (перевірка — після входу й далі кожні 5 хвилин).' })
  if (report.installError) lines.push({ tone: 'bad', text: `Оновлення не встановилось при закритті: ${report.installError}` })
  return lines
}

export function LanUpdateStatus({ report }: { report: LanUpdateReport }) {
  const color = { ok: 'text-emerald-900', warn: 'text-amber-800', bad: 'text-red-700' }
  return (
    <div className="mt-2 space-y-1 rounded-lg bg-white/80 px-2 py-1 text-xs" data-lan-update-status>
      <p className="font-semibold text-gray-800">Оновлення з головного ПК</p>
      {lanUpdateLines(report).map((line, index) => <p key={index} className={color[line.tone]}>{line.text}</p>)}
      {report.executable && <p className="truncate font-mono text-[10px] text-gray-500">{report.executable}</p>}
    </div>
  )
}
