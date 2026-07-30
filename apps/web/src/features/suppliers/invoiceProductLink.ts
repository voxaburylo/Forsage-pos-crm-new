function isMissingProductError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown }
  if (Number(candidate.status) === 404) return true
  if (String(candidate.code ?? '').toUpperCase() === 'PRODUCT_NOT_FOUND') return true
  return /товар не знайдено|product not found/i.test(String(candidate.message ?? ''))
}

/**
 * A saved invoice row may point to a product that another device deleted.
 * Only a definite "not found" turns the row back into a new/restorable item;
 * network and server errors must still stop posting instead of creating a
 * duplicate card.
 */
export async function resolveActiveLinkedInvoiceProduct<T>(
  productId: string,
  load: (productId: string) => Promise<T>,
): Promise<T | null> {
  try {
    return await load(productId)
  } catch (error) {
    if (isMissingProductError(error)) return null
    throw error
  }
}
