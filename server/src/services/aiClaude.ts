import type Anthropic from '@anthropic-ai/sdk'
// 21.11.2026 (швидкість вебу): SDK Anthropic вантажився ~0,44 с при кожному холодному старті сервера,
// хоча потрібен лише запитам до ШІ. Тепер вантажиться при першому запиті до ШІ.
type AnthropicModule = typeof import('@anthropic-ai/sdk')
let anthropicSdk: AnthropicModule | null = null
let anthropicSdkLoading: Promise<AnthropicModule> | null = null
export async function loadAnthropicSdk(): Promise<AnthropicModule> {
  if (anthropicSdk) return anthropicSdk
  anthropicSdkLoading ??= import('@anthropic-ai/sdk').then(module => { anthropicSdk = module; return module })
  return anthropicSdkLoading
}
import { AppError } from '../middleware/errorHandler.js'
import type { AiExecutionBudget } from './aiExecutionBudget.js'
import { isAiBudgetError } from './aiExecutionBudget.js'

/**
 * Claude як модель помічника (чат і розбір накладних). Інструменти й перевірки ті самі, що в
 * Gemini: модель лише читає дані й готує пропозиції; записує тільки користувач кнопкою.
 */
export const CLAUDE_MODELS = ['claude-sonnet-5-5'] as const
export type ClaudeModel = (typeof CLAUDE_MODELS)[number]
export const isClaudeModel = (model: string | null | undefined): model is ClaudeModel =>
  CLAUDE_MODELS.includes(model as ClaudeModel)

/**
 * Пара моделей (26.11.2026, слово власника: «підключи Haiku 5.5, щоб Sonnet 5.5 працював з ним у парі — кожен робить те,
 * в чому сильний»). Основна (Sonnet 5.5) пише тексти, веде розмову, розбирає накладні. Помічниця (Haiku 5.5) — швидка й
 * у 20 разів дешевша: другий незалежний голос у розкладці по категоріях і перевірка написаного «чи немає вигадок».
 * Дві РІЗНІ моделі, що зійшлись у відповіді, надійніші за одну модель, спитану двічі. Ключ Anthropic той самий.
 */
export const HELPER_MODEL = 'claude-haiku-5-5' as const
export type AnyClaudeModel = ClaudeModel | typeof HELPER_MODEL
/** $ за 1 млн токенів. Haiku 5.5: $0,10 / $0,50 для запитів до 100 тис. токенів (наші — значно менші). */
export const MODEL_RATES: Record<AnyClaudeModel, { input: number; output: number; cacheRead: number }> = {
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.10 },
  'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheRead: 0.01 },
}

/** Типи полів схем (колишній SchemaType з Gemini): ті самі назви, щоб схеми не переписувати. */
export const SchemaType = { STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array', OBJECT: 'object' } as const
export interface FunctionDeclaration { name: string; description?: string; parameters?: unknown }

/** Інструкція «поверни лише JSON за схемою» — замість режиму JSON-відповіді Gemini. */
export function jsonOnlyInstruction(schema: unknown): string {
  return 'Поверни ЛИШЕ один JSON-обʼєкт без Markdown і без пояснень, за цією JSON Schema (поля, яких немає в джерелі, пропускай): '
    + JSON.stringify(geminiSchemaToJson(schema))
}

const BETAS: Anthropic.Beta.AnthropicBeta[] = ['server-side-fallback-2026-07-01']

export interface ClaudeImage { mime_type: string; data_base64: string }
/**
 * costAdjustUsd — поправка до «усі вхідні токени за повною ціною»: читання кешу дешевше (знижка, від'ємна),
 * запис у кеш дорожчий на 25 %, веб-пошук платний окремо. 19.11.2026: лічильник «Витрати за місяць»
 * завищував кешовані запити й не рахував веб-пошук.
 */
export interface ClaudeUsage { promptTokens: number; completionTokens: number; costAdjustUsd?: number }
/** Ціни Claude Sonnet 5.5, $ за 1 млн токенів; веб-пошук — $ за один запит ($10 за 1000). */
export const CLAUDE_PRICES = { input: 2.0, cacheRead: 0.10, cacheWriteMultiplier: 1.25, webSearch: 0.01 } as const
/**
 * Облік програми рахує токени за ціною основної моделі. Щоб запити помічниці (Haiku) не завищували «Витрати за місяць»,
 * різницю в ціні кладемо в поправку: токени лишаються чесними, а сума виходить за справжнім тарифом.
 */
export function helperRebateUsd(model: AnyClaudeModel, promptTokens: number, completionTokens: number): number {
  const rate = MODEL_RATES[model], base = MODEL_RATES['claude-sonnet-5-5']
  return (promptTokens * (rate.input - base.input) + completionTokens * (rate.output - base.output)) / 1_000_000
}
export function claudeUsageFrom(u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; server_tool_use?: { web_search_requests?: number | null } | null }, model: AnyClaudeModel = 'claude-sonnet-5-5'): ClaudeUsage {
  const cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0
  const searches = u.server_tool_use?.web_search_requests ?? 0
  const adjust = -cacheRead * (CLAUDE_PRICES.input - CLAUDE_PRICES.cacheRead) / 1_000_000
    + cacheWrite * CLAUDE_PRICES.input * (CLAUDE_PRICES.cacheWriteMultiplier - 1) / 1_000_000
    + searches * CLAUDE_PRICES.webSearch
  const promptTokens = (u.input_tokens ?? 0) + cacheRead + cacheWrite, completionTokens = u.output_tokens ?? 0
  // Помічниця кеш не використовує; її поправка — лише різниця тарифів.
  if (model !== 'claude-sonnet-5-5') return { promptTokens, completionTokens, costAdjustUsd: helperRebateUsd(model, promptTokens, completionTokens) + searches * CLAUDE_PRICES.webSearch }
  return { promptTokens, completionTokens, costAdjustUsd: adjust }
}

