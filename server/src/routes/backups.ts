import { Router } from 'express'
import { createHash } from 'node:crypto'
import { db } from '../db/supabase.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { BACKUP_BUCKET, BACKUP_MIME_TYPES, MAX_BACKUP_BYTES, MAX_BACKUP_PARTS, VERIFIED_BACKUP_NAME, backupDescriptor, backupFormatOfName, backupPartPath, backupPartSize, backupsToKeep, hasArchiveMagic } from '../services/backupPolicy.js'

const router = Router()
router.use(requireAuth)
async function privateBucket() {
  let result = await db.storage.getBucket(BACKUP_BUCKET)
  if (result.error) {
    await db.storage.createBucket(BACKUP_BUCKET, { public: false, fileSizeLimit: MAX_BACKUP_BYTES, allowedMimeTypes: BACKUP_MIME_TYPES })
    result = await db.storage.getBucket(BACKUP_BUCKET)
  }
  // 22.11.2026: нові копії стиснені Zstandard. Сховище, створене раніше, приймало лише gzip — дозволяємо й новий тип.
  const allowed = (result.data as { allowed_mime_types?: string[] | null } | null)?.allowed_mime_types
  if (result.data && !result.data.public && Array.isArray(allowed) && BACKUP_MIME_TYPES.some(type => !allowed.includes(type))) {
    const updated = await db.storage.updateBucket(BACKUP_BUCKET, { public: false, fileSizeLimit: MAX_BACKUP_BYTES, allowedMimeTypes: BACKUP_MIME_TYPES })
    if (updated.error) throw new AppError('BACKUP_STORAGE_UNAVAILABLE', 'Не вдалося підготувати сховище до нового формату копій', 503)
  }
  if (result.error || !result.data) throw new AppError('BACKUP_STORAGE_UNAVAILABLE', 'Сховище резервних копій недоступне', 503)
  if (result.data.public) throw new AppError('BACKUP_BUCKET_PUBLIC', 'Зупинено резервування: сховище має бути приватним', 503)
}
router.post('/prepare', requireRole('owner','admin','cashier'), async (req,res,next) => {
  try {
    const item = backupDescriptor(req.body, req.user!.tenant_id)
    // 24.11.2026 (план C10): велика копія — лише частинами; кожна частина звіряється своєю сумою.
    if (item.parts > 1 && !item.part) throw new AppError('VALIDATION_ERROR','Велику копію надсилають частинами',422)
    const target = item.part ? backupPartPath(item.path, item.part.index) : item.path
    const expectedSize = item.part ? item.part.size_bytes : item.size_bytes
    const expectedSha = item.part ? item.part.sha256 : item.sha256
    await privateBucket()
    const existing = await db.storage.from(BACKUP_BUCKET).download(target)
    if (existing.data) {
      if (existing.data.size !== expectedSize || createHash('sha256').update(Buffer.from(await existing.data.arrayBuffer())).digest('hex') !== expectedSha)
        throw new AppError('BACKUP_CONFLICT','Існуюча копія не збігається. Автоматичний перезапис заборонено.',409)
      res.json({data:{already_uploaded:true}})
      return
    }
    const { data,error } = await db.storage.from(BACKUP_BUCKET).createSignedUploadUrl(target, { upsert: false })
    if (error || !data) throw new AppError('BACKUP_UPLOAD_DENIED','Не вдалося підготувати завантаження копії',503)
    res.json({ data: { signed_url: data.signedUrl } })
  } catch(error) { next(error) }
})
router.post('/verify', requireRole('owner','admin','cashier'), async (req,res,next) => {
  try {
    const item = backupDescriptor({ ...req.body, part: undefined }, req.user!.tenant_id)
    await privateBucket()
    // 24.11.2026 (план C10): частини читаються по одній, сума рахується від усього архіву.
    const hash = createHash('sha256')
    for (let index = 1; index <= item.parts; index += 1) {
      const target = item.parts > 1 ? backupPartPath(item.path, index) : item.path
      const expectedSize = item.parts > 1 ? backupPartSize(item.size_bytes, index) : item.size_bytes
      const { data,error } = await db.storage.from(BACKUP_BUCKET).download(target)
      if (error || !data || data.size !== expectedSize) throw new AppError('BACKUP_INCOMPLETE','Резервна копія завантажена не повністю',422)
      const bytes = Buffer.from(await data.arrayBuffer())
      if (index === 1 && !hasArchiveMagic(bytes, item.format)) throw new AppError('BACKUP_CHECKSUM','Контрольна сума резервної копії не збігається',422)
      hash.update(bytes)
    }
    if (hash.digest('hex') !== item.sha256) throw new AppError('BACKUP_CHECKSUM','Контрольна сума резервної копії не збігається',422)
    const manifest = { ...item, part: undefined, verified_at: new Date().toISOString(), closed_at: String(req.body.closed_at ?? ''), captured_at: String(req.body.captured_at ?? '') }
    const saved = await db.storage.from(BACKUP_BUCKET).upload(item.path+'.json', JSON.stringify(manifest), { contentType:'application/json',upsert:true })
    if (saved.error) throw new AppError('BACKUP_MANIFEST','Не вдалося підтвердити копію',503)
    // Лише перевірені копії цього пристрою. Лишаємо 7 днів + 4 тижні + 6 місяців (backupsToKeep), решту прибираємо.
    const folder = item.tenant_id+'/'+item.device_id
    const listed = await db.storage.from(BACKUP_BUCKET).list(folder, { limit:1000,sortBy:{column:'created_at',order:'desc'} })
    const verified = (listed.data ?? []).filter(file => VERIFIED_BACKUP_NAME.test(file.name))
    if (!listed.error) {
      const keep = backupsToKeep(verified)
      const obsolete = verified.filter(file => !keep.has(file.name) && folder+'/'+file.name !== item.path+'.json')
      if (obsolete.length) await db.storage.from(BACKUP_BUCKET).remove(obsolete.flatMap(file=>{
        const base = folder+'/'+file.name.slice(0,-5)
        // Разом із копією — і її частини, якщо вона велика (план C10).
        return [folder+'/'+file.name, base, ...Array.from({ length: MAX_BACKUP_PARTS }, (_, index) => backupPartPath(base, index + 1))]
      }))
    }
    res.json({ data: { sha256: item.sha256 } })
  } catch(error) { next(error) }
})
router.get('/', requireRole('owner','admin'), async(req,res,next)=>{
  try {
    await privateBucket()
    const devices = await db.storage.from(BACKUP_BUCKET).list(req.user!.tenant_id,{limit:1000})
    if(devices.error) throw devices.error
    const result: unknown[]=[]
    for(const device of devices.data ?? []) {
      if(!/^[a-f0-9-]{36}$/i.test(device.name)) continue
      const files=await db.storage.from(BACKUP_BUCKET).list(req.user!.tenant_id+'/'+device.name,{limit:1000})
      if(files.error) throw files.error
      const sizes = new Map((files.data ?? []).map(file => [file.name, Number((file as any).metadata?.size) || 0]))
      for(const file of files.data ?? []) if(VERIFIED_BACKUP_NAME.test(file.name)) {
        const name = file.name.slice(0,-5)
        // Усе, що потрібно для аварійного відновлення: id, контрольна сума, розмір і формат архіву.
        // Велика копія лежить частинами: розмір — сума частин (план C10).
        const partSizes = Array.from({ length: MAX_BACKUP_PARTS }, (_, index) => sizes.get(name + '.part' + String(index + 1).padStart(2, '0'))).filter((size): size is number => typeof size === 'number' && size > 0)
        const size = sizes.get(name) || partSizes.reduce((sum, value) => sum + value, 0)
        result.push({device_id:device.name,name,created_at:file.created_at,id:name.slice(0,36),sha256:name.slice(37,101),size_bytes:size,format:backupFormatOfName(name),parts:sizes.get(name) ? 1 : partSizes.length})
      }
    }
    res.json({data:result})
  }catch(error){next(error)}
})
router.post('/download',requireRole('owner','admin'),async(req,res,next)=>{
  try {
    // Розмір архіву перевіряє сама програма за контрольною сумою; сервер бере його зі сховища, а не з тіла запиту.
    const requested = { ...req.body, tenant_id: req.user!.tenant_id, size_bytes: Number.isSafeInteger(req.body?.size_bytes) && req.body.size_bytes > 0 ? req.body.size_bytes : 1 }
    const item=backupDescriptor(requested,req.user!.tenant_id)
    await privateBucket()
    const verified=await db.storage.from(BACKUP_BUCKET).download(item.path+'.json')
    if(verified.error || !verified.data) throw new AppError('BACKUP_NOT_VERIFIED','Перевірену копію не знайдено',404)
    // 24.11.2026 (план C10): велика копія — адреса на кожну частину; кількість частин — з перевіреного маніфесту.
    let parts = 1
    try { const manifest = JSON.parse(await verified.data.text()) as { parts?: unknown }; if (Number.isInteger(manifest.parts) && Number(manifest.parts) > 1 && Number(manifest.parts) <= MAX_BACKUP_PARTS) parts = Number(manifest.parts) } catch { /* старий маніфест — один файл */ }
    if (parts > 1) {
      const urls: string[] = []
      for (let index = 1; index <= parts; index += 1) {
        const signed = await db.storage.from(BACKUP_BUCKET).createSignedUrl(backupPartPath(item.path, index), 120)
        if (signed.error || !signed.data) throw new AppError('BACKUP_DOWNLOAD','Не вдалося відкрити копію',503)
        urls.push(signed.data.signedUrl)
      }
      res.json({data:{urls,parts}})
      return
    }
    const signed=await db.storage.from(BACKUP_BUCKET).createSignedUrl(item.path,60)
    if(signed.error||!signed.data) throw new AppError('BACKUP_DOWNLOAD','Не вдалося відкрити копію',503)
    res.json({data:{url:signed.data.signedUrl}})
  }catch(error){next(error)}
})
export default router
