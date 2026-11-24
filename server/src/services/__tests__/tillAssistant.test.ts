import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assistantActor, DEVICE_AI_DENIED } from '../tillAssistantActor.js'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 24.11.2026 (власник: «прибери пароль у ШІ-помічнику»): помічник на головному ПК ходить ключем самого ПК.
describe('the assistant on the main PC works with the PC key', () => {
  const device = { tenant_id: 'tenant-1', created_by: '11111111-1111-4111-8111-111111111111' }

  it('acts as the user who issued the key, in the key tenant, with the role the till names', () => {
    expect(assistantActor(device, 'cashier')).toEqual({ id: device.created_by, email: '', role: 'cashier', tenant_id: 'tenant-1' })
    expect(assistantActor(device, 'owner').role).toBe('owner')
  })

  it('refuses roles the assistant is closed for, a missing role and a key without an author', () => {
    for (const role of ['storekeeper', 'sto_viewer', 'tire_worker', '', undefined, 'OWNER', 'owner,admin']) {
      expect(() => assistantActor(device, role)).toThrow('Помічник доступний')
    }
    expect(() => assistantActor({ tenant_id: 'tenant-1', created_by: null }, 'owner')).toThrow('без автора')
  })

  it('the AI key and its test stay with the owner signed in himself', () => {
    expect([...DEVICE_AI_DENIED].sort()).toEqual(['/config', '/test'])
    const routes = read('../../routes/tillDevice.ts')
    expect(routes).toContain("tillDeviceRouter.use('/ai', requireTillDevice, actAsTillStaff, (req, _res, next) => {\n  if (DEVICE_AI_DENIED.has(req.path)) return next(new AppError('FORBIDDEN'")
    expect(routes).toContain("tillDeviceRouter.use('/vin', requireTillDevice, actAsTillStaff, vinRouter)")
    expect(routes).toContain("tillDeviceRouter.post('/assistant-upload', requireTillDevice, actAsTillStaff,")
  })

  it('only the server sets the actor: the key is checked first, and the header never becomes a user by itself', () => {
    const auth = read('../../middleware/auth.ts')
    expect(auth).toContain('if (req.tillDeviceActor) {\n    req.user = req.tillDeviceActor\n    return next()\n  }')
    // Поле ставиться в одному місці — після перевірки ключа ПК.
    const sources = ['../../routes/tillDevice.ts', '../../middleware/auth.ts', '../../index.ts', '../../routes/ai.ts', '../../routes/vin.ts'].map(read).join('\n')
    expect(sources.match(/tillDeviceActor = /g)).toHaveLength(1)
    expect(read('../../routes/tillDevice.ts')).toContain("req.tillDeviceActor = assistantActor(req.tillDevice!, req.get('x-forsage-staff-role'))")
  })

  it('the photo of an invoice fits: body limits are set before the general till-device limit', () => {
    const index = read('../../index.ts')
    const chat = index.indexOf("app.use('/api/v1/till-device/ai/chat', express.json({ limit: '25mb' }))")
    const upload = index.indexOf("app.use('/api/v1/till-device/assistant-upload', express.json({ limit: '18mb' }))")
    const general = index.indexOf("app.use('/api/v1/till-device', express.json({ limit: '4mb' }))")
    expect(chat).toBeGreaterThan(0)
    expect(upload).toBeGreaterThan(chat)
    expect(general).toBeGreaterThan(upload)
  })

  it('a stored attachment keeps the same owner-path rule as ordinary uploads', () => {
    const uploads = read('../processingUploadService.ts')
    expect(uploads).toContain("const path = options.userId + '/' + options.purpose + '/' + crypto.randomUUID() + '.' + extension\n  validateOwnedPath(path, options.userId, options.purpose)")
    expect(uploads).toContain('if (options.buffer.length > STORED_UPLOAD_MAX_BYTES)')
  })
})