/** Схема Gemini (SchemaType: 'string' | 'object' …) → JSON Schema для інструментів Claude. */
export function geminiSchemaToJson(schema: any): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }
  const out: Record<string, unknown> = {}
  if (schema.type) out.type = String(schema.type).toLowerCase()
  if (schema.description) out.description = schema.description
  if (Array.isArray(schema.enum)) out.enum = schema.enum
  if (schema.nullable) out.type = [out.type, 'null']
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, geminiSchemaToJson(value)]))
  }
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required
  if (schema.items) out.items = geminiSchemaToJson(schema.items)
  return out
}

export function claudeTools(declarations: readonly FunctionDeclaration[]): Anthropic.Beta.BetaTool[] {
  return declarations.map(declaration => ({
    name: declaration.name,
    description: declaration.description ?? '',
    input_schema: { type: 'object', ...geminiSchemaToJson(declaration.parameters ?? { type: 'object', properties: {} }) } as Anthropic.Beta.BetaTool.InputSchema,
  }))
}

/** Фото — блок зображення; PDF накладної Claude читає як документ (текст і вигляд сторінок). */
function imageBlock(image: ClaudeImage): Anthropic.Beta.BetaImageBlockParam | Anthropic.Beta.BetaRequestDocumentBlock {
  if (image.mime_type === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image.data_base64 } }
  }
  const mediaType = (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mime_type)
    ? image.mime_type : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.data_base64 } }
}

/** Помилки Anthropic → зрозумілі повідомлення програми. Ключ і тексти запиту не логуються тут. */
export function claudeAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  // Помилка SDK можлива лише після його завантаження; інакше — загальна «тимчасово недоступний».
  const Anthropic = anthropicSdk?.default
  if (!Anthropic) return new AppError('AI_UPSTREAM_UNAVAILABLE', 'Claude тимчасово недоступний. Зачекайте кілька секунд і повторіть запит.', 503)
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
    return new AppError('AI_KEY_INVALID', 'Ключ Anthropic не підходить або не має доступу до моделі. Перевірте його в Налаштуваннях → ШІ.', 400)
  if (error instanceof Anthropic.RateLimitError)
    return new AppError('AI_QUOTA_EXCEEDED', 'Досягнуто ліміту Anthropic або закінчився баланс. Перевірте рахунок на console.anthropic.com. Дані не збережено.', 429)
  // Нульовий баланс Anthropic повертає 400 «credit balance is too low» — це не поганий запит, а порожній рахунок.
  if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(String((error as Error).message ?? '')))
    return new AppError('AI_QUOTA_EXCEEDED', 'На рахунку Anthropic закінчилися кошти. Поповніть баланс на console.anthropic.com (Billing) і повторіть. Дані не збережено.', 429)
  if (error instanceof Anthropic.BadRequestError)
    return new AppError('AI_INVALID_RESPONSE', 'Claude не прийняв запит. Зменшіть фото або розділіть запит і повторіть. Дані не збережено.', 422)
  return new AppError('AI_UPSTREAM_UNAVAILABLE', 'Claude тимчасово недоступний. Зачекайте кілька секунд і повторіть запит.', 503)
}

export class ClaudeClient {
  private client: Anthropic | null
  private apiKey: string

