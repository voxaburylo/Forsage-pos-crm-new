import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Увесь код синхронізації одним текстом.
 *
 * Частина перевірок стереже не поведінку, а самі рядки коду: «читаємо час з
 * бази, а не з процесу», «сторно комісії не мовчить», «курсор має перекриття».
 * Такі перевірки цінні — вони ловлять зміни, які тестом поведінки не спіймаєш
 * без справжньої бази. Але поки вони читали ОДИН файл, будь-який поділ того
 * файлу ламав їх на порожньому місці, хоча код нікуди не дівся.
 *
 * Тому дивимось на модуль синхронізації цілком: `syncService.ts` плюс усе, що
 * з нього винесено в `sync/`. Наступний поділ нічого не зламає.
 */
const servicesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function readSyncModule(): string {
  const parts = [readFileSync(path.join(servicesDir, 'syncService.ts'), 'utf8')]
  const syncDir = path.join(servicesDir, 'sync')
  for (const entry of readdirSync(syncDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      parts.push(readFileSync(path.join(syncDir, entry.name), 'utf8'))
    }
  }
  // Файли лежать із CRLF. Без нормалізації рядок «}» ніколи не збігається
  // точно, і межа функції їде далі, захоплюючи половину модуля.
  return parts.join('\n').replace(/\r\n/g, '\n')
}

export const syncModuleSource = readSyncModule()

/**
 * Тіло однієї функції синхронізації — від оголошення до закривної дужки на
 * початку рядка.
 *
 * Раніше тести різали код «від функції X до функції Y», спираючись на те, що
 * вони сусіди в одному файлі. Після поділу на модулі сусідство змінилося, і
 * перевірки почали падати на порожньому місці, хоча код той самий. Тепер межа
 * не залежить від того, де саме лежить функція.
 */
export function syncFunctionBody(name: string): string {
  const declaration = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm')
  const match = declaration.exec(syncModuleSource)
  if (!match) throw new Error(`не знайдено функцію синхронізації: ${name}`)

  const lines = syncModuleSource.slice(match.index).split('\n')
  const body: string[] = []
  for (const line of lines) {
    body.push(line)
    if (line === '}') break
  }
  return body.join('\n')
}
