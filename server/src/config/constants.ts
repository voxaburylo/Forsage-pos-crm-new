// MVP: single-tenant deployment. Services use this as default.
// Routes should prefer req.user!.tenant_id for proper multi-tenant support.
export const MVP_TENANT_ID = '00000000-0000-0000-0000-000000000001'
