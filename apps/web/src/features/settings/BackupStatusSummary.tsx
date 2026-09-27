import { desktopBridge, type DesktopDatabaseBackup } from '@/lib/desktopBridge'

type Bridge = NonNullable<ReturnType<typeof desktopBridge>>
export type ShiftCopyStatus = Awaited<ReturnType<NonNullable<Bridge['shiftBackups']>['status']>>[number]
const dateText = (value?: string | null) => value ? new Date(value).toLocaleString('uk-UA') : 'Ще немає'

export function BackupStatusSummary({ backups, shifts }: { backups: DesktopDatabaseBackup[]; shifts: ShiftCopyStatus[] }) {
  const localDate = backups.map(row => row.createdAt).sort().reverse()[0]
  const latest = shifts[0]
  const external = [...shifts].filter(row => row.cloud_completed_at).sort((a, b) => (b.captured_at ?? '').localeCompare(a.captured_at ?? ''))[0]
  const waiting = latest && !latest.cloud_completed_at
  return <section>
    <dl className="mt-3 space-y-3 text-sm">
      <div><dt className="text-gray-500">Остання локальна копія бази</dt><dd>{dateText(localDate)}</dd></div>
      <div><dt className="text-gray-500">База після закриття зміни</dt><dd>{!latest ? 'Ще немає закритої зміни з резервною копією' : latest.local_ready === true ? `Готова · ${dateText(latest.captured_at)}` : latest.local_error ? `Помилка: ${latest.local_error}` : latest.local_ready === false ? 'Не готова або файли відсутні — перевірте резервування' : 'Стан файлів не перевірено — потрібне оновлення програми'}</dd></div>
      {latest && <div><dt className="text-gray-500">Excel: товари та клієнти</dt><dd>{latest.exports_ready === true ? 'Обидва файли готові' : latest.exports_ready === false ? 'Файли не готові або недоступні' : 'Потрібне оновлення для перевірки файлів'}</dd></div>}
      <div><dt className="text-gray-500">Остання перевірена зовнішня копія</dt><dd>{external ? `Дані станом на ${dateText(external.captured_at)}; перевірено ${dateText(external.cloud_completed_at)}` : 'Підтвердженої зовнішньої копії немає'}</dd></div>
      {waiting && <div className="rounded-lg bg-amber-50 p-3 text-amber-800">Остання зміна ще не має підтвердженої зовнішньої копії.{latest.cloud_error ? ` ${latest.cloud_error}` : ' Передавання повториться у фоні за наявності зв’язку.'}</div>}
    </dl>
    <p className="mt-3 text-xs text-gray-500">Локальна копія на цьому ПК не захищає від поломки його диска. Копія для вебперегляду — окрема функція, не підтвердження резервування.</p>
  </section>
}
