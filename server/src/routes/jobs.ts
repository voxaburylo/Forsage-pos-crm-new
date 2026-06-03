import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { getJobStatus, QUEUE_NAMES } from '../lib/bullmq.js'

const router = Router()
router.use(requireAuth)

// GET /api/v1/jobs/:queueName/:jobId
router.get('/:queueName/:jobId', async (req, res, next) => {
  try {
    const { queueName, jobId } = req.params

    const validQueues = Object.values(QUEUE_NAMES) as string[]
    if (!validQueues.includes(queueName)) {
      return res.status(400).json({ error: 'Invalid queue name' })
    }

    const status = await getJobStatus(queueName, jobId)
    if (!status) {
      return res.status(404).json({ error: 'Job not found' })
    }

    res.json({ data: status })
  } catch (err) { next(err) }
})

export default router
