import { Router } from 'express'
import { createHash } from 'node:crypto'
import { db } from '../db/supabase.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'
import { BACKUP_BUCKET, MAX_BACKUP_BYTES, backupDescriptor } from '../services/backupPolicy.js'

const router = Router()
router.use(requireAuth)
async function privateBucket() {
  let result = await db.storage.getBucket(BACKUP_BUCKET)
  if (result.error) {
    await db.storage.createBucket(BACKUP_BUCKET, { public: false, fileSizeLimit: MAX_BACKUP_BYTES, allowedMimeTypes: ['application/gzip','application/json'] })
    result = await db.storage.getBucket(BACKUP_BUCKET)
  }
  if (result.error || !result.data) throw new AppError('BACKUP_STORAGE_UNAVAILABLE', 'Сховище резервних копій недоступне', 503)
  if (result.data.public) throw new AppError('BACKUP_BUCKET_PUBLIC', 'Зупинено резервування: сховище має бути приватним', 503)
}
router.post('/prepare', requireRole('owner','admin','cashier'), async (req,res,next) => {
  try {
    const item = backupDescriptor(req.body, req.user!.tenant_id)
    await privateBucket()
    const existing = await db.storage.from(BACKUP_BUCKET).download(item.path)
    if (existing.data) {
      if (existing.data.size !== item.size_bytes || createHash('sha256').update(Buffer.from(await existing.data.arrayBuffer())).digest('hex') !== item.sha256)
        throw new AppError('BACKUP_CONFLICT','Існуюча копія не збігається. Автоматичний перезапис заборонено.',409)
      res.json({data:{already_uploaded:true}})
      return
    }
    const { data,error } = await db.storage.from(BACKUP_BUCKET).createSignedUploadUrl(item.path, { upsert: false })
    if (error || !data) throw new AppError('BACKUP_UPLOAD_DENIED','Не вдалося підготувати завантаження копії',503)
    res.json({ data: { signed_url: data.signedUrl } })
  } catch(error) { next(error) }
})
router.post('/verify', requireRole('owner','admin','cashier'), async (req,res,next) => {
  try {
    const item = backupDescriptor(req.body, req.user!.tenant_id)
    await privateBucket()
    const { data,error } = await db.storage.from(BACKUP_BUCKET).download(item.path)
    if (error || !data || data.size !== item.size_bytes) throw new AppError('BACKUP_INCOMPLETE','Резервна копія завантажена не повністю',422)
    const bytes = Buffer.from(await data.arrayBuffer())
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
      throw new AppError('BACKUP_CHECKSUM','Контрольна сума резервної копії не збігається',422)
    const manifest = { ...item, verified_at: new Date().toISOString(), closed_at: String(req.body.closed_at ?? ''), captured_at: String(req.body.captured_at ?? '') }
    const saved = await db.storage.from(BACKUP_BUCKET).upload(item.path+'.json', JSON.stringify(manifest), { contentType:'application/json',upsert:true })
    if (saved.error) throw new AppError('BACKUP_MANIFEST','Не вдалося підтвердити копію',503)
    // Only this device's verified shift copies; retain seven, newest first.
    const folder = item.tenant_id+'/'+item.device_id
    const listed = await db.storage.from(BACKUP_BUCKET).list(folder, { limit:1000,sortBy:{column:'created_at',order:'desc'} })
    const verified = (listed.data ?? []).filter(file => /^[a-f0-9-]{36}-[a-f0-9]{64}\.db\.gz\.json$/i.test(file.name))
    if (!listed.error && verified.length > 7) {
      const obsolete = verified.slice(7).filter(file=>folder+'/'+file.name !== item.path+'.json')
      if (obsolete.length) await db.storage.from(BACKUP_BUCKET).remove(obsolete.flatMap(file=>[folder+'/'+file.name,folder+'/'+file.name.slice(0,-5)]))
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
      for(const file of files.data ?? []) if(/^[a-f0-9-]{36}-[a-f0-9]{64}\.db\.gz\.json$/i.test(file.name)) {
        result.push({device_id:device.name,name:file.name.slice(0,-5),created_at:file.created_at})
      }
    }
    res.json({data:result})
  }catch(error){next(error)}
})
router.post('/download',requireRole('owner','admin'),async(req,res,next)=>{
  try {
    const item=backupDescriptor(req.body,req.user!.tenant_id)
    await privateBucket()
    const verified=await db.storage.from(BACKUP_BUCKET).download(item.path+'.json')
    if(verified.error || !verified.data) throw new AppError('BACKUP_NOT_VERIFIED','Перевірену копію не знайдено',404)
    const signed=await db.storage.from(BACKUP_BUCKET).createSignedUrl(item.path,60)
    if(signed.error||!signed.data) throw new AppError('BACKUP_DOWNLOAD','Не вдалося відкрити копію',503)
    res.json({data:{url:signed.data.signedUrl}})
  }catch(error){next(error)}
})
export default router
