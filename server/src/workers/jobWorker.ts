import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'

type JobHandler = (payload: any, jobInfo: { id: string; tenantId: string }) => Promise<void>

export class JobWorker {
  private workerId: string
  private intervalId: NodeJS.Timeout | null = null
  private handlers: Map<string, JobHandler> = new Map()
  private isPolling = false
  private pollIntervalMs: number

  constructor(options?: { pollIntervalMs?: number }) {
    this.workerId = `worker-${Math.random().toString(36).substring(2, 9)}`
    this.pollIntervalMs = options?.pollIntervalMs || 5000
  }

  public register(jobType: string, handler: JobHandler) {
    this.handlers.set(jobType, handler)
    logger.info({ jobType }, 'Registered background job handler')
  }

  public start() {
    if (this.intervalId) {
      logger.warn('JobWorker is already running')
      return
    }
    logger.info({ workerId: this.workerId }, 'Starting JobWorker')
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs)
    // Run immediate check
    this.poll()
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      logger.info('Stopped JobWorker')
    }
  }

  private async poll() {
    if (this.isPolling) return
    this.isPolling = true

    try {
      // Claim the next available job via Postgres RPC
      const { data, error } = await db.rpc('claim_next_job', { worker_id: this.workerId })

      if (error) {
        logger.error({ error: error.message }, 'Error claiming next job')
        this.isPolling = false
        return
      }

      const job = data?.[0]
      if (!job) {
        // No pending jobs
        this.isPolling = false
        return
      }

      logger.info({ jobId: job.id, jobType: job.job_type }, 'Processing background job')
      const handler = this.handlers.get(job.job_type)

      if (!handler) {
        const errorMsg = `No handler registered for job type: ${job.job_type}`
        logger.error({ jobId: job.id, jobType: job.job_type }, errorMsg)
        await this.handleFailure(job.id, new Error(errorMsg), job.attempts, job.max_attempts)
      } else {
        try {
          await handler(job.payload, { id: job.id, tenantId: job.tenant_id })
          await this.handleSuccess(job.id)
        } catch (err: any) {
          logger.error({ jobId: job.id, error: err.message }, 'Background job failed')
          await this.handleFailure(job.id, err, job.attempts, job.max_attempts)
        }
      }

      // Immediately poll again for more jobs
      this.isPolling = false
      this.poll()
    } catch (err: any) {
      logger.error({ error: err.message }, 'Unexpected error in JobWorker poll loop')
      this.isPolling = false
    }
  }

  private async handleSuccess(jobId: string) {
    const { error } = await db
      .from('sys_background_jobs')
      .update({
        status: 'completed',
        error_message: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId)

    if (error) {
      logger.error({ jobId, error: error.message }, 'Failed to update job status to completed')
    } else {
      logger.info({ jobId }, 'Background job completed successfully')
    }
  }

  private async handleFailure(jobId: string, error: Error, attempts: number, maxAttempts: number) {
    const isFatal = attempts >= maxAttempts
    const nextStatus = isFatal ? 'failed' : 'pending'
    
    // Exponential backoff or simple delay: (attempts * 30 seconds)
    const delaySeconds = attempts * 30
    const scheduledAt = isFatal ? new Date() : new Date(Date.now() + delaySeconds * 1000)

    const { error: updateError } = await db
      .from('sys_background_jobs')
      .update({
        status: nextStatus,
        error_message: error.message || String(error),
        scheduled_at: scheduledAt.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId)

    if (updateError) {
      logger.error({ jobId, error: updateError.message }, 'Failed to update failed job status')
    } else {
      logger.warn(
        { jobId, attempts, maxAttempts, isFatal, retryInSeconds: isFatal ? 0 : delaySeconds },
        'Logged job failure'
      )
    }
  }
}
