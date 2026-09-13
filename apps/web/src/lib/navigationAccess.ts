const WEB_ROUTES = new Set(['/products', '/customers', '/analytics', '/analytics/statistics', '/analytics/sales', '/analytics/payroll', '/reports', '/dashboard', '/sales', '/abc', '/staff-analytics'])
export function navigationAllowed(path: string, desktop: boolean): boolean { return desktop || WEB_ROUTES.has(path) }
