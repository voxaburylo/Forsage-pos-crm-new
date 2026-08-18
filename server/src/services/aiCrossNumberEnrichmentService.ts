import { createHash, randomUUID } from 'node:crypto'
import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { db } from '../db/supabase.js'
import { logger } from '../lib/logger.js'
import { clearProductSearchCache, catalogCodesFromName } from './productService.js'
import { groundedSourceLabel, isPlaceholderSku, normalizedNameContains, safeCatalogNumber } from './aiCrossNumberRules.js'
import { getAiConfig, recordAiUsage } from './aiService.js'

const BATCH_SIZE = 5
const MIN_CROSS_CONFIDENCE = 0.9
const MIN_PRIMARY_CONFIDENCE = 0.95

type ClaimedProduct = {
  tenant_id: string
  product_id: string
  source_fingerprint: string
  sku: string
  name: string
  oem_number: string | null
  supplier_article: string | null
  brand_name: string | null
}

const crossCandidateSchema = z.object({
  number: z.string().trim().min(1).max(100),
  brand: z.string().trim().min(1).max(100),
  number_type: z.enum(['cross', 'oe']),
  evidence_index: z.number().int().min(0).max(1000),
  confidence: z.number().min(0).max(1),
})

const enrichmentProductSchema = z.object({
  product_id: z.string().min(1).max(200),
  primary_catalog_number: z.string().trim().max(100).nullable().optional(),
  primary_confidence: z.number().min(0).max(1).default(0),
  primary_evidence_index: z.number().int().min(0).max(1000).nullable().optional(),
  cross_numbers: z.array(crossCandidateSchema).max(100).default([]),
})

const enrichmentResponseSchema = z.object({
  products: z.array(enrichmentProductSchema).max(BATCH_SIZE),
})

const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          product_id: { type: 'string' },
          primary_catalog_number: { type: ['string', 'null'] },
          primary_confidence: { type: 'number' },
          primary_evidence_index: { type: ['integer', 'null'] },
          cross_numbers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                number: { type: 'string' },
                brand: { type: 'string' },
                number_type: { type: 'string', enum: ['cross', 'oe'] },
                evidence_index: { type: 'integer' },
                confidence: { type: 'number' },
              },
              required: ['number', 'brand', 'number_type', 'evidence_index', 'confidence'],
            },
          },
        },
        required: [
          'product_id',
          'primary_catalog_number',
          'primary_confidence',
          'primary_evidence_index',
          'cross_numbers',
        ],
      },
    },
  },
  required: ['products'],
} as const
function productFingerprint(product: ClaimedProduct, sku: string): string {
  return createHash('md5')
    .update([
      product.name ?? '',
      sku ?? '',
      product.oem_number ?? '',
      product.supplier_article ?? '',
      product.brand_name ?? '',
    ].join('|'))
    .digest('hex')
}

function inputCatalogNumbers(product: ClaimedProduct): string[] {
  const values = new Set<string>()
  if (!isPlaceholderSku(product.sku)) {
    const sku = safeCatalogNumber(product.sku)
    if (sku) values.add(sku)
  }
  for (const raw of [product.oem_number, product.supplier_article]) {
    const code = safeCatalogNumber(raw)
    if (code) values.add(code)
  }
  for (const raw of catalogCodesFromName(product.name)) {
    const code = safeCatalogNumber(raw)
    if (code) values.add(code)
  }
  return [...values].slice(0, 12)
}

function buildPrompt(products: ClaimedProduct[]): string {
  const product = products[0]
  if (!product) return ''
  const codes = inputCatalogNumbers(product)
  const exactQueries = codes.map((code) => `"${code}" cross reference MANN WIX MAHLE OE`).join('\n')

  return `You MUST use Google Search now. Research this one automotive spare part and cite every factual relationship with URL citations.

Product name: ${product.name}
Brand: ${product.brand_name ?? 'unknown'}
Current article: ${isPlaceholderSku(product.sku) ? 'missing' : product.sku}
OEM: ${product.oem_number ?? 'missing'}
Supplier article: ${product.supplier_article ?? 'missing'}
Candidate catalog numbers found in the card: ${codes.join(', ')}

Run searches equivalent to:
${exactQueries}

Find only exact, explicitly documented interchangeable cross references from established manufacturers such as MANN-FILTER, WIX Filters, MAHLE/KNECHT, Bosch, Filtron, Hengst and Purflux, plus original-equipment OE numbers.
Also identify the main catalog number only if it is visibly present in the product name.
Never treat a barcode, vehicle model, year, dimension, voltage, volume, oil grade, quantity or AUTO-* placeholder as a catalog number.
Do not infer compatibility from similar names or vehicle applications. Do not use marketplaces, social networks or search-result pages as evidence.
Return a concise research report, not JSON. If no source explicitly confirms a relationship, say that no verified cross reference was found.`
}
async function updateState(
  product: ClaimedProduct,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from('product_cross_enrichment_state')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('tenant_id', product.tenant_id)
    .eq('product_id', product.product_id)
    .eq('source_fingerprint', product.source_fingerprint)

  if (error) throw new Error(`Не вдалося оновити стан фонового пошуку: ${error.message}`)
}

