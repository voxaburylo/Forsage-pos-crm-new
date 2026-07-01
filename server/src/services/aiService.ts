import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import type { FunctionDeclaration, Content, Part } from '@google/generative-ai'
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { AppError } from '../middleware/errorHandler.js'
import { encryptSecret, decryptSecret } from '../lib/crypto.js'
import { searchProductsForPOS } from './searchService.js'
import { getProduct, createProduct, updateProduct } from './productService.js'
import { listCategories, listBrands, createCategory } from './adminService.js'
import { listCustomers, updateCustomer } from './customerService.js'
import { normalizePhone } from '../validators/customerSchema.js'

// ─── Моделі та приблизна вартість ($ за 1M токенів) ──────────────────────────
// Значення орієнтовні (тарифи Google можуть змінюватись) — лічильник показуємо
// як приблизний («≈»). Оновити просто тут за потреби.
export const AI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] as const
export type AiModel = (typeof AI_MODELS)[number]
export const DEFAULT_MODEL: AiModel = 'gemini-2.5-flash'

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-pro':   { input: 1.25, output: 10.0 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
}

function computeCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING[DEFAULT_MODEL]
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output
}

// ─── Конфіг AI магазину ──────────────────────────────────────────────────────
export interface AiConfig {
  enabled: boolean
  model: string
  hasKey: boolean
  apiKey: string | null // розшифрований (тільки для внутрішнього використання)
}

export async function getAiConfig(tenantId: string): Promise<AiConfig> {
  const { data, error } = await db
    .from('shop_settings')
    .select('ai_enabled, ai_model, ai_api_key_encrypted')
    .eq('tenant_id', tenantId)
    .single()

  if (error || !data) throw new AppError('DB_ERROR', 'Налаштування не знайдено', 500)

  let apiKey: string | null = null
  if (data.ai_api_key_encrypted) {
    try { apiKey = decryptSecret(data.ai_api_key_encrypted) }
    catch (e: any) { logger.warn({ err: e?.message }, '[ai] failed to decrypt api key') }
  }

  return {
    enabled: data.ai_enabled ?? false,
    model: data.ai_model ?? DEFAULT_MODEL,
    hasKey: !!apiKey,
    apiKey,
  }
}

export async function saveAiConfig(
  tenantId: string,
  input: { apiKey?: string | null; model?: string; enabled?: boolean },
): Promise<{ enabled: boolean; model: string; hasKey: boolean }> {
  const patch: Record<string, any> = { updated_at: new Date().toISOString() }

  if (input.model !== undefined) {
    if (!AI_MODELS.includes(input.model as AiModel)) {
      throw new AppError('VALIDATION_ERROR', 'Невідома модель', 400)
    }
    patch.ai_model = input.model
  }
  if (input.enabled !== undefined) patch.ai_enabled = input.enabled
  // apiKey: '' або null → очистити; непорожній рядок → зашифрувати; undefined → не чіпати
  if (input.apiKey !== undefined) {
    patch.ai_api_key_encrypted = input.apiKey ? encryptSecret(input.apiKey.trim()) : null
  }

  const { data, error } = await db
    .from('shop_settings')
    .update(patch)
    .eq('tenant_id', tenantId)
    .select('ai_enabled, ai_model, ai_api_key_encrypted')
    .single()

  if (error) {
    const isMissingColumn = error.code === 'PGRST204'
      || /could not find .* column|column .* does not exist/i.test(error.message)
    if (isMissingColumn) {
      throw new AppError('AI_SCHEMA_DRIFT',
        'У БД бракує колонок AI. Застосуйте міграцію 120_ai_assistant.sql.', 500)
    }
    throw new AppError('DB_ERROR', error.message, 500)
  }

  return {
    enabled: data.ai_enabled ?? false,
    model: data.ai_model ?? DEFAULT_MODEL,
    hasKey: !!data.ai_api_key_encrypted,
  }
}

// ─── Перевірка ключа ─────────────────────────────────────────────────────────
export async function testKey(apiKey: string, model: string): Promise<{ ok: boolean }> {
  try {
    const genAI = new GoogleGenerativeAI(apiKey)
    const m = genAI.getGenerativeModel({ model })
    const res = await m.generateContent('Відповідай одним словом: ОК')
    const text = res.response.text().trim()
    logger.info({ model, text }, '[ai] test key ok')
    return { ok: true }
  } catch (e: any) {
    logger.warn({ err: e?.message }, '[ai] test key failed')
    throw new AppError('AI_KEY_INVALID', 'Ключ або модель не працюють: ' + (e?.message ?? ''), 400)
  }
}

// ─── Облік використання ──────────────────────────────────────────────────────
async function logUsage(
  tenantId: string, userId: string | null, model: string,
  promptTokens: number, completionTokens: number,
): Promise<void> {
  try {
    await db.from('ai_usage').insert({
      tenant_id: tenantId,
      user_id: userId,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      cost_usd: computeCostUsd(model, promptTokens, completionTokens),
    })
  } catch (e: any) {
    logger.warn({ err: e?.message }, '[ai] failed to log usage')
  }
}

