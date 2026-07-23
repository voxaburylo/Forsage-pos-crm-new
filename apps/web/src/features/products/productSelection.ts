interface SelectableProduct {
  id: string
}

export function areAllDisplayedProductsSelected(
  products: readonly SelectableProduct[],
  selectedIds: ReadonlySet<string>,
): boolean {
  return products.length > 0 && products.every((product) => selectedIds.has(product.id))
}

export function toggleDisplayedProductsSelection(
  products: readonly SelectableProduct[],
  selectedIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selectedIds)
  const shouldClear = areAllDisplayedProductsSelected(products, selectedIds)

  for (const product of products) {
    if (shouldClear) next.delete(product.id)
    else next.add(product.id)
  }

  return next
}
