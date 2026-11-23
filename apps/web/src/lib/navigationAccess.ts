const WEB_ROUTES = new Set(['/products', '/customers', '/analytics', '/analytics/statistics', '/analytics/sales', '/analytics/payroll', '/analytics/control', '/reports', '/dashboard', '/sales', '/abc', '/staff-analytics', '/orders', '/invoice-photo', '/system'])
/**
 * 22.11.2026, рішення власника «веб повний, але тільки через головний ПК»: ці розділи у вебі відкриваються,
 * коли головний ПК на звʼязку (див. TillOnly), і кожна дія виконується на ньому. Каса (продаж) і друк — лише на касі.
 */
export const WEB_VIA_MAIN_PC_ROUTES = new Set(['/suppliers/invoices', '/inventory', '/suppliers', '/auto-purchase', '/internal',
  '/inventory/picking', '/waitlist', '/ai-assistant', '/ai-agent', '/staff', '/settings'])
export function navigationAllowed(path: string, desktop: boolean): boolean {
  return desktop || WEB_ROUTES.has(path) || WEB_VIA_MAIN_PC_ROUTES.has(path)
}