export async function getUsageSummary(tenantId: string) {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const { data, error } = await db
    .from('ai_usage')
    .select('total_tokens, cost_usd, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', monthStart)
    .limit(100000)

  if (error) throw new AppError('DB_ERROR', error.message, 500)

  const rows = data ?? []
  const totalCost = rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)
  const totalTokens = rows.reduce((s, r) => s + Number(r.total_tokens ?? 0), 0)

  return {
    month: monthStart.slice(0, 7),
    requests: rows.length,
    total_tokens: totalTokens,
    cost_usd: Number(totalCost.toFixed(4)),
  }
}

// ─── Інструменти (function-calling) ──────────────────────────────────────────
// READ-інструменти виконуються одразу. WRITE-інструменти НЕ виконуються, а
// повертаються користувачу як «пропозиція змін» (було → стане) на підтвердження.
const READ_TOOLS = new Set(['search_products', 'get_product', 'list_categories', 'list_brands', 'search_customers'])
const WRITE_TOOLS = new Set(['update_product', 'create_product', 'create_customer', 'update_customer', 'create_category'])
// Масові дії: одна картка-пропозиція з багатьма рядками, застосовується пакетом
const BULK_TOOLS = new Set(['create_customers_bulk', 'create_products_bulk', 'create_categories_bulk'])

const toolDeclarations: FunctionDeclaration[] = [
  {
    name: 'search_products',
    description: 'Знайти товари на складі за артикулом, назвою, штрихкодом або OEM. Повертає ціни в гривнях.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: 'Пошуковий запит' },
        limit: { type: SchemaType.NUMBER, description: 'Скільки показати (1-15)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'Отримати повну картку одного товару за його ID (product_id).',
    parameters: {
      type: SchemaType.OBJECT,
      properties: { product_id: { type: SchemaType.STRING } },
      required: ['product_id'],
    },
  },
  {
    name: 'list_categories',
    description: 'Список категорій товарів магазину (id + назва).',
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'list_brands',
    description: 'Список брендів магазину (id + назва).',
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'update_product',
    description: 'Запропонувати зміну наявного товару. НЕ застосовується одразу — користувач підтвердить вручну. Ціни у гривнях.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        product_id: { type: SchemaType.STRING, description: 'ID товару, який змінюємо' },
        name: { type: SchemaType.STRING, description: 'Нова назва (наприклад, чистий переклад)' },
        description: { type: SchemaType.STRING, description: 'Опис товару (піде в поле нотаток)' },
        retail_price_uah: { type: SchemaType.NUMBER, description: 'Роздрібна ціна, грн' },
        category_id: { type: SchemaType.STRING, description: 'ID категорії' },
        brand_name: { type: SchemaType.STRING, description: 'Назва бренду (знайдемо або створимо)' },
        oem_number: { type: SchemaType.STRING },
        barcode: { type: SchemaType.STRING },
        storage_bin: { type: SchemaType.STRING, description: 'Місце зберігання (комірка)' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'create_product',
    description: 'Запропонувати створення нового товару. НЕ застосовується одразу — користувач підтвердить. Ціни у гривнях.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        sku: { type: SchemaType.STRING, description: 'Артикул' },
        name: { type: SchemaType.STRING, description: 'Назва товару' },
        description: { type: SchemaType.STRING, description: 'Опис (піде в нотатки)' },
        retail_price_uah: { type: SchemaType.NUMBER, description: 'Роздрібна ціна, грн' },
        purchase_price_uah: { type: SchemaType.NUMBER, description: 'Закупівельна ціна, грн' },
        category_id: { type: SchemaType.STRING },
        brand_name: { type: SchemaType.STRING },
        oem_number: { type: SchemaType.STRING },
        barcode: { type: SchemaType.STRING },
      },
      required: ['sku', 'name'],
    },
  },
  {
    name: 'search_customers',
    description: 'Знайти клієнтів за імʼям, телефоном або VIN. Повертає id + основні дані.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING },
        limit: { type: SchemaType.NUMBER, description: '1-20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_customer',
    description: 'Запропонувати створення одного клієнта. НЕ застосовується одразу. Телефон у форматі +380XXXXXXXXX.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        full_name: { type: SchemaType.STRING },
        phone: { type: SchemaType.STRING, description: 'Телефон (необовʼязково), +380...' },
        email: { type: SchemaType.STRING },
        notes: { type: SchemaType.STRING },
        vin: { type: SchemaType.STRING, description: 'VIN авто (17 символів), якщо є' },
        car_make: { type: SchemaType.STRING, description: 'Марка авто (можна визначити за WMI — перші символи VIN)' },
        car_model: { type: SchemaType.STRING },
        car_year: { type: SchemaType.NUMBER },
      },
      required: [],
    },
  },
  {
    name: 'update_customer',
    description: 'Запропонувати зміну наявного клієнта за customer_id. НЕ застосовується одразу.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        customer_id: { type: SchemaType.STRING },
        full_name: { type: SchemaType.STRING },
        phone: { type: SchemaType.STRING },
        email: { type: SchemaType.STRING },
        notes: { type: SchemaType.STRING },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'create_category',
    description: 'Запропонувати створення однієї категорії («папки») товарів. НЕ застосовується одразу.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: { name: { type: SchemaType.STRING } },
      required: ['name'],
    },
  },
  {
    name: 'create_customers_bulk',
    description: 'МАСОВЕ створення клієнтів зі списку (наприклад, перетягнутого Excel). Одна пропозиція на весь список, застосовується пакетом. Використовуй для 2+ клієнтів.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        customers: {
          type: SchemaType.ARRAY,
          description: 'Список клієнтів',
          items: {
            type: SchemaType.OBJECT,
            properties: {
              full_name: { type: SchemaType.STRING },
              phone: { type: SchemaType.STRING, description: 'Телефон, необовʼязково, +380...' },
              vin: { type: SchemaType.STRING },
              car_make: { type: SchemaType.STRING },
              car_model: { type: SchemaType.STRING },
              car_year: { type: SchemaType.NUMBER },
            },
            required: [],
          },
        },
      },
      required: ['customers'],
    },
  },
  {
    name: 'create_products_bulk',
    description: 'МАСОВЕ створення товарів зі списку/прайсу. Одна пропозиція, застосовується пакетом. Ціни у грн.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        products: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              sku: { type: SchemaType.STRING },
              name: { type: SchemaType.STRING },
              brand_name: { type: SchemaType.STRING },
              category_name: { type: SchemaType.STRING, description: 'Назва категорії (знайдемо або створимо)' },
              retail_price_uah: { type: SchemaType.NUMBER },
              purchase_price_uah: { type: SchemaType.NUMBER },
              oem_number: { type: SchemaType.STRING },
            },
            required: ['sku', 'name'],
          },
        },
      },
      required: ['products'],
    },
  },
  {
    name: 'create_categories_bulk',
    description: 'МАСОВЕ створення категорій («папок») зі списку назв. Одна пропозиція, пакетне застосування.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        names: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      },
      required: ['names'],
    },
  },
]

