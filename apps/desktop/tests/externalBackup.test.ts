import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXTERNAL_FOLDER_NAME, ExternalBackupService, externalStatus, importExternalCopy, listExternalCopies,
  pruneExternalCopies, readExternalConfig, setExternalFolder, writeExternalCopy,
} from '../src/backup/externalBackup'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { exportExcelOnly } from '../src/backup/shiftExportWorker'
import * as XLSX from 'xlsx'

describe('copies on a flash drive', () => {
  let root: string, dataRoot: string, usb: string, source: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-external-backup-'))
    dataRoot = path.join(root, 'Forsage'); usb = path.join(root, 'usb')
    mkdirSync(path.join(dataRoot, 'backups'), { recursive: true }); mkdirSync(usb)
    source = path.join(dataRoot, 'backups', 'Forsage-2026-11-17_10-00-00-000-abcdef12.db')
    writeFileSync(source, Buffer.alloc(200_000, 'forsage-database-page '))
  })
  afterEach(() => { if (path.basename(root).startsWith('forsage-external-backup-')) rmSync(root, { recursive: true, force: true }) })

  it('writes a compressed copy with a matching SHA-256 file and no partial leftovers', async () => {
    const copy = await writeExternalCopy(source, usb, new Date('2026-11-17T10:00:00Z'))
    const dir = path.join(usb, EXTERNAL_FOLDER_NAME)
    const archive = readFileSync(path.join(dir, copy.fileName))
    expect(gunzipSync(archive).equals(readFileSync(source))).toBe(true)
    expect(createHash('sha256').update(archive).digest('hex')).toBe(copy.sha256)
    expect(readFileSync(path.join(dir, copy.fileName + '.sha256'), 'utf8')).toBe(`${copy.sha256}  ${copy.fileName}\n`)
    expect(readdirSync(dir).some(name => name.endsWith('.partial'))).toBe(false)
    expect(listExternalCopies(usb)).toEqual([copy])
  })

  it('keeps the newest copies and frees space without dropping below three', async () => {
    for (let i = 0; i < 6; i++) await writeExternalCopy(source, usb, new Date(Date.UTC(2026, 10, 10 + i, 10)))
    expect(pruneExternalCopies(usb, 4, () => Number.MAX_SAFE_INTEGER)).toHaveLength(2)
    expect(listExternalCopies(usb).map(c => c.createdAt.slice(0, 10))).toEqual(['2026-11-15', '2026-11-14', '2026-11-13', '2026-11-12'])
    expect(pruneExternalCopies(usb, 30, () => 0)).toHaveLength(1)
    expect(listExternalCopies(usb)).toHaveLength(3)
    expect(readdirSync(path.join(usb, EXTERNAL_FOLDER_NAME)).filter(name => name.endsWith('.sha256'))).toHaveLength(3)
  })

  it('imports a copy back only when its checksum matches', async () => {
    const copy = await writeExternalCopy(source, usb)
    const checked: string[] = []
    const imported = await importExternalCopy(usb, copy.fileName, path.join(dataRoot, 'backups'), file => { checked.push(file) })
    expect(imported.fileName).toMatch(/^Forsage-\d{4}-\d{2}-\d{2}_usb-[a-f0-9]{8}\.db$/)
    expect(readFileSync(path.join(dataRoot, 'backups', imported.fileName)).equals(readFileSync(source))).toBe(true)
    expect(checked).toHaveLength(1)

    const other = await writeExternalCopy(source, usb, new Date('2026-11-18T10:00:00Z'))
    writeFileSync(path.join(usb, EXTERNAL_FOLDER_NAME, other.fileName + '.sha256'), '0'.repeat(64) + '  x\n')
    await expect(importExternalCopy(usb, other.fileName, path.join(dataRoot, 'backups'), () => {})).rejects.toThrow('Контрольна сума')
    await expect(importExternalCopy(usb, '../../forsage.db.gz', path.join(dataRoot, 'backups'), () => {})).rejects.toThrow('Некоректна назва')
  })

  it('round-trips a real program database through the drive', async () => {
    const realRoot = path.join(root, 'real')
    const db = new LocalDatabase(realRoot)
    try {
      const backup = await db.backupNow()
      const copy = await writeExternalCopy(backup, usb)
      const imported = await importExternalCopy(usb, copy.fileName, path.join(realRoot, 'backups'), file => LocalDatabase.assertBackupIsUsable(file))
      expect(LocalDatabase.listBackups(realRoot).map(entry => entry.fileName)).toContain(imported.fileName)
    } finally { db.close() }
  })

  it('puts readable Excel «Товари» and «Клієнти» next to the copy and keeps only the newest (20.11.2026)', async () => {
    const realRoot = path.join(root, 'real')
    const db = new LocalDatabase(realRoot)
    try {
      new LocalCatalogRepository(db).saveProduct({ id: '00000000-0000-4000-8000-000000000001', sku: 'WL7129', name: 'Фільтр масляний WIX WL7129', unit: 'шт', qty_on_hand: 3, purchase_price: 15000, retail_price: 25000 })
      const backup = await db.backupNow()
      const errors: unknown[] = []
      const service = new ExternalBackupService(dataRoot, { listBackups: () => [{ filePath: backup, createdAt: new Date().toISOString() }], backupNow: async () => backup },
        error => errors.push(error), exportExcelOnly)
      setExternalFolder(dataRoot, usb)
      await service.runNow()
      const dir = path.join(usb, EXTERNAL_FOLDER_NAME)
      writeFileSync(path.join(dir, 'Товари_2020-01-01-00-00.xlsx'), 'old')
      await new Promise(resolve => setTimeout(resolve, 1100))
      await service.runNow()
      expect(errors).toEqual([])
      const excel = readdirSync(dir).filter(name => name.endsWith('.xlsx')).sort()
      expect(excel).toHaveLength(2)
      const products = XLSX.read(readFileSync(path.join(dir, excel.find(name => name.startsWith('Товари_'))!)))
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(products.Sheets['Товари'])
      expect(rows[0]).toMatchObject({ 'Артикул': 'WL7129', 'Залишок': 3, 'Продаж, грн': 250 })
    } finally { db.close() }
  })

  it('refuses a folder inside the program data', () => {
    expect(() => setExternalFolder(dataRoot, path.join(dataRoot, 'backups'))).toThrow('флешку')
    expect(() => setExternalFolder(dataRoot, 'relative')).toThrow('повний шлях')
  })

  it('treats a missing drive as a reminder, writes once a day and records failures', async () => {
    const db = { listBackups: () => [{ filePath: source, createdAt: new Date().toISOString() }], backupNow: async () => source }
    const errors: unknown[] = []
    const service = new ExternalBackupService(dataRoot, db, error => errors.push(error), async () => null)
    expect(await service.runIfDue()).toBeNull()

    setExternalFolder(dataRoot, path.join(root, 'not-inserted'))
    expect(await service.runIfDue()).toBeNull()
    expect(errors).toEqual([])
    expect(externalStatus(dataRoot)).toMatchObject({ available: false, stale: true, copies: [] })

    setExternalFolder(dataRoot, usb)
    expect(await service.runIfDue()).not.toBeNull()
    expect(await service.runIfDue()).toBeNull()
    expect(externalStatus(dataRoot)).toMatchObject({ available: true, stale: false, last_error: null })
    expect(listExternalCopies(usb)).toHaveLength(1)

    rmSync(source)
    await expect(service.runNow()).rejects.toThrow()
    expect(readExternalConfig(dataRoot).last_error).toBeTruthy()
    expect(existsSync(path.join(usb, EXTERNAL_FOLDER_NAME))).toBe(true)
  })
})
