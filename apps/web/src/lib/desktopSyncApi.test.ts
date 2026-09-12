import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopSyncOutboxOperation } from './desktopBridge'
import { DESKTOP_PUSH_MAX_BYTES } from './desktopSyncBatch'

const mocks = vi.hoisted(() => ({
  post: vi.fn(), listPending: vi.fn(), getPullState: vi.fn(),
  applyPushResults: vi.fn(), markBatchFailed: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ api: { post: mocks.post } }))
vi.mock('@/lib/desktopBridge', () => ({ isDesktopRuntime: () => true,
  desktopBridge: () => ({ sync: mocks }),
}))
import { pushDesktopOutbox } from './desktopSyncApi'

const operation = (sequence: number, size = 1): DesktopSyncOutboxOperation => ({
  sequence, operation_id: `op-${sequence}`, tenant_id: 'tenant', device_id: 'device',
  aggregate_type: 'sale', aggregate_id: `sale-${sequence}`, operation_type: 'sale.completed',
  payload: { text: 'x'.repeat(size) }, created_at: '2026-01-01T00:00:00Z', attempts: 0, last_error: null,
})
const ack = (sequence: number) => ({ sequence, operation_id: `op-${sequence}`, status: 'synced' })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getPullState.mockResolvedValue({ reset_generation: 12 })
  mocks.post.mockResolvedValue({ data: { results: [ack(1)] } })
})
describe('desktop outbox upload execution', () => {
  it('sends only a bounded prefix and leaves the rest pending', async () => {
    const rows = [operation(1, 2_000_000), operation(2, 2_000_000), operation(3)]
    mocks.listPending.mockResolvedValue(rows)
    expect(await pushDesktopOutbox()).toEqual({ pushed: 1, failed: 0, pending: 2, resetRequired: false })
    expect(mocks.post.mock.calls[0][1].operations).toEqual([rows[0]])
    expect(mocks.applyPushResults).toHaveBeenCalledWith([ack(1)])
  })
  it('network failure marks only documents actually sent', async () => {
    mocks.listPending.mockResolvedValue([operation(1, 2_000_000), operation(2, 2_000_000)])
    mocks.post.mockRejectedValue(new Error('offline'))
    await expect(pushDesktopOutbox()).rejects.toThrow('offline')
    expect(mocks.markBatchFailed).toHaveBeenCalledWith([1], 'offline')
    expect(mocks.applyPushResults).not.toHaveBeenCalled()
  })
  it('oversized document stays local, other documents are not failed with it', async () => {
    mocks.listPending.mockResolvedValue([operation(1, DESKTOP_PUSH_MAX_BYTES), operation(2)])
    expect(await pushDesktopOutbox()).toEqual({ pushed: 0, failed: 1, pending: 1, resetRequired: false })
    expect(mocks.markBatchFailed).toHaveBeenCalledWith([1], expect.stringContaining('Локальні дані збережено'))
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('does not apply an acknowledgement for a document outside the request', async () => {
    mocks.listPending.mockResolvedValue([operation(1)])
    mocks.post.mockResolvedValue({ data: { results: [ack(2)] } })
    await expect(pushDesktopOutbox()).rejects.toThrow('Некоректне підтвердження')
    expect(mocks.applyPushResults).not.toHaveBeenCalled()
    expect(mocks.markBatchFailed).toHaveBeenCalledWith([1], expect.any(String))
  })
  it('partial response retries only unconfirmed operations', async () => {
    mocks.listPending.mockResolvedValue([operation(1), operation(2)])
    expect(await pushDesktopOutbox()).toEqual({ pushed: 1, failed: 1, pending: 0, resetRequired: false })
    expect(mocks.applyPushResults).toHaveBeenCalledWith([ack(1), expect.objectContaining({ sequence: 2, status: 'failed' })])
  })
  it('concurrent callers share one request; a subsequent call can proceed', async () => {
    mocks.listPending.mockResolvedValue([operation(1)])
    const first = pushDesktopOutbox()
    expect(pushDesktopOutbox()).toBe(first)
    await first
    await pushDesktopOutbox()
    expect(mocks.post).toHaveBeenCalledTimes(2)
  })
})