const SYSTEM_PROMPT = `Ти — AI-помічник «Директор» для CRM автозапчастин «Форсаж». Спілкуйся українською, коротко й по суті.
Ти допомагаєш власнику як досвідчений кладівник і директор: розбираєш товар, перекладаєш і чистиш назви, пишеш описи, підбираєш категорію та бренд, створюєш і сортуєш категорії («папки»), заводиш клієнтів з їхніми авто, аналізуєш прайси й таблиці (Excel/CSV/текст).

Що ти вмієш (через інструменти):
- Товари: пошук, картка, створення (по одному або МАСОВО create_products_bulk).
- Клієнти: пошук, створення (по одному або МАСОВО create_customers_bulk), редагування. Телефон НЕОБОВʼЯЗКОВИЙ — якщо його нема, все одно створюй клієнта (імʼя + авто). Прізвище та імʼя обʼєднуй у full_name. Якщо в клітинці кілька телефонів — бери перший. При наявності VIN — заведи авто клієнту (make/model/year/vin); марку/модель бери з рядка або визнач за WMI (перші символи VIN). Додаткові примітки (напр. «Такси», список деталей) клади в notes.
- Категорії («папки»): створення по одній або МАСОВО create_categories_bulk.

Правила:
- Усі грошові суми — у гривнях (грн). Телефони клієнтів — у форматі +380XXXXXXXXX (нормалізуй сам), але вони НЕОБОВʼЯЗКОВІ. Дані можуть бути «брудною» таблицею через табуляцію (колонки: №, прізвище, імʼя, телефон, рік, обʼєм, VIN, марка, модель, примітки) — розбирай по колонках, порожні клітинки пропускай.
- Коли тобі надсилають список (перетягнутий Excel/вставлений текст) на 2+ записи — ЗАВЖДИ використовуй масовий інструмент (create_customers_bulk / create_products_bulk / create_categories_bulk), а не окремі виклики. Це створює ОДНУ картку-пропозицію на весь список.
- Будь-які зміни в базі ти лише ПРОПОНУЄШ — вони застосуються, коли користувач натисне «Застосувати». Після виклику інструмента коротко словами підсумуй, що саме пропонуєш (напр. «Підготував 47 клієнтів до створення»).
- Щоб дізнатись реальні дані — спочатку виклич пошук, не вигадуй ID.
- Не вигадуй фактів про товар/клієнта, якого немає в даних.`

interface ChatMessage { role: 'user' | 'model'; text: string }
export interface PendingAction {
  id: string
  tool: string
  title: string
  changes: Array<{ label: string; old: string | null; next: string }>
  payload: Record<string, any>
  // для масових дій — компактний прев'ю-список
  count?: number
  columns?: string[]
  items?: Array<Record<string, string>>
}

const money = (kop: number) => (kop / 100).toFixed(2) + ' грн'

