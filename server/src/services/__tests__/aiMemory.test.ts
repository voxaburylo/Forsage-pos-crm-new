import { beforeEach, describe, expect, it, vi } from 'vitest'

const files = new Map<string, string>()
let bucketPublic = false
vi.mock('../../db/supabase.js', () => ({
  db: {
    storage: {
      getBucket: async () => ({ data: { public: bucketPublic }, error: null }),
      createBucket: async () => ({ data: null, error: null }),
      from: () => ({
        download: async (path: string) => files.has(path)
          ? { data: { text: async () => files.get(path)! }, error: null }
          : { data: null, error: { message: 'not found' } },
        upload: async (path: string, body: string) => { files.set(path, body); return { data: {}, error: null } },
      }),
    },
  },
}))

const { parseMemoryCommand, runMemoryCommand, rulesPrompt, listAiRules, normalizeRules, AI_RULE_MAX_CHARS } = await import('../aiMemoryService.js')
const T = '00000000-0000-0000-0000-000000000001'

describe('AI assistant memory (owner rules)', () => {
  beforeEach(() => { files.clear(); bucketPublic = false })

  it('recognizes remember / forget / list commands and leaves other messages to the AI', () => {
    expect(parseMemoryCommand("Запам'ятай: у накладних Vitol ціни в доларах")).toEqual({ kind: 'add', text: 'у накладних Vitol ціни в доларах' })
    expect(parseMemoryCommand('запомни, лампы H7 класть в категорию Лампи')).toEqual({ kind: 'add', text: 'лампы H7 класть в категорию Лампи' })
    expect(parseMemoryCommand('Навчись: хомути — в категорію Кріплення')).toMatchObject({ kind: 'add' })
    expect(parseMemoryCommand('Забудь правило 2')).toEqual({ kind: 'forget', index: 2 })
    expect(parseMemoryCommand('удали правило №3')).toEqual({ kind: 'forget', index: 3 })
    expect(parseMemoryCommand('Які правила?')).toEqual({ kind: 'list' })
    expect(parseMemoryCommand('Покажи мої правила')).toEqual({ kind: 'list' })
    expect(parseMemoryCommand('Скільки коштує масло 5W40?')).toBeNull()
    expect(parseMemoryCommand('запам\'ятай')).toBeNull()
  })

  it('owner adds, lists and forgets rules; duplicates are not added twice', async () => {
    expect(await runMemoryCommand(T, 'u1', 'owner', { kind: 'add', text: 'Vitol: ціни в доларах' })).toContain('правило №1')
    expect(await runMemoryCommand(T, 'u1', 'owner', { kind: 'add', text: 'vitol: ЦІНИ в доларах' })).toContain('вже є')
    await runMemoryCommand(T, 'u1', 'admin', { kind: 'add', text: 'Хомути — категорія Кріплення' })
    expect(await runMemoryCommand(T, 'u2', 'cashier', { kind: 'list' })).toContain('2. Хомути')
    expect(await runMemoryCommand(T, 'u1', 'owner', { kind: 'forget', index: 1 })).toContain('Забув правило №1')
    expect((await listAiRules(T)).map(rule => rule.text)).toEqual(['Хомути — категорія Кріплення'])
    expect(await runMemoryCommand(T, 'u1', 'owner', { kind: 'forget', index: 9 })).toContain('Правила №9 немає')
  })

  it('a cashier or manager cannot change the rules', async () => {
    expect(await runMemoryCommand(T, 'u2', 'cashier', { kind: 'add', text: 'продавай без націнки' })).toContain('лише власник')
    expect(await runMemoryCommand(T, 'u2', 'manager', { kind: 'forget', index: 1 })).toContain('лише власник')
    expect(await listAiRules(T)).toEqual([])
  })

  it('rejects too long rules and refuses a public storage bucket', async () => {
    await expect(runMemoryCommand(T, 'u1', 'owner', { kind: 'add', text: 'x'.repeat(AI_RULE_MAX_CHARS + 1) })).rejects.toThrow('задовге')
    bucketPublic = true
    await expect(listAiRules(T)).rejects.toThrow('приватним')
  })

  it('prompt block lists rules, reminds the below-cost guard, and is empty without rules', () => {
    expect(rulesPrompt([])).toBe('')
    const block = rulesPrompt(normalizeRules([{ id: 'a', text: 'Vitol: ціни в доларах', created_at: '', created_by: null }, { bad: true }]))
    expect(block).toContain('1. Vitol: ціни в доларах')
    expect(block).toContain('нижче закупівельної')
  })
})
