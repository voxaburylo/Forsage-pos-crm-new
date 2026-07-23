export const CATALOG_DELETE_ROLES = ['owner', 'admin'] as const

export function canDeleteCatalog(role: string | null | undefined): boolean {
  return Boolean(role && CATALOG_DELETE_ROLES.includes(role as (typeof CATALOG_DELETE_ROLES)[number]))
}

export async function performCatalogDelete<T>(
  role: string | null | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!canDeleteCatalog(role)) {
    throw new Error('Видаляти товари, категорії та бренди може лише власник або адміністратор')
  }
  return operation()
}
