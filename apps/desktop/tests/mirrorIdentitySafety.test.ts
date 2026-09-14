import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { expect, it } from 'vitest'
import { createMirrorSigner } from '../src/security/mirrorIdentity'
it('never regenerates an unreadable key and retries after an explicit profile repair', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'forsage-identity-test-'))
  const codec = { encrypt: (text:string) => Buffer.from(text).toString('base64'), decrypt: (text:string) => Buffer.from(text,'base64').toString() }
  try {
    const original = createMirrorSigner(root,codec)('probe')
    const file = path.join(root,'mirror-identity.json'), before = readFileSync(file,'utf8')
    let available = false
    const signer = createMirrorSigner(root,{...codec,decrypt: text => { if(!available) throw Error('profile unavailable'); return codec.decrypt(text) }})
    expect(() => signer('probe')).toThrow('MIRROR_IDENTITY_UNAVAILABLE')
    expect(readFileSync(file,'utf8')).toBe(before)
    available = true
    expect(signer('probe')).toBe(original)
    const wrong = generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString()
    writeFileSync(file,JSON.stringify({...JSON.parse(before),public_key:wrong}))
    expect(() => createMirrorSigner(root,codec)('probe')).toThrow('MIRROR_IDENTITY_UNAVAILABLE')
  } finally { if(path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-identity-test-')) rmSync(root,{recursive:true,force:true}) }
})