async function executeReadTool(name: string, args: any, tenantId: string): Promise<any> {
  switch (name) {
    case 'search_products': {
      const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 15)
      const results = await searchProductsForPOS(String(args?.query ?? ''), limit, tenantId)
      return {
        products: results.map((r) => ({
          product_id: r.id,
          sku: r.sku,
          name: r.name,
          brand: r.brand?.name ?? null,
          retail_price_uah: r.retail_price / 100,
          qty_on_hand: r.qty_on_hand,
          qty_available: r.qty_available,
          has_photo: !!r.photo_url,
        })),
      }
    }
    case 'get_product': {
      const p = await getProduct(String(args?.product_id), tenantId)
      return {
        product_id: p.id, sku: p.sku, name: p.name,
        brand: p.brand?.name ?? null, category: p.category?.name ?? null,
        retail_price_uah: p.retail_price / 100, purchase_price_uah: p.purchase_price / 100,
        qty_on_hand: p.qty_on_hand, oem_number: p.oem_number, barcode: p.barcode,
        notes: p.notes, storage_bin: p.storage_bin, has_photo: !!p.photo_url,
      }
    }
    case 'list_categories': {
      const cats = await listCategories(tenantId)
      return { categories: cats.map((c: any) => ({ id: c.id, name: c.name })) }
    }
    case 'list_brands': {
      const brands = await listBrands(tenantId)
      return { brands: brands.map((b: any) => ({ id: b.id, name: b.name })) }
    }
    case 'search_customers': {
      const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 20)
      const { data } = await listCustomers({ search: String(args?.query ?? ''), page: 1, per_page: limit } as any, tenantId)
      return {
        customers: (data ?? []).map((c: any) => ({
          customer_id: c.id, full_name: c.full_name, phone: c.phone,
          primary_vin: c.primary_vin ?? null, debt_balance_uah: (c.debt_balance ?? 0) / 100,
        })),
      }
    }
    default:
      return { error: 'Невідомий інструмент' }
  }
}

function newActionId() { return 'act_' + Math.random().toString(36).slice(2, 10) }

