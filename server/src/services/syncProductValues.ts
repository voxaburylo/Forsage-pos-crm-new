const PRODUCT_INSERT_PARAMETER_COUNT = 23

/**
 * Keeps INSERT and UPDATE parameter lists explicit. The UPDATE has one extra
 * stock-correction flag; passing it to INSERT caused every new offline product
 * to fail with a PostgreSQL parameter-count error.
 */
export function buildProductSyncQueryValues(
  insertValues: unknown[],
  stockCorrection: boolean,
): { insertValues: unknown[]; updateValues: unknown[] } {
  if (insertValues.length !== PRODUCT_INSERT_PARAMETER_COUNT) {
    throw new Error(
      `SYNC_PRODUCT_PARAMETER_COUNT: expected ${PRODUCT_INSERT_PARAMETER_COUNT}, got ${insertValues.length}`,
    )
  }
  return {
    insertValues,
    updateValues: [...insertValues, stockCorrection],
  }
}
