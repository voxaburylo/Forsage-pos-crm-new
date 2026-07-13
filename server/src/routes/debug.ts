import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { requireAuth } from '../middleware/auth.js'
import { logger } from '../lib/logger.js'

// «Чорна скринька» сканера: фронтенд надсилає сирі keydown-події з каси,
// щоб можна було побачити, які саме символи/суфікси шле конкретний сканер.
const router = Router()
router.use(requireAuth)

const LOG_PATH = path.resolve(process.cwd(), 'scanner-keys.log')

router.post('/scanner-keys', (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 1000) : []
  const line = JSON.stringify({
    at: new Date().toISOString(),
    note: req.body?.note ?? null,
    events,
  })
  fs.appendFile(LOG_PATH, line + '\n', (err) => {
    if (err) logger.warn({ err: err.message }, '[debug] scanner log append failed')
  })
  logger.info({ count: events.length, note: req.body?.note }, '[debug] scanner keys batch')
  res.json({ data: { ok: true, received: events.length } })
})

export default router
