import { createImportWorker, createOnecImportWorker } from '../lib/bullmq.js'
import { confirmImport } from '../services/importService.js'
import { runOnecImport } from '../services/onecImportService.js'
import { logger } from '../lib/logger.js'

let importWorker: ReturnType<typeof createImportWorker> | null = null
let onecWorker: ReturnType<typeof createOnecImportWorker> | null = null

export function startImportWorkers(): void {
  try {
    importWorker = createImportWorker(async (data) => {
      const { items, userId, supplierId, mode, createMissing, updateRetail, tenantId } = data
      logger.info({ itemCount: items.length, userId, supplierId }, 'Import worker: processing confirm import')
      const result = await confirmImport({ items, supplier_id: supplierId, mode, create_missing: createMissing, update_retail: updateRetail }, userId, tenantId)
      return result
    })

    onecWorker = createOnecImportWorker(async (data) => {
      const { tenantId, rows, mode, updatePrices } = data
      logger.info({ rowCount: rows.length, tenantId, mode }, 'Import worker: processing 1C import')
      const result = await runOnecImport(tenantId, rows, { mode, updatePrices })
      return result
    })

    logger.info('Import workers started (BullMQ)')
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to start import workers (Redis may be unavailable)')
  }
}

export function stopImportWorkers(): void {
  if (importWorker) {
    importWorker.close()
    importWorker = null
  }
  if (onecWorker) {
    onecWorker.close()
    onecWorker = null
  }
  logger.info('Import workers stopped')
}
