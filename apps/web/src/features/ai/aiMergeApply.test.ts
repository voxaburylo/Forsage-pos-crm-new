import { describe, expect, it, vi } from 'vitest'
import { applyChatMerges } from './aiMergeApply'

const preview = (target: string, source: string, extra: Record<string, unknown> = {}) => ({
  fingerprint: 'fp-' + source, target_id: target, source_ids: [source],
  products: [{ id: target, name: 'Основна ' + target }, { id: source, name: 'Дубль ' + source }],
  history_counts: {}, blockers: [], warnings: [], quantity_before: [1, 1], quantity_after: 2, barcodes: [], photos: [],
  can_apply: true, stock_review: 'pending', ...extra,
}) as any

describe('chat merges on the till', () => {
  it('merges each pair through the fresh cleanup check and skips refused ones with a reason', async () => {
    const bridge = {
      cleanupPreview: vi.fn(async (input: any) => input.source_ids[0] === 'bad'
        ? preview(input.target_id, 'bad', { can_apply: false, blockers: ['Різні одиниці виміру'] })
        : preview(input.target_id, input.source_ids[0])),
      cleanupApply: vi.fn(async () => ({ quantity_after: 2, backupPath: 'b.db' })),
    }
    const result = await applyChatMerges([
      { primary_product_id: 'EL 101514', duplicate_product_id: 'dup1', reason: 'Той самий замок, номер з пробілом' },
      { primary_product_id: 'x', duplicate_product_id: 'bad' },
      { primary_product_id: 'dup1', duplicate_product_id: 'y' },
      { primary_product_id: 'same', duplicate_product_id: 'same' },
    ], bridge, async index => 'op-' + index)
    expect(result.merged).toBe(1)
    expect(bridge.cleanupApply).toHaveBeenCalledTimes(1)
    expect(bridge.cleanupApply.mock.calls[0][0]).toMatchObject({
      target_id: 'EL 101514', source_ids: ['dup1'], preview_fingerprint: 'fp-dup1', stock_review: 'pending', operation_id: 'op-0',
      reason: 'Той самий замок, номер з пробілом (підтверджено власником у чаті)',
    })
    expect(result.skipped.map(row => row.error)).toEqual(['Різні одиниці виміру', 'Картку вже об’єднано в цьому ж пакеті', 'Некоректна пара карток'])
    expect(result.backupPath).toBe('b.db')
  })
})
