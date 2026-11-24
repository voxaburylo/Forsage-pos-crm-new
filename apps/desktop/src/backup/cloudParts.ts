import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * 24.11.2026 (план C10): копія, більша за ліміт одного файла хмари (45 МБ), іде частинами по 40 МБ.
 * Ті самі числа, що на сервері (server/src/services/backupPolicy.ts); сторож — cloudBackupParts.test.ts.
 */
export const SINGLE_FILE_MAX_BYTES = 45 * 1024 * 1024
export const BACKUP_PART_BYTES = 40 * 1024 * 1024
export const MAX_CHUNKED_BACKUP_BYTES = 400 * 1024 * 1024

export function backupPartsOf(sizeBytes: number, partBytes = BACKUP_PART_BYTES, singleMax = SINGLE_FILE_MAX_BYTES): number {
  return sizeBytes <= singleMax ? 1 : Math.ceil(sizeBytes / partBytes)
}

/** Межі частини у файлі архіву: [start, end) у байтах. */
export function backupPartRange(sizeBytes: number, part: number, partBytes = BACKUP_PART_BYTES, singleMax = SINGLE_FILE_MAX_BYTES): { start: number; end: number } {
  const parts = backupPartsOf(sizeBytes, partBytes, singleMax)
  if (!Number.isInteger(part) || part < 1 || part > parts) throw new Error('Некоректна частина копії')
  const start = (part - 1) * partBytes
  return { start, end: part < parts ? start + partBytes : sizeBytes }
}

export function backupPartSuffix(part: number): string {
  return '.part' + String(part).padStart(2, '0')
}

/** Контрольні суми кожної частини — сервер звіряє кожну окремо, а цілу копію — загальною сумою. */
export async function backupPartHashes(file: string, sizeBytes: number, partBytes = BACKUP_PART_BYTES, singleMax = SINGLE_FILE_MAX_BYTES): Promise<string[]> {
  const parts = backupPartsOf(sizeBytes, partBytes, singleMax)
  if (parts < 2) return []
  const hashes: string[] = []
  for (let part = 1; part <= parts; part += 1) {
    const { start, end } = backupPartRange(sizeBytes, part, partBytes, singleMax)
    const hash = createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      createReadStream(file, { start, end: end - 1 }).on('data', chunk => hash.update(chunk)).on('end', () => resolve()).on('error', reject)
    })
    hashes.push(hash.digest('hex'))
  }
  return hashes
}