async function buildPendingAction(name: string, args: any, tenantId: string): Promise<PendingAction> {
  const id = newActionId()

  // ── Масові дії ──────────────────────────────────────────────────────────
  if (name === 'create_customers_bulk') {
    const list: any[] = Array.isArray(args?.customers) ? args.customers : []
    const items = list.map((c) => ({
      'Імʼя': String(c.full_name ?? '—'),
      'Телефон': String(c.phone ?? '—'),
      'Авто': [c.car_make, c.car_model, c.car_year].filter(Boolean).join(' ') || '—',
      'VIN': String(c.vin ?? '—'),
    }))
    return {
      id, tool: name, title: `Створити клієнтів: ${list.length}`,
      changes: [], count: list.length,
      columns: ['Імʼя', 'Телефон', 'Авто', 'VIN'], items,
      payload: { customers: list },
    }
  }

  if (name === 'create_products_bulk') {
    const list: any[] = Array.isArray(args?.products) ? args.products : []
    const items = list.map((p) => ({
      'Артикул': String(p.sku ?? '—'),
      'Назва': String(p.name ?? '—'),
      'Бренд': String(p.brand_name ?? '—'),
      'Категорія': String(p.category_name ?? '—'),
      'Ціна': p.retail_price_uah !== undefined ? Number(p.retail_price_uah).toFixed(2) + ' грн' : '—',
    }))
    return {
      id, tool: name, title: `Створити товари: ${list.length}`,
      changes: [], count: list.length,
      columns: ['Артикул', 'Назва', 'Бренд', 'Категорія', 'Ціна'], items,
      payload: { products: list },
    }
  }

  if (name === 'create_categories_bulk') {
    const names: string[] = Array.isArray(args?.names) ? args.names.map((n: any) => String(n)) : []
    return {
      id, tool: name, title: `Створити категорії: ${names.length}`,
      changes: [], count: names.length,
      columns: ['Категорія'], items: names.map((n) => ({ 'Категорія': n })),
      payload: { names },
    }
  }

  // ── Одиничні клієнти / категорії ────────────────────────────────────────
  if (name === 'create_customer') {
    const changes: PendingAction['changes'] = [
      { label: 'Імʼя', old: null, next: String(args.full_name ?? '—') },
      { label: 'Телефон', old: null, next: String(args.phone ?? '') },
    ]
    const car = [args.car_make, args.car_model, args.car_year].filter(Boolean).join(' ')
    if (car) changes.push({ label: 'Авто', old: null, next: car })
    if (args.vin) changes.push({ label: 'VIN', old: null, next: String(args.vin) })
    if (args.email) changes.push({ label: 'Email', old: null, next: String(args.email) })
    if (args.notes) changes.push({ label: 'Нотатки', old: null, next: String(args.notes) })
    return { id, tool: name, title: `Створити клієнта: ${args.full_name ?? args.phone ?? ''}`, changes, payload: { ...args } }
  }

  if (name === 'update_customer') {
    const changes: PendingAction['changes'] = []
    if (args.full_name !== undefined) changes.push({ label: 'Імʼя', old: null, next: String(args.full_name) })
    if (args.phone !== undefined) changes.push({ label: 'Телефон', old: null, next: String(args.phone) })
    if (args.email !== undefined) changes.push({ label: 'Email', old: null, next: String(args.email) })
    if (args.notes !== undefined) changes.push({ label: 'Нотатки', old: null, next: String(args.notes) })
    return { id, tool: name, title: 'Змінити клієнта', changes, payload: { ...args } }
  }

  if (name === 'create_category') {
    return {
      id, tool: name, title: `Створити категорію: ${args.name ?? ''}`,
      changes: [{ label: 'Назва', old: null, next: String(args.name ?? '') }],
      payload: { name: args.name },
    }
  }

  if (name === 'update_product') {
    const current = await getProduct(String(args.product_id), tenantId)
    const changes: PendingAction['changes'] = []
    if (args.name !== undefined && args.name !== current.name)
      changes.push({ label: 'Назва', old: current.name, next: String(args.name) })
    if (args.description !== undefined && args.description !== current.notes)
      changes.push({ label: 'Опис', old: current.notes ?? null, next: String(args.description) })
    if (args.retail_price_uah !== undefined)
      changes.push({ label: 'Роздрібна ціна', old: money(current.retail_price), next: Number(args.retail_price_uah).toFixed(2) + ' грн' })
    if (args.brand_name !== undefined)
      changes.push({ label: 'Бренд', old: current.brand?.name ?? null, next: String(args.brand_name) })
    if (args.oem_number !== undefined && args.oem_number !== current.oem_number)
      changes.push({ label: 'OEM', old: current.oem_number ?? null, next: String(args.oem_number) })
    if (args.barcode !== undefined && args.barcode !== current.barcode)
      changes.push({ label: 'Штрихкод', old: current.barcode ?? null, next: String(args.barcode) })
    if (args.storage_bin !== undefined && args.storage_bin !== current.storage_bin)
      changes.push({ label: 'Комірка', old: current.storage_bin ?? null, next: String(args.storage_bin) })
    if (args.category_id !== undefined)
      changes.push({ label: 'Категорія (id)', old: current.category?.name ?? null, next: String(args.category_id) })

    return {
      id, tool: name,
      title: `Змінити товар: ${current.name} (${current.sku})`,
      changes,
      payload: { ...args, product_id: current.id },
    }
  }

  // create_product
  const changes: PendingAction['changes'] = [
    { label: 'Артикул', old: null, next: String(args.sku ?? '') },
    { label: 'Назва', old: null, next: String(args.name ?? '') },
  ]
  if (args.brand_name) changes.push({ label: 'Бренд', old: null, next: String(args.brand_name) })
  if (args.retail_price_uah !== undefined) changes.push({ label: 'Роздрібна ціна', old: null, next: Number(args.retail_price_uah).toFixed(2) + ' грн' })
  if (args.purchase_price_uah !== undefined) changes.push({ label: 'Закупівля', old: null, next: Number(args.purchase_price_uah).toFixed(2) + ' грн' })
  if (args.description) changes.push({ label: 'Опис', old: null, next: String(args.description) })
  if (args.oem_number) changes.push({ label: 'OEM', old: null, next: String(args.oem_number) })

  return {
    id, tool: name,
    title: `Створити товар: ${args.name ?? ''}`,
    changes,
    payload: { ...args },
  }
}

// Транзієнтні помилки Gemini (перевантаження/мережа) — має сенс повторити.
// Помилки ключа/квоти/валідації (400/401/403) не ретраїмо.
function isQuotaError(e: any): boolean {
  const msg = String(e?.message ?? '')
  return /\b429\b|quota|rate limit|resource_exhausted|exceeded your current/i.test(msg)
}

function isTransientGeminiError(e: any): boolean {
  const msg = String(e?.message ?? '')
  // Квота/ключ/валідація — не ретраїмо (короткий бекоф не поверне денний ліміт).
  if (isQuotaError(e)) return false
  if (/\b(400|401|403|API key|API_KEY|invalid|permission)\b/i.test(msg)) return false
  return /\b(50[0-9])\b|overload|unavailable|deadline|timeout|timed out|fetch failed|network|ECONNRESET|ETIMEDOUT|socket hang|EAI_AGAIN/i.test(msg)
}

// Виклик Gemini з експоненційним бекофом на транзієнтних помилках.
async function sendWithRetry(chat: any, parts: string | Part[], iter: number) {
  const delays = [600, 1500, 3000] // мс: до 3 повторів
  let lastErr: any
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await chat.sendMessage(parts)
    } catch (e: any) {
      lastErr = e
      if (attempt < delays.length && isTransientGeminiError(e)) {
        logger.warn({ err: e?.message, iter, attempt }, '[ai] transient Gemini error, retrying')
        await new Promise((r) => setTimeout(r, delays[attempt]))
        continue
      }
      break
    }
  }
  throw lastErr
}