  constructor(apiKey: string, private model: AnyClaudeModel, client?: Anthropic) {
    // Повтори 429/5xx робить SDK; час обмежує наш бюджет виконання.
    this.client = client ?? null
    this.apiKey = apiKey
  }

  private async create(budget: AiExecutionBudget, body: Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, 'model' | 'betas' | 'fallbacks'>) {
    try {
      const client = this.client ??= new (await loadAnthropicSdk()).default({ apiKey: this.apiKey, maxRetries: 2 })
      // Для Haiku 5.5 серверної підміни моделі немає — параметр і бета-прапорець не шлемо.
      const extra = this.model === HELPER_MODEL ? {} : { betas: BETAS, fallbacks: 'default' as const }
      return await budget.run(signal => client.beta.messages.stream({ ...body, model: this.model, ...extra }, { signal }).finalMessage())
    } catch (error) {
      if (isAiBudgetError(error)) throw error
      throw claudeAppError(error)
    }
  }

  private static usage(message: Anthropic.Beta.BetaMessage): ClaudeUsage {
    return claudeUsageFrom(message.usage, String(message.model ?? "").startsWith(HELPER_MODEL) ? HELPER_MODEL : 'claude-sonnet-5-5')
  }

  private static text(message: Anthropic.Beta.BetaMessage): string {
    return message.content.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text').map(block => block.text).join('\n').trim()
  }

