import { constants, createGunzip, createGzip, createZstdCompress, createZstdDecompress } from 'node:zlib'
import type { Transform } from 'node:stream'

/**
 * Формат стисненої копії бази.
 *
 * 22.11.2026: хмарне сховище (безкоштовний тариф) приймає файли до 45 МБ, а копія в gzip уже 27,6 МБ
 * і росте на 5–7 МБ на місяць — за ~3 місяці хмарні копії перестали б завантажуватись.
 * Zstandard рівня 17 на тій самій базі дає 17,8 МБ (−36 %) за ~20 с. Нові копії пишемо в zst;
 * усі старі копії в gz читаються як і раніше — формат визначає розширення файлу.
 */
export type ArchiveFormat = 'gz' | 'zst'
export const NEW_ARCHIVE_FORMAT: ArchiveFormat = 'zst'
const ZSTD_LEVEL = 17

export function isArchiveFormat(value: unknown): value is ArchiveFormat {
  return value === 'gz' || value === 'zst'
}

/** Формат за іменем файлу (`….db.gz`, `….db.zst`); невідоме розширення — null. */
export function archiveFormatOf(fileName: string): ArchiveFormat | null {
  if (/\.zst$/i.test(fileName)) return 'zst'
  if (/\.gz$/i.test(fileName)) return 'gz'
  return null
}

export function archiveMime(format: ArchiveFormat): string {
  return format === 'zst' ? 'application/zstd' : 'application/gzip'
}

export function createArchiveCompressor(format: ArchiveFormat): Transform {
  return format === 'zst'
    ? createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } })
    : createGzip()
}

export function createArchiveDecompressor(format: ArchiveFormat): Transform {
  return format === 'zst' ? createZstdDecompress() : createGunzip()
}
