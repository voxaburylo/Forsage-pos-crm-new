import { describe, it, expect } from 'vitest'
import { backupDescriptor, MAX_BACKUP_BYTES } from './backupPolicy.js'
const tenant='11111111-1111-4111-8111-111111111111'
const input={tenant_id:tenant,device_id:'22222222-2222-4222-8222-222222222222',id:'33333333-3333-4333-8333-333333333333',sha256:'a'.repeat(64),size_bytes:100}
describe('private backup paths',()=>{
  it('uses immutable tenant/device/shift and checksum names',()=>expect(backupDescriptor(input,tenant).path).toBe(tenant+'/'+input.device_id+'/'+input.id+'-'+input.sha256+'.db.gz'))
  it.each([{tenant_id:'other'},{id:'../../secret'},{device_id:'../other'},{sha256:'x'},{size_bytes:MAX_BACKUP_BYTES+1},{size_bytes:-1}])('rejects %j',change=>expect(()=>backupDescriptor({...input,...change},tenant)).toThrow())
})
