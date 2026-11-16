import Anthropic from '@anthropic-ai/sdk'
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
export interface ClaudeUsage { promptTokens: number; completionTokens: number }

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

function imageBlock(image: ClaudeImage): Anthropic.Beta.BetaImageBlockParam {
  const mediaType = (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mime_type)
    ? image.mime_type : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.data_base64 } }
}

/** Помилки Anthropic → зрозумілі повідомлення програми. Ключ і тексти запиту не логуються тут. */
export function claudeAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
    return new AppError('AI_KEY_INVALID', 'Ключ Anthropic не підходить або не має доступу до моделі. Перевірте його в Налаштуваннях → ШІ.', 400)
  if (error instanceof Anthropic.RateLimitError)
    return new AppError('AI_QUOTA_EXCEEDED', 'Досягнуто ліміту Anthropic або закінчився баланс. Перевірте рахунок на console.anthropic.com. Дані не збережено.', 429)
  if (error instanceof Anthropic.BadRequestError)
    return new AppError('AI_INVALID_RESPONSE', 'Claude не прийняв запит. Зменшіть фото або розділіть запит і повторіть. Дані не збережено.', 422)
  return new AppError('AI_UPSTREAM_UNAVAILABLE', 'Claude тимчасово недоступний. Зачекайте кілька секунд і повторіть запит.', 503)
}

export class ClaudeClient {
  private client: Anthropic

  constructor(apiKey: string, private model: ClaudeModel, client?: Anthropic) {
    // Повтори 429/5xx робить SDK; час обмежує наш бюджет виконання.
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2 })
  }

  private async create(budget: AiExecutionBudget, body: Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, 'model' | 'betas' | 'fallbacks'>) {
    try {
      return await budget.run(signal => this.client.beta.messages.stream({
        ...body, model: this.model, betas: BETAS, fallbacks: 'default',
      }, { signal }).finalMessage())
    } catch (error) {
      if (isAiBudgetError(error)) throw error
      throw claudeAppError(error)
    }
  }

  private static usage(message: Anthropic.Beta.BetaMessage): ClaudeUsage {
    const u = message.usage
    return {
      promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      completionTokens: u.output_tokens ?? 0,
    }
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
        output_config: { effort: 'medium' },
        messages,
      })
      const current = ClaudeClient.usage(message)
      usage.promptTokens += current.promptTokens
      usage.completionTokens += current.completionTokens
      if (message.stop_reason === 'refusal') throw new AppError('AI_INVALID_RESPONSE', 'Claude відмовився виконати цей запит. Переформулюйте його.', 422)
      if (message.stop_reason === 'max_tokens') throw new AppError('AI_RESPONSE_TOO_LARGE', 'Відповідь ШІ завелика. Розділіть запит на частини. Зміни не застосовано.', 422)
      // Повна відповідь (з блоками міркувань) іде назад без змін — так вимагає API.
      messages.push({ role: 'assistant', content: message.content })

      const calls = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use')
      if (!calls.length) {
        const reply = ClaudeClient.text(message)
        const nudge = input.review(reply)
        if (nudge) { messages.push({ role: 'user', content: nudge }); continue }
        return { reply, finished: true }
      }
      const results = await input.handleCalls(calls.map(call => ({ name: call.name, args: (call.input ?? {}) as Record<string, unknown> })))
      messages.push({
        role: 'user',
        content: calls.map((call, index) => ({ type: 'tool_result' as const, tool_use_id: call.id, content: JSON.stringify(results[index] ?? null) })),
      })
    }
    return { reply: '', finished: false }
  }
}
