import { createHash } from 'node:crypto'
import type { LanSession, LocalNetworkCoordinator } from './localNetwork'
import { LanOrderQueue } from './orderQueue'

/** Only order data gets a durable offline path; there is no generic fallback to local repositories. */
export class LanOrderClient {
  constructor(private readonly network: LocalNetworkCoordinator, private readonly queue: LanOrderQueue) {}
  scope(): string {
    const config = this.network.getStatus()
    return createHash('sha256').update(JSON.stringify([config.hubAddress, config.accessKey])).digest('hex')
  }
  async invoke(channel: string, args: any[], session: LanSession): Promise<unknown> {
    const hub = this.scope()
    if (channel === 'desktop:orders:get-save-result') {
      return this.queue.getSaveResult(hub, session, args[0], args[1]) ?? this.network.invoke(channel, args, session)
    }
    if (channel === 'desktop:orders:save') {
      const body = args[0]
      // Preserve online-only workflows and roles; never enqueue money or exchanges.
      if (!['owner', 'admin', 'manager'].includes(session.role) || body?.exchange_source_order_id
        || Number(body?.prepayment || 0) !== 0 || body?.prepayment_method || body?.prepayment_is_fiscal) {
        this.queue.assertNoPending(hub, session, args[1] || body?.exchange_source_order_id)
        return this.network.invoke(channel, args, session)
      }
      return this.queue.save(hub, session, body, args[1])
    }
    if (channel === 'desktop:orders:list') return this.queue.list(hub, session, args[0])
    if (channel === 'desktop:orders:get') return this.queue.get(hub, session, args[0])
    if (channel.startsWith('desktop:orders:') && !['desktop:orders:count', 'desktop:orders:list-ready', 'desktop:orders:pending-items', 'desktop:orders:list-payments', 'desktop:orders:list-payments-period'].includes(channel)) {
      this.queue.assertNoPending(hub, session, typeof args[0] === 'string' ? args[0] : undefined)
    }
    return this.network.invoke(channel, args, session)
  }
  async flush(session: LanSession): Promise<void> {
    const hub = this.scope()
    if (this.queue.status(hub, session).pending) {
      await this.queue.flush(hub, session)
    } else {
      // Refresh cached order screens after reconnect even when there was nothing to send.
      try { await this.network.testConnection() } catch { /* status retains the connection error */ }
    }
  }
  status(session: LanSession) {
    const network = this.network.getStatus()
    return { client: network.mode === 'client', connected: network.connected,
      ...(network.mode === 'client' ? this.queue.status(this.scope(), session) : { pending: 0, blocked: 0 }),
      lastError: network.lastError }
  }
  discard(session: LanSession, id: string) { return this.queue.discard(this.scope(), session, id) }
  retry(session: LanSession, id: string) { return this.queue.retry(this.scope(), session, id) }
}