// ─── Головний чат ────────────────────────────────────────────────────────────
export async function runChat(
  tenantId: string,
  userId: string | null,
  params: { history?: ChatMessage[]; message: string; fileText?: string },
): Promise<{ reply: string; actions: PendingAction[]; usage: { prompt_tokens: number; completion_tokens: number; cost_usd: number } }> {
  const cfg = await getAiConfig(tenantId)
  if (!cfg.apiKey) throw new AppError('AI_NOT_CONFIGURED', 'Ключ Gemini не налаштовано. Додайте його в Налаштуваннях.', 400)
  if (!cfg.enabled) throw new AppError('AI_DISABLED', 'Помічник АІ вимкнено в Налаштуваннях.', 400)

  const genAI = new GoogleGenerativeAI(cfg.apiKey)
  const model = genAI.getGenerativeModel({
    model: cfg.model,
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: toolDeclarations }],
  })

  const history: Content[] = (params.history ?? [])
    .filter((m) => m.text?.trim())
    .map((m) => ({ role: m.role, parts: [{ text: m.text }] }))

  const chat = model.startChat({ history })

  let userText = params.message
  if (params.fileText) {
    const clipped = params.fileText.slice(0, 100_000)
    userText += `\n\n[Прикріплений файл / вставлені дані]:\n${clipped}`
  }

  const actions: PendingAction[] = []
  let promptTokens = 0
  let completionTokens = 0
  let reply = ''

  // Надсилаємо або текст користувача, або відповіді інструментів (parts).
  let nextParts: string | Part[] = userText
  let corrections = 0

  for (let iter = 0; iter < 10; iter++) {
    let result
    try {
      result = await sendWithRetry(chat, nextParts, iter)
    } catch (err: any) {
      if (isQuotaError(err)) {
        logger.warn({ err: err?.message, iter }, '[ai] Gemini quota exceeded')
        throw new AppError(
          'AI_QUOTA_EXCEEDED',
          'Вичерпано денний ліміт безкоштовного Gemini (лише ~20 запитів/добу для 2.5-flash). Підключіть білінг у Google AI Studio (aistudio.google.com) — ліміти зростуть у сотні разів, а вартість flash копійчана. Або зачекайте скидання ліміту (щодоби).',
          429,
        )
      }
      logger.warn({ err: err?.message, iter }, '[ai] Gemini request failed after retries')
      throw new AppError(
        'AI_UPSTREAM_UNAVAILABLE',
        'Gemini тимчасово перевантажений. Зачекайте кілька секунд і повторіть запит.',
        503,
      )
    }
    const resp = result.response

    const um = resp.usageMetadata
    if (um) {
      const pin = um.promptTokenCount ?? 0
      promptTokens += pin
      // total - prompt враховує і "thinking"-токени (thoughtsTokenCount), які
      // тарифікуються як output. Фолбек на candidatesTokenCount, якщо total немає.
      const out = um.totalTokenCount != null
        ? Math.max(um.totalTokenCount - pin, 0)
        : (um.candidatesTokenCount ?? 0)
      completionTokens += out
    }

    const calls = resp.functionCalls() ?? []
    if (calls.length === 0) {
      reply = resp.text()

      // Запобіжник галюцинації: модель написала, ніби виконала дію («готово»,
      // «створив/создал», «додав/добавил»…), але НЕ підготувала ЖОДНОЇ write-пропозиції
      // (actions порожні) — отже фактично нічого не зроблено. Це стосується і випадку,
      // коли модель лише щось шукала (search_*), а тоді відрапортувала «готово».
      // Змушуємо її таки викликати потрібний інструмент (до 2 спроб).
      const claimsDone = /(готов|створ|створи|заве|заві|додав|додано|додай|оновив|оновлено|видал|внесено|занесено|создал|создан|добав|завел|завёл|занес|занёс|внес|внёс|обновил|удалил|added|created|done|saved)/i.test(reply)
      if (corrections < 2 && actions.length === 0 && claimsDone) {
        corrections++
        nextParts = 'СИСТЕМА: Ти відрапортував, ніби виконав дію, але НЕ підготував жодної пропозиції (не викликав інструмент створення/зміни) — у базі НІЧОГО не змінилося, і користувач нічого не побачить. Якщо у повідомленні/файлі є дані для заведення (клієнти, товари, категорії) — ОБОВʼЯЗКОВО виклич відповідний інструмент ЗАРАЗ: для 2+ записів — масовий (create_customers_bulk / create_products_bulk / create_categories_bulk), для одного — одиничний. НЕ пиши «готово», доки не викликав інструмент. Якщо ж це було лише запитання — дай відповідь без слів «готово/створив/додав».'
        continue
      }
      break
    }

    const responseParts: Part[] = []
    for (const call of calls) {
      if (READ_TOOLS.has(call.name)) {
        let data: any
        try { data = await executeReadTool(call.name, call.args, tenantId) }
        catch (e: any) { data = { error: e?.message ?? 'помилка' } }
        responseParts.push({ functionResponse: { name: call.name, response: data } })
      } else if (WRITE_TOOLS.has(call.name) || BULK_TOOLS.has(call.name)) {
        try {
          const action = await buildPendingAction(call.name, call.args, tenantId)
          actions.push(action)
          responseParts.push({ functionResponse: { name: call.name, response: {
            status: 'pending_user_confirmation',
            message: 'Пропозицію показано користувачу. Він підтвердить її вручну кнопкою «Застосувати».',
          } } })
        } catch (e: any) {
          responseParts.push({ functionResponse: { name: call.name, response: { error: e?.message ?? 'помилка' } } })
        }
      } else {
        responseParts.push({ functionResponse: { name: call.name, response: { error: 'Невідомий інструмент' } } })
      }
    }
    nextParts = responseParts
  }

  await logUsage(tenantId, userId, cfg.model, promptTokens, completionTokens)

  if (!reply) {
    reply = actions.length > 0 ? 'Підготував пропозицію нижче.' : 'Готово.'
  }

  // Детермінована примітка: модель може написати «створив», але фактично це лише
  // ПРОПОЗИЦІЯ — нічого не збережеться, доки користувач не натисне «Застосувати».
  if (actions.length > 0) {
    reply += `\n\n📋 Це ще не збережено. ${actions.length === 1 ? 'Пропозиція' : 'Пропозиції'} нижче — натисніть «Застосувати», щоб внести зміни в базу.`
  }

  return {
    reply,
    actions,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_usd: Number(computeCostUsd(cfg.model, promptTokens, completionTokens).toFixed(6)),
    },
  }
}

