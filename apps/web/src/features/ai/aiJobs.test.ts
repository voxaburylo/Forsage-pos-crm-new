import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/api', () => ({ api: {} }))
import { applyProductChunk, type AiJobItem } from './aiJobs'
import { dedupeChatEntries, localSavedAt } from './aiSharedChat'

// 26.11.2026, слово власника: «по 200 за раз дуже довго; товарів мільйони; хай працює на сервері у фоні;
// на будь-якому пристрої однаковий чат».
const item = (key: string, name: string, over: Partial<AiJobItem> = {}): AiJobItem => ({ item_key: key, seq: 1, old_name: 'old ' + key, sku: null, new_name: name, new_sku: null, state: 'proposed', note: null, ...over })

describe('applying a background job to our goods goes through the main PC', () => {
  it('same protected path as chat proposals: fingerprints, then one apply per chunk; reports what was written and what the PC refused', async () => {
    const bridge = {
      agentFingerprints: vi.fn(async (ids: string[]) => ids.filter(id => id !== 'gone').map(id => ({ product_id: id, fingerprint: 'fp-' + id, name: id === 'same' ? 'Та сама назва' : 'old ' + id }))),
      agentApply: vi.fn(async (input: { items: Array<{ product_id: string; cleanup?: true }> }) => ({ updated: input.items.length - 1, skipped: [{ product_id: 'p2', name: 'old p2', error: 'Картку змінили після пропозиції' }] })),
    }
    const out = await applyProductChunk({ id: 'job-1', task: 'cleanup' }, [item('p1', 'Нова 1'), item('p2', 'Нова 2'), item('gone', 'Нова'), item('same', 'Та сама назва')], bridge)
    expect(bridge.agentApply).toHaveBeenCalledTimes(1)
    const sent = bridge.agentApply.mock.calls[0][0] as { operation_id: string; items: Array<{ product_id: string; cleanup?: true; changes: { name?: string } }> }
    expect(sent.items.map(row => [row.product_id, row.changes.name, row.cleanup])).toEqual([['p1', 'Нова 1', true], ['p2', 'Нова 2', true]])
    expect(sent.operation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    expect(out.applied.sort()).toEqual(['p1', 'same'])
    expect(out.failed).toEqual([{ key: 'gone', error: 'Товар не знайдено в базі каси (видалено?)' }, { key: 'p2', error: 'Картку змінили після пропозиції' }])
  })

  it('translation is never sent as «cleanup» (the till keeps every digit)', async () => {
    const bridge = { agentFingerprints: vi.fn(async () => [{ product_id: 'p1', fingerprint: 'fp', name: 'Масло' }]), agentApply: vi.fn(async () => ({ updated: 1 })) }
    await applyProductChunk({ id: 'job-2', task: 'translate' }, [item('p1', 'Олива')], bridge)
    expect((bridge.agentApply.mock.calls[0] as unknown as [{ items: Array<{ cleanup?: true }> }])[0].items[0].cleanup).toBeUndefined()
  })
})

describe('shared chat on every device', () => {
  it('one reply once: the copy from the server and from the screen with the same request number is not duplicated', () => {
    const entries = [{ role: 'user', text: 'a', rid: 'r1' }, { role: 'model', text: 'b', rid: 'r1' }, { role: 'model', text: 'b', rid: 'r1' }, { role: 'model', text: 'старе без номера' }, { role: 'model', text: 'старе без номера' }]
    expect(dedupeChatEntries(entries)).toHaveLength(4)
  })

  it('reads the local save time; a broken record counts as old', () => {
    expect(localSavedAt('k', { getItem: () => JSON.stringify({ savedAt: 123 }) })).toBe(123)
    expect(localSavedAt('k', { getItem: () => '{bad' })).toBe(0)
  })

  it('wiring: the opened chat is not pushed over a newer one; on the till only the owner shares; the panel sits above the chat', () => {
    const hook = readFileSync(new URL('./aiSharedChat.ts', import.meta.url), 'utf8')
    expect(hook).toContain('if (first.current) { first.current = false; return }')
    expect(hook).toContain('if (adopted.current) { adopted.current = false; return }')
    const page = readFileSync(new URL('./AiAssistantPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain("enabled: !isDesktopRuntime() || role === 'owner'")
    expect(page).toContain('{!invoiceOnly && canConfigure && <AiJobsPanel />}')
    expect(page).toContain("chat_kind: invoiceOnly ? 'invoice' as const : 'assistant' as const")
    expect(page).not.toContain("navigate('/ai-agent')")
  })
})

describe('supplier goods changed from the chat', () => {
  it('owner/admin can apply without the main PC (the data lives only in the cloud); others cannot; the server applies it', async () => {
    const { canApplyAiWrite, aiWriteBlockReason } = await import('./aiWritePolicy')
    expect(canApplyAiWrite('update_supplier_offers_bulk', 'owner', false)).toBe(true)
    expect(canApplyAiWrite('update_supplier_offers_bulk', 'admin', false)).toBe(true)
    expect(canApplyAiWrite('update_supplier_offers_bulk', 'cashier', true)).toBe(false)
    expect(aiWriteBlockReason('update_supplier_offers_bulk', 'manager', true)).toContain('лише власник або адміністратор')
    const api = readFileSync(new URL('./aiApi.ts', import.meta.url), 'utf8')
    expect(api).toContain("body.tool === 'update_supplier_offers_bulk' ? api.post<{ data: AiApplyResult }>('/api/v1/ai/supplier-offers/apply'")
  })
})
