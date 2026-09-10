export const BACKUP_BUCKET = 'forsage-private-backups'
export const MAX_BACKUP_BYTES = 45 * 1024 * 1024
export function backupDescriptor(body: any, tenantId: string) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  if (!uuid.test(tenantId) || !uuid.test(String(body?.device_id)) || !uuid.test(String(body?.id))
    || !/^[a-f0-9]{64}$/.test(String(body?.sha256))
    || !Number.isSafeInteger(body?.size_bytes) || body.size_bytes < 1 || body.size_bytes > MAX_BACKUP_BYTES
    || body.tenant_id !== tenantId) throw new Error('Некоректні параметри резервної копії')
  return {
    id: body.id as string, device_id: body.device_id as string, tenant_id: tenantId,
    sha256: body.sha256 as string, size_bytes: body.size_bytes as number,
    path: tenantId + '/' + body.device_id + '/' + body.id + '-' + body.sha256 + '.db.gz',
  }
}
