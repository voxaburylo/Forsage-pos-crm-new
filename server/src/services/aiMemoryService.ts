import { randomUUID } from 'node:crypto'
import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'

/**
 * Пам'ять помічника ШІ: правила власника («запам'ятай: …»), 20.11.2026.
 *
 * Зберігаються JSON-файлом у приватному сховищі файлів Supabase (по файлу на магазин), тому окрема
 * міграція бази не потрібна. Правила додаються до інструкції чату й розбору накладних. Правило може
 * стосуватися постачальника («Vitol: ціни в доларах») — так задається профіль постачальника.
 * Додавати й видаляти правила можуть лише власник і адміністратор.
 */
export const AI_MEMORY_BUCKET = 'forsage-ai-memory'
export const AI_RULES_MAX = 100
export const AI_RULE_MAX_CHARS = 500
const PROMPT_MAX_CHARS = 12_000

export interface AiRule { id: string; text: string; created_at: string; created_by: string | null }

export type MemoryCommand =
  | { kind: 'add'; text: string }
  | { kind: 'forget'; index: number }
  | { kind: 'list' }

/** Розпізнає команди пам'яті на початку повідомлення. Решта повідомлень іде до ШІ як звичайно. */
export function parseMemoryCommand(message: string): MemoryCommand | null {
  const text = message.trim()
  const add = /^(?:запам['’ʼ`]?ятай|запамятай|запомни|навчись|научись|запиши правило|нове правило|новое правило)\s*[:,.\-—–]?\s*([\s\S]+)$/i.exec(text)
  if (add) {
    const body = add[1].trim()
    return body ? { kind: 'add', text: body } : null
  }
  const forget = /^(?:забудь|видали|удали|прибери|убери)\s+правило\s*(?:№|#|номер)?\s*(\d{1,3})\s*[.!]?$/i.exec(text)
  if (forget) return { kind: 'forget', index: Number(forget[1]) }
  if (/^(?:які|какие|покажи|покажи мені|покажи мне|список)\s+(?:в тебе |у тебя |твої |твои |мої |мои )?(?:правила|запам['’ʼ`]?ятані правила)\s*[?.!]?$/i.test(text)) return { kind: 'list' }
  return null
}

function rulesPath(tenantId: string) { return tenantId + '/rules.json' }

async function ensureBucket() {
  let result = await db.storage.getBucket(AI_MEMORY_BUCKET)
  if (result.error) {
    await db.storage.createBucket(AI_MEMORY_BUCKET, { public: false, fileSizeLimit: 512 * 1024, allowedMimeTypes: ['application/json'] })
    result = await db.storage.getBucket(AI_MEMORY_BUCKET)
  }
  if (result.error || !result.data) throw new AppError('AI_MEMORY_UNAVAILABLE', 'Сховище правил помічника недоступне. Спробуйте пізніше.', 503)
  if (result.data.public) throw new AppError('AI_MEMORY_PUBLIC', 'Правила не збережено: сховище має бути приватним.', 503)
}

export function normalizeRules(value: unknown): AiRule[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is AiRule => !!row && typeof row === 'object'
    && typeof (row as any).id === 'string' && typeof (row as any).text === 'string' && (row as any).text.trim().length > 0)
    .slice(0, AI_RULES_MAX)
    .map(row => ({ id: row.id, text: row.text.slice(0, AI_RULE_MAX_CHARS), created_at: String(row.created_at ?? ''), created_by: row.created_by ?? null }))
}

export async function listAiRules(tenantId: string): Promise<AiRule[]> {
  await ensureBucket()
  const { data, error } = await db.storage.from(AI_MEMORY_BUCKET).download(rulesPath(tenantId))
  if (error || !data) return []
  try { return normalizeRules(JSON.parse(await data.text())) } catch { return [] }
}

async function saveRules(tenantId: string, rules: AiRule[]) {
  const { error } = await db.storage.from(AI_MEMORY_BUCKET)
    .upload(rulesPath(tenantId), JSON.stringify(rules), { contentType: 'application/json', upsert: true })
  if (error) throw new AppError('AI_MEMORY_SAVE', 'Не вдалося зберегти правило. Спробуйте ще раз.', 503)
}

export async function addAiRule(tenantId: string, userId: string | null, text: string): Promise<{ rules: AiRule[]; added: boolean }> {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length < 3) throw new AppError('VALIDATION_ERROR', 'Правило занадто коротке.', 422)
  if (clean.length > AI_RULE_MAX_CHARS) throw new AppError('VALIDATION_ERROR', `Правило задовге: до ${AI_RULE_MAX_CHARS} символів.`, 422)
  const rules = await listAiRules(tenantId)
  if (rules.some(rule => rule.text.toLocaleLowerCase('uk') === clean.toLocaleLowerCase('uk'))) return { rules, added: false }
  if (rules.length >= AI_RULES_MAX) throw new AppError('AI_MEMORY_FULL', `Уже ${AI_RULES_MAX} правил. Видаліть зайві в Налаштування → ШІ.`, 422)
  const next = [...rules, { id: randomUUID(), text: clean, created_at: new Date().toISOString(), created_by: userId }]
  await saveRules(tenantId, next)
  return { rules: next, added: true }
}

export async function deleteAiRule(tenantId: string, id: string): Promise<{ rules: AiRule[]; removed: AiRule | null }> {
  const rules = await listAiRules(tenantId)
  const removed = rules.find(rule => rule.id === id) ?? null
  if (!removed) return { rules, removed }
  const next = rules.filter(rule => rule.id !== id)
  await saveRules(tenantId, next)
  return { rules: next, removed }
}

/** Блок для інструкції ШІ. Порожній, якщо правил немає. */
export function rulesPrompt(rules: AiRule[]): string {
  if (!rules.length) return ''
  let out = '\n\nПРАВИЛА ВЛАСНИКА МАГАЗИНУ (він попросив їх запам\'ятати; дотримуйся їх, якщо вони не суперечать безпеці й не дозволяють продаж нижче закупівельної ціни; правило з назвою постачальника застосовуй лише до його накладних):\n'
  for (const [index, rule] of rules.entries()) {
    const line = `${index + 1}. ${rule.text}\n`
    if (out.length + line.length > PROMPT_MAX_CHARS) break
    out += line
  }
  return out
}

/** Правила для інструкції ШІ; збій сховища не зупиняє роботу помічника. */
export async function rulesPromptSafe(tenantId: string): Promise<string> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const rules = await Promise.race([
        listAiRules(tenantId),
        new Promise<AiRule[]>(resolve => { timer = setTimeout(() => resolve([]), 4000) }),
      ])
      return rulesPrompt(rules)
    } finally { if (timer) clearTimeout(timer) }
  } catch { return '' }
}

const RULE_LIST_LIMIT = 30
export function formatRuleList(rules: AiRule[]): string {
  if (!rules.length) return 'Запам\'ятованих правил поки немає. Напишіть, наприклад: «Запам\'ятай: у накладних Vitol ціни в доларах».'
  const shown = rules.slice(0, RULE_LIST_LIMIT).map((rule, index) => `${index + 1}. ${rule.text}`).join('\n')
  const more = rules.length > RULE_LIST_LIMIT ? `\n…і ще ${rules.length - RULE_LIST_LIMIT}. Усі правила — у Налаштування → ШІ.` : ''
  return `Мої правила (${rules.length}):\n${shown}${more}\n\nЩоб прибрати правило, напишіть «Забудь правило 2».`
}

/** Виконує команду пам'яті без запиту до ШІ (безкоштовно). */
export async function runMemoryCommand(tenantId: string, userId: string | null, role: string, command: MemoryCommand): Promise<string> {
  if (command.kind === 'list') return formatRuleList(await listAiRules(tenantId))
  if (role !== 'owner' && role !== 'admin') return 'Правила помічника може змінювати лише власник або адміністратор.'
  if (command.kind === 'add') {
    const { rules, added } = await addAiRule(tenantId, userId, command.text)
    return added
      ? `Запам'ятав як правило №${rules.length}: «${rules[rules.length - 1].text}». Застосовуватиму його в чаті й під час розбору накладних.`
      : 'Таке правило вже є, нічого не змінено.'
  }
  const rules = await listAiRules(tenantId)
  const target = rules[command.index - 1]
  if (!target) return `Правила №${command.index} немає. ${rules.length ? `Зараз правил: ${rules.length}.` : 'Правил поки немає.'}`
  await deleteAiRule(tenantId, target.id)
  return `Забув правило №${command.index}: «${target.text}».`
}
