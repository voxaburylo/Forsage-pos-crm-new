import { z } from 'zod'

const query = z.string().trim().min(1).max(200)
const integer = (max: number, fallback: number) => z.number().finite().int().min(1).max(max).default(fallback)
const schemas: Record<string, z.ZodTypeAny> = {
  search_products: z.object({ query, limit: integer(15, 8) }).strict(),
  search_customers: z.object({ query, limit: integer(20, 10) }).strict(),
  get_product: z.object({ product_id: z.string().uuid() }).strict(),
  list_categories: z.object({}).strict(),
  list_brands: z.object({}).strict(),
  list_products_page: z.object({
    page: integer(10000, 1), per_page: integer(200, 200),
    filter: z.enum(['all', 'russian_names', 'no_category']).default('all'),
  }).strict(),
  find_duplicate_products: z.object({ by: z.enum(['name', 'sku']).default('name'), limit: integer(40, 20) }).strict(),
}

export function parseAiReadArguments(name: string, args: unknown): Record<string, any> {
  if (!Object.hasOwn(schemas, name)) throw new Error('Невідомий інструмент читання.')
  const result = schemas[name].safeParse(args ?? {})
  if (!result.success) throw new Error('Некоректні параметри пошуку. Перевірте запит, цілий номер сторінки та допустимий ліміт.')
  return result.data
}

// Per user request, not global: a new request gets a fresh budget.
// Reserve the whole model response before running any of its tools.
export function createAiToolBudget(maxCalls = 40) {
  let used = 0
  return (count: number): void => {
    if (!Number.isSafeInteger(count) || count < 0 || used + count > maxCalls) {
      throw new Error('Забагато дій в одному запиті ШІ. Звузьте запит і повторіть.')
    }
    used += count
  }
}