// ─── Застосування підтвердженої дії ──────────────────────────────────────────
async function resolveBrandId(brandName: string, tenantId: string): Promise<string | null> {
  const name = brandName.trim()
  if (!name) return null
  const { data: existing } = await db
    .from('brands').select('id').eq('tenant_id', tenantId).ilike('name', name).maybeSingle()
  if (existing?.id) return existing.id
  const { data: created, error } = await db
    .from('brands').insert({ name, tenant_id: tenantId }).select('id').single()
  if (error) { logger.warn({ err: error.message, name }, '[ai] failed to create brand'); return null }
  return created.id
}

async function resolveCategoryId(categoryName: string, tenantId: string): Promise<string | null> {
  const n = categoryName.trim()
  if (!n) return null
  const cats = await listCategories(tenantId)
  const found = cats.find((c: any) => (c.name ?? '').toLowerCase() === n.toLowerCase())
  if (found) return found.id
  const created = await createCategory({ name: n, sort_order: 0 } as any, tenantId)
  return created.id
}

// Витягнути перший валідний укр. телефон із клітинки (може бути "067..., 066..." тощо).
// Повертає нормалізований +380… або null, якщо валідного нема.
function pickPhone(raw: any): string | null {
  const candidates = String(raw ?? '').split(/[,;/]|\bабо\b|\bor\b/i)
  for (const cand of candidates) {
    const n = normalizePhone(cand.trim())
    if (/^\+?380\d{9}$/.test(n)) return n
  }
  return null
}

// Створення одного клієнта (+ авто, якщо є VIN/марка). Телефон НЕ обовʼязковий
// (реальні списки авто-магазину часто мають лише імʼя + авто). Використовується
// поштучно і пакетно.
async function doCreateCustomer(c: any, tenantId: string) {
  const phone = pickPhone(c.phone)

  // Дедуп лише коли телефон є (клієнти без телефону не конфліктують — NULL != NULL)
  if (phone) {
    const { data: existing } = await db
      .from('customers').select('id').eq('tenant_id', tenantId).eq('phone', phone).is('deleted_at', null).maybeSingle()
    if (existing) throw new AppError('PHONE_DUPLICATE', `Клієнт з телефоном ${phone} вже існує`, 409)
  }

  const input: any = { tenant_id: tenantId, phone, tags: [] }
  if (c.full_name) input.full_name = String(c.full_name)
  if (c.email) input.email = String(c.email)
  if (c.notes) input.notes = String(c.notes)

  const { data: customer, error: custErr } = await db.from('customers').insert(input).select('*').single()
  if (custErr) throw new AppError('DB_ERROR', custErr.message, 500)

  // Авто клієнта — не критичне: помилку (напр. дубль VIN) ковтаємо, клієнт лишається створеним
  if (c.vin || c.car_make || c.car_model) {
    const rawVin = typeof c.vin === 'string' ? c.vin.trim().toUpperCase() : ''
    const vin = rawVin.length === 17 ? rawVin : null
    const extraNote = rawVin && !vin ? `VIN: ${rawVin}` : null
    const { error } = await db.from('customer_cars').insert({
      tenant_id: tenantId,
      customer_id: customer.id,
      make: c.car_make ? String(c.car_make) : 'Авто',
      model: c.car_model ? String(c.car_model) : '—',
      year: c.car_year ?? null,
      vin,
      notes: extraNote,
    })
    if (error) logger.warn({ err: error.message, customer: customer.id }, '[ai] car insert skipped')
  }
  return customer
}

