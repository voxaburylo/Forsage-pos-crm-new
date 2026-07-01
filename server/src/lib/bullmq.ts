import { Queue, Worker } from 'bullmq'
import { logger } from '../lib/logger.js'

const QUEUE_NAMES = {
  IMPORT: 'import-jobs',
  ONEC_IMPORT: 'onec-import-jobs',
} as const

function getRedisOpts(): { host: string; port: number } {
  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error('REDIS_URL is not configured; background imports use synchronous fallback')
  }
  try {
    const parsed = new URL(url)
    return { host: parsed.hostname, port: parseInt(parsed.port || '6379', 10) }
  } catch {
    return { host: 'localhost', port: 6379 }
  }
}

const queues = new Map<string, Queue>()

function getQueue(name: string): Queue {
  getRedisOpts()
  if (!queues.has(name)) {
    const q = new Queue(name, {
      connection: getRedisOpts(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    })
    queues.set(name, q)
  }
  return queues.get(name)!
}

async function enqueueImportJob(payload: {
  items: any[]
  userId: string
  supplierId?: string
  mode: string
  createMissing: boolean
  updateRetail: boolean
  tenantId?: string
}): Promise<string> {
  const queue = getQueue(QUEUE_NAMES.IMPORT)
  const job = await queue.add('confirm-import', payload, { priority: 5 })
  logger.info({ jobId: job.id, itemCount: payload.items.length }, 'Enqueued import job')
  return job.id!
}

async function enqueueOnecImportJob(payload: {
  tenantId: string
  rows: any[]
  mode: 'replace' | 'add'
  updatePrices: boolean
}): Promise<string> {
  const queue = getQueue(QUEUE_NAMES.ONEC_IMPORT)
  const job = await queue.add('onec-import', payload, { priority: 5 })
  logger.info({ jobId: job.id, rowCount: payload.rows.length }, 'Enqueued 1C import job')
  return job.id!
}

async function getJobStatus(queueName: string, jobId: string, tenantId: string): Promise<{
  id: string
  state: string
  progress: number
  result: any
  failedReason?: string
} | null> {
  const queue = getQueue(queueName)
  const job = await queue.getJob(jobId)
  if (!job) return null
  if (job.data?.tenantId !== tenantId) return null
  const state = await job.getState()
  return {
    id: job.id!,
    state,
    progress: typeof job.progress === 'number' ? job.progress : 0,
    result: job.returnvalue,
    failedReason: job.failedReason,
  }
}

function createImportWorker(handler: (data: any) => Promise<any>): Worker {
  const connection = getRedisOpts()
  const worker = new Worker(QUEUE_NAMES.IMPORT, async (job) => {
    logger.info({ jobId: job.id, type: job.name }, 'Processing import job')
    return handler(job.data)
  }, {
    connection,
    concurrency: 2,
  })
  worker.on('completed', (job) => { logger.info({ jobId: job.id }, 'Import job completed') })
  worker.on('failed', (job, err) => { logger.error({ jobId: job?.id, err: err.message }, 'Import job failed') })
  return worker
}

function createOnecImportWorker(handler: (data: any) => Promise<any>): Worker {
  const connection = getRedisOpts()
  const worker = new Worker(QUEUE_NAMES.ONEC_IMPORT, async (job) => {
    logger.info({ jobId: job.id, type: job.name }, 'Processing 1C import job')
    return handler(job.data)
  }, {
    connection,
    concurrency: 2,
  })
  worker.on('completed', (job) => { logger.info({ jobId: job.id }, '1C import job completed') })
  worker.on('failed', (job, err) => { logger.error({ jobId: job?.id, err: err.message }, '1C import job failed') })
  return worker
}

async function shutdownQueues(): Promise<void> {
  for (const [name, queue] of queues) {
    await queue.close()
    logger.info({ queue: name }, 'Queue closed')
  }
}

export {
  QUEUE_NAMES,
  getQueue,
  enqueueImportJob,
  enqueueOnecImportJob,
  getJobStatus,
  createImportWorker,
  createOnecImportWorker,
  shutdownQueues,
}