async function markFailed(products: ClaimedProduct[], error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
  const retryAt = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString()
  await Promise.all(products.map((product) => updateState(product, {
    status: 'failed',
    next_retry_at: retryAt,
    locked_at: null,
    locked_by: null,
    last_error: message,
  }).catch((stateError) => {
    logger.error({ productId: product.product_id, error: stateError }, '[ai-cross] failed to record failure')
  })))
}

export async function callGemini(products: ClaimedProduct[], apiKey: string, model: string) {
  const ai = new GoogleGenAI({ apiKey })
  const searchInteraction = await ai.interactions.create({
    model,
    input: buildPrompt(products),
    tools: [{ type: 'google_search' }],
  })

  const sourceByUri = new Map<string, { title: string; uri: string }>()
  const reportParts: string[] = []
  for (const step of searchInteraction.steps ?? []) {
    if (step.type !== 'model_output') continue
    for (const content of step.content ?? []) {
      if (content.type !== 'text') continue
      reportParts.push(content.text)
      for (const annotation of content.annotations ?? []) {
        if (annotation.type !== 'url_citation' || !annotation.url) continue
        if (!sourceByUri.has(annotation.url)) {
          sourceByUri.set(annotation.url, {
            title: annotation.title ?? '',
            uri: annotation.url,
          })
        }
      }
    }
  }
  const searchReport = reportParts.join('\n')
  const sources = [...sourceByUri.values()]
  if (sources.length === 0) {
    await recordAiUsage(
      products[0].tenant_id,
      null,
      model,
      searchInteraction.usage?.total_input_tokens ?? 0,
      searchInteraction.usage?.total_output_tokens ?? 0,
    )
    return { products: [], sources: [] }
  }

  const extractionPrompt = `Convert the grounded research below into the required JSON schema.
Use only claims explicitly present in the grounded report. Do not search again and do not add knowledge.
Every primary number and every cross number must reference evidence_index from the supplied sources array.
Use an index only if that exact source explicitly supports the exact catalog-number relationship.
If no source supports a candidate, omit it. Return exactly one product result per input product_id.

Original product input:
${buildPrompt(products)}

Grounded report:
${searchReport}

Sources (zero-based evidence_index):
${JSON.stringify(sources.map((source, evidence_index) => ({ evidence_index, ...source })))}`

  const extractionResponse = await ai.models.generateContent({
    model,
    contents: extractionPrompt,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: RESPONSE_JSON_SCHEMA,
      temperature: 0,
    },
  })

  const parsed = enrichmentResponseSchema.safeParse(JSON.parse(extractionResponse.text ?? '{}'))
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.code).join(', ')
    throw new Error('Gemini повернув некоректну структуру крос-номерів: ' + issues)
  }
  logger.info({
    sources: sources.length,
    products: parsed.data.products.length,
    candidates: parsed.data.products.reduce((sum, item) => sum + item.cross_numbers.length, 0),
  }, '[ai-cross] grounded response parsed')

  await recordAiUsage(
    products[0].tenant_id,
    null,
    model,
    (searchInteraction.usage?.total_input_tokens ?? 0)
      + (extractionResponse.usageMetadata?.promptTokenCount ?? 0),
    (searchInteraction.usage?.total_output_tokens ?? 0)
      + (extractionResponse.usageMetadata?.candidatesTokenCount ?? 0),
  )

  const normalizedProducts = parsed.data.products.slice(0, products.length).map((item, index) => ({
    ...item,
    product_id: products[index]?.product_id ?? item.product_id,
    cross_numbers: [...item.cross_numbers]
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, 30),
  }))
  return { products: normalizedProducts, sources }
}
async function saveProductResult(
  product: ClaimedProduct,
  result: z.infer<typeof enrichmentProductSchema> | undefined,
  sources: Array<{ title: string; uri: string }>,
): Promise<{ added: number; skuUpdated: boolean }> {
  if (!result) {
    await updateState(product, {
      status: 'no_match',
      result_count: 0,
      processed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    return { added: 0, skuUpdated: false }
  }

  const sourceNumbers = new Set(inputCatalogNumbers(product))
  const rowsByNumber = new Map<string, Record<string, unknown>>()
  for (const candidate of result.cross_numbers) {
    if (candidate.confidence < MIN_CROSS_CONFIDENCE) continue
    const normalized = safeCatalogNumber(candidate.number)
    const source = sources[candidate.evidence_index]
    const sourceLabel = source ? groundedSourceLabel(source.title, source.uri) : null
    if (!normalized || !sourceLabel || sourceNumbers.has(normalized) || rowsByNumber.has(normalized)) continue

    rowsByNumber.set(normalized, {
      tenant_id: product.tenant_id,
      product_id: product.product_id,
      number: candidate.number.trim(),
      normalized_number: normalized,
      number_type: candidate.number_type,
      brand: candidate.brand.trim(),
      source: `AI Gemini · ${sourceLabel}`.slice(0, 200),
      is_verified: false,
      created_by: null,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    })
  }

  logger.info({
    productId: product.product_id,
    candidates: result.cross_numbers.length,
    accepted: rowsByNumber.size,
    primaryCandidate: Boolean(result.primary_catalog_number),
  }, '[ai-cross] product candidates filtered')

  let added = 0
  if (rowsByNumber.size > 0) {
    const { data, error } = await db
      .from('product_cross_numbers')
      .upsert([...rowsByNumber.values()], {
        onConflict: 'tenant_id,product_id,normalized_number',
        ignoreDuplicates: true,
      })
      .select('id')

    if (error) throw new Error(`Не вдалося зберегти крос-номери: ${error.message}`)
    added = data?.length ?? 0
  }

  let skuUpdated = false
  const primaryNumber = safeCatalogNumber(result.primary_catalog_number)
  const primarySource = result.primary_evidence_index == null ? null : sources[result.primary_evidence_index]
  const primarySourceLabel = primarySource ? groundedSourceLabel(primarySource.title, primarySource.uri) : null
  if (
    isPlaceholderSku(product.sku)
    && primaryNumber
    && primarySourceLabel
    && result.primary_confidence >= MIN_PRIMARY_CONFIDENCE
    && normalizedNameContains(product.name, primaryNumber)
  ) {
    const { data, error } = await db.rpc('set_product_sku_from_ai', {
      p_tenant_id: product.tenant_id,
      p_product_id: product.product_id,
      p_expected_sku: product.sku,
      p_new_sku: primaryNumber,
    })
    if (error) throw new Error(`Не вдалося записати основний артикул: ${error.message}`)
    skuUpdated = data === true
  }

  const finalFingerprint = skuUpdated
    ? productFingerprint(product, primaryNumber!)
    : product.source_fingerprint
  const status = rowsByNumber.size > 0 || skuUpdated ? 'completed' : 'no_match'
  const { error: stateError } = await db
    .from('product_cross_enrichment_state')
    .update({
      source_fingerprint: finalFingerprint,
      status,
      result_count: added,
      processed_at: new Date().toISOString(),
      next_retry_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', product.tenant_id)
    .eq('product_id', product.product_id)
    .eq('source_fingerprint', product.source_fingerprint)

  if (stateError) throw new Error(`Не вдалося завершити фоновий пошук: ${stateError.message}`)
  return { added, skuUpdated }
}

export type AiCrossEnrichmentSummary = {
  claimed: number
  processed: number
  added: number
  sku_updated: number
  failed: number
}

export async function runAiCrossNumberEnrichment(): Promise<AiCrossEnrichmentSummary> {
  const workerId = `vercel-cron-${randomUUID()}`
  const { data, error } = await db.rpc('claim_product_cross_enrichment', {
    p_worker_id: workerId,
    p_batch_size: BATCH_SIZE,
  })
  if (error) throw new Error(`Не вдалося отримати товари для фонового пошуку: ${error.message}`)

  const products = (data ?? []) as ClaimedProduct[]
  if (products.length === 0) {
    return { claimed: 0, processed: 0, added: 0, sku_updated: 0, failed: 0 }
  }

  try {
    const searchableProducts = products.filter((product) => inputCatalogNumbers(product).length > 0)
    let cfg: Awaited<ReturnType<typeof getAiConfig>> | null = null
    if (searchableProducts.length > 0) {
      cfg = await getAiConfig(products[0].tenant_id)
      if (!cfg.enabled || !cfg.apiKey) throw new Error('Gemini вимкнено або API-ключ не налаштовано')
    }

    let processed = 0
    let added = 0
    let skuUpdated = 0
    let failed = 0

    for (const product of products) {
      try {
        let result: z.infer<typeof enrichmentProductSchema> | undefined
        let sources: Array<{ title: string; uri: string }> = []
        if (inputCatalogNumbers(product).length > 0 && cfg?.apiKey) {
          const response = await callGemini([product], cfg.apiKey, cfg.model)
          result = response.products.find((item) => item.product_id === product.product_id)
          sources = response.sources
        }

        const saved = await saveProductResult(product, result, sources)
        processed += 1
        added += saved.added
        if (saved.skuUpdated) skuUpdated += 1
      } catch (productError) {
        failed += 1
        await markFailed([product], productError)
        logger.warn({ productId: product.product_id, error: productError }, '[ai-cross] product enrichment failed')
      }
    }

    if (added > 0 || skuUpdated > 0) await clearProductSearchCache()
    logger.info({ claimed: products.length, processed, added, skuUpdated, failed }, '[ai-cross] batch completed')
    return { claimed: products.length, processed, added, sku_updated: skuUpdated, failed }  } catch (batchError) {
    await markFailed(products, batchError)
    throw batchError
  }
}
