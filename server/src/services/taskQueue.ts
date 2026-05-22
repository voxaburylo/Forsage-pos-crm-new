import { db } from '../db/supabase.js'

// Пріоритети задач: 10 = критично, 5 = норма, 1 = фонове
export const JOB_PRIORITY = {
  CRITICAL: 10,
  HIGH:      8,
  NORMAL:    5,
  LOW:       3,
  BACKGROUND: 1,
} as const

export class TaskQueue {
  static async enqueue(
    jobType: string,
    payload: Record<string, any>,
    options?: { scheduledAt?: Date; maxAttempts?: number; tenantId?: string; priority?: number }
  ) {
    const scheduledAt = options?.scheduledAt || new Date()
    const maxAttempts = options?.maxAttempts || 3
    const tenantId    = options?.tenantId    || '00000000-0000-0000-0000-000000000001'
    const priority    = options?.priority    ?? JOB_PRIORITY.NORMAL

    const { data, error } = await db
      .from('sys_background_jobs')
      .insert({
        job_type: jobType,
        payload,
        status: 'pending',
        attempts: 0,
        max_attempts: maxAttempts,
        scheduled_at: scheduledAt.toISOString(),
        tenant_id: tenantId,
        priority,
      })
      .select()

    if (error) {
      throw new Error(`Failed to enqueue job: ${error.message}`)
    }

    return data?.[0]
  }
}
