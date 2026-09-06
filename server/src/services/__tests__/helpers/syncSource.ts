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
  return parts.join('\n')
}

export const syncModuleSource = readSyncModule()
