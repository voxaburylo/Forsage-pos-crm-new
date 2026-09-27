import { createHash, randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import type { LanSession } from './localNetwork'
import { assertOrderItemAmounts, assertOrderTotal } from '../repositories/orderValidation'

export class LanUnavailableError extends Error {}
export type OrderSender = (channel: string, args: unknown[], session: LanSession) => Promise<any>
type Job = { operationId: string; payload: any; attempted: boolean; expectedVersion?: string; followsPrevious: boolean }
type Draft = { id: string; serverId?: string; baseVersion?: string; createOperationId?: string; createFingerprint?: string; view: any; jobs: Job[]; error?: string }
type State = { drafts: Draft[]; cache: Record<string, { value: any; at: string }> }
const PREFIX = 'lan-order-workspace:v1:'
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

/** Deliberately stores only order envelopes in app_meta, never warehouse rows or the cloud outbox. */
export class LanOrderQueue {
  private flights = new Map<string, Promise<void>>()
  constructor(private readonly db: LocalDatabase, private readonly send: OrderSender) {}

  private key(hub: string, session: LanSession): string {
    return PREFIX + createHash('sha256').update(JSON.stringify([hub, session.tenant_id, session.id])).digest('hex')
  }
  private load(key: string): State {
    const row = this.db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(key) as { value_json: string } | undefined
    if (!row) return { drafts: [], cache: {} }
    const state = JSON.parse(row.value_json) as State
    if (!Array.isArray(state.drafts) || !state.cache) throw new Error('Локальна черга замовлень пошкоджена. Дані не видалено.')
    return state
  }
  private persist(key: string, state: State): void {
    this.db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at')
      .run(key, JSON.stringify(state), new Date().toISOString())
  }
  hasPending(): boolean {
    return (this.db.prepare('SELECT value_json FROM app_meta WHERE key LIKE ?').all(PREFIX + '%') as Array<{ value_json: string }>)
      .some(row => (JSON.parse(row.value_json) as State).drafts.some(draft => draft.jobs.length > 0))
  }
  status(hub: string, session: LanSession) {
    const drafts = this.load(this.key(hub, session)).drafts.filter(d => d.jobs.length)
    return { pending: drafts.length, blocked: drafts.filter(d => d.error).length }
  }
  async settle(): Promise<void> { await Promise.allSettled([...this.flights.values()]) }
  assertNoPending(hub: string, session: LanSession, id?: string): void {
    if (this.load(this.key(hub, session)).drafts.some(d => d.jobs.length && (!id || d.id === id || d.serverId === id))) {
      throw new Error('Замовлення ще не підтверджене головним ПК. Оплата, видача, видалення та зміна статусу поки недоступні.')
    }
  }

  private present(draft: Draft): any {
    const view = clone(draft.view)
    if (draft.jobs.length) view.lan_sync = { state: draft.error ? 'blocked' : 'pending', message: draft.error || 'Правки збережено тут. Очікують підтвердження головного ПК; наявність і резерв ще не перевірено.', local_id: draft.id }
    return view
  }

  getSaveResult(hub: string, session: LanSession, operationId: string, orderId?: string): any {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(operationId)) throw new Error('Некоректний номер операції замовлення')
    const key = this.key(hub, session)
    const receipt = this.db.prepare('SELECT value_json FROM app_meta WHERE key = ?')
      .get(`lan-order-form-save:v1:${key}:${operationId}`) as { value_json: string } | undefined
    if (!receipt) return null
    const saved = JSON.parse(receipt.value_json)
    if ((saved.orderId ?? null) !== (orderId ?? null)) throw new Error('Операція належить іншому замовленню')
    const draft = this.load(key).drafts.find(d => d.id === saved.id)
    if (!draft) throw new Error('Збережені локальні правки були відкинуті. Повтор не створено.')
    return this.present(draft)
  }

  enqueue(hub: string, session: LanSession, input: any, orderId?: string): any {
    if (!['owner', 'admin', 'manager'].includes(session.role)) throw new Error('Офлайн-замовлення доступні лише менеджеру та власнику')
    if (!input || !Array.isArray(input.items)) throw new Error('Немає позицій замовлення')
    if (input.tenant_id && input.tenant_id !== session.tenant_id) throw new Error('Операція належить іншому магазину')
    if (Number(input.prepayment || 0) !== 0 || input.prepayment_method || input.prepayment_is_fiscal || input.exchange_source_order_id) {
      throw new Error('Оплата та обмін потребують зв’язку з головним ПК')
    }
    const key = this.key(hub, session)
    return this.db.transaction(() => {
      if (input.operation_id && !/^[a-zA-Z0-9-]{16,80}$/.test(String(input.operation_id))) throw new Error('Некоректний номер операції замовлення')
      const receiptKey = input.operation_id ? `lan-order-form-save:v1:${key}:${input.operation_id}` : null
      const saveFingerprint = createHash('sha256').update(JSON.stringify([orderId ?? null, input])).digest('hex')
      const receipt = receiptKey ? this.db.prepare('SELECT value_json FROM app_meta WHERE key = ?').get(receiptKey) as { value_json: string } | undefined : undefined
      if (receipt) {
        if (JSON.parse(receipt.value_json).fingerprint !== saveFingerprint) throw new Error('Повтор збереження містить інші дані. Попереднє замовлення збережено.')
        return this.getSaveResult(hub, session, input.operation_id, orderId)
      }
      const state = this.load(key)
      let draft = state.drafts.find(d => orderId ? d.id === orderId || d.serverId === orderId : !!input.operation_id && d.createOperationId === input.operation_id)
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      if (!orderId && draft) {
        if (draft.createFingerprint !== fingerprint) throw new Error('Повтор створення містить інші дані. Попереднє замовлення збережено.')
        return this.present(draft)
      }
      if (draft?.error) throw new Error('Спочатку перегляньте помилку передавання. Ваші попередні правки збережені: ' + draft.error)
      const base = draft?.jobs.length ? draft.view : state.cache['get:' + (draft?.serverId || orderId)]?.value ?? draft?.view ?? null
      if (orderId && !base) throw new Error('Спочатку відкрийте це замовлення з головного ПК. Локальної копії ще немає.')
      if (base && ['completed', 'canceled', 'archived'].includes(base.status)) throw new Error('Закрите замовлення не можна редагувати')
      if (orderId && (!input.expected_updated_at || input.expected_updated_at !== base.updated_at)) throw new Error('Замовлення вже змінено. Відкрийте актуальну картку перед редагуванням.')
      const items = input.items.map((item: any) => {
        assertOrderItemAmounts(item)
        if (!String(item.name ?? '').trim() || !Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0
          || !Number.isFinite(Number(item.sell_price)) || Number(item.sell_price) < 0
          || !Number.isFinite(Number(item.buy_price ?? 0)) || Number(item.buy_price ?? 0) < 0) throw new Error('Перевірте назву, кількість і ціни позицій')
        const status = item.item_status ?? 'pending'
        const previous = base?.items?.find((row: any) => row.id === item.id)
        if (status !== (previous?.item_status ?? 'pending')) throw new Error('Зміна статусу товару потребує зв’язку з головним ПК')
        if (['handed', 'returned'].includes(status)) throw new Error('Виданий або повернений товар не можна редагувати офлайн')
        return { ...item, id: item.id || randomUUID(), item_status: status }
      })
      const timestamp = new Date(Math.max(Date.now(), (Date.parse(base?.updated_at ?? '') || 0) + 1)).toISOString()
      const payload = clone({ ...input, items, tenant_id: session.tenant_id })
      delete payload.expected_updated_at
      delete payload.operation_id
      delete payload.manager_id
      delete payload.lan_sync
      for (const field of ['status', 'total_paid', 'discount_amount', 'sale_id', 'prepayment', 'prepayment_method', 'prepayment_is_fiscal']) delete payload[field]
      if (!draft) {
        draft = { id: orderId || 'lan-' + randomUUID(), serverId: orderId, baseVersion: base?.updated_at,
          createOperationId: !orderId ? input.operation_id || randomUUID() : undefined, createFingerprint: !orderId ? fingerprint : undefined, view: base, jobs: [] }
        state.drafts.push(draft)
      }
      if (!draft.jobs.length) draft.baseVersion = base?.updated_at
      if (state.drafts.filter(d => d.jobs.length > 0).length >= 500 && !draft.jobs.length) throw new Error('Передайте збережені замовлення на головний ПК перед створенням нових')
      if (draft.jobs.length >= 500) throw new Error('У цього замовлення забагато непереданих правок. Передайте їх на головний ПК; попередні правки збережено.')
      const totalAmount = items.reduce((sum: number, item: any) => sum + (item.item_status === 'canceled' ? 0
        : Math.round(Number(item.sell_price) * Number(item.qty)) + Math.round(Number(item.core_deposit_amount ?? 0) * Number(item.qty))), 0)
      assertOrderTotal(totalAmount)
      draft.jobs.push({ operationId: randomUUID(), payload, attempted: false,
        expectedVersion: draft.baseVersion, followsPrevious: draft.jobs.length > 0 })
      draft.view = { ...(base || {}), ...payload, id: draft.id, manager_id: session.id,
        order_number: base?.order_number ?? null, status: base?.status ?? 'lead',
        created_at: base?.created_at ?? timestamp, updated_at: timestamp,
        customer: base?.customer ?? null, prepayment: base?.prepayment ?? 0,
        total_paid: base?.total_paid ?? 0, discount_amount: base?.discount_amount ?? 0,
        total_amount: totalAmount,
        items: items.map((item: any) => ({ ...item, order_id: draft!.id })) }
      delete draft.view.lan_sync
      this.persist(key, state)
      if (receiptKey) this.db.prepare('INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)')
        .run(receiptKey, JSON.stringify({ id: draft.id, orderId, fingerprint: saveFingerprint }), timestamp)
      return this.present(draft)
    })
  }

  async save(hub: string, session: LanSession, input: any, orderId?: string): Promise<any> {
    const queued = this.enqueue(hub, session, input, orderId)
    await this.flush(hub, session)
    const draft = this.load(this.key(hub, session)).drafts.find(d => d.id === queued.id || d.serverId === queued.id)
    return draft ? this.present(draft) : queued
  }

  async flush(hub: string, session: LanSession): Promise<void> {
    const key = this.key(hub, session)
    if (this.flights.has(key)) return this.flights.get(key)!
    const work = this.drain(key, session).finally(() => { this.flights.delete(key) })
    this.flights.set(key, work)
    return work
  }
  private async drain(key: string, session: LanSession): Promise<void> {
    // A bounded pass cannot monopolise the app if the manager keeps adding work.
    for (let sent = 0; sent < 50; sent++) {
      const state = this.load(key)
      const draft = state.drafts.find(d => d.jobs.length > 0 && !d.error)
      if (!draft) return
      const job = draft.jobs[0]
      job.attempted = true
      this.persist(key, state) // durable BEFORE the network request
      try {
        const result = await this.send('desktop:orders:accept-offline', [{
          operation_id: job.operationId, input: job.payload,
          order_id: draft.serverId, expected_updated_at: job.expectedVersion,
        }], session)
        if (!result?.id || !result.updated_at) throw new LanUnavailableError('Не отримано підтвердження збереження замовлення')
        const latest = this.load(key)
        const current = latest.drafts.find(d => d.id === draft.id)!
        if (current.jobs[0]?.operationId !== job.operationId) throw new Error('Черга замовлення змінилася під час передавання')
        current.jobs.shift()
        current.serverId = result.id
        current.baseVersion = result.updated_at
        if (current.jobs[0]?.followsPrevious) current.jobs[0].expectedVersion = result.updated_at
        if (!current.jobs.length) current.view = result
        latest.cache['get:' + result.id] = { value: result, at: new Date().toISOString() }
        this.persist(key, latest)
      } catch (error) {
        if (error instanceof LanUnavailableError) return
        const latest = this.load(key)
        const current = latest.drafts.find(d => d.id === draft.id)!
        current.error = error instanceof Error ? error.message : 'Передавання не виконано'
        this.persist(key, latest)
      }
    }
  }

  /** Never discard an ambiguous write: discard is only for a confirmed rejection or a never-sent draft. */
  discard(hub: string, session: LanSession, id: string): { success: true } {
    const key = this.key(hub, session), state = this.load(key)
    const draft = state.drafts.find(d => d.id === id)
    if (!draft?.jobs.length || this.flights.has(key) || (!draft.error && draft.jobs.some(job => job.attempted))) {
      throw new Error('Спочатку дочекайтеся підтвердження головного ПК. Результат передавання ще невідомий.')
    }
    state.drafts = state.drafts.filter(d => d !== draft)
    this.persist(key, state)
    return { success: true }
  }
  async retry(hub: string, session: LanSession, id: string): Promise<void> {
    const key = this.key(hub, session), state = this.load(key)
    if (this.flights.has(key)) throw new Error('Передавання вже виконується')
    const draft = state.drafts.find(d => d.id === id)
    if (!draft?.jobs.length) throw new Error('Немає локальних правок для передавання')
    delete draft.error
    this.persist(key, state)
    await this.flush(hub, session) // the SAME immutable operation and expected version, never force-overwrite
  }

  private cache(key: string, entry: string, value: any): void {
    const state = this.load(key)
    state.cache[entry] = { value, at: new Date().toISOString() }
    const keys = Object.keys(state.cache).sort((a, b) => state.cache[b].at.localeCompare(state.cache[a].at))
    for (const old of keys.slice(200)) delete state.cache[old]
    this.persist(key, state)
  }

  async get(hub: string, session: LanSession, id: string): Promise<any> {
    const key = this.key(hub, session)
    const state = this.load(key), draft = state.drafts.find(d => d.id === id || d.serverId === id)
    if (draft?.jobs.length) return this.present(draft)
    const serverId = draft?.serverId || id
    try {
      const result = await this.send('desktop:orders:get', [serverId], session)
      this.cache(key, 'get:' + serverId, result)
      return result
    } catch (error) {
      if (!(error instanceof LanUnavailableError)) throw error
      const cached = state.cache['get:' + serverId]
      if (!cached?.value) throw new Error('Немає зв’язку з головним ПК і збереженої копії цього замовлення')
      return { ...cached.value, lan_sync: { state: 'cached', message: 'Збережена копія. Оплата, видача та зміна статусу потребують зв’язку з головним ПК.', cached_at: cached.at } }
    }
  }

  async list(hub: string, session: LanSession, input: any = {}): Promise<any[]> {
    const key = this.key(hub, session)
    const state = this.load(key)
    const pending = state.drafts.filter(d => d.jobs.length).map(d => this.present(d))
    const q = String(input.search ?? '').trim().toLocaleLowerCase('uk-UA')
    const statuses = String(input.status ?? '').split(',').filter(Boolean)
    const matches = (row: any) => (!input.customer_id || row.customer_id === input.customer_id)
      && (!statuses.length || statuses.includes(row.status))
      && (!q || [row.order_number, row.comment, row.customer?.phone, row.customer?.full_name, ...(row.items ?? []).flatMap((item: any) => [item.name, item.sku])].join(' ').toLocaleLowerCase('uk-UA').includes(q))
    const local = pending.filter(matches)
    const offset = Math.max(0, Math.trunc(Number(input.offset) || 0)), limit = Math.min(500, Math.max(1, Math.trunc(Number(input.limit) || 200)))
    const pageLocal = local.slice(offset, offset + limit)
    const remoteInput = { ...input, offset: Math.max(0, offset - local.length), limit: limit - pageLocal.length,
      exclude_ids: state.drafts.filter(d => d.jobs.length && d.serverId).map(d => d.serverId) }
    if (!remoteInput.limit) return pageLocal
    const entry = 'list:' + JSON.stringify(remoteInput)
    let rows: any[] = [], stale = false
    try {
      rows = await this.send('desktop:orders:list', [remoteInput], session)
      const updated = this.load(key), at = new Date().toISOString()
      updated.cache[entry] = { value: rows, at }
      // Lists contain full order items, so these can be opened while the hub is down.
      for (const row of rows) updated.cache['get:' + row.id] = { value: row, at }
      const keys = Object.keys(updated.cache).sort((a, b) => updated.cache[b].at.localeCompare(updated.cache[a].at))
      for (const old of keys.slice(500)) delete updated.cache[old]
      this.persist(key, updated)
    } catch (error) {
      if (!(error instanceof LanUnavailableError)) throw error
      rows = this.load(key).cache[entry]?.value ?? []
      stale = true
    }
    return [...pageLocal, ...rows.map(row => stale ? { ...row, lan_sync: { state: 'cached', message: 'Збережена копія. Головний ПК недоступний.' } } : row)]
  }
}