  /** Тест ключа: найкоротша відповідь. */
  async ping(budget: AiExecutionBudget): Promise<void> {
    const message = await this.create(budget, { max_tokens: 1000, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Відповідай одним словом: ОК' }] })
    if (message.stop_reason === 'refusal') throw new AppError('AI_KEY_INVALID', 'Claude відхилив тестовий запит.', 400)
  }

  /** Один прохід без інструментів (накладна, VIN, перевірка каталогу): відповідь — текст, зазвичай JSON. */
  async complete(budget: AiExecutionBudget, input: {
    system: string; text: string; images?: ClaudeImage[]; maxTokens?: number; effort?: 'low' | 'medium' | 'high'
  }): Promise<ClaudeUsage & { text: string; truncated: boolean }> {
    const message = await this.create(budget, {
      max_tokens: input.maxTokens ?? 32000, system: input.system, output_config: { effort: input.effort ?? 'medium' },
      messages: [{ role: 'user', content: [...(input.images ?? []).map(imageBlock), { type: 'text', text: input.text }] }],
    })
    if (message.stop_reason === 'refusal') throw new AppError('AI_INVALID_RESPONSE', 'Claude відмовився виконати цей запит. Перевірте фото чи дані.', 422)
    return { ...ClaudeClient.usage(message), text: ClaudeClient.text(message), truncated: message.stop_reason === 'max_tokens' }
  }

  /**
   * Пошук в інтернеті (вбудований веб-пошук Anthropic): текст звіту і джерела, на які він посилається.
   * Нічого не записує — результат перевіряє окремий крок програми.
   */
  async research(budget: AiExecutionBudget, prompt: string, maxSearches = 5): Promise<ClaudeUsage & { text: string; sources: Array<{ title: string; uri: string }> }> {
    const usage: ClaudeUsage = { promptTokens: 0, completionTokens: 0 }
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }]
    const texts: string[] = []
    const sources = new Map<string, { title: string; uri: string }>()
    // pause_turn: сервер зупинив довгий пошук — продовжуємо, повертаючи відповідь як є.
    for (let round = 0; round < 4; round++) {
      const message = await this.create(budget, {
        max_tokens: 16000, output_config: { effort: 'medium' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }],
        messages,
      })
      const current = ClaudeClient.usage(message)
      usage.promptTokens += current.promptTokens
      usage.completionTokens += current.completionTokens
      usage.costAdjustUsd = (usage.costAdjustUsd ?? 0) + (current.costAdjustUsd ?? 0)
      if (message.stop_reason === 'refusal') throw new AppError('AI_INVALID_RESPONSE', 'Claude відмовився виконати пошук.', 422)
      for (const block of message.content) {
        if (block.type !== 'text') continue
        texts.push(block.text)
        for (const citation of block.citations ?? []) {
          if (citation.type === 'web_search_result_location' && citation.url && !sources.has(citation.url))
            sources.set(citation.url, { title: citation.title ?? '', uri: citation.url })
        }
      }
      if (message.stop_reason !== 'pause_turn') break
      messages.push({ role: 'assistant', content: message.content })
    }
    return { ...usage, text: texts.join('\n').trim(), sources: [...sources.values()] }
  }

  /**
   * Чат з інструментами. `handleCall` виконує читання або готує пропозицію і повертає відповідь
   * інструмента; виняток з нього зупиняє розмову (як у Gemini-гілці).
   */
  async chat(budget: AiExecutionBudget, input: {
    system: string
    tools: Anthropic.Beta.BetaTool[]
    history: Array<{ role: 'user' | 'model'; text: string }>
    userText: string
    images: ClaudeImage[]
    maxSteps: number
    handleCalls: (calls: Array<{ name: string; args: Record<string, unknown> }>) => Promise<unknown[]>
    /** Повертає підказку для ще однієї спроби або null, якщо відповідь прийнято. */
    review: (reply: string) => string | null
    /** Лічильник токенів наповнюється по ходу, щоб облік не губився при помилці посеред розмови. */
    usage: ClaudeUsage
    /** Глибина міркувань: коротке питання без вкладень — low (швидше), решта — medium. */
    effort?: 'low' | 'medium'
    /** Хід роботи для екрана («Шукаю в каталозі…»), щоб власник не дивився хвилину в порожнечу. */
    onProgress?: (event: { stage: 'tools'; tools: string[] } | { stage: 'answer' }) => void
  }): Promise<{ reply: string; finished: boolean }> {
    const messages: Anthropic.Beta.BetaMessageParam[] = []
    for (const turn of input.history) {
      const role = turn.role === 'model' ? 'assistant' : 'user'
      // API вимагає почати з користувача; сусідні репліки однієї ролі API об'єднує сам.
      if (!messages.length && role === 'assistant') continue
      messages.push({ role, content: turn.text })
    }
    messages.push({ role: 'user', content: [...input.images.map(imageBlock), { type: 'text', text: input.userText }] })

    const usage = input.usage
    for (let step = 0; step < input.maxSteps; step++) {
      const message = await this.create(budget, {
        max_tokens: 32000,
        system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
        tools: input.tools,
        output_config: { effort: input.effort ?? 'medium' },
        // 21.11.2026: кешуємо і зростаючу історію кроку інструментів — наступний крок не перечитує її
        // за повною ціною і починає відповідати швидше.
        cache_control: { type: 'ephemeral' },
        messages,
      })
      const current = ClaudeClient.usage(message)
      usage.promptTokens += current.promptTokens
      usage.completionTokens += current.completionTokens
      usage.costAdjustUsd = (usage.costAdjustUsd ?? 0) + (current.costAdjustUsd ?? 0)
      if (message.stop_reason === 'refusal') throw new AppError('AI_INVALID_RESPONSE', 'Claude відмовився виконати цей запит. Переформулюйте його.', 422)
      if (message.stop_reason === 'max_tokens') throw new AppError('AI_RESPONSE_TOO_LARGE', 'Відповідь ШІ завелика. Розділіть запит на частини. Зміни не застосовано.', 422)
      // Повна відповідь (з блоками міркувань) іде назад без змін — так вимагає API.
      messages.push({ role: 'assistant', content: message.content })

      const calls = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use')
      if (!calls.length) {
        input.onProgress?.({ stage: 'answer' })
        const reply = ClaudeClient.text(message)
        const nudge = input.review(reply)
        if (nudge) { messages.push({ role: 'user', content: nudge }); continue }
        return { reply, finished: true }
      }
      input.onProgress?.({ stage: 'tools', tools: calls.map(call => call.name) })
      const results = await input.handleCalls(calls.map(call => ({ name: call.name, args: (call.input ?? {}) as Record<string, unknown> })))
      messages.push({
        role: 'user',
        content: calls.map((call, index) => ({ type: 'tool_result' as const, tool_use_id: call.id, content: JSON.stringify(results[index] ?? null) })),
      })
    }
    return { reply: '', finished: false }
  }
}

type CompleteInput = Parameters<ClaudeClient['complete']>[1]
type CompleteAnswer = Awaited<ReturnType<ClaudeClient['complete']>>
export interface CompleteModel { complete: (budget: AiExecutionBudget, input: CompleteInput) => Promise<CompleteAnswer> }

/**
 * Помічниця з підстраховкою: якщо Haiku недоступна (ключ без доступу до моделі, збій, відмова) — те саме питання
 * отримує основна модель, і робота не зупиняється. Вичерпаний час чи ліміт рахунку підстраховкою не лікуються.
 */
export function helperWithFallback(helper: CompleteModel, main: CompleteModel): CompleteModel {
  return {
    complete: async (budget, input) => {
      try { return await helper.complete(budget, input) }
      catch (error) {
        if (isAiBudgetError(error) || (error instanceof AppError && error.code === 'AI_QUOTA_EXCEEDED')) throw error
        return main.complete(budget, input)
      }
    },
  }
}
