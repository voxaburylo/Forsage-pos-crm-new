import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { canApplyAiWrite, assertAiWriteAllowed, aiWriteBlockReason } from './aiWritePolicy'
import { replyParts } from './ReplyText'
describe('AI write boundary', () => {
  it.each(['owner','admin','manager','cashier','storekeeper'])('preserves confirmed local documents for %s', role => {
    for (const tool of ['create_order','create_supply_invoice_bulk']) expect(canApplyAiWrite(tool,role,true)).toBe(true)
  })
  it.each(['sto_viewer','tire_worker','superadmin','',null,undefined,{}])('rejects unprivileged or unknown role %s', role => {
    expect(() => assertAiWriteAllowed('create_order',role,true)).toThrow('Дані не змінено')
  })
  it.each(['delete_products','create_products_bulk','create_customer','run_sql','__proto__'])('does not authorize injected action %s even for owner', tool => {
    expect(canApplyAiWrite(tool,'owner',true)).toBe(false)
  })
  it('lets only owner/admin write chat catalog edits, and only in the till', () => {
    for (const role of ['owner','admin']) expect(canApplyAiWrite('update_products_bulk',role,true)).toBe(true)
    for (const role of ['owner','admin']) expect(canApplyAiWrite('merge_products_bulk',role,true)).toBe(true)
    expect(canApplyAiWrite('merge_products_bulk','manager',true)).toBe(false)
    expect(canApplyAiWrite('merge_products_bulk','owner',false)).toBe(false)
    expect(canApplyAiWrite('add_cross_numbers_bulk','owner',true)).toBe(true)
    expect(canApplyAiWrite('add_cross_numbers_bulk','cashier',true)).toBe(false)
    for (const role of ['manager','cashier','storekeeper',null]) expect(canApplyAiWrite('update_products_bulk',role,true)).toBe(false)
    expect(canApplyAiWrite('update_products_bulk','owner',false)).toBe(false)
  })
  it('never permits cloud writes through local assistant policy', () => {
    expect(canApplyAiWrite('create_order','owner',false)).toBe(false)
    expect(canApplyAiWrite('create_supply_invoice_bulk','cashier',false)).toBe(false)
  })

  // 24.11.2026 (фото власника): 194 зміни без кнопок і фраза «Ця дія недоступна для запису» — незрозуміло, що робити.
  it('says why a proposal cannot be applied and what to do, instead of a vague refusal', () => {
    expect(aiWriteBlockReason('update_products_bulk', 'owner', true)).toBeNull()
    expect(aiWriteBlockReason('update_products_bulk', 'owner', false)).toContain('Немає звʼязку з головним ПК')
    expect(aiWriteBlockReason('update_products_bulk', 'owner', false)).toContain('зʼявиться тут сама')
    expect(aiWriteBlockReason('update_products_bulk', 'manager', true)).toContain('лише власник або адміністратор')
    expect(aiWriteBlockReason('run_sql', 'owner', true)).toContain('лише показує')
    const page = readFileSync(new URL('./AiAssistantPage.tsx', import.meta.url), 'utf8')
    expect(page).not.toContain('Ця дія недоступна для запису')
    expect(page).toContain('const toMainPc = useWritesToMainPc()')
    expect(page).toContain('Переглянути всі рядки')
  })
  it('shows the reply without asterisks: bold and headings are drawn, everything else stays text', () => {
    expect(replyParts('**Нові категорії**, які створить каса:\n- «Зварювання»')).toEqual([{ text: 'Нові категорії', bold: true }, { text: ', які створить каса:\n- «Зварювання»', bold: false }])
    expect(replyParts('## Що залишилось\n13 сторінок')).toEqual([{ text: 'Що залишилось', bold: true }, { text: '\n13 сторінок', bold: false }])
    expect(replyParts('2 * 3 = 6, <b>не тег</b>')).toEqual([{ text: '2 * 3 = 6, <b>не тег</b>', bold: false }])
  })
})