export async function applyAction(
  action: { tool: string; payload: Record<string, any> },
  userId: string,
  tenantId: string,
): Promise<{ result: any }> {
  const { tool, payload } = action

  if (tool === 'update_product') {
    const input: Record<string, any> = {}
    if (payload.name !== undefined) input.name = payload.name
    if (payload.description !== undefined) input.notes = payload.description
    if (payload.retail_price_uah !== undefined) input.retail_price = Math.round(Number(payload.retail_price_uah) * 100)
    if (payload.category_id !== undefined) input.category_id = payload.category_id || null
    if (payload.oem_number !== undefined) input.oem_number = payload.oem_number
    if (payload.barcode !== undefined) input.barcode = payload.barcode
    if (payload.storage_bin !== undefined) input.storage_bin = payload.storage_bin
    if (payload.brand_name) input.brand_id = await resolveBrandId(payload.brand_name, tenantId)

    const result = await updateProduct(String(payload.product_id), input as any, userId, tenantId)
    return { result }
  }

  if (tool === 'create_product') {
    const input: Record<string, any> = {
      sku: String(payload.sku),
      name: String(payload.name),
      purchase_price: payload.purchase_price_uah !== undefined ? Math.round(Number(payload.purchase_price_uah) * 100) : 0,
      retail_price: payload.retail_price_uah !== undefined ? Math.round(Number(payload.retail_price_uah) * 100) : 0,
    }
    if (payload.description !== undefined) input.notes = payload.description
    if (payload.category_id) input.category_id = payload.category_id
    if (payload.oem_number) input.oem_number = payload.oem_number
    if (payload.barcode) input.barcode = payload.barcode
    if (payload.brand_name) input.brand_id = await resolveBrandId(payload.brand_name, tenantId)

    const result = await createProduct(input as any, userId, tenantId)
    return { result }
  }

  // ── Клієнти ───────────────────────────────────────────────────────────────
  if (tool === 'create_customer') {
    const result = await doCreateCustomer(payload, tenantId)
    return { result }
  }

  if (tool === 'update_customer') {
    const input: Record<string, any> = {}
    if (payload.full_name !== undefined) input.full_name = payload.full_name
    if (payload.email !== undefined) input.email = payload.email
    if (payload.notes !== undefined) input.notes = payload.notes
    if (payload.phone !== undefined) input.phone = normalizePhone(String(payload.phone))
    const result = await updateCustomer(String(payload.customer_id), input as any, tenantId)
    return { result }
  }

  if (tool === 'create_category') {
    const result = await createCategory({ name: String(payload.name), sort_order: 0 } as any, tenantId)
    return { result }
  }

  // ── Масові дії (пакетне застосування з підсумком) ─────────────────────────
  if (tool === 'create_customers_bulk') {
    const list: any[] = Array.isArray(payload.customers) ? payload.customers : []
    return { result: await runBatch(list, (c) => doCreateCustomer(c, tenantId), (c) => c.full_name || c.phone) }
  }

  if (tool === 'create_categories_bulk') {
    const names: any[] = Array.isArray(payload.names) ? payload.names : []
    return { result: await runBatch(names, (n) => createCategory({ name: String(n), sort_order: 0 } as any, tenantId), (n) => String(n)) }
  }

  if (tool === 'create_products_bulk') {
    const list: any[] = Array.isArray(payload.products) ? payload.products : []
    return {
      result: await runBatch(list, async (p) => {
        const input: Record<string, any> = {
          sku: String(p.sku),
          name: String(p.name),
          purchase_price: p.purchase_price_uah !== undefined ? Math.round(Number(p.purchase_price_uah) * 100) : 0,
          retail_price: p.retail_price_uah !== undefined ? Math.round(Number(p.retail_price_uah) * 100) : 0,
        }
        if (p.oem_number) input.oem_number = p.oem_number
        if (p.brand_name) input.brand_id = await resolveBrandId(String(p.brand_name), tenantId)
        if (p.category_name) input.category_id = await resolveCategoryId(String(p.category_name), tenantId)
        return createProduct(input as any, userId, tenantId)
      }, (p) => p.sku || p.name),
    }
  }

  throw new AppError('VALIDATION_ERROR', 'Невідома дія', 400)
}

// Пакетне виконання: по черзі, кожен запис у своєму try — часткова помилка не валить усе.
async function runBatch<T>(
  items: T[],
  fn: (item: T) => Promise<any>,
  labelOf: (item: T) => string,
): Promise<{ created: number; failed: number; errors: Array<{ item: string; error: string }> }> {
  let created = 0
  const errors: Array<{ item: string; error: string }> = []
  for (const item of items) {
    try { await fn(item); created++ }
    catch (e: any) { errors.push({ item: String(labelOf(item) ?? ''), error: e?.message ?? 'помилка' }) }
  }
  return { created, failed: errors.length, errors: errors.slice(0, 50) }
}
